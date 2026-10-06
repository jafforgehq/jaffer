# Jaffer shell integration for fish (generated, experimental).
if set -q _JAFFER_LOADED
    exit 0
end
set -g _JAFFER_LOADED 1
if set -q JAFFER_BIN; and test -d "$JAFFER_BIN"
    fish_add_path -g "$JAFFER_BIN"
end

function __jaffer_esc
    string replace -a '\\' '\\x5c' -- $argv[1] | string replace -a ';' '\\x3b' | string replace -a \n '\\x0a'
end

function __jaffer_preexec --on-event fish_preexec
    printf '\e]633;E;%s\a\e]133;C\a' (__jaffer_esc "$argv[1]")
end

function __jaffer_postexec --on-event fish_postexec
    printf '\e]133;D;%d\a' $status
end

function __jaffer_prompt --on-event fish_prompt
    printf '\e]633;P;Cwd=%s\a' (__jaffer_esc "$PWD")
    printf '\e]133;A\a'
end
