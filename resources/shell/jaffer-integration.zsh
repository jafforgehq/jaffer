# Jaffer shell integration for zsh (generated).
[[ -n "$_JAFFER_LOADED" ]] && return
typeset -g _JAFFER_LOADED=1
[[ -n "$JAFFER_BIN" && -d "$JAFFER_BIN" ]] && path=("$JAFFER_BIN" ${path:#"$JAFFER_BIN"})

_jaffer_esc() {
  local s="${1//\\/\\x5c}"
  s="${s//;/\\x3b}"
  s="${s//$'\n'/\\x0a}"
  s="${s//$'\e'/\\x1b}"
  s="${s//$'\a'/\\x07}"
  print -rn -- "$s"
}

typeset -g _jaffer_ran=0
_jaffer_preexec() {
  _jaffer_ran=1
  printf '\e]633;E;%s\a\e]133;C\a' "$(_jaffer_esc "$1")"
}
_jaffer_precmd() {
  local ec=$?
  if (( _jaffer_ran )); then
    printf '\e]133;D;%d\a' "$ec"
    _jaffer_ran=0
  else
    printf '\e]133;D\a'
  fi
  printf '\e]633;P;Cwd=%s\a' "$(_jaffer_esc "$PWD")"
  printf '\e]133;A\a'
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec _jaffer_preexec
# Run last so we see the real exit status and other precmd hooks have finished drawing.
precmd_functions=(${precmd_functions:#_jaffer_precmd} _jaffer_precmd)
