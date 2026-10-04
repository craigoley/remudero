/**
 * W1-T5283 — THE MAIN-HEALTH RUNG'S REMAINING gh CALLS NEVER BLOCK THE DAEMON LOOP.
 *
 * MEASURED 2026-10-02: a live CPU profile of the core daemon caught a 144 s loop stall, 50.2 s of
 * it in spawnSync < execFileSync < ghJson < main-health-rung.ts. #8674 moved the rung's `fetch`
 * reads to ghJsonAsync; this suite covers the three gh paths that were left synchronous: the issue
 * gateway (open, dedupe, close), the CI-failure evidence read and the Actions job requeue.
 *
 * Every "lets a timer fire" test runs the REAL async transport against a PATH-shimmed `gh` that holds
 * one call open, and counts the interval ticks the loop ran while that call was in flight. A sync
 * implementation cannot pass: it holds the loop until the child exits, so no tick observes it in
 * flight. No wall clock is read; the only number asserted is a count of ticks.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  escalate,
  escalateAsync,
  ghIssueGateway,
  ghIssueGatewayAsync,
  NEEDS_HUMAN_LABEL,
  runStepsAsync,
  runStepsSync,
  step,
  tryEscalate,
  tryEscalateAsync,
  type Escalation,
  type AsyncIssueGateway,
  type IssueGateway,
  type OpenIssue,
} from "../src/lib/escalate.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { buildMainHealthRung, type MainHealthRungDeps } from "../src/lib/main-health-rung.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  defaultCiAnnotationFetchAsync,
  defaultCiJobLogFetchAsync,
  fetchCiFailures,
  fetchCiFailuresAsync,
  requeueActionsJob,
  requeueActionsJobAsync,
  type CiFailureFetchOptions,
} from "../src/run-task.js";
import { ghShim, type GhShimRoute } from "./helpers/gh-shim.js";

type Row = Record<string, unknown>;
const HEAD = "a".repeat(40);
const JOB = "4242";
const JOB_URL = `https://github.com/o/r/actions/runs/1/job/${JOB}`;
const INFRA_ANNOTATIONS = JSON.stringify([
  { annotation_level: "failure", message: "Artifact upload completed successfully" },
  { annotation_level: "failure", message: "Finalizing artifact upload" },
  { annotation_level: "failure", message: "Failed to FinalizeArtifact: 403 Forbidden Error from intermediary" },
]);
const TEST_ANNOTATIONS = JSON.stringify([{ annotation_level: "failure", message: "ci shard 2 failed: expected 3, got 4" }]);
const OPEN_MAIN_HEALTH = JSON.stringify([
  { number: 7, url: "https://api.github.com/repos/o/r/issues/7", html_url: "https://github.com/o/r/issues/7", state: "open", title: "[BLOCKED] MAIN-HEALTH: main's own check suite is red", body: "**Task:** MAIN-HEALTH" },
]);

/** Counts the interval ticks the loop ran while `inFlight()` read true, across `call`. */
async function ticksWhileInFlight<T>(inFlight: () => boolean, call: () => Promise<T>): Promise<{ inFlightTicks: number; value: T }> {
  let inFlightTicks = 0;
  const interval = setInterval(() => {
    if (inFlight()) inFlightTicks += 1;
  }, 5);
  try {
    const value = await call();
    return { inFlightTicks, value };
  } finally {
    clearInterval(interval);
  }
}

