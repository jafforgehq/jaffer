# Jaffer bash bootstrap (generated). Mimics normal startup, then loads integration.
# (1.4.2) The nonce that signs the PATH mark leaves the environment before your startup files run; the copy is never exported.
__jaffer_nonce="${JAFFER_NONCE-}"
export -n __jaffer_nonce 2>/dev/null
unset JAFFER_NONCE
if [[ "$JAFFER_LOGIN" == "1" ]]; then
  [ -r /etc/profile ] && . /etc/profile
  if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
  elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
  elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
  fi
else
  [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
fi
[ -r "$JAFFER_SHELL_DIR/jaffer-integration.bash" ] && . "$JAFFER_SHELL_DIR/jaffer-integration.bash"
