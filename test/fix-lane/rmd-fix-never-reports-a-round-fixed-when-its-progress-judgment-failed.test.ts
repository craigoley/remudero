// W1-T12701: `rmd fix` reported "dispatched the fix rung" and outcome fixed on #18422 (2026-11-14) when the
// rung's progress judge threw ProviderCapacityBlockedError and no round ran. These tests drive the real
// dispatch: the verb with no route seam, buildSweepEffects' own dispatchFix, and runSweep.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildSweepEffects, fixCommand, routeFix } from "#test/helpers/run-task-test.js";
import type { Config } from "#src/lib/config.js";
import { DEFAULT_SWEEP_POLICY, dispatchFixSpent, runSweep, type OpenPrView } from "#src/lib/sweep.js";
import { loadPlan } from "#src/lib/plan.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ProviderCapacityBlockedError } from "#src/lib/worker-provider.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { originWithClone } from "#test/helpers/git-repo.js";

const TASK = "W1-T12701";
const PR = 18422;
/** The PR's last activity, an hour before this run. The verb judges abandonment against its own clock, and a fixed
 *  2026-11-14 stamp crossed the 14-day abandonment threshold as the wall clock moved (W1-T14786). */
const ACTIVITY_MS = Date.now() - 3_600_000;
const STAMP = new Date(ACTIVITY_MS).toISOString();
/** The earlier round at this head, three hours before that activity. */
const PRIOR_ROUND_MS = ACTIVITY_MS - 3 * 3_600_000;
const PR_URL = `https://github.com/acme/fixrepo/pull/${PR}`;
const WORKER = { sessionId: "T12701", costUsd: 0, text: "REPORT\nno change\n", blocks: [], stderr: "", subtype: "success",
  isError: false, apiError: false, verdict: "success", tokens: {}, compactionEvents: [], childEnvKeys: [] } as unknown as WorkerResult;

type Row = Record<string, unknown>;

interface World {
  root: string;
  ledgerPath: string;
  head: string;
  branch: string;
  config: Config;
  prRest: Record<string, unknown>;
  checks: Array<Record<string, unknown>>;
}

