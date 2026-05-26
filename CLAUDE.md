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

Or do one tool at a time: `install-{fish,vim,git,zed}` for symlinks, `bootstrap-{fish,vim}-plugins` for plugin managers.

The plugin step **must** run after `install` — fisher reads `~/.config/fish/fish_plugins` and vim reads `~/.vimrc`, both from `$HOME` (via the symlinks `install` just created). `bootstrap-vim-plugins` also clones Vundle itself if missing.

All `install-*` recipes are idempotent — they **skip if the target path already exists**. `bootstrap` is also re-runnable. `bootstrap-plugins` is safe to re-run but does network I/O each time. Recipes call the internal `_link` helper (just `ln -s` with a skip-if-exists guard); edits to individual files go live immediately because the dotfiles are symlinked, not copied.

`install-zed` symlinks `settings.json` and `themes/` individually rather than the whole `~/.config/zed/` directory — Zed writes runtime state (`conversations/`, `prompts/`) into that directory and we don't want it leaking into the repo.

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
