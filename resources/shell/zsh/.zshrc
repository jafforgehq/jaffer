# macOS /etc/zshrc runs while ZDOTDIR still points at this shim, so it may have put HISTFILE here. History must stay the user's.
if [[ -z "$HISTFILE" || "$HISTFILE" == "$JAFFER_ZSH_DIR"/* ]]; then HISTFILE="$_jaffer_zdot/.zsh_history"; fi
[[ -f "$_jaffer_zdot/.zshrc" ]] && { ZDOTDIR="$_jaffer_zdot"; source "$_jaffer_zdot/.zshrc"; _jaffer_zdot="$ZDOTDIR"; }
# Hand ZDOTDIR back to the user so nested shells and tools see the real value.
if [[ -n "$JAFFER_USER_ZDOTDIR" ]]; then ZDOTDIR="$JAFFER_USER_ZDOTDIR"; else unset ZDOTDIR; fi
[[ -r "$JAFFER_SHELL_DIR/jaffer-integration.zsh" ]] && source "$JAFFER_SHELL_DIR/jaffer-integration.zsh"
