import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	RequestUrlParam,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
	htmlToMarkdown,
	requestUrl,
	sanitizeHTMLToDom,
} from "obsidian";

type SyncManifest = Record<string, Record<string, string>>;

interface SyncedRepoEntry {
	host: string;
	projectPath: string;
	lastSyncAt: number;
}

type SyncedRepos = Record<string, SyncedRepoEntry>;

interface GitlabReadmeImportSettings {
	gitlabUrl: string;
	gitlabToken: string;
	convertHtml: boolean;
	syncFolder: string;
	syncExtensions: string;
	syncManifest: SyncManifest;
	syncedRepos: SyncedRepos;
}

const DEFAULT_SETTINGS: GitlabReadmeImportSettings = {
	gitlabUrl: "https://gitlab.com",
	gitlabToken: "",
	convertHtml: true,
	syncFolder: "GitLab",
	syncExtensions: ".md,.markdown,.mdown",
	syncManifest: {},
	syncedRepos: {},
};

interface ParsedRepo {
	host: string;
	projectPath: string;
	ref: string | null;
}

interface GitlabProject {
	id: number;
	default_branch: string;
	web_url: string;
}

interface GitlabTreeEntry {
	id: string;
	name: string;
	type: string;
	path: string;
}

const README_CANDIDATES = [
	"README.md",
	"readme.md",
	"Readme.md",
	"README.MD",
	"README",
	"readme",
	"README.markdown",
	"README.mdown",
	"README.rst",
	"README.txt",
];

