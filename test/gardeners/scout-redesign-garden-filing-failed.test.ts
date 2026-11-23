import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { runGardenAsync, type GardenerDeps } from "#src/lib/gardener.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { REDESIGN_JUDGED_STEP, redesignGardenSpec } from "#src/lib/redesign-gardener.js";
import { promoteIntroducedPlanOnlyDiagnostics, sharedProofViolations } from "#src/lib/task-linter.js";

const ID = "W1-T998439";
const SHARD = `plan/tasks.d/${ID}-row-reader.yaml`;
const FIRST_PROOF = `unit test: ${ID}: reads a widened row`;
const SECOND_PROOF = `unit test: ${ID}: reads a legacy row`;
const NEW_PROOF = `unit test: ${ID}: replays a legacy row`;
const THIRD_PROOF = `unit test: ${ID}: rejects a malformed row`;
const FAILURE = "redesign.garden_filing_failed";

async function replayAmendment(
  t: TestContext,
  proofs: Array<{ criterion: number; proof: string }>,
  legacyProof = SECOND_PROOF,
) {
  const root = mkdtempSync(join(tmpdir(), "rmd-redesign-shared-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const stateDir = join(root, "state");
  const path = join(root, SHARD);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(join(checkout, SHARD)), { recursive: true });
  mkdirSync(stateDir);

  const clock = fixedClock(Date.UTC(2026, 10, 12, 12));
  const pointerStamp = new Date(clock.now() - 2 * 3_600_000).toISOString();
  const base = [
    `- id: ${ID}`,
    "  title: Read legacy and widened rows",
    "  repo: remudero",
    "  type: implement",
    "  verify: auto",
    "  risk: low",
    "  priority: 1",
    `  # refusal-amendment (${ID}, run fixture, ${pointerStamp}): the legacy row proof needs amendment`,
    "  status: queued",
    "  files:",
    "    - src/lib/row-reader.ts",
    "  acceptance:",
    "    - claim: a widened row is readable",
    `      proof: "${FIRST_PROOF}"`,
    "    - claim: a legacy row is readable",
    `      proof: "${legacyProof}"`,
    "    - claim: a malformed row is rejected",
    `      proof: "${THIRD_PROOF}"`,
    "",
  ].join("\n");
  writeFileSync(path, base);
  writeFileSync(join(checkout, SHARD), base);

  const tasks = parseTasksFromYaml(base, SHARD);
  const rows: Array<Record<string, unknown>> = [];
  const filingChecks: string[][] = [];
  const deps: GardenerDeps = {
    repoRoot: root,
    stateDir,
    clock,
    seed: 1,
    log: (step, fields) => { rows.push({ ...fields, step, ts: clock.iso() }); },
    mergedPlanLint: () => undefined,
    openWorkspace: () => ({
      root: checkout,
      dispose: () => {},
      land: () => {
        const [draft] = parseTasksFromYaml(readFileSync(join(checkout, SHARD), "utf8"), SHARD);
        // Replay the plan-only preflight's promotion for the audited shared-proof refusal.
        const checks = promoteIntroducedPlanOnlyDiagnostics(
          sharedProofViolations(draft!), sharedProofViolations(tasks[0]!), false,
        ).filter((finding) => finding.severity === "block").map((finding) => finding.check);
        filingChecks.push(checks);
        return checks.length ? undefined : "https://example.test/pull/42";
      },
    }),
  };
  const spec = redesignGardenSpec(deps, {
    plan: () => ({ all: tasks, open: tasks, shards: new Map([[ID, SHARD]]) }),
    ledger: (steps) => rows.filter((row) => steps.some((step) => step === row.step)),
    judgeText: async () => `REDESIGN: ${JSON.stringify({
      verdict: "amend",
      reason: "update the row reader proofs",
      amendment: "Replay rows through the reader.",
      files_add: [],
      proofs,
    })}`,
  });
  await runGardenAsync(spec, deps);
  return { rows, filingChecks, base, draft: readFileSync(join(checkout, SHARD), "utf8") };
}

test("W1-T12439: a redesign amendment with distinct proofs reaches filing", async (t) => {
  const { rows, filingChecks, draft } = await replayAmendment(t, [{ criterion: 2, proof: NEW_PROOF }]);
  assert.deepEqual(filingChecks, [[]]);
  assert.ok(draft.includes(NEW_PROOF));
  assert.equal(rows.some((row) => row.step === FAILURE), false);
});

test("W1-T12439: an unchanged shared proof on an existing task reaches filing", async (t) => {
  const { rows, filingChecks, draft } = await replayAmendment(t, [{ criterion: 3, proof: NEW_PROOF }], FIRST_PROOF);
  assert.deepEqual(filingChecks, [[]]);
  assert.ok(draft.includes(NEW_PROOF));
  assert.equal(rows.some((row) => row.step === FAILURE), false);
});

test("W1-T12439: redesign.garden_filing_failed no longer recurs", async (t) => {
  const cases = [
    { name: "duplicates an untouched sibling", proofs: [{ criterion: 2, proof: FIRST_PROOF }] },
    { name: "duplicates another edited proof", proofs: [{ criterion: 1, proof: NEW_PROOF }, { criterion: 2, proof: NEW_PROOF }] },
    { name: "expands an inherited duplicate", proofs: [{ criterion: 3, proof: FIRST_PROOF }], legacyProof: FIRST_PROOF },
  ];
  for (const { name, proofs, legacyProof } of cases) {
    await t.test(name, async (t) => {
      const { rows, filingChecks, base, draft } = await replayAmendment(t, proofs, legacyProof);
      const verdict = rows.find((row) => row.step === REDESIGN_JUDGED_STEP);
      assert.deepEqual(filingChecks, [], "a duplicate proof must be refused before the plan PR preflight");
      assert.equal(draft, base);
      assert.equal(rows.some((row) => row.step === FAILURE), false);
      assert.equal(verdict?.outcome, "refused");
      assert.match(String(verdict?.reason), /shared-proof/);
    });
  }
});