/** A fixture repo with one red run branch, a gh shim, and a host config whose only provider cannot be asked. */
function world(t: TestContext, opts: { priorStrike: boolean }): World {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12701-`));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "repos"), { recursive: true });
  const repoDir = join(root, "repos", "fixrepo");
  const { clone } = originWithClone(repoDir, { seed: {
    "plan/tasks.yaml": `- id: ${TASK}\n  title: fixture\n  repo: fixrepo\n  type: implement\n  depends_on: []\n` +
      "  risk: low\n  verify: auto\n  status: queued\n  files: [src/a.ts]\n  acceptance: []\n",
    "src/a.ts": "export const a = 1;\n",
  } });
  const branch = `run-${TASK}-1794675190690`;
  clone.git("checkout", "--quiet", "-b", branch);
  writeFileSync(join(repoDir, "src/a.ts"), "export const a = 2;\n");
  clone.git("commit", "--quiet", "-am", "feat: fixture change");
  clone.git("push", "--quiet", "origin", branch);
  const head = clone.git("rev-parse", "HEAD");
  const base = clone.git("rev-parse", "main");
  clone.git("checkout", "--quiet", "main");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  // One earlier round at this head, so the rung asks the progress judge before it spawns a worker.
  writeFileSync(ledgerPath, opts.priorStrike ? JSON.stringify({ ts: new Date(PRIOR_ROUND_MS).toISOString(), run_id: `FIX-${PRIOR_ROUND_MS}`,
    task_id: TASK, step: "fix.dispatch", lane: "fix", strike: 1, pr_number: PR, head_sha: head, mode: "ci-log",
    round_id: "r1" }) + "\n" : "");
  const config = { root, claudeBin: "/bin/true",
    workerProviders: { enabled: ["codex"], codexBin: join(root, "absent", "codex") } } as unknown as Config;
  const home = join(root, "home");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify(config));
  const checks = [{ name: "ci-gate", status: "completed", conclusion: "failure", started_at: STAMP,
    details_url: "https://github.com/acme/fixrepo/actions/runs/1/job/7" }];
  const prRest = { number: PR, html_url: PR_URL, state: "open", merged: false, title: "fixture", body: `Remudero-Task: ${TASK}`,
    updated_at: STAMP, mergeable_state: "blocked", head: { ref: branch, sha: head }, base: { ref: "main", sha: base }, auto_merge: null };
  const shim = ghShim([
    { when: "required_status_checks", stdout: JSON.stringify({ contexts: ["ci-gate"] }) },
    { when: "/actions/jobs/7/logs", stdout: "not ok 1 - ci-gate fixture failure\n# fail 1" },
    { when: "headRefName,headRefOid", stdout: JSON.stringify({ headRefName: branch, headRefOid: head, body: `Remudero-Task: ${TASK}`,
      files: [{ path: "src/a.ts" }] }) },
    { when: `pulls/${PR}`, stdout: JSON.stringify(prRest) },
    { when: "pr view", stdout: JSON.stringify({ state: "OPEN", headRefOid: head, headRefName: branch }) },
    { when: "check-runs", stdout: JSON.stringify({ check_runs: checks }) },
    { when: "/status", stdout: JSON.stringify({ state: "failure", statuses: [] }) },
    { when: "", stdout: "{}" },
  ], { kind: "t12701-gh" });
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  // The judge's worker spawn reads the host config from HOME: this one enables only a provider that cannot be asked.
  process.env.HOME = home;
  t.after(() => {
    process.env.PATH = oldPath;
    process.env.HOME = oldHome;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { root, ledgerPath, head, branch, config, prRest, checks };
}

function effectsFor(w: World, log: (step: string, extra?: Row) => void) {
  return buildSweepEffects({ owner: "acme", repo: "fixrepo", config: w.config, ledgerPath: w.ledgerPath, runId: "SWEEP-T12701",
    plan: loadPlan(join(w.root, "repos", "fixrepo", "plan", "tasks.yaml")), log, policy: DEFAULT_SWEEP_POLICY,
    localRepoName: "selfrepo", spawnImpl: (async () => WORKER) as never } as never);
}

function redView(w: World): OpenPrView {
  return { prNumber: PR, prUrl: PR_URL, headSha: w.head, headRefName: w.branch, taskId: TASK, reviewState: "none",
    checksState: "red", unmetCriteria: [], priorStrikes: 1, lastActivityAt: STAMP,
    ciFailures: [{ name: "ci-gate", logTail: "not ok 1 - ci-gate fixture failure" }] } as unknown as OpenPrView;
}

/** Runs the verb in process and returns its exit code, the lines it printed and the rows it wrote. */
async function runVerb(w: World, args: string[], route?: NonNullable<Parameters<typeof fixCommand>[1]>["route"]) {
  const printed: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a: unknown[]) => { printed.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { printed.push(a.join(" ")); };
  let code: number;
  try {
    code = await fixCommand([String(PR), "--repo", "fixrepo", ...args], {
      config: w.config,
      self: { owner: "acme", repo: "selfrepo" },
      contributorAdmission: async () => {},
      fetch: (a) => {
        if (a[1] === `repos/acme/fixrepo/pulls/${PR}`) return w.prRest;
        if (a[1]?.includes("/check-runs?")) return { check_runs: w.checks };
        if (a[1]?.endsWith("/status")) return { statuses: [] };
        assert.fail(`unrouted REST read: ${a.join(" ")}`);
      },
      ...(route ? { route } : {}),
    });
  } finally {
    [console.log, console.error] = [log, error];
  }
  const rows = readFileSync(w.ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
  return { code, printed, rows: rows.filter((r) => String(r.run_id).startsWith("FIX-") && r.run_id !== `FIX-${PRIOR_ROUND_MS}`) };
}

test("W1-T12701 criterion 1: dispatchFix returns a no-round result for a handoff before any round, and spent after one", async (t) => {
  await t.test("the judge throws before the first round of this dispatch", async (c) => {
    const w = world(c, { priorStrike: true });
    const rows: Array<{ step: string }> = [];
    const outcome = await effectsFor(w, (step) => void rows.push({ step })).dispatchFix(redView(w),
      { unmetCriteria: [], ciFailures: redView(w).ciFailures, progressJudge: async () => {
        throw new ProviderCapacityBlockedError([]);
      } } as never);
    assert.equal(typeof outcome, "object");
    const notRun = outcome as { roundNotRun?: unknown; reason?: unknown };
    assert.equal(notRun.roundNotRun, true);
    assert.match(String(notRun.reason), /^fix progress judgment failed: ProviderCapacityBlockedError/);
    assert.equal(dispatchFixSpent(outcome), false, "a dispatch that ran no round spent nothing");
    assert.equal(rows.some((r) => r.step === "fix.dispatch" || r.step === "fix.retrigger"), false);
  });
  await t.test("the judge throws after a round of this dispatch wrote fix.dispatch", async (c) => {
    const w = world(c, { priorStrike: true });
    const rows: Array<{ step: string }> = [];
    let asked = 0;
    const outcome = await effectsFor(w, (step) => void rows.push({ step })).dispatchFix(redView(w),
      { unmetCriteria: [], ciFailures: redView(w).ciFailures, progressJudge: async () => {
        asked += 1;
        if (asked === 1) return { verdict: "continue", reason: "round two may act on the named failure" };
        throw new ProviderCapacityBlockedError([]);
      } } as never);
    assert.equal(asked, 2, "the judge was asked again after the round");
    assert.ok(rows.some((r) => r.step === "fix.dispatch"), "this dispatch ran a round");
    assert.equal(dispatchFixSpent(outcome), true, "a handoff after a real round still reads as spent");
    assert.equal(outcome, undefined);
  });
});

test("W1-T12701 criterion 2: the verb refuses, never fixed, when the judge throws ProviderCapacityBlockedError", async (t) => {
  const w = world(t, { priorStrike: true });
  const { code, rows } = await runVerb(w, ["--requested"]);
  assert.equal(code, 1);
  const judged = rows.find((r) => r.step === "fix.progress_judged");
  assert.equal(judged?.verdict, "unavailable", "the production judge ran and failed");
  assert.match(String(judged?.reason), /ProviderCapacityBlockedError/);
  assert.equal(rows.some((r) => r.step === "fix.dispatch"), false, "no round ran");
  assert.equal(rows.some((r) => r.step === "fix.disposed"), false, "never fix.disposed");
  const refused = rows.filter((r) => r.step === "fix.refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.outcome, "refused");
  assert.equal(refused[0]!.refusal, "progress_judgment_unavailable");
  assert.match(String(refused[0]!.provider_cause), /^ProviderCapacityBlockedError: no configured worker subscription has readable headroom/);
});

test("W1-T12701 criterion 3: the verb prints one no-round line with the provider cause, never dispatched", async (t) => {
  const w = world(t, { priorStrike: true });
  const { printed } = await runVerb(w, ["--requested"]);
  const verdictLines = printed.filter((l) => l.startsWith("### rmd fix"));
  assert.equal(verdictLines.length, 1, JSON.stringify(printed));
  assert.match(verdictLines[0]!, /^### rmd fix — PR #18422 is not fixable: no fix round ran: fix progress judgment failed: /);
  assert.match(verdictLines[0]!, /ProviderCapacityBlockedError: no configured worker subscription has readable headroom/);
  assert.equal(printed.some((l) => l.includes("dispatched the fix rung")), false);
});

test("W1-T12701 criterion 4: a verb run whose rung wrote fix.dispatch still reads fixed and exits 0", async (t) => {
  const w = world(t, { priorStrike: false });
  const rungRows: string[] = [];
  const { code, printed, rows } = await runVerb(w, ["--requested"], (state, pr, deps, policy) => {
    const effects = effectsFor(w, (step, extra) => { rungRows.push(step); deps.log?.(step, extra); });
    // The judge fails after the round, so the rung hands off with a round already spent.
    const dispatchFix: typeof effects.dispatchFix = (view, evidence, onPhase, control) => effects.dispatchFix(view,
      { ...evidence, progressJudge: async () => { throw new ProviderCapacityBlockedError([]); } }, onPhase, control);
    return routeFix(state, pr, { ...deps, dispatchFix }, policy);
  });
  assert.ok(rungRows.includes("fix.dispatch"), `the rung ran a round; steps ${JSON.stringify(rungRows)}`);
  assert.ok(rows.some((r) => r.step === "fix.progress_judged" && r.verdict === "unavailable"), "the rung handed off after it");
  assert.equal(code, 0);
  const disposed = rows.filter((r) => r.step === "fix.disposed");
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0]!.outcome, "fixed");
  assert.equal(disposed[0]!.refusal, undefined);
  assert.ok(printed.some((l) => l.startsWith(`### rmd fix — PR #${PR} (${TASK}): `) && l.endsWith("— dispatched the fix rung.")),
    JSON.stringify(printed));
});

