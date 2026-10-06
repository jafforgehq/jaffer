# Jaffer shell integration for bash (generated). Compatible with bash 3.2.
[ -n "$_JAFFER_LOADED" ] && return
_JAFFER_LOADED=1
if [ -n "$JAFFER_BIN" ] && [ -d "$JAFFER_BIN" ]; then PATH="$JAFFER_BIN:$PATH"; fi

__jaffer_esc() {
  local s="$1"
  s="${s//\\/\\x5c}"
  s="${s//;/\\x3b}"
  s="${s//$'\n'/\\x0a}"
  s="${s//$'\e'/\\x1b}"
  s="${s//$'\a'/\\x07}"
  printf '%s' "$s"
}

# The DEBUG trap fires before *every* command, including startup lines and the user's own PROMPT_COMMAND
# hooks. __jaffer_in_prompt stays 1 from the start of the prompt phase until our last hook runs, so only
# commands the user actually typed are reported.
__jaffer_in_prompt=1
__jaffer_ran=0

__jaffer_precmd() {
  local ec=$?
  __jaffer_in_prompt=1
  if [ "$__jaffer_ran" = "1" ]; then
    printf '\e]133;D;%d\a' "$ec"
    __jaffer_ran=0
  else
    printf '\e]133;D\a'
  fi
  printf '\e]633;P;Cwd=%s\a' "$(__jaffer_esc "$PWD")"
  printf '\e]133;A\a'
  # keep our end-of-prompt hook last, even if other tools rewrote PROMPT_COMMAND since
  if [ "${PROMPT_COMMAND##*;}" != "__jaffer_prompt_end" ] && [ "${PROMPT_COMMAND}" != "__jaffer_prompt_end" ]; then
    PROMPT_COMMAND="${PROMPT_COMMAND//;__jaffer_prompt_end/};__jaffer_prompt_end"
  fi
  return $ec
}

__jaffer_prompt_end() {
  local ec=$?
  __jaffer_in_prompt=0
  return $ec
}

__jaffer_preexec() {
  [ "$__jaffer_in_prompt" = "1" ] && return
  [ "$__jaffer_ran" = "1" ] && return
  case "$BASH_COMMAND" in __jaffer_*) return;; esac
  __jaffer_ran=1
  local line
  line="$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)"
  line="$(printf '%s' "$line" | sed -e 's/^ *[0-9]* *//')"
  [ -z "$line" ] && line="$BASH_COMMAND"
  printf '\e]633;E;%s\a\e]133;C\a' "$(__jaffer_esc "$line")"
}
trap '__jaffer_preexec' DEBUG
if [ -n "$PROMPT_COMMAND" ]; then
  PROMPT_COMMAND="__jaffer_precmd;${PROMPT_COMMAND};__jaffer_prompt_end"
else
  PROMPT_COMMAND="__jaffer_precmd;__jaffer_prompt_end"
fi
