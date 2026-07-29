---
name: worktree
description: Create a git worktree off the default branch for isolated feature work in the current session
user-invocable: true
allowed-tools: EnterWorktree, Bash(git *)
---

Create a git worktree branched from the default branch (main or master) for the current session.

## Arguments

`/worktree <branch-name> [--from <base-branch>]`

- `branch-name` (required): Ask the user if not provided.
- `--from <base-branch>` (optional): Explicit base branch. If omitted, auto-detect.

## Steps

1. Ask the user for a branch name if not provided as an argument (e.g., `/worktree feature/my-thing`).

2. Detect the base branch to branch from:
   - If `--from` was specified, use that.
   - Otherwise, detect the default branch:
     ```bash
     git remote show origin | sed -n 's/.*HEAD branch: //p'
     ```
   - Fall back to whichever of `main` or `master` exists locally.

3. Fetch the latest base branch:
   ```bash
   git fetch origin <base-branch>
   ```

4. Use the `EnterWorktree` tool with the branch name to create and enter the worktree.

5. Reset the worktree branch to the latest base branch:
   ```bash
   git reset --hard origin/<base-branch>
   ```

6. Confirm the worktree is ready:
   - Print the worktree path
   - Print the branch name
   - Print the base branch used
   - Print the current HEAD commit (short hash + subject)
