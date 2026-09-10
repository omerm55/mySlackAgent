#!/usr/bin/env bash
# Fail if anything that looks like a live credential is committed.
#
# Patterns are the token shapes this project actually handles (Slack, Atlassian, Supabase, OpenAI)
# plus generic private keys. `.env.example` is allowed — it holds empty placeholders. Run locally with:
#   bash scripts/scan-secrets.sh
set -uo pipefail

# Slack bot / user / app tokens; Atlassian API tokens; Supabase secret/publishable keys; OpenAI keys;
# private key blocks; a base64 32-byte value assigned to our encryption key variable.
PATTERNS=(
  'xox[baprs]-[0-9A-Za-z-]{10,}'
  'ATATT3[0-9A-Za-z_=-]{20,}'
  'sb_secret_[0-9A-Za-z_-]{20,}'
  'sb_publishable_[0-9A-Za-z_-]{20,}'
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  'sk-[A-Za-z0-9_-]{20,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'TOKEN_ENCRYPTION_KEY[[:space:]]*=[[:space:]]*[A-Za-z0-9+/]{40,}={0,2}'
)

# Everything tracked by git, minus this script (it contains the patterns) and the example env file.
mapfile -t FILES < <(git ls-files | grep -v -E '^(scripts/scan-secrets\.sh|\.env\.example)$')

status=0
for pattern in "${PATTERNS[@]}"; do
  if hits=$(grep -InE "$pattern" "${FILES[@]}" 2>/dev/null); then
    echo "Possible credential matching /$pattern/:"
    # Show file and line number only — never echo the value into CI logs.
    echo "$hits" | cut -d: -f1,2 | sed 's/^/  /'
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo
  echo "Remove the value, rotate the credential, and keep secrets in the runtime environment."
  echo "See docs/PROJECT_SPEC.md §10 and §12.5."
else
  echo "No committed credentials found in $(git ls-files | wc -l) tracked files."
fi
exit "$status"