test("W1-T12701 criterion 5: in runSweep a no-round result stands down, and is no claim decline", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12701-sweep-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledgerPath = join(dir, "ledger.ndjson");
  const at = "2026-11-14T16:54:00.000Z";
  const view = { prNumber: PR, prUrl: PR_URL, taskId: TASK, headSha: "f".repeat(40), headRefName: `run-${TASK}-1794675190690`,
    reviewState: "failure", checksState: "green", priorStrikes: 0, lastActivityAt: at, autoMergeArmed: false,
    unmetCriteria: [{ claim: "a criterion", proof: "unit test: fixture", met: false, reason: "not done", proof_exec: "not_executable" }],
  } as unknown as OpenPrView;
  const reason = "fix progress judgment failed: ProviderCapacityBlockedError: no configured worker subscription has readable headroom";
  let dispatched = 0;
  await runSweep([view], { runId: "SWEEP-T12701", ledgerPath, now: () => Date.parse(at),
    arm: () => assert.fail("red cannot arm"), close: () => assert.fail("not stale"), escalate: () => {},
    readLedger: () => readLedgerLines(ledgerPath),
    dispatchFix: () => { dispatched++; return { roundNotRun: true, reason }; } });
  assert.equal(dispatched, 1);
  const rows = readLedgerLines(ledgerPath);
  const disposed = rows.findLast((r) => r.step === "sweep.disposed" && r.pr_number === PR);
  assert.equal(disposed?.acted, false);
  assert.equal(disposed?.stand_down_reason, `no fix round ran: ${reason}`);
  assert.equal(rows.some((r) => r.step === "sweep.fix.checkout_claim_declined"), false);
  assert.equal(rows.some((r) => r.dispatch_held === "fix_claim_decline" || r.fix_claim_decline_escalated !== undefined), false);
});
