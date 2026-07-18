// Diff-path trigger for the containment-probe CI gate (MASTER-PLAN §5 TIER 1,
// W1-T28: "Containment probe as a REQUIRED check ... on any diff touching
// sandbox / deny-floor / env").
//
// Reuses `containmentTrigger()` from src/lib/specialist-panel.ts — the SAME
// deterministic predicate the Layer-4 containment specialist is routed by —
// so the CI gate and the advisory panel can never drift on what counts as
// "touches sandbox/hooks/env/deny-floor" (two independent definitions of the
// same boundary is exactly the drift FIELD FINDING 10a warns about: a typo in
// a path pattern must never silently drop containment coverage).
//
// Usage: node --import tsx containment-diff-trigger.ts <changed-files-file>
// (one path per line, e.g. `git diff --name-only <base>...HEAD`). Writes
// `matched=true|false` to $GITHUB_OUTPUT when set (CI), and always prints the
// verdict + reason to stdout (local/manual runs).

import { appendFileSync, readFileSync } from "node:fs";
import { containmentTrigger } from "../../src/lib/specialist-panel.js";

const listPath = process.argv[2];
if (!listPath) {
  console.error("usage: containment-diff-trigger.ts <changed-files-file>");
  process.exit(1);
}

const files = readFileSync(listPath, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((path) => ({ path }));

const trigger = containmentTrigger({ files });
const matched = trigger !== null;

if (matched && trigger) {
  console.log(`containment-probe: REQUIRED — ${trigger.reason}`);
} else {
  console.log(
    "containment-probe: not required for this diff — no changed path touches sandbox/hooks/env/deny-floor.",
  );
}

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `matched=${matched}\n`);
}
