import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FAST_GATE_STEPS } from "../src/lib/ci-parity.js";
import { COMMANDS, PREFLIGHT_BOOL_FLAGS, PREFLIGHT_VALUE_FLAGS, renderFastGateScriptList } from "../src/run-task.js";

// ── W1-T2646: the preflight help text stops RE-TYPING a table the code owns ────────────────────
//
// FILED FROM the W1-T2478 follow-up harvest (PR #3323): the `preflight` COMMANDS entry hand-
// listed 7 of FAST_GATE_STEPS's 13 scripts (three merged tasks — W1-T2488, W1-T2491, W1-T2478 —
// each added a row and none touched the string), still asserted the mechanism rule W1-T2478
// replaced with a measured bound ("never shells the test suite"), and omitted `--coverage`, an
// already-accepted flag, from the usage signature. This suite proves each drift is now CLOSED BY
// CONSTRUCTION, not merely corrected for today: the script list is DERIVED (a synthetic table
// row changes the rendered text with no edit to the string), the flag list is SHARED with the
// validator (not retyped), and the doc generator agrees.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function preflightSpec() {
  const spec = COMMANDS.find((c) => c.name === "preflight");
  assert.ok(spec, "COMMANDS must carry a 'preflight' entry");
  return spec!;
}

test("preflight usage: the fast-gate script list is DERIVED from FAST_GATE_STEPS, never re-typed", () => {
  const spec = preflightSpec();

  // Every one of TODAY's FAST_GATE_STEPS entries is named — the falsifier the old hand-typed
  // list (7 of 13) failed: three merged tasks each added a row the string never saw.
  assert.ok(FAST_GATE_STEPS.length >= 13, `expected FAST_GATE_STEPS to carry at least 13 entries, got ${FAST_GATE_STEPS.length}`);
  for (const step of FAST_GATE_STEPS) {
    assert.ok(
      spec.detail.includes(step.script),
      `preflight's detail is missing FAST_GATE_STEPS script "${step.script}" — the list is hand-typed again`,
    );
  }

  // The registry entry is actually COMPOSED from renderFastGateScriptList(FAST_GATE_STEPS), not
  // a copy that merely happens to agree with it right now.
  assert.ok(
    spec.detail.includes(renderFastGateScriptList(FAST_GATE_STEPS)),
    "preflight's detail does not contain the exact rendered FAST_GATE_STEPS script list — it is not composed from the table",
  );

  // The falsifier itself: feed renderFastGateScriptList a table FAST_GATE_STEPS does not carry
  // today, and prove the render reflects the synthetic row with no edit to any string.
  const synthetic = [...FAST_GATE_STEPS, { job: "synthetic-job", script: "synthetic-entry-w1-t2646", reason: "test-only" }];
  const rendered = renderFastGateScriptList(synthetic);
  assert.ok(rendered.includes("synthetic-entry-w1-t2646"), "renderFastGateScriptList did not reflect an added synthetic row");
  assert.equal(rendered, [...FAST_GATE_STEPS.map((s) => s.script), "synthetic-entry-w1-t2646"].join(", "));

  // Only script names render — never an entry's own paragraph-length `reason` (design i).
  for (const step of FAST_GATE_STEPS) {
    assert.ok(!spec.detail.includes(step.reason), `preflight's detail leaked FAST_GATE_STEPS entry "${step.job}"'s own reason prose`);
  }
});

test("preflight usage: names the measured bound + RUNAWAY refusal, not the superseded 'never shells the test suite' rule", () => {
  const spec = preflightSpec();

  // The superseded mechanism-proxy claim (W1-T2478 replaced it) must not reappear.
  assert.ok(
    !/never\s+shells?\s+the\s+test\s+suite/i.test(spec.detail),
    "preflight's detail still asserts the superseded 'never shells the test suite' mechanism rule",
  );

  // What actually governs admission now: a per-run measured bound, refused as RUNAWAY — the one
  // failure mode unique to --fast an operator can meet and should be able to look up here.
  assert.match(spec.detail, /RUNAWAY/, "preflight's detail does not name the RUNAWAY refusal an operator can meet under --fast");
  assert.match(spec.detail, /node --test/, "preflight's detail does not disclose that the census entries spawn node --test");
});

test("preflight usage: every flag the arg validator ACCEPTS appears in the printed usage signature", () => {
  const spec = preflightSpec();
  for (const flag of [...PREFLIGHT_VALUE_FLAGS, ...PREFLIGHT_BOOL_FLAGS]) {
    assert.ok(spec.syntax.includes(flag), `preflight's syntax line is missing accepted flag "${flag}" (--coverage was the shipped gap)`);
  }
  // --coverage specifically: the drift this task was filed to close.
  assert.ok(spec.syntax.includes("--coverage"), "preflight's syntax line omits --coverage");
});

test("docs/cli-reference.md agrees with a fresh regeneration from COMMANDS (cli-reference:check is green)", () => {
  const script = join(REPO_ROOT, "scripts", "generate-cli-reference.mjs");
  const docPath = join(REPO_ROOT, "docs", "cli-reference.md");
  const result = spawnSync(process.execPath, ["--import", "tsx", script, "--check", "--out", docPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `cli-reference:check failed:\n${result.stdout}${result.stderr}`);

  // The published surface carries the full derived list, not the stale hand-typed seven.
  const committed = readFileSync(docPath, "utf8");
  for (const step of FAST_GATE_STEPS) {
    assert.ok(committed.includes(step.script), `docs/cli-reference.md is missing FAST_GATE_STEPS script "${step.script}"`);
  }
});
