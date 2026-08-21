---
name: worktrunk
description: Manage git worktrees with worktrunk (the `wt` CLI) — create/switch/list/merge/remove worktrees, review another branch without leaving the current one, and launch parallel agents each in their own worktree. Use when the user asks to start work on a branch in a separate directory, wants isolated worktrees for parallel tasks, asks to clean up or merge a worktree, or mentions worktrunk / `wt`. Prefer this over raw `git worktree` whenever `wt` is on PATH.
---

# Worktrunk

`wt` makes worktrees as easy as branches: worktrees are addressed by **branch name**, and paths are
computed from a template (default `../<repo>.<branch>`). Docs: <https://worktrunk.dev>.

```bash
command -v wt || echo "not installed"        # always check first
```

If `wt` is missing, say so and offer `brew install worktrunk && wt config shell install` — do not
silently fall back to `git worktree` under a worktrunk-shaped plan, and never invent flags.
worktrunk moves fast; when unsure of a flag run `wt <command> --help` instead of recalling it.

## The one thing that will bite you: `wt switch` cannot move *you*

Directory switching is done by a **shell function** that reads a path worktrunk writes to
`$WORKTRUNK_DIRECTIVE_CD_FILE` and `cd`s the *interactive* shell. A tool call is a fresh
non-interactive process, so that wrapper isn't loaded — and even if it were, the `cd` would die with
the subprocess. Without it, `wt switch` just prints the target directory.

So never treat `wt switch` as navigation. Create or resolve, capture the path, then carry it:

```bash
path=$(wt switch --create feature-auth --no-cd --format=json -y | jq -r .path)
cd "$path" && <do work>                      # same invocation, or persist $path yourself
```

`--format=json` emits `{action, branch, path, created_branch, base_branch, from_remote}`, where
`action` is `created`, `existing`, or `already_at`. `--no-cd` suppresses only the cd attempt — hooks
still run.

JSON goes to **stdout, progress to stderr**, so never redirect `2>&1` into a parser — the status line
(`○ Switched to worktree for …`) lands mid-stream and `jq` dies on it. Use `2>/dev/null`, or keep
stderr on the terminal as above. This applies to every `--format=json` command.

Afterwards, reach the worktree explicitly. Every `wt` command takes a global `-C <path>`:

```bash
wt list -C "$path"
wt step diff -C "$path"
git -C "$path" status --short
```

## Never run anything interactive

| Don't | Because | Do instead |
| --- | --- | --- |
| `wt switch` (no branch) | opens the fuzzy picker and hangs | always pass a branch |
| `wt switch --branches` / `--remotes` / `--prs` | picker-only flags | `wt list --branches --format=json` |
| any `wt` command that runs project hooks, unattended | first run prompts for approval | `-y`, or pre-approve (below) |

Project hooks and aliases from `.config/wt.toml` need approval on first run. Check before committing
to an unattended run — this reads state without prompting or writing:

```bash
wt config approvals list --format=json | jq -r .state   # no_commands | approval_required | approved
```

`-y` grants consent for a single run and records nothing; `wt config approvals add --yes` persists it
(the right choice for a freshly cloned repo). A first run with no shell integration also offers to
install it — another prompt `-y` avoids.

## Core commands

```bash
wt switch -c <branch>            # create branch + worktree (--base <b>, default: default branch)
wt switch <branch>               # existing branch → creates the worktree if absent
wt list                          # every worktree with status
wt merge [target]                # squash + rebase + fast-forward target + remove worktree
wt remove [branch…]              # remove worktree, delete branch if integrated
wt step commit                   # stage + commit with an LLM-generated message
wt step diff [--branch <b>]      # everything since the merge-base, untracked included
```

Shortcuts work anywhere a branch is accepted, `--base` included: `^` default branch, `@` current,
`-` previous, `pr:123` / `mr:123` a GitHub PR / GitLab MR branch (a PR URL works too). Stack a
branch on the current HEAD with `--base=@`. Any argument that takes a branch also accepts a worktree
path, which is the only way to name a detached worktree.

## Reading state as JSON

`wt list --format=json` still defaults to the legacy **schema 1** bare array and warns about it
unless the user's config sets `[list] json-schema = 2`. Pin it per call rather than parsing whatever
turns up:

```bash
wt list --format=json --config-set list.json-schema=2 | jq '.items[] | {branch, path: .worktree.path}'
```

