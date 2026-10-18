# Jaffer zsh bootstrap (generated). Sources your own startup files, then loads integration.
# (1.4.2) The nonce that signs the PATH mark leaves the environment before your startup files run; the copy is never exported.
typeset -g +x _jaffer_nonce="$JAFFER_NONCE"
unset JAFFER_NONCE
typeset -g _jaffer_zdot="${JAFFER_USER_ZDOTDIR:-$HOME}"
if [[ -f "$_jaffer_zdot/.zshenv" ]]; then
  ZDOTDIR="$_jaffer_zdot"
  source "$_jaffer_zdot/.zshenv"
  _jaffer_zdot="$ZDOTDIR"
fi
ZDOTDIR="$JAFFER_ZSH_DIR"
