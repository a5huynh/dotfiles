# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Install

Fresh machine, in order:

```sh
# Install `just` first — either via Homebrew (needs brew already) or directly:
curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh \
  | bash -s -- --to /usr/local/bin

just bootstrap                 # install Homebrew if missing, then brew bundle
just install                   # symlink dotfiles into $HOME
just bootstrap-plugins         # install fish/vim plugins
```

Or do one tool at a time: `install-{fish,vim,git,zed,zellij,claude,pi,herdr}` for symlinks, `bootstrap-{fish,vim}-plugins` for plugin managers, `bootstrap-herdr-integrations` for herdr agent hooks.

The plugin step **must** run after `install` — fisher reads `~/.config/fish/fish_plugins` and vim reads `~/.vimrc`, both from `$HOME` (via the symlinks `install` just created). `bootstrap-vim-plugins` also clones Vundle itself if missing.

All `install-*` recipes are idempotent — they **skip if the target path already exists**. `bootstrap` is also re-runnable. `bootstrap-plugins` is safe to re-run but does network I/O each time. Recipes call the internal `_link` helper (just `ln -s` with a skip-if-exists guard); edits to individual files go live immediately because the dotfiles are symlinked, not copied.

`install-zed` and `install-zellij` symlink individual files (`settings.json` + `themes/` for Zed; `config.kdl` + `layouts/` for Zellij) rather than the whole `~/.config/{zed,zellij}/` directory — both apps write runtime state (Zed: `conversations/`, `prompts/`; Zellij: `plugins/` with downloaded WASM binaries) into those directories and we don't want it leaking into the repo. `install-claude` follows the same pattern for `.claude/hooks/zellij-tab-notify.sh` — `~/.claude/` is full of runtime state and other unversioned hooks. `install-pi` symlinks `.pi/agent/AGENTS.md` (global agent instructions) and every skill directory under `.pi/agent/skills/` (currently `herdr` and `socratic-tutor`) into `~/.pi/agent/`, which otherwise holds runtime state (`auth.json`, `sessions/`, `extensions/`, other unmanaged `skills/`, `themes/`). The recipe loops over `.pi/agent/skills/*/`, so tracking a new pi skill is just dropping a `<name>/SKILL.md` dir into the repo — no justfile edit needed (the `_link` skip-if-exists guard keeps it idempotent). `install-herdr` symlinks only `.config/herdr/config.toml` — `~/.config/herdr/` also accumulates runtime logs (`herdr.log`, `herdr-client.log`, `herdr-server.log`).

The herdr↔agent state integrations (pi/claude/codex lifecycle hooks that report `idle`/`working`/`blocked` and enable native session restore) are generated *outside* this repo by herdr, so they're not symlinked. Run `just bootstrap-herdr-integrations` to (re)install them via `herdr integration install` — safe to re-run, and it re-syncs versions after a herdr upgrade (`herdr integration status` shows current/outdated). herdr and pi are not in the Brewfile yet, so a fresh machine needs them installed first.

The vendored herdr control-skill (`.pi/agent/skills/herdr/SKILL.md`) teaches pi to *drive* herdr from inside a pane — spawn sibling panes with `--no-focus`, run commands/agents, `herdr wait agent-status`, read output. It's gated on `HERDR_ENV=1` (a no-op outside herdr) and defers to `herdr --help` for live CLI syntax, so it tolerates herdr upgrades. It's a copy of upstream; refresh with `curl -fsSL https://raw.githubusercontent.com/ogulcancelik/herdr/master/SKILL.md -o .pi/agent/skills/herdr/SKILL.md`.

`.claude/hooks/zellij-tab-notify.sh` puts a 🔔 on the zellij tab containing a Claude Code session that's waiting for input, and clears it when you respond. The script alone does nothing — it must be wired to hook events (`track` on SessionStart/UserPromptSubmit, `notify` on Stop/Notification/PermissionRequest, `clear` on PostToolUse/SessionEnd) in `~/.claude/settings.json`, which is not versioned here. It targets tabs via `rename-tab-by-id` (needs zellij ≥ 0.43) because plain `rename-tab` acts on the user's *focused* tab, which is the wrong tab exactly when the notification matters.

The Firefox `extensions/treestyletab/style.css` is not symlinked — it must be pasted into the Tree Style Tab options page manually.

## Architecture

**Fish is the primary surface.** The bulk of the customization lives under `.config/fish/`:

- `config.fish` — entrypoint. Defines `SCHEME_*` color variables (Monokai-derived), bootstraps `pyenv` / `rbenv` / `fzf` / `fisher`, sets `fish_color_*` globals, and prepends path entries to `fish_user_paths`. Fish 4.3+ no longer persists `fish_color_*` in universal scope, so they're set as globals here on every shell start.
- `fish_plugins` — fisher plugin manifest. Run `fisher update` after editing.
- `functions/fish_prompt.fish` — custom two-line prompt that consumes the `SCHEME_*` variables from `config.fish` via the `__print_color` helper.
- `functions/_env_hints.fish` — invoked from the prompt; surfaces active env context.
- `functions/git_*.fish` come from the `arbourd/fish-git-util` plugin (not custom).

**Plugin managers in play** — each owns its own install path:

| Tool | Manager | Manifest | Install path |
|---|---|---|---|
| fish | fisher | `.config/fish/fish_plugins` | `~/.config/fish/functions/` (mixed with custom functions) |
| vim | Vundle | `Plugin` lines in `.vimrc` | `~/.vim/bundle/` (gitignored) |

When adding a fish function, drop it in `.config/fish/functions/<name>.fish` — fish autoloads by filename. Functions prefixed `__` are internal helpers (e.g. `__print_color`, `__fzf_*`).

**Prompt color scheme** lives in two places that must stay in sync: `SCHEME_*` vars in `config.fish` (used by `fish_prompt.fish`) and the `fish_color_*` globals further down in the same file (used by fish's syntax highlighting).

**Secrets** go in `~/.config/fish/secrets.fish` — gitignored, sourced from `config.fish` if present. Use this for API keys, tokens, anything machine-specific. The file is optional; if it doesn't exist the source line is a no-op. Never commit secrets to `config.fish` directly.
