import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { appendLedger, type LedgerLine } from "../src/lib/ledger.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { PlanPrPreflightResult } from "../src/lib/plan-pr-emitter.js";
import type { Plan, Task } from "../src/lib/plan.js";
import {
  REFUSAL_AMENDMENT_MAX_AGE_MS,
  REFUSAL_AMENDMENT_STEP,
  noPrVerdictRowsFromLedger,
  refusalIsMainCaused,
} from "../src/lib/refusal-amendment.js";
import { buildSweepEffects, runSweep, type BuildSweepEffectsDeps, type SweepDeps } from "../src/lib/sweep.js";
import { buildFixturePlanPrBody } from "./helpers/plan-pr-body-fixture.js";

// W1-T5531 — W1-T5405 records a red refusal-amendment preflight as the source run's outcome, and the
// reader treated every such row as handled forever. When origin/main ITSELF was red, the amendment failed
// checks it did not cause. The sweep now records the base sha and whether every failing check also fails
// on that base alone; the reader re-offers such a refusal once main moves past that sha, at most once.

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const VERDICT_TS = "2026-10-03T11:00:00.000Z"; // expiring-fixture: exempt -- compared only against this suite's INJECTED now (NOW), never the wall clock
const TASK = "W1-T5531-FIXTURE";
const RUN = "RUN-REFUSED-5531";
const SHARD = ["- id: " + TASK, "  repo: remudero", "  status: queued", "  attempts: 0", ""].join("\n");
const REFUSAL = ["REFUSED:", "1. [premise-rotted] No headline at this checkout meets the task record's required condition"].join("\n");
const COMMIT_SHA = "5531c0ffee0123456789";
const BASE_A = "5531aaaa00000000";
const BASE_B = "5531bbbb00000000";
const BASE_C = "5531cccc00000000";

const LINT_RED: PlanPrPreflightResult = {
  ok: false,
  failures: [{ check: "lint-plan", firstLine: "lint-plan-precheck: duplicate key on main" }],
  unreadable: [],
};
const TITLE_RED: PlanPrPreflightResult = {
  ok: false,
  failures: [{ check: "pr-title", firstLine: "pr-title: too long" }],
  unreadable: [],
};
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };

type Row = Record<string, unknown>;

function rows(path: string): Row[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
}

const verdict = (): LedgerLine => ({ run_id: RUN, task_id: TASK, step: "verdict", verdict: "no_pr", report_excerpt: REFUSAL, ts: VERDICT_TS });
const refused = (extra: Row): Row => ({ run_id: "SWEEP", task_id: TASK, step: REFUSAL_AMENDMENT_STEP, source_run_id: RUN, outcome: "preflight_refused", ...extra });
const offered = (lines: Row[], mainSha: string | undefined): boolean =>
  noPrVerdictRowsFromLedger(lines, NOW, REFUSAL_AMENDMENT_MAX_AGE_MS, mainSha).length > 0;

// ── the reader ──────────────────────────────────────────────────────────────────────────────────

test("W1-T5531: a main-red refusal is held while main is still that sha and offered once main moves", () => {
  const lines = [verdict(), refused({ main_red: true, origin_main_sha: BASE_A })];
  assert.equal(offered(lines, BASE_A), false, "main has not moved: the same red would recur");
  assert.equal(offered(lines, BASE_B), true, "main moved past the recorded red sha: retry");
  assert.equal(offered(lines, undefined), false, "an unread main tip never re-pays the preflight");
});

test("W1-T5531: an amendment-caused red refusal stays final even after main moves", () => {
  assert.equal(offered([verdict(), refused({ main_red: false, origin_main_sha: BASE_A })], BASE_B), false);
  assert.equal(offered([verdict(), refused({ origin_main_sha: BASE_A })], BASE_B), false, "a W1-T5405 row (no main_red) stays final");
  assert.equal(offered([verdict(), refused({ main_red: true })], BASE_B), false, "a main-red row naming no sha cannot be compared");
});

test("W1-T5531: a second refusal for the same source run is final, and a drafted row is handled", () => {
  const twice = [verdict(), refused({ main_red: true, origin_main_sha: BASE_A }), refused({ main_red: true, origin_main_sha: BASE_B })];
  assert.equal(offered(twice, BASE_C), false, "retried at most once");
  const drafted = [verdict(), refused({ main_red: true, origin_main_sha: BASE_A }), refused({ outcome: "drafted" })];
  assert.equal(offered(drafted, BASE_B), false, "the retry drafted it");
  const otherRun = [verdict(), refused({ main_red: true, origin_main_sha: BASE_A, source_run_id: "OTHER" })];
  assert.equal(offered(otherRun, BASE_A), true, "another run's refusal does not handle this one");
});