/** A PATH `gh` answering `routes`, with `slow` held open 0.3 s and a marker written when it ends. */
function slowGh(kind: string, slow: string, routes: GhShimRoute[]) {
  const scratch = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5283-${kind}-`));
  const done = join(scratch, "slow.done");
  const shim = ghShim([{ ...routes.find((r) => r.when === slow), when: slow, delaySeconds: 0.3, doneFile: done }, ...routes.filter((r) => r.when !== slow)], {
    kind: `t5283-${kind}-gh`,
  });
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  return {
    shim,
    scratch,
    inFlight: () => shim.calls().some((call) => call.includes(slow)) && !existsSync(done),
    restore: () => {
      process.env.PATH = savedPath;
      rmSync(scratch, { recursive: true, force: true });
      rmSync(shim.dir, { recursive: true, force: true });
    },
  };
}

function readRows(path: string): Row[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const { ts: _ts, actor_pid: _pid, ...rest } = JSON.parse(line) as Row;
      return rest;
    });
}

/** A fake GitHub for the rung's awaited `fetch`: one head, one `ci` check of `conclusion`. */
function mainFetch(conclusion: "success" | "failure") {
  return async (args: string[]): Promise<unknown> => {
    const path = args[1]!;
    if (path === "repos/o/r") return { default_branch: "main" };
    if (path === "repos/o/r/commits/main") return { sha: HEAD };
    if (path.includes("/check-runs?")) return { check_runs: [{ id: 9, name: "ci", status: "completed", conclusion, details_url: JOB_URL }] };
    if (path.endsWith("/status")) return { statuses: [] };
    if (path.includes("/actions/runs?")) return { workflow_runs: [] };
    throw new Error(`unrouted: ${path}`);
  };
}

function rungHarness(kind: string, conclusion: "success" | "failure", ports: Pick<MainHealthRungDeps, "issues" | "readCiFailures" | "requeueCheck">) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5283-${kind}-`));
  const ledgerPath = join(root, "ledger.ndjson");
  const logged: Row[] = [];
  const rung = buildMainHealthRung("o", "r", {
    fetch: mainFetch(conclusion),
    ledgerPath,
    runId: "T5283",
    log: (s, extra) => void logged.push({ step: s, ...extra }),
    readRequiredChecks: () => ["ci"],
    ...ports,
  });
  return { rung, ledgerPath, logged, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A recording, scripted issue gateway; `async` wraps every call in a promise. */
function scriptedGateway(
  script: { open?: OpenIssue[] | Error; noList?: boolean; noClose?: boolean; createFails?: boolean; closeFails?: string; labelRefused?: string },
  wrap: "sync" | "async",
): { gateway: AsyncIssueGateway; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const answer = <T>(value: () => T): T | Promise<T> => (wrap === "async" ? Promise.resolve().then(value) : value());
  const gateway: AsyncIssueGateway = {
    create: (title, body, labels) =>
      answer(() => {
        calls.push(["create", title, labels]);
        if (script.createFails) throw new Error("gh issue create: HTTP 502");
        return "https://github.com/o/r/issues/99";
      }),
    ensureLabel: (label) => answer(() => (calls.push(["ensureLabel", label]), label !== script.labelRefused)),
    comment: (url, body) => answer(() => void calls.push(["comment", url, body.slice(0, 40)])),
    ...(script.noList
      ? {}
      : {
          listOpen: (label: string) =>
            answer(() => {
              calls.push(["listOpen", label]);
              if (script.open instanceof Error) throw script.open;
              return script.open ?? [];
            }),
        }),
    ...(script.noClose
      ? {}
      : {
          closeWithComment: (url: string, comment: string) =>
            answer(() => {
              calls.push(["close", url, comment.slice(0, 40)]);
              if (url === script.closeFails) throw new Error("gh issue close: HTTP 403");
            }),
        }),
  };
  return { gateway, calls };
}

test("W1-T5283: the main health issue gateway lets a timer fire while gh is in flight", async (t) => {
  // GREEN main resolves the open MAIN-HEALTH issue: `listOpen` is held open by the shim.
  const gh = slowGh("issues", "issues?labels=", [{ when: "issues?labels=", stdout: OPEN_MAIN_HEALTH }]);
  const h = rungHarness("issues", "success", { issues: ghIssueGatewayAsync("o", "r") });
  try {
    const { inFlightTicks } = await ticksWhileInFlight(gh.inFlight, () => h.rung());
    t.diagnostic(`issue gateway: ${inFlightTicks} loop tick(s) ran while gh api issues was in flight`);
    assert.ok(inFlightTicks > 0, "a timer must run while the rung's issue read is in flight");
    assert.deepEqual(
      h.logged.filter((r) => r.step !== "main.health.observed"),
      [{ step: "main.health.resolved", branch: "main", sha: HEAD, issue_url: "https://github.com/o/r/issues/7" }],
    );
    const calls = gh.shim.calls();
    assert.ok(calls.includes(`api repos/o/r/issues?labels=${encodeURIComponent(NEEDS_HUMAN_LABEL)}&state=open&per_page=100 --paginate`));
    assert.ok(calls.some((c) => c.startsWith("issue close https://github.com/o/r/issues/7 --repo o/r --comment Resolved automatically")));
  } finally {
    h.cleanup();
    gh.restore();
  }

  // RED main opens the escalation through the same async gateway: its dedup read is held open.
  const red = slowGh("issues-red", "issues?labels=", [
    { when: "issues?labels=", stdout: "[]" },
    { when: "issue create", stdout: "https://github.com/o/r/issues/12" },
  ]);
  const r = rungHarness("issues-red", "failure", { issues: ghIssueGatewayAsync("o", "r") });
  try {
    const { inFlightTicks } = await ticksWhileInFlight(red.inFlight, () => withLiveWritesAllowed(() => r.rung()));
    t.diagnostic(`issue gateway (red): ${inFlightTicks} loop tick(s) ran while the dedup read was in flight`);
    assert.ok(inFlightTicks > 0, "a timer must run while the escalation's dedup read is in flight");
    const escalated = r.logged.find((row) => row.step === "main.health.escalated");
    assert.equal(escalated?.issue_url, "https://github.com/o/r/issues/12");
    const opened = readRows(r.ledgerPath).find((row) => row.step === "escalation.issue_opened");
    assert.equal(opened?.issue_url, "https://github.com/o/r/issues/12");
    assert.ok(red.shim.calls().some((c) => c.startsWith("label create needs-human --repo o/r")));
  } finally {
    r.cleanup();
    red.restore();
  }
});

test("W1-T5283: the ci failure read lets a timer fire while gh is in flight", async (t) => {
  const gh = slowGh("ci", `check-runs/${JOB}/annotations`, [{ when: `check-runs/${JOB}/annotations`, stdout: TEST_ANNOTATIONS }]);
  const { gateway, calls } = scriptedGateway({}, "sync");
  const h = rungHarness("ci", "failure", {
    issues: gateway,
    readCiFailures: (rollup) => fetchCiFailuresAsync("o", "r", [...(rollup ?? [])]),
  });
  try {
    const { inFlightTicks } = await ticksWhileInFlight(gh.inFlight, () => h.rung());
    t.diagnostic(`ci failure read: ${inFlightTicks} loop tick(s) ran while the annotations read was in flight`);
    assert.ok(inFlightTicks > 0, "a timer must run while the rung's CI evidence read is in flight");
    assert.ok(!h.logged.some((r) => r.step === "main.health.ci_evidence_unreadable"));
    assert.ok(calls.some((c) => c[0] === "create"), "a non-infrastructure red still escalates");
    assert.deepEqual(gh.shim.calls(), [`api repos/o/r/check-runs/${JOB}/annotations`], "annotations answered, so no job log read");
  } finally {
    h.cleanup();
    gh.restore();
  }
});

test("W1-T5283: the requeue lets a timer fire while gh is in flight", async (t) => {
  const rerun = `actions/jobs/${JOB}/rerun`;
  const gh = slowGh("requeue", rerun, [{ when: `check-runs/${JOB}/annotations`, stdout: INFRA_ANNOTATIONS }, { when: rerun }]);
  const { gateway, calls } = scriptedGateway({}, "sync");
  const logged: Row[] = [];
  const h = rungHarness("requeue", "failure", {
    issues: gateway,
    readCiFailures: (rollup) => fetchCiFailuresAsync("o", "r", [...(rollup ?? [])]),
    requeueCheck: (failure) => requeueActionsJobAsync("o", "r", failure, (s, extra) => void logged.push({ step: s, ...extra })),
  });
  try {
    const { inFlightTicks } = await ticksWhileInFlight(gh.inFlight, () => h.rung());
    t.diagnostic(`requeue: ${inFlightTicks} loop tick(s) ran while the rerun POST was in flight`);
    assert.ok(inFlightTicks > 0, "a timer must run while the rung's requeue is in flight");
    assert.ok(gh.shim.calls().includes(`api -X POST repos/o/r/${rerun}`));
    const requeued = readRows(h.ledgerPath).filter((r) => r.step === "main.health.ci_requeued");
    assert.deepEqual(requeued.map((r) => [r.check_name, r.job_id, r.outcome]), [["ci", JOB, "dispatched"]]);
    assert.deepEqual(calls, [], "a dispatched infrastructure requeue opens no issue");
    assert.deepEqual(logged, []);
  } finally {
    h.cleanup();
    gh.restore();
  }
});

const ESCALATION: Escalation = {
  class: "BLOCKED",
  taskId: "W1-T9999",
  summary: "PR #42 is stuck",
  detail: "https://github.com/o/r/pull/42 needs a ruling.",
  headSha: "new-head",
  options: [{ label: "retry", detail: "try again", kind: { type: "operator-only" } }],
  recommendation: "retry",
};
const STALE: OpenIssue = { number: 5, url: "https://github.com/o/r/issues/5", title: "[BLOCKED] W1-T9999: PR #42 is stuck", body: "**Class:** BLOCKED\n**Task:** W1-T9999\n**Head:** old-head\n\nPR #42" };
const OTHER_STALE: OpenIssue = { ...STALE, number: 6, url: "https://github.com/o/r/issues/6" };
const SAME_HEAD: OpenIssue = { ...STALE, number: 8, url: "https://github.com/o/r/issues/8", body: "**Class:** BLOCKED\n**Task:** W1-T9999\n**Head:** new-head\n\nPR #42" };

test("W1-T5283: the awaited issue and requeue calls act exactly as the sync ones did", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5283-same-`));
  try {
    // (1) THE ESCALATION TRANSPORT: every dedup, create, supersede and failure arm, both drivers.
    const scenarios: Array<[string, Parameters<typeof scriptedGateway>[0], Escalation?]> = [
      ["no list surface creates", { noList: true }],
      ["an unreadable list refuses to create", { open: new Error("HTTP 502") }],
      ["a duplicate is commented, not reopened", { open: [SAME_HEAD] }],
      ["a new head supersedes the stale issues", { open: [STALE, OTHER_STALE] }],
      ["a supersede close failure is ledgered", { open: [STALE, OTHER_STALE], closeFails: STALE.url }],
      ["a gateway that cannot close", { open: [STALE], noClose: true }],
      ["a refused class label degrades", { labelRefused: "escalation-blocked" }],
      ["a failed create", { createFails: true }],
      ["no options is refused", {}, { ...ESCALATION, options: [] }],
    ];
    for (const [name, script, e] of scenarios) {
      const sync = scriptedGateway(script, "sync");
      const viaAsync = scriptedGateway(script, "async");
      const syncLedger = join(root, `${name}-sync.ndjson`);
      const asyncLedger = join(root, `${name}-async.ndjson`);
      const syncUrl = withLiveWritesAllowed(() => tryEscalate(e ?? ESCALATION, { issues: sync.gateway as IssueGateway, ledgerPath: syncLedger, runId: "R" }));
      const asyncUrl = await withLiveWritesAllowed(() => tryEscalateAsync(e ?? ESCALATION, { issues: viaAsync.gateway, ledgerPath: asyncLedger, runId: "R" }));
      assert.equal(asyncUrl, syncUrl, `${name}: the same issue url`);
      assert.deepEqual(viaAsync.calls, sync.calls, `${name}: the same gateway calls, in order`);
      assert.deepEqual(readRows(asyncLedger), readRows(syncLedger), `${name}: the same ledger rows`);
      assert.ok(readRows(syncLedger).length > 0, `${name}: the scenario ledgers something`);
    }
    // The throwing form agrees too: an unreadable dedup read is "" from both, a failed create throws from both.
    const unreadable = scriptedGateway({ open: new Error("HTTP 502") }, "async");
    assert.equal(await escalateAsync(ESCALATION, { issues: unreadable.gateway, ledgerPath: join(root, "u.ndjson"), runId: "R" }), "");
    assert.equal(escalate(ESCALATION, { issues: scriptedGateway({ open: new Error("x") }, "sync").gateway as IssueGateway, ledgerPath: join(root, "u2.ndjson"), runId: "R" }), "");
    await assert.rejects(
      withLiveWritesAllowed(() => escalateAsync(ESCALATION, { issues: scriptedGateway({ createFails: true }, "async").gateway, ledgerPath: join(root, "c.ndjson"), runId: "R" })),
      /HTTP 502/,
    );

    // (2) THE RUNG: a red escalation then a green resolution, through a sync and an async gateway.
    for (const conclusion of ["failure", "success"] as const) {
      const sync = scriptedGateway({ open: [{ number: 7, url: "https://github.com/o/r/issues/7", body: "**Task:** MAIN-HEALTH" }] }, "sync");
      const viaAsync = scriptedGateway({ open: [{ number: 7, url: "https://github.com/o/r/issues/7", body: "**Task:** MAIN-HEALTH" }] }, "async");
      const a = rungHarness(`rung-sync-${conclusion}`, conclusion, { issues: sync.gateway });
      const b = rungHarness(`rung-async-${conclusion}`, conclusion, { issues: viaAsync.gateway });
      try {
        await a.rung();
        await b.rung();
        assert.deepEqual(viaAsync.calls, sync.calls, `${conclusion}: the rung makes the same issue calls`);
        assert.deepEqual(readRows(b.ledgerPath), readRows(a.ledgerPath), `${conclusion}: the same ledger rows`);
        assert.deepEqual(b.logged, a.logged, `${conclusion}: the same log rows`);
      } finally {
        a.cleanup();
        b.cleanup();
      }
    }

    // (3) THE REQUEUE: no job id, a dispatched rerun, a refused one — same answer, argv and log.
    for (const [failure, fails] of [[{ name: "ci" }, false], [{ name: "ci", jobId: JOB }, false], [{ name: "ci", jobId: JOB }, true]] as const) {
      const run = (wrap: "sync" | "async") => {
        const argv: string[][] = [];
        const logged: Row[] = [];
        const exec = (args: string[]) => {
          argv.push(args);
          if (fails) throw new Error("403 rate limited");
          return "";
        };
        const log = (s: string, extra?: Row) => void logged.push({ step: s, ...extra });
        return {
          argv,
          logged,
          result:
            wrap === "sync"
              ? requeueActionsJob("o", "r", failure, log, exec)
              : requeueActionsJobAsync("o", "r", failure, log, async (args) => exec(args)),
        };
      };
      const sync = run("sync");
      const viaAsync = run("async");
      assert.equal(await viaAsync.result, sync.result);
      assert.deepEqual(viaAsync.argv, sync.argv);
      assert.deepEqual(viaAsync.logged, sync.logged);
    }

    // (4) THE CI EVIDENCE READ: every annotation and log outcome, both drivers.
    const rollup = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `shard ${i}`, conclusion: "FAILURE", detailsUrl: `https://github.com/o/r/actions/runs/1/job/${100 + i}` }));
    const fetchScenarios: Array<[string, CiFailureFetchOptions, number?]> = [
      ["annotations recovered", { fetchAnnotations: () => ["boom"], fetchJobLog: () => "" }],
      ["bare exit code reads the log", { fetchAnnotations: () => ["Process completed with exit code 1."], fetchJobLog: () => "not ok 1 - x\n  ...\n" }],
      ["empty annotations, empty log", { fetchAnnotations: () => [], fetchJobLog: () => "" }],
      ["annotations fail, log fails", { fetchAnnotations: () => { throw Object.assign(new Error("HTTP 403"), { code: "E403" }); }, fetchJobLog: () => { throw new Error("HTTP 404"); } }],
      ["a thrown non-error", { fetchAnnotations: () => { throw "plain"; }, fetchJobLog: () => { throw "plain"; } }],
      ["the read limit skips annotations", { fetchAnnotations: () => ["boom"], fetchJobLog: () => "##[error]step failed\n", annotationReadLimit: 1 }, 3],
    ];
    for (const [name, options, n] of fetchScenarios) {
      const sync = fetchCiFailures("o", "r", rollup(n ?? 1), 60, options);
      const viaAsync = await fetchCiFailuresAsync("o", "r", rollup(n ?? 1), 60, {
        ...options,
        fetchAnnotations: async (...args) => options.fetchAnnotations!(...args),
        fetchJobLog: async (...args) => options.fetchJobLog!(...args),
      });
      assert.deepEqual(viaAsync, sync, name);
    }
    assert.deepEqual(await fetchCiFailuresAsync("o", "r", undefined), [], "no rollup reads nothing");
    assert.deepEqual(await fetchCiFailuresAsync("o", "r", [{ name: "ci", conclusion: "FAILURE" }]), fetchCiFailures("o", "r", [{ name: "ci", conclusion: "FAILURE" }]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5283: the async issue gateway sends the sync gateway's argv and classifies its failures the same", async () => {
  const cap = "Commenting is disabled on issues with more than 2500 comments";
  const script = (args: string[]): string => {
    const joined = args.join(" ");
    if (joined.startsWith("label create refused")) throw new Error("HTTP 422");
    if (joined.includes("--comment") && joined.includes("issues/1 ")) throw new Error(`Command failed\n${cap}`);
    if (joined.includes("--comment") && joined.includes("issues/2 ")) throw new Error("HTTP 500");
    if (args[0] === "api") return OPEN_MAIN_HEALTH;
    return "https://github.com/o/r/issues/3\n";
  };
  const syncArgv: string[][] = [];
  const asyncArgv: string[][] = [];
  const sync = ghIssueGateway("o", "r", { exec: (args) => (syncArgv.push(args), script(args)) });
  const viaAsync = ghIssueGatewayAsync("o", "r", { exec: async (args) => (asyncArgv.push(args), script(args)) });
  await withLiveWritesAllowed(async () => {
    assert.equal(await viaAsync.ensureLabel!("ok"), sync.ensureLabel!("ok"));
    assert.equal(await viaAsync.ensureLabel!("refused"), sync.ensureLabel!("refused"));
    assert.equal(await viaAsync.create("t", "b", ["x", "y"]), sync.create("t", "b", ["x", "y"]));
    assert.deepEqual(await viaAsync.listOpen!(NEEDS_HUMAN_LABEL), sync.listOpen!(NEEDS_HUMAN_LABEL));
    assert.equal(await viaAsync.closeWithComment!("https://github.com/o/r/issues/1", "c"), sync.closeWithComment!("https://github.com/o/r/issues/1", "c"));
    assert.equal(await viaAsync.closeWithComment!("https://github.com/o/r/issues/4", "c"), sync.closeWithComment!("https://github.com/o/r/issues/4", "c"));
    await assert.rejects(Promise.resolve(viaAsync.closeWithComment!("https://github.com/o/r/issues/2", "c")), /HTTP 500/);
    assert.throws(() => sync.closeWithComment!("https://github.com/o/r/issues/2", "c"), /HTTP 500/);
    await viaAsync.comment!("https://github.com/o/r/issues/4", "hello");
    sync.comment!("https://github.com/o/r/issues/4", "hello");
  });
  assert.deepEqual(asyncArgv, syncArgv);
  // The live-write guard still refuses an unguarded create, as a rejection rather than a sync throw.
  const pending = viaAsync.create("t", "b", []);
  await assert.rejects(Promise.resolve(pending), /gh-issue-create/);
});

test("W1-T5283: the async defaults shell out to gh: the issue gateway, both evidence reads and the requeue", async () => {
  const gh = slowGh("defaults", "never-matched", [
    { when: "check-runs/1/annotations", stdout: JSON.stringify([{ annotation_level: "notice", message: "runner image" }, { annotation_level: "failure", message: "a; b" }]) },
    { when: "actions/jobs/2/logs", stdout: "line one" },
    { when: "actions/jobs/3/rerun", stderr: "HTTP 403", exit: 1 },
    { when: "issue comment", stderr: "HTTP 500", exit: 1 },
  ]);
  try {
    assert.deepEqual(await defaultCiAnnotationFetchAsync("o", "r", "1"), ["a; b"], "only failure-level annotations are kept");
    assert.equal((await defaultCiJobLogFetchAsync("o", "r", "2")).trim(), "line one");
    assert.equal(await requeueActionsJobAsync("o", "r", { name: "ci", jobId: "4" }, () => {}), true);
    const logged: Row[] = [];
    assert.equal(await requeueActionsJobAsync("o", "r", { name: "ci", jobId: "3" }, (s, extra) => void logged.push({ step: s, ...extra })), false);
    assert.equal(logged[0]?.step, "main.health.ci_requeue.error");
    assert.match(String(logged[0]?.error), /HTTP 403/);
    const issues = ghIssueGatewayAsync("o", "r");
    await assert.rejects(Promise.resolve(issues.comment!("https://github.com/o/r/issues/1", "x")), /HTTP 500/);
    assert.ok(gh.shim.calls().includes("api -X POST repos/o/r/actions/jobs/4/rerun"));
  } finally {
    gh.restore();
  }
});

test("W1-T5283: the step drivers resume a step's value and throw its failure back into the steps", async () => {
  function* steps(effect: () => unknown): Generator<() => unknown, string, unknown> {
    try {
      return `ok:${String(yield* step(effect))}`;
    } catch (error) {
      return `caught:${(error as Error).message}`;
    }
  }
  assert.equal(runStepsSync(steps(() => 1)), "ok:1");
  assert.equal(await runStepsAsync(steps(async () => 2)), "ok:2");
  assert.equal(runStepsSync(steps(() => { throw new Error("sync"); })), "caught:sync");
  assert.equal(await runStepsAsync(steps(async () => { throw new Error("async"); })), "caught:async");
});
