# Test Plan — Import GitLab README (PR #1)

## What changed
Brand-new Obsidian plugin. Adds a command **Import GitLab README** that prompts
for a GitLab repo URL and inserts the repo's README into the current editor at
the cursor. Uses the GitLab REST API (`/projects/:id/repository/files/...`),
auto-detects the default branch, supports self-hosted hosts, and optionally
rewrites relative image URLs.

Relevant source: <ref_file file="/home/ubuntu/repos/obsidian-gitlab-readme-import/main.ts" /> (command registration line 66, `importReadme` line 87, `fetchReadme` line 187, default-branch lookup via `fetchProject` line 180, modal at bottom).

## Primary flow (one adversarial test)

**Scenario:** Import the README of a public gitlab.com repository and verify
the inserted markdown is the *actual* upstream README, not stub/fallback/empty
content.

**Ground truth** (captured independently with `curl`):
```
$ curl -s https://gitlab.com/gitlab-org/cli/-/raw/main/README.md | wc -c
29858
```
- Contains the substring `GLab is an open source GitLab CLI tool` (exactly 1 match).
- Contains the heading `## Table of contents` at start-of-line (exactly 1 match).

**Steps:**
1. In TestVault, open an empty untitled note.
2. Open the command palette (`Ctrl+P`) and select **Import GitLab Readme: Import GitLab README**.
3. In the modal, paste `https://gitlab.com/gitlab-org/cli` and click **Import**.
4. Wait for the Notice toast.

**Pass / fail criteria (concrete byte-level assertions):**
- [ ] **A1 — Notice fires with success message.** A Notice appears containing the text `Imported README` and the project path `gitlab-org/cli`. A toast containing `Failed` means failure.
- [ ] **A2 — Inserted content contains ground-truth substring.** The current note's text contains the exact substring `GLab is an open source GitLab CLI tool`. This line exists only in the real upstream README; any fallback/placeholder/stub would not include it.
- [ ] **A3 — Inserted content contains second ground-truth substring.** The note also contains `## Table of contents` as a heading. Having both A2 and A3 rules out partial/truncated reads.
- [ ] **A4 — Size is in the right order of magnitude.** Character count shown in Obsidian's status bar is within ±20% of `29858` (i.e. roughly `24000–36000`). Rules out "inserted a few bytes" bugs.
- [ ] **A5 — No console errors in the renderer devtools.** `Ctrl+Shift+I` → Console tab shows no `GitLab README import failed` error (the plugin's own error log), no uncaught exceptions from `main.js`.

**Why this is adversarial:** the substrings in A2 and A3 come from ground truth
captured independently via `curl` against the GitLab raw endpoint.
A broken implementation that e.g.:
- fetches the wrong project → would not return this exact text
- fetches the wrong branch / file → would not match both substrings
- silently inserts empty or error text → fails A2/A3/A4
- returns base64 file payload instead of raw → fails A2/A3 (substrings would be base64-encoded)
- truncates content → A4 catches length mismatches A2/A3 might miss
…would all produce visibly different output on this screen.

## Out of scope for this run
- Private repos (needs a GitLab personal access token from the user — not
  required to prove the PR works for public repos, which is the stated intent).
- Self-hosted GitLab host (no self-hosted instance available to test against).
- Relative-image-URL rewriting correctness (touched by this README indirectly
  — `![GLab](docs/source/img/glab-logo.png)` should become an absolute
  `…/-/raw/main/docs/source/img/glab-logo.png`; we will spot-check this as a
  bonus observation if present in inserted text, but not gate on it).
