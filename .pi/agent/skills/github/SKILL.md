---
name: github
description: Interact with GitHub using the gh CLI. Use for creating/reviewing PRs, managing issues, checking CI status, browsing repos, and other GitHub operations.
---

# GitHub

Interact with GitHub via the `gh` CLI. No additional setup required.

## Pull Requests

```bash
# List open PRs
gh pr list

# Create a PR (interactive)
gh pr create

# Create a PR with details
gh pr create --title "Title" --body "Description" --base main

# View PR details
gh pr view <number>

# View PR diff
gh pr diff <number>

# Review a PR — show files changed with full diff
gh pr diff <number> | head -200

# Check PR CI status
gh pr checks <number>

# Merge a PR
gh pr merge <number> --squash --delete-branch

# Checkout a PR locally
gh pr checkout <number>
```

## Issues

```bash
# List open issues
gh issue list

# List issues with labels
gh issue list --label "bug" --label "help wanted"

# Create an issue
gh issue create --title "Title" --body "Description"

# View issue details
gh issue view <number>

# Close an issue
gh issue close <number>

# Search issues
gh issue list --search "keyword"
```

## Repository

```bash
# View repo info
gh repo view

# Clone a repo
gh repo clone owner/repo

# Fork a repo
gh repo fork owner/repo

# List repos for a user/org
gh repo list <owner> --limit 20

# Browse repo in browser
gh browse
```

## CI / Actions

```bash
# List recent workflow runs
gh run list --limit 10

# View a specific run
gh run view <run-id>

# View run logs
gh run view <run-id> --log

# Watch a running workflow
gh run watch <run-id>

# Re-run a failed workflow
gh run rerun <run-id>

# List workflows
gh workflow list
```

## Releases

```bash
# List releases
gh release list

# Create a release
gh release create <tag> --title "Title" --notes "Release notes"

# Create release from generated notes
gh release create <tag> --generate-notes

# Upload assets to a release
gh release upload <tag> ./path/to/file.wasm
```

## Code Search & Browse

```bash
# Search code in current repo
gh search code "pattern" --repo owner/repo

# Search across GitHub
gh search repos "query" --language rust

# Search issues across GitHub
gh search issues "query" --language rust

# View file contents from a repo
gh api repos/owner/repo/contents/path/to/file | jq -r .content | base64 -d
```

## Notifications

```bash
# List notifications
gh api notifications | jq '.[].subject.title'
```

## Tips

- Most commands auto-detect the repo from the current git directory
- Add `--json field1,field2` to get structured JSON output
- Add `--jq '.[]'` to filter JSON output
- Use `--web` flag on most commands to open in browser instead
- Use `gh api <endpoint>` for any GitHub API call not covered by built-in commands
