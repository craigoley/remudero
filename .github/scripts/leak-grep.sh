#!/usr/bin/env bash
# leak-grep — CI tripwire for plaintext secrets committed to the tree
# (MASTER-PLAN §5 TIER 1). Push protection is the hard backstop; this is
# the cheap grep-based check that runs on EVERY PR, not just once at
# spike time. Deliberately a plain grep over a short list of high-signal
# regexes rather than a third-party secret-scanning action — smaller
# supply-chain surface for a check this simple to write and audit.
#
# Scans TRACKED files only (git grep reads from the index, so .gitignore'd
# / untracked paths are already out of scope) at the current commit.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Each pattern targets a real secret FORMAT (fixed prefix / structure), not
# a generic "looks like a password" heuristic — keeps false positives low
# enough that a hit is worth stopping the PR for.
PATTERNS=(
  'AKIA[0-9A-Z]{16}'                                   # AWS access key ID
  '-----BEGIN[[:space:]](RSA|EC|OPENSSH|DSA|PGP)?[[:space:]]?PRIVATE KEY-----' # private key material
  'gh[pousr]_[A-Za-z0-9]{36,255}'                       # GitHub tokens (PAT/OAuth/app/refresh)
  'xox[baprs]-[0-9A-Za-z-]{10,}'                        # Slack tokens
  'AIza[0-9A-Za-z_-]{35}'                               # Google API key
  'sk_live_[0-9A-Za-z]{24,}'                            # Stripe live secret key
  'npm_[A-Za-z0-9]{36}'                                 # npm access token
)

hits=0
for pattern in "${PATTERNS[@]}"; do
  if matches=$(git grep -InE "$pattern" -- . ':!.github/scripts/leak-grep.sh' 2>/dev/null); then
    echo "leak-grep: possible secret matching /${pattern}/:"
    echo "$matches"
    echo
    hits=1
  fi
done

if [ "$hits" -ne 0 ]; then
  echo "leak-grep: FAILED — plaintext secret pattern(s) found above." >&2
  echo "If a match is a genuine false positive, reword it so the pattern no" >&2
  echo "longer matches (a static allowlist would defeat the tripwire)." >&2
  exit 1
fi

echo "leak-grep: clean — no plaintext secret patterns found."
