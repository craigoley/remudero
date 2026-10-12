import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import {
  BASE_RED_STOOD_DOWN_STEP,
  PR_BODY_SCOPED_CHECKS,
  baseRedHistoryFromLedger,
  decideBaseRed,
  isMainRepairPr,
  mainLatestRunFromLedger,
  runSweep,
  type OpenPrView,
} from "./helpers/sweep-test.js";

// W1-T8575 — on 2026-10-12 the red-main repair PR #11096 stood down as base red ("proof-discrimination
// is absent from main's latest run, and main is red"), so the PR that would turn main green waited for
// main to turn green. A repair PR is never held for main's red, and a check that judges only the PR's
// own body, title or proofs is never read as inherited from main.

const HEAD = "f84af4f".padEnd(40, "0");
const MAIN = "c42bab6ea".padEnd(40, "0");
const NOW = Date.parse("2026-10-12T13:55:09Z");
const REPAIR_URL = "https://github.com/craigoley/remudero/pull/11096";

const pr = (names: string[], over: Partial<OpenPrView> = {}): OpenPrView => ({
  prNumber: 11096, prUrl: REPAIR_URL, taskId: "main-repair-97e3f9136d82",
  headSha: HEAD, headRefName: "main-repair-fix-97e3f9136d82-1791813063189", checksState: "red", reviewState: "pending",
  unmetCriteria: [], priorStrikes: 0, autoMergeArmed: false, lastActivityAt: new Date(NOW - 60_000).toISOString(),
  ciFailures: names.map((name) => ({ name, conclusion: "FAILURE", logTail: `${name}: FAILED` })),
  ...over,
});
const ordinary = (names: string[]): OpenPrView =>
  pr(names, { prNumber: 11200, prUrl: "https://github.com/craigoley/remudero/pull/11200", taskId: "W1-T9999", headRefName: "run-W1-T9999-1" });
// Main is red on `ci`; its census never ran the pull_request-only checks.
const redMain = () => ({ step: "main.health.observed", sha: MAIN, state: "red", failing_checks: ["ci"], observed_checks: ["ci", "build"] });
const fixOpened = (url: string) => ({ step: "main.repair.fix_opened", task_id: "MAIN-HEALTH", surface: "main", pr_url: url });

async function sweepOnce(prs: OpenPrView[], rows: Record<string, unknown>[]) {
  const dispatched: number[] = [];
  await runSweep(prs, {
    ledgerPath: "/dev/null/t8575", runId: "T8575", now: () => NOW,
    readLedger: () => rows, appendLine: (_path, row) => { rows.push(row); },
    arm: () => {}, close: () => {}, escalate: () => {}, postReview: async () => {},
    dispatchFix: (p) => { dispatched.push(p.prNumber); },
    // As on #11096, the metadata lane ruled the body red out, so it reached the base-red arm.
    repairMetadata: () => ({ repaired: false, notMetadata: true, reason: "not a metadata defect" }),
    updateBranch: () => "updated",
  });
  return dispatched;
}