export default class GitlabReadmeImportPlugin extends Plugin {
	settings: GitlabReadmeImportSettings;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new GitlabReadmeImportSettingTab(this.app, this));

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				void this.handleRename(file, oldPath);
			}),
		);

		this.addCommand({
			id: "import-gitlab-readme",
			name: "Import GitLab README",
			editorCallback: (editor: Editor, _view: MarkdownView) => {
				new GitlabRepoModal(this.app, {
					title: "Import GitLab README",
					description:
						"Paste a GitLab repository URL (e.g. https://gitlab.com/group/project). URLs pointing at a branch or file will also be accepted.",
					buttonText: "Import",
					onSubmit: (repoUrl) => {
						this.importReadme(repoUrl, editor);
					},
				}).open();
			},
		});

		this.addCommand({
			id: "sync-gitlab-markdown",
			name: "Sync GitLab repo markdown",
			callback: () => {
				new GitlabRepoModal(this.app, {
					title: "Sync GitLab repo markdown",
					description:
						"Paste a GitLab repo URL. Every markdown file in the repo will be mirrored into your vault, preserving folder structure. Re-run to pull updates.",
					buttonText: "Sync",
					onSubmit: (repoUrl) => {
						this.syncRepoMarkdown(repoUrl);
					},
				}).open();
			},
		});

		this.addCommand({
			id: "sync-all-gitlab-repos",
			name: "Sync all GitLab repos",
			callback: () => {
				void this.syncAllRepos();
			},
		});
	}

	async loadSettings() {
		const loaded = (await this.loadData()) ?? {};
		this.settings = {
			...DEFAULT_SETTINGS,
			syncManifest: {},
			syncedRepos: {},
			...loaded,
		};
		if (!this.settings.syncManifest) this.settings.syncManifest = {};
		if (!this.settings.syncedRepos) this.settings.syncedRepos = {};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async importReadme(repoUrl: string, editor: Editor): Promise<void> {
		const trimmed = (repoUrl ?? "").trim();
		if (!trimmed) {
			new Notice("Please enter a GitLab repository URL.");
			return;
		}

		try {
			const parsed = this.parseRepoUrl(trimmed);
			const apiBase = this.buildApiBase(parsed.host);
			const project = await this.fetchProject(apiBase, parsed.projectPath);
			const ref = parsed.ref ?? project.default_branch;

			const { content, filename } = await this.fetchReadme(
				apiBase,
				parsed.projectPath,
				ref,
			);

			let output = content;
			if (this.settings.convertHtml && this.looksLikeMarkdown(filename)) {
				output = this.resolveRelativeUrls(
					output,
					parsed.host,
					parsed.projectPath,
					ref,
				);
				output = this.removeEmptyHtmlTags(output);
			}

			editor.replaceSelection(output);
			new Notice(`Imported ${filename} from ${parsed.projectPath}`);
		} catch (error) {
			console.error("GitLab README import failed", error);
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Failed to import GitLab README: ${message}`);
		}
	}

	parseRepoUrl(input: string): ParsedRepo {
		const defaultHost = this.normalizeHost(this.settings.gitlabUrl);
		let host = defaultHost;
		let pathPart = input;
		let ref: string | null = null;

		if (/^https?:\/\//i.test(input)) {
			const url = new URL(input);
			host = `${url.protocol}//${url.host}`;
			pathPart = url.pathname;
		}

		pathPart = pathPart.replace(/^\/+/, "").replace(/\/+$/, "");
		pathPart = pathPart.replace(/\.git$/i, "");

		const refMarker = pathPart.indexOf("/-/");
		let projectPath = pathPart;
		if (refMarker !== -1) {
			projectPath = pathPart.substring(0, refMarker);
			const after = pathPart.substring(refMarker + 3).split("/");
			if (after.length >= 2 && (after[0] === "tree" || after[0] === "blob")) {
				ref = decodeURIComponent(after[1]);
			}
		}

		if (!projectPath || !projectPath.includes("/")) {
			throw new Error(
				`Could not parse GitLab project path from "${input}". Expected something like https://gitlab.com/group/project.`,
			);
		}

		return { host, projectPath, ref };
	}

	private normalizeHost(url: string): string {
		const fallback = "https://gitlab.com";
		const value = (url ?? "").trim() || fallback;
		try {
			const parsed = new URL(value);
			return `${parsed.protocol}//${parsed.host}`;
		} catch {
			return fallback;
		}
	}

	private buildApiBase(host: string): string {
		return `${host.replace(/\/+$/, "")}/api/v4`;
	}

	private async fetchProject(
		apiBase: string,
		projectPath: string,
	): Promise<GitlabProject> {
		const url = `${apiBase}/projects/${encodeURIComponent(projectPath)}`;
		return await this.requestJson<GitlabProject>(url);
	}

	private async fetchReadme(
		apiBase: string,
		projectPath: string,
		ref: string,
	): Promise<{ content: string; filename: string }> {
		const filename = await this.findReadmeFilename(apiBase, projectPath, ref);
		const fileUrl = `${apiBase}/projects/${encodeURIComponent(
			projectPath,
		)}/repository/files/${encodeURIComponent(filename)}/raw?ref=${encodeURIComponent(
			ref,
		)}`;
		const response = await this.request({ url: fileUrl });
		if (response.status < 200 || response.status >= 300) {
			throw new Error(
				`GitLab responded with status ${response.status} when fetching ${filename}.`,
			);
		}
		return { content: response.text, filename };
	}

	private async findReadmeFilename(
		apiBase: string,
		projectPath: string,
		ref: string,
	): Promise<string> {
		const treeUrl = `${apiBase}/projects/${encodeURIComponent(
			projectPath,
		)}/repository/tree?ref=${encodeURIComponent(ref)}&per_page=100`;
		try {
			const entries = await this.requestJson<GitlabTreeEntry[]>(treeUrl);
			const readmes = entries
				.filter((entry) => entry.type === "blob")
				.filter((entry) => /^readme(\.[a-z0-9]+)?$/i.test(entry.name));
			if (readmes.length > 0) {
				const preferred = readmes.find((e) => /\.md$/i.test(e.name));
				return (preferred ?? readmes[0]).name;
			}
		} catch (error) {
			console.warn(
				"GitLab tree listing failed; falling back to candidate filenames.",
				error,
			);
		}

		for (const candidate of README_CANDIDATES) {
			const url = `${apiBase}/projects/${encodeURIComponent(
				projectPath,
			)}/repository/files/${encodeURIComponent(candidate)}?ref=${encodeURIComponent(
				ref,
			)}`;
			try {
				const response = await this.request({ url, method: "HEAD" });
				if (response.status >= 200 && response.status < 300) {
					return candidate;
				}
			} catch {
				// try next candidate
			}
		}

		throw new Error(
			`No README file found at ref "${ref}" for ${projectPath}.`,
		);
	}

	private async requestJson<T>(url: string): Promise<T> {
		const response = await this.request({ url });
		if (response.status < 200 || response.status >= 300) {
			throw new Error(
				`GitLab request to ${url} failed with status ${response.status}.`,
			);
		}
		return response.json as T;
	}

	private async request(params: RequestUrlParam) {
		const headers: Record<string, string> = { ...(params.headers ?? {}) };
		if (this.settings.gitlabToken) {
			headers["PRIVATE-TOKEN"] = this.settings.gitlabToken;
		}
		return await requestUrl({ ...params, headers, throw: false });
	}

	private looksLikeMarkdown(filename: string): boolean {
		return /\.(md|mdown|markdown)$/i.test(filename);
	}

	async syncRepoMarkdown(repoUrl: string): Promise<void> {
		const trimmed = (repoUrl ?? "").trim();
		if (!trimmed) {
			new Notice("Please enter a GitLab repository URL.");
			return;
		}

		try {
			const parsed = this.parseRepoUrl(trimmed);
			const apiBase = this.buildApiBase(parsed.host);
			const project = await this.fetchProject(apiBase, parsed.projectPath);
			const ref = parsed.ref ?? project.default_branch;

			const entries = await this.fetchTreeRecursive(
				apiBase,
				parsed.projectPath,
				ref,
			);
			const extensions = this.parseExtensions(this.settings.syncExtensions);
			const files = entries.filter(
				(entry) =>
					entry.type === "blob" &&
					extensions.some((ext) =>
						entry.path.toLowerCase().endsWith(ext),
					),
			);
			if (files.length === 0) {
				new Notice(
					`No matching files found in ${parsed.projectPath}@${ref}.`,
				);
				return;
			}

			const baseFolder = this.normalizeFolder(this.settings.syncFolder);
			const targetRoot = baseFolder
				? `${baseFolder}/${parsed.projectPath}`
				: parsed.projectPath;

			const progress = new Notice(
				`Syncing ${files.length} file(s) from ${parsed.projectPath}@${ref}\u2026`,
				0,
			);

			const projectKey = this.projectKey(parsed.host, parsed.projectPath);
			if (!this.settings.syncManifest) this.settings.syncManifest = {};
			if (!this.settings.syncManifest[projectKey]) {
				this.settings.syncManifest[projectKey] = {};
			}
			const projectManifest = this.settings.syncManifest[projectKey];

			let written = 0;
			let failed = 0;
			let movedCount = 0;
			for (const entry of files) {
				try {
					const content = await this.fetchRawFile(
						apiBase,
						parsed.projectPath,
						ref,
						entry.path,
					);
					const defaultPath = `${targetRoot}/${entry.path}`;
					let targetPath = defaultPath;
					const trackedPath = projectManifest[entry.path];
					if (
						trackedPath &&
						trackedPath !== defaultPath &&
						this.app.vault.getAbstractFileByPath(trackedPath) instanceof
							TFile
					) {
						targetPath = trackedPath;
						movedCount += 1;
					}
					await this.writeVaultFile(targetPath, content);
					projectManifest[entry.path] = targetPath;
					written += 1;
					progress.setMessage(
						`Syncing ${parsed.projectPath}\u2026 ${written}/${files.length}`,
					);
				} catch (err) {
					failed += 1;
					console.warn(`Failed to sync ${entry.path}`, err);
				}
			}
			if (!this.settings.syncedRepos) this.settings.syncedRepos = {};
			this.settings.syncedRepos[projectKey] = {
				host: parsed.host,
				projectPath: parsed.projectPath,
				lastSyncAt: Date.now(),
			};
			await this.saveSettings();
			progress.hide();
			const movedSuffix =
				movedCount > 0
					? ` (${movedCount} file(s) updated at user-moved locations)`
					: "";
			const failSuffix =
				failed > 0 ? ` (${failed} failed \u2014 see console)` : "";
			new Notice(
				`Synced ${written} file(s) to ${targetRoot}/${movedSuffix}${failSuffix}`,
			);
		} catch (error) {
			console.error("GitLab markdown sync failed", error);
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Failed to sync GitLab markdown: ${message}`);
		}
	}

	async syncAllRepos(): Promise<void> {
		const repos = this.settings.syncedRepos ?? {};
		const keys = Object.keys(repos);
		if (keys.length === 0) {
			new Notice(
				"No synced GitLab repos yet. Run 'Sync GitLab repo markdown' at least once first.",
			);
			return;
		}
		new Notice(`Re-syncing ${keys.length} GitLab repo(s)\u2026`);
		for (const key of keys) {
			const entry = repos[key];
			const url = `${entry.host.replace(/\/+$/, "")}/${entry.projectPath}`;
			await this.syncRepoMarkdown(url);
		}
		new Notice(`Finished re-syncing ${keys.length} GitLab repo(s).`);
	}

	forgetSyncedRepo(projectKey: string): void {
		if (this.settings.syncedRepos) {
			delete this.settings.syncedRepos[projectKey];
		}
		if (this.settings.syncManifest) {
			delete this.settings.syncManifest[projectKey];
		}
		void this.saveSettings();
	}

	private async fetchTreeRecursive(
		apiBase: string,
		projectPath: string,
		ref: string,
	): Promise<GitlabTreeEntry[]> {
		const entries: GitlabTreeEntry[] = [];
		let page = 1;
		const maxPages = 100;
		while (page > 0 && page <= maxPages) {
			const url = `${apiBase}/projects/${encodeURIComponent(
				projectPath,
			)}/repository/tree?ref=${encodeURIComponent(
				ref,
			)}&recursive=true&per_page=100&page=${page}`;
			const response = await this.request({ url });
			if (response.status < 200 || response.status >= 300) {
				throw new Error(
					`GitLab tree request failed with status ${response.status}.`,
				);
			}
			const pageEntries = response.json as GitlabTreeEntry[];
			if (!Array.isArray(pageEntries)) break;
			entries.push(...pageEntries);
			const next = this.getHeader(response.headers, "x-next-page");
			if (!next) break;
			const parsedNext = parseInt(next, 10);
			if (!parsedNext || parsedNext <= page) break;
			page = parsedNext;
		}
		return entries;
	}

	private async fetchRawFile(
		apiBase: string,
		projectPath: string,
		ref: string,
		filePath: string,
	): Promise<string> {
		const fileUrl = `${apiBase}/projects/${encodeURIComponent(
			projectPath,
		)}/repository/files/${encodeURIComponent(
			filePath,
		)}/raw?ref=${encodeURIComponent(ref)}`;
		const response = await this.request({ url: fileUrl });
		if (response.status < 200 || response.status >= 300) {
			throw new Error(
				`Failed to fetch ${filePath} (status ${response.status}).`,
			);
		}
		return response.text;
	}

	private parseExtensions(raw: string): string[] {
		return (raw ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter((s) => s.length > 0)
			.map((s) => (s.startsWith(".") ? s : `.${s}`));
	}

	private normalizeFolder(folder: string): string {
		return (folder ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
	}

	private getHeader(
		headers: Record<string, string> | undefined,
		name: string,
	): string | null {
		if (!headers) return null;
		const lower = name.toLowerCase();
		for (const key of Object.keys(headers)) {
			if (key.toLowerCase() === lower) {
				const value = headers[key];
				return value && value.length > 0 ? value : null;
			}
		}
		return null;
	}

	private async writeVaultFile(
		path: string,
		content: string,
	): Promise<void> {
		const normalized = path.replace(/^\/+/, "");
		const lastSlash = normalized.lastIndexOf("/");
		if (lastSlash > 0) {
			await this.ensureFolder(normalized.substring(0, lastSlash));
		}
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(normalized, content);
		}
	}

	private projectKey(host: string, projectPath: string): string {
		return `${host.replace(/\/+$/, "")}::${projectPath}`;
	}

	private async handleRename(
		file: TAbstractFile,
		oldPath: string,
	): Promise<void> {
		if (!this.settings?.syncManifest) return;
		const newPath = file.path;
		if (oldPath === newPath) return;

		const isFolder = file instanceof TFolder;
		const prefix = oldPath + "/";
		let changed = false;

		for (const projectKey of Object.keys(this.settings.syncManifest)) {
			const manifest = this.settings.syncManifest[projectKey];
			for (const originalPath of Object.keys(manifest)) {
				const current = manifest[originalPath];
				if (current === oldPath) {
					manifest[originalPath] = newPath;
					changed = true;
				} else if (isFolder && current.startsWith(prefix)) {
					manifest[originalPath] =
						newPath + current.substring(oldPath.length);
					changed = true;
				}
			}
		}

		if (changed) await this.saveSettings();
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (this.app.vault.getAbstractFileByPath(current)) continue;
			try {
				await this.app.vault.createFolder(current);
			} catch {
				// concurrent creation is fine
			}
		}
	}

	resolveRelativeUrls(
		content: string,
		host: string,
		projectPath: string,
		ref: string,
	): string {
		const rawBase = `${host.replace(/\/+$/, "")}/${projectPath}/-/raw/${encodeURIComponent(
			ref,
		)}/`;

		// Markdown images: ![alt](relative/path)
		content = content.replace(
			/!\[([^\]]*)\]\((?!https?:\/\/|data:|#)([^)\s]+)(\s+"[^"]*")?\)/g,
			(_match, alt: string, url: string, title: string | undefined) => {
				const resolved = this.resolveUrl(url, rawBase);
				return `![${alt}](${resolved}${title ?? ""})`;
			},
		);

		// HTML <img src="relative/path">
		content = content.replace(
			/<img\b([^>]*?)\bsrc=(["'])(?!https?:\/\/|data:|#)([^"']+)\2([^>]*)>/gi,
			(_match, before: string, quote: string, url: string, after: string) => {
				const resolved = this.resolveUrl(url, rawBase);
				return `<img${before}src=${quote}${resolved}${quote}${after}>`;
			},
		);

		return content;
	}

	private resolveUrl(url: string, base: string): string {
		try {
			if (/^https?:\/\//i.test(url) || url.startsWith("data:")) {
				return url;
			}
			return new URL(url, base).href;
		} catch (error) {
			console.warn(`Failed to resolve URL "${url}" against "${base}"`, error);
			return url;
		}
	}

	removeEmptyHtmlTags(content: string): string {
		const emptyTagRegex = /<([a-z]+)(?:\s+[^>]*)?>\s*<\/\1>/gi;
		let result = content;
		let previous;
		do {
			previous = result;
			result = result.replace(emptyTagRegex, "");
		} while (result !== previous);
		return result;
	}

	// Expose helpers for potential future use / testing without adding deps.
	convertInlineHtmlToMarkdown(content: string): string {
		const container = document.createElement("div");
		container.appendChild(sanitizeHTMLToDom(content));
		return htmlToMarkdown(container.innerHTML);
	}
}

interface GitlabRepoModalOptions {
	title: string;
	description: string;
	buttonText: string;
	onSubmit: (result: string) => void;
}

class GitlabRepoModal extends Modal {
	private result = "";
	private readonly opts: GitlabRepoModalOptions;

	constructor(app: App, opts: GitlabRepoModalOptions) {
		super(app);
		this.opts = opts;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: this.opts.title });
		contentEl.createEl("p", { text: this.opts.description });

		new Setting(contentEl)
			.setName("Repository URL or path")
			.addText((text) => {
				text.setPlaceholder("https://gitlab.com/group/project").onChange(
					(value) => {
						this.result = value;
					},
				);
				text.inputEl.addEventListener("keydown", (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						this.submit();
					}
				});
			});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText(this.opts.buttonText)
				.setCta()
				.onClick(() => this.submit()),
		);
	}

	private submit() {
		this.close();
		this.opts.onSubmit(this.result);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class GitlabReadmeImportSettingTab extends PluginSettingTab {
	plugin: GitlabReadmeImportPlugin;

	constructor(app: App, plugin: GitlabReadmeImportPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "GitLab README Import" });

		const howTo = containerEl.createDiv({ cls: "gitlab-readme-import-howto" });
		howTo.createEl("h3", { text: "How to use" });
		const ol = howTo.createEl("ol");
		const step1 = ol.createEl("li");
		step1.appendText("Open or create a note.");
		const step2 = ol.createEl("li");
		step2.appendText("Open the command palette (");
		step2.createEl("kbd", { text: "Ctrl/Cmd+P" });
		step2.appendText(") and run ");
		step2.createEl("strong", { text: "Import GitLab README" });
		step2.appendText(".");
		const step3 = ol.createEl("li");
		step3.appendText("Paste a repository URL (e.g. ");
		step3.createEl("code", { text: "https://gitlab.com/group/project" });
		step3.appendText(") and click ");
		step3.createEl("strong", { text: "Import" });
		step3.appendText(". The README is inserted at the cursor.");

		const syncPara = howTo.createEl("p");
		syncPara.createEl("strong", { text: "Sync every markdown file: " });
		syncPara.appendText("run ");
		syncPara.createEl("strong", { text: "Sync GitLab repo markdown" });
		syncPara.appendText(" instead. All ");
		syncPara.createEl("code", { text: ".md" });
		syncPara.appendText(
			" files in the repo are written into the vault under the folder configured below, preserving the repo's directory structure. Re-run any time to pull updates.",
		);

		const privateNote = howTo.createEl("p");
		privateNote.createEl("strong", { text: "Private repos: " });
		privateNote.appendText("set \u201CPersonal access token\u201D below. Create one at ");
		privateNote.createEl("a", {
			text: "gitlab.com/-/user_settings/personal_access_tokens",
			href: "https://gitlab.com/-/user_settings/personal_access_tokens",
		});
		privateNote.appendText(" with the ");
		privateNote.createEl("code", { text: "read_api" });
		privateNote.appendText(" scope.");

		new Setting(containerEl)
			.setName("GitLab instance URL")
			.setDesc(
				"Root URL of your GitLab host only \u2014 e.g. https://gitlab.com or https://gitlab.example.com. Do NOT include a group or project path here.",
			)
			.addText((text) =>
				text
					.setPlaceholder("https://gitlab.com")
					.setValue(this.plugin.settings.gitlabUrl)
					.onChange(async (value) => {
						this.plugin.settings.gitlabUrl = value.trim() || DEFAULT_SETTINGS.gitlabUrl;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Personal access token")
			.setDesc(
				"Optional. Required for private repositories. Create a token with the `read_api` scope.",
			)
			.addText((text) => {
				text
					.setPlaceholder("glpat-xxxxxxxxxxxxxxxxxxxx")
					.setValue(this.plugin.settings.gitlabToken)
					.onChange(async (value) => {
						this.plugin.settings.gitlabToken = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Rewrite relative URLs")
			.setDesc(
				"Rewrite relative image URLs in imported markdown READMEs to absolute GitLab raw URLs so they render in Obsidian.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.convertHtml)
					.onChange(async (value) => {
						this.plugin.settings.convertHtml = value;
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("h3", { text: "Sync GitLab repo markdown" });

		new Setting(containerEl)
			.setName("Sync destination folder")
			.setDesc(
				"Vault folder where synced repos are mirrored. Each repo is placed under <folder>/<group>/<project>/\u2026 . Leave blank to mirror at the vault root.",
			)
			.addText((text) =>
				text
					.setPlaceholder("GitLab")
					.setValue(this.plugin.settings.syncFolder)
					.onChange(async (value) => {
						this.plugin.settings.syncFolder = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("File extensions to sync")
			.setDesc(
				"Comma-separated list of file extensions to include when syncing (case-insensitive).",
			)
			.addText((text) =>
				text
					.setPlaceholder(".md,.markdown,.mdown")
					.setValue(this.plugin.settings.syncExtensions)
					.onChange(async (value) => {
						this.plugin.settings.syncExtensions = value;
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("h4", { text: "Synced repos" });
		const syncedRepos = this.plugin.settings.syncedRepos ?? {};
		const repoKeys = Object.keys(syncedRepos).sort();
		if (repoKeys.length === 0) {
			const empty = containerEl.createEl("p");
			empty.appendText(
				"No repos synced yet. Run \u201CSync GitLab repo markdown\u201D to add one. Once you've synced at least one repo, \u201CSync all GitLab repos\u201D will refresh them all at once.",
			);
		} else {
			for (const key of repoKeys) {
				const entry = syncedRepos[key];
				const when = entry.lastSyncAt
					? new Date(entry.lastSyncAt).toLocaleString()
					: "never";
				new Setting(containerEl)
					.setName(entry.projectPath)
					.setDesc(`${entry.host} \u2014 last synced ${when}`)
					.addButton((btn) =>
						btn
							.setButtonText("Sync now")
							.onClick(async () => {
								const url = `${entry.host.replace(
									/\/+$/,
									"",
								)}/${entry.projectPath}`;
								await this.plugin.syncRepoMarkdown(url);
								this.display();
							}),
					)
					.addButton((btn) =>
						btn
							.setButtonText("Forget")
							.setWarning()
							.onClick(() => {
								this.plugin.forgetSyncedRepo(key);
								this.display();
							}),
					);
			}
			new Setting(containerEl)
				.setName("Sync all now")
				.setDesc(
					"Re-sync every remembered repo. Same as the \u201CSync all GitLab repos\u201D command.",
				)
				.addButton((btn) =>
					btn
						.setButtonText("Sync all")
						.setCta()
						.onClick(async () => {
							await this.plugin.syncAllRepos();
							this.display();
						}),
				);
		}

		containerEl.createEl("h3", { text: "More information" });
		containerEl.createEl("a", {
			text: "GitLab Repository Files API documentation",
			href: "https://docs.gitlab.com/ee/api/repository_files.html",
		});
	}
}
