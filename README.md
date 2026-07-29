# dotfiles

My personal dotfiles — fish shell, vim, git, [Zed](https://zed.dev), and [Zellij](https://zellij.dev). macOS-only.

## Install

```sh
# 1. Install `just` (only prerequisite). Either via Homebrew, if already installed:
brew install just

# Or directly, on a truly fresh machine:
curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh \
  | bash -s -- --to /usr/local/bin

# 2. Clone and bootstrap.
git clone git@github.com:a5huynh/dotfiles.git ~/dotfiles && cd ~/dotfiles
just bootstrap           # installs Homebrew (if missing) + everything in Brewfile
just install             # symlinks all configs into $HOME
just bootstrap-plugins   # installs fish + vim plugins
```

`just --list` shows every recipe. Per-tool installs (`install-fish`, `install-zed`, etc.) are available if you want to set up one thing at a time.

## What's tracked

| | |
|---|---|
| **fish** | `config.fish`, plugin manifest, custom functions, prompt theme |
| **vim** | `.vimrc` + plugin list (managed via Vundle) |
| **git** | global gitconfig + global gitignore |
| **Zed** | `settings.json` + the `Zedokai` theme |
| **Zellij** | `config.kdl` + custom layouts |
| **pi** | global `AGENTS.md` + tracked agent skills (`herdr`, `socratic-tutor`, `github`) |
| **Claude Code** | notification hook + tracked skills (`pr`, `worktree`) |
| **Brewfile** | every brew/cask the configs assume exists |

Machine-local secrets (API keys, tokens) go in `~/.config/fish/secrets.fish` — gitignored, sourced from `config.fish` if present.