test("W1-T8575: the #11096 shape gets a fix dispatched, not a base-red stand-down", async () => {
  // 13:55Z the head was red on proof-discrimination; at 14:07Z coverage-ratchet took its place.
  for (const names of [["proof-discrimination"], ["coverage-ratchet"]]) {
    const rows: Record<string, unknown>[] = [redMain()];
    const repair = pr(names);
    assert.equal(isMainRepairPr(repair, []), true, "the main-repair task id alone names the lane");
    assert.deepEqual(decideBaseRed(repair, mainLatestRunFromLedger(rows), baseRedHistoryFromLedger(rows)), { kind: "own" }, names[0]);
    const dispatched = await sweepOnce([repair], rows);
    assert.deepEqual(dispatched, [11096], names[0]);
    assert.equal(rows.filter((r) => r.step === BASE_RED_STOOD_DOWN_STEP).length, 0, names[0]);
    const reasons = rows.filter((r) => r.pr_number === 11096).map((r) => String(r.stand_down_reason ?? r.reason ?? ""));
    assert.equal(reasons.some((r) => /is absent from main's latest run/.test(r)), false, reasons.join(" | "));
  }
});

test("W1-T8575: a PR the main-health lane opened is never held for main", () => {
  // Recognised by its main.repair.fix_opened row alone: no main-repair- task id, an ordinary-looking head.
  const lane = pr([], { taskId: undefined, headRefName: "some-branch" });
  const rows: Record<string, unknown>[] = [redMain(), fixOpened(REPAIR_URL)];
  assert.equal(isMainRepairPr(lane, rows), true);
  assert.equal(isMainRepairPr(lane, [redMain(), fixOpened("https://github.com/craigoley/remudero/pull/1")]), false);
  const main = mainLatestRunFromLedger(rows);
  const history = baseRedHistoryFromLedger(rows);
  // Whichever check reds: a tree-running one main never ran, one main fails too, or a body-scoped one.
  for (const names of [["coverage-ratchet"], ["lint-plan"], ["ci"], ["proof-discrimination"], ["ci", "lint-plan"]]) {
    assert.deepEqual(decideBaseRed({ ...lane, ciFailures: pr(names).ciFailures }, main, history), { kind: "own" }, names.join(","));
  }
  // Positive control: the same reds on an unrelated PR are still held while main is red.
  assert.deepEqual(decideBaseRed(ordinary(["coverage-ratchet"]), main, history), { kind: "wait", check: "coverage-ratchet" });
  assert.deepEqual(decideBaseRed(ordinary(["ci"]), main, history), { kind: "wait", check: "ci" });
});

test("W1-T8575: a body-scoped red is the PR own while a tree red still waits", () => {
  const main = mainLatestRunFromLedger([redMain()]);
  const none = baseRedHistoryFromLedger([]);
  for (const name of ["proof-discrimination", "acceptance-author-gate", "commitlint"]) {
    assert.ok(PR_BODY_SCOPED_CHECKS.includes(name), name);
    assert.deepEqual(decideBaseRed(ordinary([name]), main, none), { kind: "own" }, name);
  }
  // W1-T5490's lint-plan wait is unchanged, alone or beside a body-scoped red.
  assert.deepEqual(decideBaseRed(ordinary(["lint-plan"]), main, none), { kind: "wait", check: "lint-plan" });
  assert.deepEqual(decideBaseRed(ordinary(["proof-discrimination", "lint-plan"]), main, none), { kind: "wait", check: "lint-plan" });
  assert.deepEqual(decideBaseRed(ordinary(["coverage-shard (2/8)"]), main, none), { kind: "wait", check: "coverage-shard (2/8)" });
});

// Checks that trigger on `edited` for a reason other than judging the PR's own body or title.
const EDITED_EXEMPT: Record<string, string> = {};

test("W1-T8575: every edited-triggered required check is classified", () => {
  const dir = join(process.cwd(), ".github", "workflows");
  const gate = parseYaml(readFileSync(join(dir, "ci-gate.yml"), "utf8")) as {
    jobs: Record<string, { env?: Record<string, string> }>;
  };
  const required = JSON.parse(gate.jobs["ci-gate"]!.env!.REQUIRED!) as string[];
  const editedRequired: string[] = [];
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const doc = parseYaml(readFileSync(join(dir, file), "utf8")) as {
      on?: { pull_request?: { types?: string[] } | null } | string | string[];
      jobs?: Record<string, { name?: string }>;
    };
    const on = doc.on;
    const types = on && typeof on === "object" && !Array.isArray(on) ? on.pull_request?.types : undefined;
    if (!Array.isArray(types) || !types.includes("edited")) continue;
    for (const [key, job] of Object.entries(doc.jobs ?? {})) {
      const name = typeof job.name === "string" ? job.name : key;
      if (required.includes(name)) editedRequired.push(name);
    }
  }
  assert.ok(editedRequired.includes("proof-discrimination"), `positive control: ${editedRequired.join(", ")}`);
  const unclassified = editedRequired.filter((name) => !PR_BODY_SCOPED_CHECKS.includes(name) && !(name in EDITED_EXEMPT));
  assert.deepEqual(unclassified, [], "an edited-triggered required check must be body-scoped or exempted with its reason");
});
