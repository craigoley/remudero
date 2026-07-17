#!/usr/bin/env bash
# ts-strict-probe — MASTER-PLAN §5 TIER 2: "TypeScript strict — VERIFIED
# ACTIVE, not assumed. A planted probe ... must FAIL the gate: '0 violations'
# from a fresh strict gate is suspicious until falsified" (W1-T25).
#
# Plants fixtures/ts-strict-probe/violation.ts (a strictNullChecks-only
# violation — TS18047 on this repo's pinned TypeScript 7, "possibly 'null'")
# INTO src/lib/, then runs
# the EXACT command ci.yml's `ci` job uses to typecheck (`tsc -p tsconfig.json
# --noEmit`) — not a reconstructed one-off invocation — so this proves the
# real, configured gate catches it, not just that `tsc --strict` in the
# abstract would. Cleans up unconditionally (trap), so a probe failure never
# leaves a broken file in the tree.
#
# Exit code contract:
#   0  strict mode is VERIFIED ACTIVE (tsc failed on the probe, citing the
#      expected strict-only error code)
#   1  the gate is INERT (tsc succeeded despite the planted violation) or
#      something else went wrong — either way, CI-red.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# NOTE: this repo pins TypeScript 7 (package.json), whose diagnostics engine
# renumbers some codes vs classic TS ≤5 — verified empirically that THIS
# violation reports TS18047 here, not the TS2531 a TS ≤5 project would show
# for the same strictNullChecks failure. Distrust any code you haven't seen
# this compiler actually emit.
FIXTURE="fixtures/ts-strict-probe/violation.ts"
PLANTED="src/lib/__ts_strict_probe__.ts"
EXPECTED_CODE="TS18047"

cleanup() {
  rm -f "${PLANTED}"
}
trap cleanup EXIT

if [ -f "${PLANTED}" ]; then
  echo "ts-strict-probe: ${PLANTED} already exists — refusing to clobber an unrelated file." >&2
  exit 1
fi

cp "${FIXTURE}" "${PLANTED}"

set +e
output="$(npx tsc -p tsconfig.json --noEmit 2>&1)"
status=$?
set -e

if [ "${status}" -eq 0 ]; then
  echo "ts-strict-probe: FAILED — tsc succeeded despite the planted strict-mode" >&2
  echo "violation in ${PLANTED}. TypeScript strict mode is NOT actually being" >&2
  echo "enforced by 'tsc -p tsconfig.json --noEmit' (the real build command)." >&2
  echo "'0 violations' from that command is therefore UNPROVEN, not clean." >&2
  exit 1
fi

if ! grep -q "${PLANTED}" <<< "${output}" || ! grep -q "${EXPECTED_CODE}" <<< "${output}"; then
  echo "ts-strict-probe: FAILED — tsc failed, but not with the expected" >&2
  echo "strict-mode violation (${EXPECTED_CODE} in ${PLANTED}). Some OTHER error" >&2
  echo "is masking the probe, so this run does not actually prove strict mode" >&2
  echo "caught it. tsc output:" >&2
  echo "${output}" >&2
  exit 1
fi

echo "ts-strict-probe: PASSED — tsc correctly rejected the planted strictNullChecks"
echo "violation (${EXPECTED_CODE}) via the real build command. Strict mode is"
echo "VERIFIED ACTIVE, not assumed."
