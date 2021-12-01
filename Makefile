.PHONY: _setup_homebrew _setup_fish install-mac

install-mac: _setup_homebrew _setup_fish


_setup_fish:
	# Setup fish shell
	@./scripts/setup_fish.sh;

_setup_homebrew:
	# Setup homebrew
	@./scripts/setup_homebrew.sh;

	# Install required utilities
	@brew bundle