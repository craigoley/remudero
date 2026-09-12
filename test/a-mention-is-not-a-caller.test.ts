import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { runMeasurementCadenceReport } from "../src/lib/measurement-cadence.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}adoption-symbol-callers-`));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, "utf8");
  }
  return root;
}

function unadoptedSymbols(root: string): Set<string> {
  const result = runMeasurementCadenceReport({
    stateDir: join(root, "state"),
    cwd: root,
    checkoutDir: root,
    escalate: false,
    gitLog: () => ({ dump: "", ref: "fixture" }),
    shipDateFor: () => "2026-01-01T00:00:00Z",
  });
  assert.ok(result.adoptionReport, "the real cadence producer must attach an adoption report");
  return new Set(
    result.adoptionReport.findings
      .filter((finding) => finding.shape === "symbol-no-caller")
      .map((finding) => finding.mechanism),
  );
}

test("W1-T3409: a comment mention and an unreachable caller cannot launder symbol adoption", () => {
  const root = fixture({
    "src/lib/comment-only.ts": "export function commentOnly(): void {}\n",
    "src/lib/dark-target.ts": "export function darkTarget(): void {}\n",
    "src/lib/live-target.ts": "export function liveTarget(): void {}\n",
    "src/lib/dark-region.ts": [
      'import { darkTarget } from "./dark-target.js";',
      "function neverReached(): void { darkTarget(); }",
    ].join("\n"),
    "src/run-task.ts": [
      "/** {@link commentOnly} is documentation, not a caller. */",
      'import { liveTarget } from "./lib/live-target.js";',
      "liveTarget();",
    ].join("\n"),
  });
  try {
    const findings = unadoptedSymbols(root);
    assert.ok(findings.has("commentOnly"), "a JSDoc-only identifier must remain a no-caller finding");
    assert.ok(findings.has("darkTarget"), "a call in an unreachable module must remain a no-caller finding");
    assert.ok(!findings.has("liveTarget"), "a reachable module importing and calling the symbol must clear the finding");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
