#!/bin/sh
# apiKeyHelper for Claude Code: prints the CLIProxyAPI client key.
# The key lives outside every config file and repo:
#   1. ~/.config/cliproxy/secrets.env  (chmod 600), line: CLIPROXY_API_KEY=...
#   2. otherwise the macOS Keychain item "cliproxy-api-key"
#      (security add-generic-password -a "$USER" -s cliproxy-api-key -w)
set -eu
secrets="${CLIPROXY_SECRETS:-$HOME/.config/cliproxy/secrets.env}"
if [ -r "$secrets" ]; then
  key=$(sed -n 's/^CLIPROXY_API_KEY=//p' "$secrets" | head -n 1 | tr -d '"'"'"' \r')
  [ -n "$key" ] && { printf '%s\n' "$key"; exit 0; }
fi
if command -v security >/dev/null 2>&1; then
  security find-generic-password -s cliproxy-api-key -w 2>/dev/null && exit 0
fi
echo "claude-key.sh: no CLIPROXY_API_KEY in $secrets or Keychain" >&2
exit 1
