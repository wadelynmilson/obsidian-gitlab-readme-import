# Obsidian GitLab README Import

An [Obsidian](https://obsidian.md/) plugin that fetches the README file from a
GitLab repository and inserts it into the current note. Works with both
[gitlab.com](https://gitlab.com) and self-hosted GitLab instances.

This plugin is inspired by
[`chasebank87/import-github-readme`](https://github.com/chasebank87/import-github-readme)
and uses GitLab authentication patterns from
[`benr77/obsidian-gitlab-issues`](https://github.com/benr77/obsidian-gitlab-issues).

## Features

- Import a README directly into the current note via the command palette.
- Supports `gitlab.com` and self-hosted GitLab instances.
- Supports private repositories via a GitLab personal access token.
- Accepts several URL formats, including branch-qualified URLs
  (`https://gitlab.com/group/project/-/tree/branch`) and blob URLs.
- Automatically detects the default branch if none is specified.
- Rewrites relative image URLs in the README to absolute GitLab raw URLs so
  images render in Obsidian.

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

1. Open a markdown note in Obsidian.
2. Open the command palette (`Ctrl+P` / `Cmd+P`) and run
   **Import GitLab README**.
3. Paste a GitLab repository URL, for example:
   - `https://gitlab.com/group/project`
   - `https://gitlab.com/group/subgroup/project`
   - `https://gitlab.com/group/project/-/tree/develop`
   - `group/project` (uses the default instance URL from settings)
4. The README will be fetched and inserted at the cursor.

## License

[MIT](LICENSE)
