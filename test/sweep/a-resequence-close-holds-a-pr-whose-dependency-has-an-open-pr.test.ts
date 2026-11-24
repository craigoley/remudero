/**
 * W1-T13226 — THE SWEEP HOLDS AN IMPLEMENTATION PR WHOSE UNMET DEPENDENCY HAS ITS OWN OPEN PR, INSTEAD OF
 * CLOSING IT AS A PLAN RESEQUENCE.
 *
 * OBSERVED 2026-11-16 on craigoley/remudero-console: #2568 (CONSOLE-T184, depends_on CONSOLE-T182) was closed
 * as "unmet dependency in the current plan: CONSOLE-T182 — the plan resequenced after this PR was admitted"
 * while #2564, carrying `Remudero-Task: CONSOLE-T182`, was open and green. Nothing had resequenced: the
 * dependency was in flight in its own PR. Each fixture below replays that shape through the real projection
 * (`projectMergedTaskCandidates`) and, where a close is in question, a real sweep pass over a private ledger.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  projectMergedTaskCandidates,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";

const NOW = Date.parse("2026-11-16T17:58:13.000Z");
const JUDGED = 2568;
const TASK_ID = "CONSOLE-T184";
const DEP_ID = "CONSOLE-T182";
const DEP_PR = 2564;
const OTHER_DEP = "CONSOLE-T183";

function openPr(prNumber: number, over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber,
    prUrl: `https://github.com/craigoley/remudero-console/pull/${prNumber}`,
    headRefName: `run-PR${prNumber}-1795300000000`,
    headSha: String(prNumber % 10).repeat(40),
    reviewState: "pending",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    autoMergeArmed: false,
    isPlanFiling: false,
    planFilingSource: "not-plan-only",
    ...over,
  };
}

/** The #2568 shape as `buildOpenPrViews` hands it on: the resequence row has its (stale) authority to close. */
function judgedPr(unmet: readonly string[] = [DEP_ID], over: Partial<OpenPrView> = {}): OpenPrView {
  return openPr(JUDGED, {
    taskId: TASK_ID,
    headRefName: `run-${TASK_ID}-1795300000000`,
    planResequenceIneligible: `unmet dependenc${unmet.length === 1 ? "y" : "ies"} in the current plan: ${unmet.join(", ")}`,
    planResequenceUnmetDependencies: unmet,
    ...over,
  });
}

/** #2564 — the open implementation PR that carries the dependency's trailer. */
function dependencyPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return openPr(DEP_PR, { taskId: DEP_ID, headRefName: `run-${DEP_ID}-1795290000000`, ...over });
}

/** The projection with a READABLE merge-credit read that holds nothing merged — the dependency really is unmet. */
function project(prs: OpenPrView[]): OpenPrView {
  const judged = projectMergedTaskCandidates(prs, []).find((pr) => pr.prNumber === JUDGED);
  assert.ok(judged, "precondition: the judged PR survives the projection");
  return judged;
}

async function sweep(prs: OpenPrView[]): Promise<{ closed: number[]; held: Array<Record<string, unknown> | undefined> }> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13226-`));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const closed: number[] = [];
  const held: Array<Record<string, unknown> | undefined> = [];
  const deps: SweepDeps = {
    ledgerPath,
    runId: "SWEEP-W1-T13226",
    now: () => NOW,
    arm: () => {},
    close: (pr) => { closed.push(pr.prNumber); },
    dispatchFix: () => {},
    escalate: () => {},
    log: (step, extra) => { if (step === "sweep.plan_resequence_close.held") held.push(extra); },
  };
  try {
    await runSweep(projectMergedTaskCandidates(prs, []), deps, DEFAULT_SWEEP_POLICY);
    return { closed, held };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T13226 criterion 1: a PR whose only unmet dependency has another open implementation PR is held naming that PR, not closed", async () => {
  assert.equal(deriveDisposition(judgedPr(), DEFAULT_SWEEP_POLICY, NOW).disposition, "stale",
    "precondition: without the open-PR read the resequence row closes it");

  const projected = project([judgedPr(), dependencyPr()]);
  assert.equal(projected.planResequenceIneligible, undefined, "an in-flight dependency grants no authority to close");
  assert.equal(projected.planResequenceUnmetDependencies, undefined);
  assert.equal(projected.planResequenceHeld, `unmet dependency ${DEP_ID} has open PR #${DEP_PR} — held until it merges or closes`);
  assert.notEqual(deriveDisposition(projected, DEFAULT_SWEEP_POLICY, NOW).disposition, "stale");

  const pass = await sweep([judgedPr(), dependencyPr()]);
  assert.ok(!pass.closed.includes(JUDGED), "the #2568 close does not happen");
  assert.equal(pass.held.length, 1, "the hold is recorded, not silent");
  assert.equal(pass.held[0]?.pr_number, JUDGED);
  assert.match(String(pass.held[0]?.reason), new RegExp(`${DEP_ID} has open PR #${DEP_PR}`));
});