test("W1-T5531: refusalIsMainCaused needs every failing check base-attributable and red on the base", () => {
  assert.equal(refusalIsMainCaused(LINT_RED.failures, LINT_RED.failures), true);
  assert.equal(refusalIsMainCaused(LINT_RED.failures, []), false, "the base is green: the amendment caused it");
  assert.equal(refusalIsMainCaused(TITLE_RED.failures, TITLE_RED.failures), false, "the title is the amendment's own");
  assert.equal(
    refusalIsMainCaused([...LINT_RED.failures, ...TITLE_RED.failures], LINT_RED.failures),
    false,
    "one amendment-caused failure makes the whole refusal amendment-caused",
  );
  assert.equal(refusalIsMainCaused([], LINT_RED.failures), false, "no failure is no refusal");
  assert.equal(
    refusalIsMainCaused([{ check: "shard-census", firstLine: "x" }], [{ check: "shard-census", firstLine: "y" }]),
    true,
  );
});

// ── the sweep's effect records the base and whether it was red ────────────────────────────────────

function fixtureTask(): Task {
  return { id: TASK, repo: "remudero", status: "queued", attempts: 0, title: "fixture" } as unknown as Task;
}

interface Fixture {
  ledger: string;
  preflightShas: string[];
  creates: () => string[][];
  setBase: (sha: string) => void;
  sweepDeps: (mainTip: string) => SweepDeps;
}

/** The real refusal-amendment effect over fakes: `amend` answers the amendment commit, `base` the base tree. */
function fixture(
  amend: () => PlanPrPreflightResult,
  base: () => PlanPrPreflightResult,
  over: Partial<BuildSweepEffectsDeps> = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t5531-"));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.d", `${TASK}-fixture.yaml`), SHARD);
  const ledger = join(root, "state", "ledger.ndjson");
  const task = fixtureTask();
  let baseSha = BASE_A;
  const preflightShas: string[] = [];
  const ghCalls: string[][] = [];
  const deps: BuildSweepEffectsDeps = {
    owner: "acme",
    repo: "remudero",
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: ledger,
    runId: "SWEEP-W1-T5531",
    plan: { tasks: [task], byId: new Map([[TASK, task]]) } as unknown as Plan,
    log: (step, extra) => appendLedger(ledger, { run_id: "SWEEP-W1-T5531", task_id: "SWEEP", step, ...extra }),
    nowMsImpl: () => NOW,
    planRepairGitImpl: (_file, args) => (args.includes("HEAD^") ? `${baseSha}\n` : args.includes("rev-parse") ? `${COMMIT_SHA}\n` : ""),
    worktreeAddImpl: (_repoDir, worktreePath) => {
      mkdirSync(join(worktreePath, "plan", "tasks.d"), { recursive: true });
    },
    gitPushRunBranchImpl: () => {},
    worktreeRemoveImpl: () => {},
    ghJsonImpl: (args) => {
      ghCalls.push(args);
      return args.includes("--method") ? { html_url: "https://github.com/acme/remudero/pull/9531", number: 9531 } : [];
    },
    buildPlanPrBodyImpl: buildFixturePlanPrBody,
    reloadPlanForFixImpl: () => undefined,
    planPrPreflightImpl: (_dir: string, sha: string) => {
      preflightShas.push(sha);
      return sha === COMMIT_SHA ? amend() : base();
    },
    ...over,
  };
  const effects = buildSweepEffects(deps);
  return {
    ledger,
    preflightShas,
    creates: () => ghCalls.filter((c) => c.includes("--method")),
    setBase: (sha) => {
      baseSha = sha;
    },
    sweepDeps: (mainTip) => ({
      arm: () => "armed",
      close: () => {},
      dispatchFix: () => {},
      escalate: () => {},
      ledgerPath: ledger,
      runId: "SWEEP-W1-T5531",
      now: () => NOW,
      readMainTip: () => mainTip,
      draftRefusalAmendments: effects.draftRefusalAmendments,
    }),
  };
}

const outcomes = (f: Fixture): Row[] => rows(f.ledger).filter((r) => r.step === REFUSAL_AMENDMENT_STEP);

test("W1-T5531: a red refusal-amendment preflight on a red origin/main records main_red and the base sha", async () => {
  const f = fixture(() => LINT_RED, () => LINT_RED);
  appendLedger(f.ledger, verdict());
  await withLiveWritesAllowed(() => runSweep([], f.sweepDeps(BASE_A)));
  assert.deepEqual(f.preflightShas, [COMMIT_SHA, BASE_A], "the amendment, then its base tree alone");
  const [row] = outcomes(f);
  assert.equal(row!.outcome, "preflight_refused");
  assert.equal(row!.main_red, true);
  assert.equal(row!.origin_main_sha, BASE_A);
});

