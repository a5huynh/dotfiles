---
name: review-pr
description: Use when asked to review a specific pull request or branch that is not the current working tree — "review PR 983", "look at this PR", a GitHub PR URL, or "review branch X". Not for reviewing uncommitted work in the current directory (use the pre-landing review for that).
user-invocable: true
argument-hint: <PR number | PR URL | branch name>
---

# Review a PR in an isolated worktree

Review the PR's actual changeset, never the session CWD. A review run against a stale checkout produces a confident report on the wrong code.

## Steps

1. **Fetch metadata first**: `gh pr view <n> --json number,title,body,author,headRefName,baseRefName,state,additions,deletions,changedFiles`. For a bare branch name, skip to step 2 and diff against the default branch.

2. **Isolate**: create a worktree — `path=$(wt switch pr:<n> --no-cd --format=json -y 2>/dev/null | jq -r .path)` (fallback: `git fetch origin <branch> && git worktree add ../<repo>.<branch> <branch>`). Never `wt switch` bare (opens an interactive picker) and never rely on it to cd you. Run the `wt` call in its own shell invocation — chaining more commands after it in one fish eval has broken PATH for the rest of the line. All later commands run with `git -C "$path"` / `cd "$path"`.

3. **Read the ENTIRE diff**: `git -C "$path" diff <base>...HEAD --stat`, then the full diff file by file. Compare the file list against the PR body — changes the body doesn't mention (especially to money-moving, auth, or migration code) are where reviews earn their keep.

4. **Check prior context**: search memory/notes and `gh pr view --json comments` for earlier reviews of related PRs; a follow-up PR can silently change behavior the earlier review signed off on.

5. **Verify claims, don't trust names**: for each load-bearing claim in the PR body or comments, read the code it depends on (constants it maps to, sync vs async of touched routes, whether a guard actually executes). "Consistent with" is not "verified" until probed.

6. **Run the checks CI runs** — derive them from `.github/workflows/`, not just CLAUDE.md (which can lag; e.g. apitwo dashboard CI also gates on `prettier --check`). Typical apitwo run:
   - backend: `uv run pytest <touched test files> -q`, then the full suite, `ruff check .`, `ruff format --check .`
   - dashboard (if touched): `npm ci` in the worktree — a fresh worktree has no `node_modules` and symlinking one breaks Next; then `typecheck`, `lint`, `npx prettier --check .`
   - Distinguish pre-existing warnings from new ones (check whether the file is in the diff).

7. **Check CI + preview**: `gh pr checks <n>`.

8. **Report, don't act**: deliver findings with `file:line` references, severity-ordered, verdict last (approve / approve-with-notes / request changes). Do NOT push fixes, comment on GitHub, or merge — each needs an explicit ask. Keep the worktree; tell the user its path. Remove it only after the PR's fate is decided.

## Red flags — stop and restart the review

- You are reading files under the original session directory instead of `$path`
- You summarized the PR body instead of the diff
- A test/lint failure was explained away without checking whether master has it too
- You're about to "quickly fix" a finding mid-review
