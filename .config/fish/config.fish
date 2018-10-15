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
set -g fish_user_paths "/usr/local/bin" $fish_user_paths;
# Fix for `gettext` not found for pyenv.
set -g fish_user_paths "/usr/local/opt/gettext/bin" $fish_user_paths;

# The next line updates PATH for the Google Cloud SDK.
if [ -f "$HOME/google-cloud-sdk/path.fish.inc" ];
    if type source > /dev/null;
        source "$HOME/google-cloud-sdk/path.fish.inc";
    else;
        . "$HOME/google-cloud-sdk/path.fish.inc";
    end;
end
