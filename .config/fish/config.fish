# Theme based on Monokai
set SCHEME_PRIMARY ff6188       # Red-ish
set SCHEME_SECONDARY fc9867     # Orange-ish
set SCHEME_WARNING ffd866       # Yellow-ish
set SCHEME_SUCCESS a9dc76       # Green-ish
set SCHEME_INFO 78dce8          # Blue-ish
set SCHEME_PURP ab9df2          # Purple-ish
# Assumes a very dark background color.
set SCHEME_GREY 666666          # Darkish grey

# Setup pyenv paths
set -g PYENV_ROOT "$HOME/.pyenv"

set fish_color_search_match $SCHEME_GREY
set fish_greeting ""

if not contains "$HOME/.pyenv/bin" $fish_user_paths
    set -U fish_user_paths "$HOME/.pyenv/bin" $fish_user_paths;
end

# Setup pyenv & pyenv-virtualenv
status --is-interactive; and source (pyenv init -|psub)
status --is-interactive; and source (pyenv virtualenv-init -|psub)

# Setup /usr/local/bin before /usr/bin.
if not contains "/usr/local/bin" $fish_user_paths
    set -U fish_user_paths "/usr/local/bin" $fish_user_paths;
end

# Setup /usr/local/sbin
if not contains "/usr/local/sbin" $fish_user_paths
    set -U fish_user_paths "/usr/local/sbin" $fish_user_paths;
end

# Fix for `gettext` source ~/.config/fish/config.fish found for pyenv.
if not contains "/usr/local/opt/gettext/bin" $fish_user_paths
    set -U fish_user_paths "/usr/local/opt/gettext/bin" $fish_user_paths;
end

# Add path for elastic beanstalk CLI
if not contains "$HOME/.ebcli-virtual-env/executables" $fish_user_paths
    set -U fish_user_paths "$HOME/.ebcli-virtual-env/executables" $fish_user_paths;
end

if not contains "$HOME/.poetry/bin" $fish_user_paths
    set -U fish_user_paths "$HOME/.poetry/bin" $fish_user_paths
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
# Colors:
set fish_color_normal F8F8F2 # the default color
set fish_color_command F92672 # the color for commands
set fish_color_quote E6DB74 # the color for quoted blocks of text
set fish_color_redirection AE81FF # the color for IO redirections
set fish_color_end F8F8F2 # the color for process separators like ';' and '&'
set fish_color_error F8F8F2 --background=F92672 # the color used to highlight potential errors
set fish_color_param A6E22E # the color for regular command parameters
set fish_color_comment 75715E # the color used for code comments
set fish_color_match F8F8F2 # the color used to highlight matching parenthesis
set fish_color_search_match --background=49483E # the color used to highlight history search matches
set fish_color_operator AE81FF # the color for parameter expansion operators like '*' and '~'
set fish_color_escape 66D9EF # the color used to highlight character escapes like '\n' and '\x70'
set fish_color_cwd 66D9EF # the color used for the current working directory in the default prompt

# Additionally, the following variables are available to change the highlighting in the completion pager:
set fish_pager_color_prefix F8F8F2 # the color of the prefix string, i.e. the string that is to be completed
set fish_pager_color_completion 75715E # the color of the completion itself
set fish_pager_color_description 49483E # the color of the completion description
set fish_pager_color_progress F8F8F2 # the color of the progress bar at the bottom left corner
set fish_pager_color_secondary F8F8F2 # the background color of the every second completion
# tabtab source for packages
# uninstall by removing these lines
[ -f ~/.config/tabtab/__tabtab.fish ]; and . ~/.config/tabtab/__tabtab.fish; or true
