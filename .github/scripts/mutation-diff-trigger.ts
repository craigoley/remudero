// Diff-path trigger for the mutation-ratchet CI gate (MASTER-PLAN §5 TIER 2, gate 2/4, W1-T108).
//
// Same shape as containment-diff-trigger.ts (W1-T28): the mutation-ratchet check run keeps
// registering UNCONDITIONALLY on every PR (ci-gate.yml's fail-closed contract — a
// path-filtered REQUIRED check that can go silently absent deadlocks merge forever, the
// synthwatch #102 class), but the EXPENSIVE part inside it (a real `npx stryker run`) only
// needs to happen when this diff can actually move the mutation score. stryker.conf.json's
// `mutate` glob is scoped to src/lib/classify.ts, so the score can only change if this diff
// touches that file, its test, or the gate's own machinery (config/script/baseline) — a diff
// that touches none of those is a guaranteed no-op for this gate, same as a containment-probe
// run on a diff that never touches sandbox/hooks/env/deny-floor.
//
// Usage: node --import tsx mutation-diff-trigger.ts <changed-files-file>
// (one path per line, e.g. `git diff --name-only <base>...HEAD`). Writes
// `matched=true|false` to $GITHUB_OUTPUT when set (CI), and always prints the verdict +
// reason to stdout (local/manual runs).

import { appendFileSync, readFileSync } from "node:fs";

// Kept in sync BY HAND with stryker.conf.json's `mutate` glob plus the ratchet's own inputs —
// this is the exhaustive list of paths that can move this PR's mutation score. Widening
// `mutate` later means widening this list too (the "one-line glob change" ci.yml's
// mutation-ratchet comment already calls out).
const MUTATION_RELEVANT_PATHS = new Set([
  "src/lib/classify.ts",
  "test/classify.test.ts",
  "stryker.conf.json",
  "scripts/mutation-ratchet.mjs",
  "scripts/mutation-baseline.json",
]);

const listPath = process.argv[2];
if (!listPath) {
  console.error("usage: mutation-diff-trigger.ts <changed-files-file>");
  process.exit(1);
}

const files = readFileSync(listPath, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

const matchedPath = files.find((path) => MUTATION_RELEVANT_PATHS.has(path));
const matched = matchedPath !== undefined;

if (matched) {
  console.log(`mutation-ratchet: REQUIRED — diff touches ${matchedPath}`);
} else {
  console.log(
    "mutation-ratchet: skipping the Stryker run for this diff — no changed path can move src/lib/classify.ts's mutation score.",
  );
}

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `matched=${matched}\n`);
}
