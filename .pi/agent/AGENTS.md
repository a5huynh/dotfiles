# Global Instructions

## Working style
- Explain your reasoning as you go — narrate *why*, not just *what*.
- Before any large or multi-file change, show a short plan first and wait for a go-ahead.
- Always confirm before destructive or large-scale edits (deleting files, mass refactors, force-pushing, migrations, anything hard to undo).
- Prefer small, verifiable steps over big-bang changes.

## Languages & tooling
Primary languages: **Python, TypeScript/React, Rust**. Comfortable in others as needed.

Dependency management (use these by default):
- **Python** → `uv` (e.g. `uv add`, `uv run`, `uv sync`). Do not use bare `pip`.
- **TypeScript / JS** → `npm`.
- **Rust** → `cargo`.

## Dependencies
- **No new dependencies without asking first.** Propose the package, say why it's needed, and wait for approval before adding it.
- Prefer the standard library or existing project dependencies when possible.

## Environment
- Terminal + multiplexer: **Rex** (truecolor; it is both). You're in Rex when `REX_SESSION`/`REX_BLOCK` are set — drive it with the `rex` CLI via the `rex` skill. Older setup: Ghostty + herdr, when `HERDR_ENV=1`.
- No background bash — for long-running processes, open a separate pane so I can observe/interact: in Rex, `rex split`/`rex run` with `--focus=false` (never send input to your own pane); in herdr, a herdr pane.
- GitHub via the `gh` CLI.

## Git & PRs
- Branch naming: `a5huynh/<type>/<short-branch-name>` where `<type>` is `feature`, `bug`, etc. (e.g. `a5huynh/feature/dark-theme`, `a5huynh/bug/login-crash`).
- GitHub operations via the `gh` CLI.
- Confirm before pushing, force-pushing, or opening PRs.

## Conventions
- Match the existing style and patterns of the file/project I'm editing.
- Don't add comments unless they clarify non-obvious logic or I ask for them.
- Keep responses concise; skip filler and restating the obvious.
