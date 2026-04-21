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
	htmlToMarkdown,
	requestUrl,
	sanitizeHTMLToDom,
} from "obsidian";

interface GitlabReadmeImportSettings {
	gitlabUrl: string;
	gitlabToken: string;
	convertHtml: boolean;
}

const DEFAULT_SETTINGS: GitlabReadmeImportSettings = {
	gitlabUrl: "https://gitlab.com",
	gitlabToken: "",
	convertHtml: true,
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

		this.addCommand({
			id: "import-gitlab-readme",
			name: "Import GitLab README",
			editorCallback: (editor: Editor, _view: MarkdownView) => {
				new GitlabRepoModal(this.app, (repoUrl) => {
					this.importReadme(repoUrl, editor);
				}).open();
			},
		});
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
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

class GitlabRepoModal extends Modal {
	private result = "";
	private readonly onSubmit: (result: string) => void;

	constructor(app: App, onSubmit: (result: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: "Import GitLab README" });
		contentEl.createEl("p", {
			text: "Paste a GitLab repository URL (e.g. https://gitlab.com/group/project). URLs pointing at a branch or file will also be accepted.",
		});

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
				.setButtonText("Import")
				.setCta()
				.onClick(() => this.submit()),
		);
	}

	private submit() {
		this.close();
		this.onSubmit(this.result);
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

		containerEl.createEl("h3", { text: "More information" });
		containerEl.createEl("a", {
			text: "GitLab Repository Files API documentation",
			href: "https://docs.gitlab.com/ee/api/repository_files.html",
		});
	}
}