test("W1-T13226 criterion 2: when one of several unmet dependencies has no open PR, the close stands naming only that dependency", async () => {
  const unmet = [DEP_ID, OTHER_DEP];
  const projected = project([judgedPr(unmet), dependencyPr()]);
  assert.equal(projected.planResequenceIneligible, `unmet dependency in the current plan: ${OTHER_DEP}`,
    "the reason names only the dependency with no open PR");
  assert.deepEqual(projected.planResequenceUnmetDependencies, [OTHER_DEP]);
  assert.equal(projected.planResequenceHeld, undefined, "a partial hold is no hold");

  const pass = await sweep([judgedPr(unmet), dependencyPr()]);
  assert.deepEqual(pass.closed, [JUDGED], "a dependency with nothing in flight still closes exactly as before");
  assert.deepEqual(pass.held, []);

  // The control: no open PR for any dependency leaves the reason byte-for-byte as the producer wrote it.
  const alone = project([judgedPr(unmet)]);
  assert.equal(alone.planResequenceIneligible, judgedPr(unmet).planResequenceIneligible);
  assert.deepEqual(alone.planResequenceUnmetDependencies, unmet);
});

test("W1-T13226 criterion 3: invariant:in-flight-dependency-never-closes, and neither the judged PR nor a plan-filing PR earns a hold", async () => {
  // Every unmet dependency in flight — each named with its own PR, the lowest number when two credit one task.
  const unmet = [DEP_ID, OTHER_DEP];
  const prs = [judgedPr(unmet), dependencyPr(), openPr(2567, { taskId: OTHER_DEP }), openPr(2569, { taskId: OTHER_DEP })];
  const projected = project(prs);
  assert.equal(projected.planResequenceIneligible, undefined);
  assert.equal(projected.planResequenceHeld,
    `unmet dependency ${DEP_ID} has open PR #${DEP_PR} — held until it merges or closes; ` +
    `unmet dependency ${OTHER_DEP} has open PR #2567 — held until it merges or closes`);
  assert.ok(!(await sweep(prs)).closed.includes(JUDGED), "the invariant: an all-in-flight PR is never closed by the row");

  // A plan-filing PR carrying the dependency's id is its record, not its build — and an UNKNOWN filing
  // classification is not positive evidence of a build either.
  for (const filing of [dependencyPr({ isPlanFiling: true, planFilingSource: "github-files" }),
    dependencyPr({ isPlanFiling: undefined, planFilingSource: "unreadable" })]) {
    const viaFiling = project([judgedPr(), filing]);
    assert.equal(viaFiling.planResequenceIneligible, judgedPr().planResequenceIneligible, "a filing PR earns no hold");
    assert.equal(viaFiling.planResequenceHeld, undefined);
    assert.deepEqual((await sweep([judgedPr(), filing])).closed, [JUDGED]);
  }

  // The judged PR naming its own dependency (a mis-trailered head) cannot hold itself.
  const selfNamed = judgedPr([DEP_ID], { taskId: DEP_ID });
  const viaSelf = project([selfNamed]);
  assert.equal(viaSelf.planResequenceIneligible, selfNamed.planResequenceIneligible, "a PR cannot hold itself");
  assert.equal(viaSelf.planResequenceHeld, undefined);
});
