/**
 * test/the-adoption-scan-reads-every-invoker-surface.test.ts — W1-T3379.
 *
 * `scanUnadoptedScripts` asked three surfaces whether a script has an adopter —
 * `.github/workflows`, `package.json`, `src/` — and a script invoked from anywhere else read as
 * permanently unadopted. Two such surfaces exist and both are live:
 *
 *   (a) scripts/ ITSELF. A shared `scripts/lib/*.mjs` module is imported only by sibling scripts.
 *       MEASURED on the checkout at filing: `scripts/lib/git.mjs` had 15 importers,
 *       `scripts/lib/repo-root.mjs` 12, `scripts/test-duration-reporter.mjs` 2 — all reported as
 *       having no adopter, and each one minted a ratification proposal.
 *   (b) plan/claims.yaml, whose rows carry an `assertion:` that RUNS a script through a required
 *       check: `node --import tsx scripts/plan-state-claims.mjs`.
 *
 * THE PRECISION HALF IS THE POINT, and is what keeps this from becoming a check that compares
 * nothing. A bare-basename match over raw text marks the whole corpus adopted, because
 * `scripts/comment-load-baseline.json` is DATA listing every script by path, and because
 * `scripts/diff-coverage.mjs` names `scripts/console-live-review.mjs` in a DOC COMMENT. So the
 * probe is a QUOTED PATH SPECIFIER over EXECUTABLE files only. Measured: reported 11 -> 4.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { runMeasurementCadenceReport } from "../src/lib/measurement-cadence.js";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "adoption-surfaces-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text, "utf8");
  }
  return dir;
}

const SHIP = () => "2026-01-01T00:00:00Z";
const NO_GIT = () => {
  throw new Error("no real git in this test — irrelevant to the adoption report");
};

/** Drives the REAL production entry point (`runMeasurementCadenceReport`), never a test-only
 *  export — the same seam test/adoption-report-has-a-producer.test.ts already uses, so this
 *  suite cannot drift from what the cadence actually runs. */
function unadoptedScripts(dir: string): string[] {
  const result = runMeasurementCadenceReport({
    stateDir: dir,
    cwd: dir,
    escalate: false,
    gitLog: NO_GIT,
    checkoutDir: dir,
    shipDateFor: SHIP,
  });
  assert.ok(result.adoptionReport, "the producer must always attach an adoptionReport");
  return result.adoptionReport.findings.filter((f) => f.shape === "script-no-invoker").map((f) => f.definedIn);
}

test("W1-T3379: a script imported only by a SIBLING SCRIPT has an adopter", () => {
  const dir = repo({
    "package.json": "{}",
    "scripts/lib/git.mjs": "export function git() {}\n",
    "scripts/uses-it.mjs": 'import { git } from "./lib/git.mjs";\ngit();\n',
  });
  try {
    assert.ok(!unadoptedScripts(dir).includes("scripts/lib/git.mjs"), "an imported sibling module is adopted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3379: a script run by a plan/claims.yaml assertion has an adopter", () => {
  const dir = repo({
    "package.json": "{}",
    "scripts/plan-state-claims.mjs": "// the gate\n",
    "plan/claims.yaml": "- id: plan-state-claims-self-consistent\n  assertion: 'node --import tsx scripts/plan-state-claims.mjs'\n",
  });
  try {
    assert.ok(!unadoptedScripts(dir).includes("scripts/plan-state-claims.mjs"), "a claims assertion is a real invocation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3379: A DATA FILE LISTING EVERY SCRIPT BY PATH IS NOT AN INVOKER — the scan still reports", () => {
  const dir = repo({
    "package.json": "{}",
    "scripts/orphan.mjs": "// nothing runs this\n",
    "scripts/comment-load-baseline.json": '{\n  "scripts/orphan.mjs": 16\n}\n',
  });
  try {
    assert.ok(
      unadoptedScripts(dir).includes("scripts/orphan.mjs"),
      "a baseline that names every script must not launder adoption",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3379: A DOC-COMMENT MENTION IS NOT AN INVOKER — the scan still reports", () => {
  const dir = repo({
    "package.json": "{}",
    "scripts/orphan.mjs": "// nothing runs this\n",
    "scripts/other.mjs": "/**\n * see scripts/orphan.mjs (#4865): 66 raw lines\n */\nexport const x = 1;\n",
  });
  try {
    assert.ok(
      unadoptedScripts(dir).includes("scripts/orphan.mjs"),
      "prose naming a script is not a call to it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T3379: a genuinely unadopted script is STILL reported — the scan did not go vacuous", () => {
  const dir = repo({
    "package.json": "{}",
    "scripts/orphan.mjs": "// nothing runs this\n",
    "scripts/unrelated.mjs": "export const y = 2;\n",
  });
  try {
    assert.ok(unadoptedScripts(dir).includes("scripts/orphan.mjs"), "a script with no invoker at all is still named");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
