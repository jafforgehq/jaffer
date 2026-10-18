# Jaffer shell integration for fish (generated, experimental).
if set -q _JAFFER_LOADED
    exit 0
end
set -g _JAFFER_LOADED 1
if set -q JAFFER_BIN; and test -d "$JAFFER_BIN"
    fish_add_path -g "$JAFFER_BIN"
end

# (1.4.2) The PATH (joined with colons), reported before a prompt only when it changed. The nonce moves into an unexported variable
# (fish runs this after config.fish, so what config.fish starts still inherits it).
set -g __jaffer_path ''
set -g -u __jaffer_nonce "$JAFFER_NONCE"
set -e JAFFER_NONCE

function __jaffer_esc
    string replace -a '\\' '\\x5c' -- $argv[1] | string replace -a ';' '\\x3b' | string replace -a \n '\\x0a' | string replace -a \e '\\x1b' | string replace -a \a '\\x07'
end

function __jaffer_preexec --on-event fish_preexec
    printf '\e]633;E;%s\a\e]133;C\a' (__jaffer_esc "$argv[1]")
end

function __jaffer_postexec --on-event fish_postexec
    printf '\e]133;D;%d\a' $status
end

function __jaffer_prompt --on-event fish_prompt
    if test "$PATH" != "$__jaffer_path"
        set -g __jaffer_path "$PATH"
        printf '\e]633;P;Path=%s;%s\a' (__jaffer_esc "$PATH") "$__jaffer_nonce"
    end
    printf '\e]633;P;Cwd=%s\a' (__jaffer_esc "$PWD")
    printf '\e]133;A\a'
end
