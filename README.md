# Obsidian GitLab README Import

An [Obsidian](https://obsidian.md/) plugin that fetches the README file from a
GitLab repository and inserts it into the current note. Works with both
[gitlab.com](https://gitlab.com) and self-hosted GitLab instances.

This plugin is inspired by
[`chasebank87/import-github-readme`](https://github.com/chasebank87/import-github-readme)
and uses GitLab authentication patterns from
[`benr77/obsidian-gitlab-issues`](https://github.com/benr77/obsidian-gitlab-issues).

## Features

- **Import GitLab README** — fetch a repo's README and insert it at the cursor.
- **Sync GitLab repo markdown** — mirror every `.md` file in a repo into the
  vault, preserving folder structure. Re-run to pull updates.
- **Sync all GitLab repos** — refresh every repo you've previously synced
  in one command.
- Remembers synced repos so you don't have to paste the URL every time.
- Follows user moves/renames: if you drag a synced file to a different folder
  or rename it, later syncs write to the new location instead of duplicating.
- Supports `gitlab.com` and self-hosted GitLab instances.
- Supports private repositories via a GitLab personal access token (`read_api`
  scope).
- Accepts several URL formats, including branch-qualified URLs
  (`https://gitlab.com/group/project/-/tree/branch`) and blob URLs.
- Automatically detects the default branch if none is specified.
- Rewrites relative image URLs in imported READMEs to absolute GitLab raw URLs
  so images render in Obsidian.

## Installation

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [Releases](../../releases) page (or build them locally with `npm run build`).
2. Copy them into your vault at
   `<vault>/.obsidian/plugins/obsidian-gitlab-readme-import/`.
3. Enable the plugin under **Settings → Community plugins**.

### Build from source

```bash
npm install
npm run build
```

The build produces `main.js` at the repo root. Copy `main.js`, `manifest.json`,
and `styles.css` into your vault's plugin directory as described above.

## Configuration

Open **Settings → GitLab README Import** and configure:

- **GitLab instance URL** — defaults to `https://gitlab.com`. Set this to your
  self-hosted GitLab URL (e.g. `https://gitlab.example.com`).
- **Personal access token** — optional. Required for private repositories.
  Create one at
  [`https://gitlab.com/-/profile/personal_access_tokens`](https://gitlab.com/-/profile/personal_access_tokens)
  (or the equivalent path on your self-hosted instance) with the `read_api`
  scope.
- **Rewrite relative URLs** — when enabled, relative image URLs in imported
  markdown READMEs are rewritten to absolute GitLab raw URLs so images render
  correctly in Obsidian.

## Usage

### Import a single README

1. Open a markdown note in Obsidian.
2. Open the command palette (`Ctrl+P` / `Cmd+P`) and run
   **Import GitLab README**.
3. Paste a GitLab repository URL, for example:
   - `https://gitlab.com/group/project`
   - `https://gitlab.com/group/subgroup/project`
   - `https://gitlab.com/group/project/-/tree/develop`
   - `group/project` (uses the default instance URL from settings)
4. The README is fetched and inserted at the cursor.

### Sync every markdown file in a repo

1. Command palette → **Sync GitLab repo markdown**.
2. Paste a repo URL (e.g. `https://gitlab.com/group/project`).
3. Every matching file (default: `.md`, `.markdown`, `.mdown`) is written into
   the vault under `<Sync destination folder>/<group>/<project>/...` with the
   repo's folder structure preserved.
4. Re-run the command any time to pull updates. Files you've moved or renamed
   in Obsidian are updated at their current location instead of being
   duplicated.

### Sync all remembered repos at once

After you sync a repo once, the plugin remembers it. Run **Sync all GitLab
repos** from the command palette to refresh every remembered repo in one
shot. The plugin settings tab has a **Synced repos** section listing each
remembered repo with **Sync now** and **Forget** buttons.

### Settings for sync

- **Sync destination folder** — vault folder where synced repos live
  (default: `GitLab`). Each repo lands at `<folder>/<group>/<project>/...`.
- **File extensions to sync** — comma-separated list, case-insensitive
  (default: `.md,.markdown,.mdown`).

## License

[MIT](LICENSE)
