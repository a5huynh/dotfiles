# Theme based on Monokai
set SCHEME_PRIMARY ff6188       # Red-ish
set SCHEME_SECONDARY fc9867     # Orange-ish
set SCHEME_WARNING ffd866       # Yellow-ish
set SCHEME_SUCCESS a9dc76       # Green-ish
set SCHEME_INFO 78dce8          # Blue-ish
set SCHEME_PURP ab9df2          # Purple-ish
# Assumes a very dark background color.
set SCHEME_GREY 666666          # Darkish grey

set fish_color_search_match $SCHEME_GREY
set fish_greeting ""

# Setup pyenv & pyenv-virtualenv
status --is-interactive; and source (pyenv init -|psub)
status --is-interactive; and source (pyenv virtualenv-init -|psub)

# Setup /usr/local/bin before /usr/bin.
if not contains "/usr/local/bin" $fish_user_paths
    set -g fish_user_paths "/usr/local/bin" $fish_user_paths;
end

# Setup /usr/local/sbin
if not contains "/usr/local/sbin" $fish_user_paths
    set -g fish_user_paths "/usr/local/sbin" $fish_user_paths;
end

# Fix for `gettext` source ~/.config/fish/config.fish found for pyenv.
if not contains "/usr/local/opt/gettext/bin" $fish_user_paths
    set -g fish_user_paths "/usr/local/opt/gettext/bin" $fish_user_paths;
end

# The next line updates PATH for the Google Cloud SDK.
if [ -f "$HOME/google-cloud-sdk/path.fish.inc" ];
    if type source > /dev/null;
        source "$HOME/google-cloud-sdk/path.fish.inc";
    else;
        . "$HOME/google-cloud-sdk/path.fish.inc";
    end;
end

# Bootstrap fisherman
if not functions -q fisher
    set -q XDG_CONFIG_HOME; or set XDG_CONFIG_HOME ~/.config
    curl https://git.io/fisher --create-dirs -sLo $XDG_CONFIG_HOME/fish/functions/fisher.fish
    fish -c fisher
end