Schema 2 is an envelope: `{schema, repo, collected, items[]}`. Per item, `branch`, `head`,
`worktree{path,current,changes{…,diff}}`, `default_branch{ahead,behind,integration}`,
`upstream{ahead,behind}`, `display{state,symbols}`. A field is **absent** when there's nothing to
report and **null** when it was requested but undetermined (timeout, failed fetch — the table's `·`).
`--full` additionally collects `pr` and `checks` over the network; skip it unless CI status is the
question. Useful reads:

```bash
… | jq -r '.items[] | select(.worktree.current) | .worktree.path'                   # where am I
… | jq -r '.items[] | select(.display.state=="integrated") | .branch'               # safe to remove
… | jq -r '.items[] | select(.worktree.changes.modified) | .branch'                 # dirty
```

## Review another worktree without leaving this one

This is usually what's wanted when several branches are in flight — no switching required:

```bash
wt step diff --branch feature-auth        # full diff since branching (branch must have a worktree)
wt step diff --branch feature-auth -- --stat
wt step for-each -- git status --short    # every worktree, sequentially [experimental]
```

## Finishing work

Two shapes; pick based on whether the repo uses PRs.

**PR workflow** — leaves history to the forge:

```bash
wt step commit && git push -u origin HEAD && gh pr create
wt remove <branch>                        # after the PR merges
```

**Local merge** — `wt merge` is a whole pipeline, not a `git merge`: it commits uncommitted work,
**squashes** the branch, **rebases** onto the target, runs `pre-merge` hooks, fast-forwards the
target, then **deletes the worktree and branch**. It rewrites history and targets the *local*
default-branch ref (it never fetches). Confirm with the user before running it, and prefer naming
the target explicitly (`wt merge main`). `--no-remove` keeps the worktree, `--no-squash` keeps the
commits, `--no-ff` makes a merge commit. Work swept into a squash is backed up to
`refs/wt-backup/<branch>`. A rebase conflict stops the merge with the rebase left open in the
worktree — resolve or `git rebase --abort` there, don't retry blindly.

`wt merge` and `wt step commit` generate messages via a configured LLM command
(`[commit.generation]`); with none configured worktrunk offers to set one up (a prompt).

## Removing

`wt remove` deletes the branch only when it would add nothing to the default branch (same commit,
ancestor, empty three-dot diff, matching trees, or a detected squash merge), so the common case is
safe. The escalations are not — **ask before either**:

- `-f` / `--force` — discards uncommitted changes in the worktree
- `-D` / `--force-delete` — deletes an unmerged branch

Removal is **backgrounded** by default (the worktree is renamed into `.git/wt/trash/` and reaped
later), so the command returns before the directory is gone. Pass `--foreground` when a later step
depends on it being finished. `--reap` also kills detached processes whose cwd is under the worktree
(dev servers, watchers) — interactive processes are spared.

## Parallel agents

The headline use case: one worktree per task, one agent per worktree. `-x` replaces the `wt` process
with a command after switching, and arguments after `--` are passed to it:

```bash
wt switch -c fix-auth -x claude -- 'Session expires after 5 min; extend the timeout to 24 hours.'
```

That command takes over the terminal, so **never** run it directly from a tool call — it would hold
the call open forever. Give it a pane of its own. In this environment that means zellij (directly, or
via herdr — see the `herdr` skill):

```bash
zellij run -- wt switch -c fix-auth -x claude -- 'Fix the pagination bug'
tmux new-session -d -s fix-auth 'wt switch -c fix-auth -x claude -- "Fix the pagination bug"'
```

Then poll from here — `wt list` shows 🤖 (working) / 💬 (waiting) per branch when the agent's
worktrunk plugin is installed, and any CLI can drive the same markers with
`wt config state marker set|clear`.

Two rules once agents are running: **don't edit files in another agent's worktree** (isolation is the
entire point), and don't `wt remove`/`wt merge` a branch someone else is mid-task on.

## Configuration, briefly

| Path | Holds |
| --- | --- |
| `~/.config/worktrunk/config.toml` | user prefs: `worktree-path` template, `[commit]`, `[list]` |
| `.config/wt.toml` | project hooks + aliases, committed to the repo |
| `.git/wt/{logs,cache,trash}/` | background hook output, caches, pending removals |

Hooks fire on switch / create / commit / merge / remove; `pre-*` blocks and a failure aborts,
`post-*` runs in the background with output in `.git/wt/logs/<branch>/`. `post-start` is the usual
place for per-worktree setup (install deps, start a dev server, `wt step copy-ignored` to clone
`target/` or `node_modules/` and skip a cold build). Any config key can be overridden for one call
with `--config-set 'key=value'` or the `WORKTRUNK_*` env vars — useful for probing without editing
the user's config.
