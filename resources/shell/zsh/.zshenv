# Jaffer zsh bootstrap (generated). Sources your own startup files, then loads integration.
typeset -g _jaffer_zdot="${JAFFER_USER_ZDOTDIR:-$HOME}"
if [[ -f "$_jaffer_zdot/.zshenv" ]]; then
  ZDOTDIR="$_jaffer_zdot"
  source "$_jaffer_zdot/.zshenv"
  _jaffer_zdot="$ZDOTDIR"
fi
ZDOTDIR="$JAFFER_ZSH_DIR"
