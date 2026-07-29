---
name: pr
description: Push current branch and create a GitHub pull request
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash(git *), Bash(gh *)
---

Push the current branch to origin and create a pull request against master.

## Steps

1. Run these commands in parallel to understand the current state:
   - `git status` (never use `-uall` flag)
   - `git diff master...HEAD --stat` to see all changed files
   - `git log master..HEAD --oneline` to see all commits on this branch
   - `git diff master...HEAD` to see the full diff
   - Check if the branch tracks a remote and is up to date

2. Analyze ALL commits and changes (not just the latest) to draft the PR:
   - Keep the title short (under 70 characters), focusing on the "what"
   - Use the body for the "why" and details
   - Summarize changes as 1-3 bullet points

3. Push and create the PR:
   - Push to origin with `-u` flag if needed
   - Create the PR using `gh pr create` with this format:

```
gh pr create --title "the pr title" --body "$(cat <<'PREOF'
## Summary
<1-3 bullet points summarizing the changes>

## Test plan
<bulleted checklist of testing steps>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PREOF
)"
```

4. Return the PR URL when done.