test("W1-T5531: a red preflight whose base is green records main_red false", async () => {
  const f = fixture(() => LINT_RED, () => GREEN);
  appendLedger(f.ledger, verdict());
  await withLiveWritesAllowed(() => runSweep([], f.sweepDeps(BASE_A)));
  const [row] = outcomes(f);
  assert.equal(row!.main_red, false);
  assert.equal(row!.origin_main_sha, BASE_A);
  await withLiveWritesAllowed(() => runSweep([], f.sweepDeps(BASE_B)));
  assert.equal(f.preflightShas.filter((s) => s === COMMIT_SHA).length, 1, "an amendment-caused red is final when main moves");
});

test("W1-T5531: a base probe that throws records the error and leaves the refusal final", async () => {
  const f = fixture(() => LINT_RED, () => {
    throw new Error("base tree could not be preflighted");
  });
  appendLedger(f.ledger, verdict());
  await withLiveWritesAllowed(() => runSweep([], f.sweepDeps(BASE_A)));
  const [row] = outcomes(f);
  assert.equal(row!.outcome, "preflight_refused");
  assert.equal(row!.main_red, false);
  assert.equal(row!.origin_main_sha, BASE_A);
  assert.match(String(row!.main_red_probe_error), /base tree could not be preflighted/);
});

test("W1-T5531: a base sha that cannot be read records the error and leaves the refusal final", async () => {
  const f = fixture(() => LINT_RED, () => LINT_RED, {
    planRepairGitImpl: (_file, args) => {
      if (args.includes("HEAD^")) throw new Error("no parent commit");
      return args.includes("rev-parse") ? `${COMMIT_SHA}\n` : "";
    },
  });
  appendLedger(f.ledger, verdict());
  await withLiveWritesAllowed(() => runSweep([], f.sweepDeps(BASE_A)));
  const [row] = outcomes(f);
  assert.equal(row!.main_red, false);
  assert.equal(row!.origin_main_sha, undefined);
  assert.match(String(row!.main_red_probe_error), /no parent commit/);
  assert.deepEqual(f.preflightShas, [COMMIT_SHA], "no base to probe");
});

test("W1-T5531: the sweep retries a main-red refusal once main moves, and only once", async () => {
  const f = fixture(() => LINT_RED, () => LINT_RED);
  appendLedger(f.ledger, verdict());
  const amendRuns = () => f.preflightShas.filter((s) => s === COMMIT_SHA).length;

  await withLiveWritesAllowed(() => runSweep([], f.sweepDeps(BASE_A)));
  assert.equal(amendRuns(), 1);
  await withLiveWritesAllowed(() => runSweep([], f.sweepDeps(BASE_A)));
  assert.equal(amendRuns(), 1, "main is still the red sha: not re-paid");

  f.setBase(BASE_B);
  await withLiveWritesAllowed(() => runSweep([], f.sweepDeps(BASE_B)));
  assert.equal(amendRuns(), 2, "main moved: the refusal amendment is offered again");
  assert.deepEqual(
    outcomes(f).map((r) => [r.outcome, r.origin_main_sha]),
    [["preflight_refused", BASE_A], ["preflight_refused", BASE_B]],
  );

  f.setBase(BASE_C);
  await withLiveWritesAllowed(() => runSweep([], f.sweepDeps(BASE_C)));
  assert.equal(amendRuns(), 2, "a second refusal is final");
  assert.equal(f.creates().length, 0);
});

test("W1-T5531: a retried main-red refusal opens its PR once main is green", async () => {
  let mainRed = true;
  const f = fixture(() => (mainRed ? LINT_RED : GREEN), () => (mainRed ? LINT_RED : GREEN));
  appendLedger(f.ledger, verdict());
  await withLiveWritesAllowed(() => runSweep([], f.sweepDeps(BASE_A)));
  mainRed = false;
  f.setBase(BASE_B);
  await withLiveWritesAllowed(() => runSweep([], f.sweepDeps(BASE_B)));
  assert.equal(f.creates().length, 1, "the amendment PR opens on the repaired main");
  assert.deepEqual(outcomes(f).map((r) => r.outcome), ["preflight_refused", "drafted"]);
  await withLiveWritesAllowed(() => runSweep([], f.sweepDeps(BASE_C)));
  assert.equal(f.creates().length, 1, "drafted is handled");
});
