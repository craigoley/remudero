import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  GATE_POSTURE_DECLARATIONS,
  NON_ZERO_RE,
  REFUSAL_LANGUAGE_RE,
  SCRIPT_RE,
  censusGatePostures,
  currentGatePostureReport,
  deriveGateSurfaces,
  renderGatePostureReport,
  type GatePostureDeclaration,
  type GatePostureTree,
} from "../src/lib/gate-posture.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const declaration = (posture: GatePostureDeclaration["posture"], complies = true): GatePostureDeclaration => ({
  posture,
  complies,
  reason: `${posture} fixture reason`,
});

test("a newly planted refusal surface joins the census from the tree and fails by name when undeclared", () => {
  const tree: GatePostureTree = {
    "hooks/pre-push": "deny() { exit 2; }\ndeny blocked\n",
    "scripts/future-ratchet.mjs": 'console.error("future ratchet blocked"); process.exitCode = 1;\n',
    ".github/workflows/ci.yml": "jobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps: []\n",
  };

  const surfaces = deriveGateSurfaces(tree);
  assert.ok(surfaces.some((surface) => surface.id === "hook:hooks/pre-push"));
  assert.ok(surfaces.some((surface) => surface.id === "script:scripts/future-ratchet.mjs"));
  assert.ok(surfaces.some((surface) => surface.id === "ci:ci"));

  const census = censusGatePostures(surfaces, {
    "hook:hooks/pre-push": declaration("REPAIR"),
    "ci:ci": declaration("REPAIR"),
  });
  assert.deepEqual(census.missingDeclarations, ["script:scripts/future-ratchet.mjs"]);
  assert.match(renderGatePostureReport(census), /script:scripts\/future-ratchet\.mjs .* UNDECLARED/);
});

test("a usage-only non-zero script is not counted as a refusal gate", () => {
  const surfaces = deriveGateSurfaces({
    "scripts/usage-ratchet.mjs": 'if (!process.argv[2]) { console.error("Usage: usage-ratchet <path>"); process.exit(1); }\n',
  });

  assert.deepEqual(surfaces, []);
});

test("the refusal-surface regexes reject unrelated text and accept their gate-shaped inputs", () => {
  assert.equal(SCRIPT_RE.test("scripts/future-ratchet.mjs"), true);
  assert.equal(SCRIPT_RE.test("scripts/future.mjs"), false);
  assert.equal(NON_ZERO_RE.test("process.exit(1)"), true);
  assert.equal(NON_ZERO_RE.test("console.log('ok')"), false);
  assert.equal(REFUSAL_LANGUAGE_RE.test("future gate blocked"), true);
  assert.equal(REFUSAL_LANGUAGE_RE.test("Usage: future <path>"), false);
});

test("the report names each surface with posture and compliance, never only an aggregate count", () => {
  const tree: GatePostureTree = {
    "hooks/deny-floor.sh": 'deny() { echo "blocked"; exit 2; }\ndeny\n',
    ".github/workflows/ci.yml": "jobs:\n  leak-grep:\n    runs-on: ubuntu-latest\n    steps: []\n",
  };
  const census = censusGatePostures(deriveGateSurfaces(tree), {
    "hook:hooks/deny-floor.sh": declaration("REPAIR", false),
    "ci:leak-grep": declaration("CLOSE", true),
  });

  const report = renderGatePostureReport(census);
  assert.match(report, /hook:hooks\/deny-floor\.sh .* posture=REPAIR .* complies=no/);
  assert.match(report, /ci:leak-grep .* posture=CLOSE .* complies=yes/);
  assert.doesNotMatch(report, /^TOTAL:/m);
});

test("state-deciding surfaces are counted, including both credit paths and correction shape", () => {
  const ids = deriveGateSurfaces({
    "src/lib/drain.ts": 'type CreditPath = "trailer" | "head-ref"; onFiltered?.(t, "already-merged");\n',
    "src/lib/correct.ts": "writeLedger(path, { actual_pr_url: pr.url });\n",
  }).map((surface) => surface.id);

  assert.ok(ids.includes("state:dispatch-filter:already-merged"));
  assert.ok(ids.includes("state:credit-path:trailer"));
  assert.ok(ids.includes("state:credit-path:head-ref"));
  assert.ok(ids.includes("state:correction:actual-pr-url"));
});

test("task-stopping surfaces are in scope, including verify:human and blocked_ci redispatch", () => {
  const ids = deriveGateSurfaces({
    "src/lib/drain.ts": 'opts.onFiltered?.(t, "verify-not-auto"); NON_HALTING_VERDICTS.add("blocked_ci");\nif (t.status === "blocked") return false;\n',
    "src/lib/daemon.ts": "const PER_TASK_FAILURE_RE = /x/; const DAEMON_EXIT_BLOCKED = 76;\n",
  }).map((surface) => surface.id);

  assert.ok(ids.includes("task-stop:verify-not-auto"));
  assert.ok(ids.includes("task-stop:verdict:blocked_ci"));
  assert.ok(ids.includes("task-stop:status-blocked"));
  assert.ok(ids.includes("task-stop:daemon-per-task-failure"));
});

test("the census is report-only and does not mutate the tree it inspects", () => {
  const tree: GatePostureTree = {
    "hooks/pre-commit": 'echo "blocked"; exit 1\n',
  };
  const before = { ...tree };

  renderGatePostureReport(censusGatePostures(deriveGateSurfaces(tree), { "hook:hooks/pre-commit": declaration("REPAIR") }));

  assert.deepEqual(tree, before);
});

test("the checked-in tree has a declared posture for every derived refusal, state, and task-stop surface", () => {
  const census = currentGatePostureReport(REPO_ROOT);

  assert.deepEqual(census.missingDeclarations, []);
  assert.deepEqual(census.staleDeclarations, []);
  assert.ok(census.rows.length > 40, "the census must cover more than the four measured resting-block producers");
  assert.ok(census.rows.some((row) => row.id === "task-stop:verify-not-auto"));
  assert.ok(census.rows.some((row) => row.id === "task-stop:verdict:blocked_ci"));
  assert.ok(census.rows.some((row) => row.id === "state:credit-path:head-ref"));
  assert.equal(Object.keys(GATE_POSTURE_DECLARATIONS).length, census.rows.length);
});
