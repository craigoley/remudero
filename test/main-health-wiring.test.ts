import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildMainHealthRung,
  escalationFor,
  MAIN_HEALTH_TASK_ID,
  type MainHealthRungDeps,
} from "../src/lib/main-health-rung.js";
import { requeueActionsJob } from "../src/run-task.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { buildSweepHook } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { CiFailure } from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";

const OWNER = "craigoley";
const REPO = "remudero";
const RED_SHA = "1111111111111111111111111111111111111111";
const GREEN_SHA = "2222222222222222222222222222222222222222";

interface CreatedIssue extends OpenIssue {
  labels: string[];
}

function fixture(overrides: Partial<MainHealthRungDeps> = {}) {
  let sha = RED_SHA;
  let conclusion: "failure" | "success" = "failure";
  let throwOnRepoRead = false;
  const calls: string[] = [];
  const fetch = ((args: string[]) => {
    const path = args[1] ?? "";
    calls.push(path);
    if (throwOnRepoRead) throw new Error("GitHub unavailable");
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "trunk" };
    if (path === `repos/${OWNER}/${REPO}/commits/trunk`) return { sha };
    if (path === `repos/${OWNER}/${REPO}/commits/${sha}/check-runs?per_page=100`) {
      return {
        check_runs: [
          { name: "ci-shard (1/4)", status: "completed", conclusion },
          { name: "coverage-ratchet", status: "completed", conclusion: "success" },
          { name: "push-only-noop", status: "completed", conclusion: "skipped" },
        ],
      };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/${sha}/status`) return { statuses: [] };
    throw new Error(`unrouted gh api path: ${path}`);
  }) as GhApiFetcher;

  const created: CreatedIssue[] = [];
  const comments: Array<{ url: string; body: string }> = [];
  const closed: Array<{ url: string; comment: string }> = [];
  const issues: IssueGateway = {
    create: (title, body, labels) => {
      const issue = { number: 9000 + created.length, url: `https://github.com/${OWNER}/${REPO}/issues/${9000 + created.length}`, title, body, labels };
      created.push(issue);
      return issue.url;
    },
    listOpen: () => created.filter((issue) => !closed.some((entry) => entry.url === issue.url)),
    comment: (url, body) => comments.push({ url, body }),
    closeWithComment: (url, comment) => closed.push({ url, comment }),
  };
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const root = mkdtempSync(join(tmpdir(), "rmd-main-health-"));
  const ledgerPath = join(root, "ledger.ndjson");
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath,
    runId: "DAEMON-TEST",
    log: (step, extra = {}) => logs.push({ step, extra }),
    ...overrides,
  });

  return {
    calls,
    closed,
    comments,
    created,
    logs,
    ledgerPath,
    rung,
    green: () => {
      sha = GREEN_SHA;
      conclusion = "success";
    },
    failReads: () => {
      throwOnRepoRead = true;
    },
    disableResolution: () => {
      delete issues.listOpen;
      delete issues.closeWithComment;
    },
  };
}

const INFRA_TRANSCRIPT = [
  "Artifact upload completed successfully!",
  "Finalizing artifact upload",
  "Failed to FinalizeArtifact: (403) Forbidden: Error from intermediary",
].join("\n");

function mainFailure(overrides: Partial<CiFailure> = {}): CiFailure {
  return {
    name: "ci-shard (1/4)",
    conclusion: "FAILURE",
    jobId: "34250017967",
    logTail: INFRA_TRANSCRIPT,
    ...overrides,
  };
}

test("malformed GitHub metadata is named and swallowed instead of inventing a branch", async () => {
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch: (() => ({})) as GhApiFetcher,
    issues: { create: () => "unused" },
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-main-health-malformed-")), "ledger.ndjson"),
    runId: "DAEMON-MALFORMED",
    log: (step, extra = {}) => logs.push({ step, extra }),
  });

  await assert.doesNotReject(rung());
  assert.equal(logs.at(-1)?.step, "main.health.error");
  assert.match(String(logs.at(-1)?.extra.error), /omitted default_branch/);
});

test("a non-red observation cannot be converted into a main-health escalation", () => {
  assert.throws(
    () =>
      escalationFor(
        {
          state: "green",
          sha: GREEN_SHA,
          reason: "passing",
          failingChecks: [],
          pendingChecks: [],
          nonEvidenceChecks: [],
        },
        "main",
      ),
    /refusing to build a main-health escalation for green/,
  );
});

test("a red default-branch rollup is observed and escalated once without gating or reverting anything", async () => {
  const f = fixture();

  await f.rung();
  await f.rung();

  assert.equal(f.created.length, 1, "a stable red head must not create or append every sweep");
  assert.equal(f.comments.length, 0);
  assert.match(f.created[0]?.title ?? "", /^\[MANUAL\] MAIN-HEALTH:/);
  assert.match(f.created[0]?.body ?? "", /never auto-reverts or pauses unrelated dispatch/i);
  assert.match(f.created[0]?.body ?? "", /\*\*Task:\*\* MAIN-HEALTH/);
  assert.deepEqual(f.created[0]?.labels.slice(0, 1), ["needs-human"]);
  assert.equal(f.calls.filter((path) => path === `repos/${OWNER}/${REPO}`).length, 1, "default branch name is stable and cached");
  assert.equal(f.calls.filter((path) => path === `repos/${OWNER}/${REPO}/commits/trunk`).length, 2, "head sha is fresh each sweep");
  const observed = f.logs.find((entry) => entry.step === "main.health.observed");
  assert.equal(observed?.extra.state, "red");
  assert.deepEqual(observed?.extra.failing_checks, ["ci-shard (1/4)"]);
  assert.equal(f.logs.filter((entry) => entry.step === "main.health.escalated").length, 1);
});

test("main with only positively identified artifact-finalization infrastructure reruns the exact job once before escalation", async () => {
  const requeued: CiFailure[] = [];
  let ledgerPath = "";
  const f = fixture({
    readCiFailures: () => [mainFailure()],
    requeueCheck: (failure) => {
      assert.ok(
        readLedgerLines(ledgerPath).some(
          (line) =>
            line.step === "sweep.check_requeued" &&
            line.surface === "main" &&
            line.head_sha === RED_SHA &&
            line.check_name === failure.name,
        ),
        "the main retry bound is durable before the API call",
      );
      requeued.push(failure);
      return true;
    },
  });
  ledgerPath = f.ledgerPath;

  await f.rung();
  assert.equal(requeued.length, 1);
  assert.equal(f.created.length, 0, "the first bounded retry does not open MAIN-HEALTH");
  const telemetry = readLedgerLines(f.ledgerPath).find((line) => line.step === "main.health.ci_requeued");
  assert.equal(telemetry?.surface, "main");
  assert.equal(telemetry?.check_name, "ci-shard (1/4)");
  assert.equal(telemetry?.job_id, "34250017967");
  assert.equal(telemetry?.outcome, "dispatched");
  assert.equal(telemetry?.worker_strike_avoided, true);
  assert.ok(!("logTail" in (telemetry ?? {})) && !("log" in (telemetry ?? {})));

  await f.rung();
  assert.equal(requeued.length, 1, "the same head and check is never rerun twice");
  assert.equal(f.created.length, 1, "a repeated matching failure preserves the existing fail-closed escalation");
});

test("main infrastructure recovery fails closed for unreadable, unaddressable, mixed, and API-failed evidence", async () => {
  const cases: Array<{
    name: string;
    readCiFailures: () => CiFailure[] | undefined;
    requeueCheck?: () => boolean;
  }> = [
    { name: "unreadable", readCiFailures: () => undefined },
    { name: "missing job id", readCiFailures: () => [mainFailure({ jobId: undefined })] },
    {
      name: "mixed product failure",
      readCiFailures: () => [
        mainFailure(),
        mainFailure({ name: "ci-shard (2/4)", jobId: "22", logTail: "AssertionError: expected true" }),
      ],
    },
    { name: "rerun API failure", readCiFailures: () => [mainFailure()], requeueCheck: () => false },
  ];

  for (const c of cases) {
    const f = fixture({ readCiFailures: c.readCiFailures, ...(c.requeueCheck ? { requeueCheck: c.requeueCheck } : {}) });
    await f.rung();
    assert.equal(f.created.length, 1, `${c.name} opens the existing MAIN-HEALTH incident`);
  }
});

test("a later genuinely green head closes the MAIN-HEALTH escalation with evidence", async () => {
  const f = fixture();
  await f.rung();
  f.green();

  await f.rung();
  await f.rung();

  assert.equal(f.closed.length, 1, "a stable green head closes once, not every sweep");
  assert.equal(f.closed[0]?.url, f.created[0]?.url);
  assert.match(f.closed[0]?.comment ?? "", new RegExp(GREEN_SHA));
  assert.equal(f.logs.at(-1)?.step, "main.health.observed");
  assert.equal(f.logs.filter((entry) => entry.step === "main.health.resolved").length, 1);
});

test("green resolution without issue list and close support is explicit and fail-soft", async () => {
  const f = fixture();
  f.green();
  f.disableResolution();

  await assert.doesNotReject(f.rung());

  assert.equal(f.logs.at(-1)?.step, "main.health.error");
  assert.match(String(f.logs.at(-1)?.extra.error), /resolution requires issue list and close support/);
});

test("an undetermined rollup observes but neither escalates nor closes an existing incident", async () => {
  const f = fixture();
  f.green();
  await f.rung();
  const createdBefore = f.created.length;
  const closedBefore = f.closed.length;

  // A new head whose only real check is still running is not evidence of green or red.
  const pendingFetch = ((args: string[]) => {
    const path = args[1] ?? "";
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "main" };
    if (path === `repos/${OWNER}/${REPO}/commits/main`) return { sha: RED_SHA };
    if (path.endsWith("/check-runs?per_page=100")) return { check_runs: [{ name: "ci", status: "in_progress", conclusion: null }] };
    if (path.endsWith("/status")) return { statuses: [] };
    throw new Error(`unrouted gh api path: ${path}`);
  }) as GhApiFetcher;
  const pendingLogs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const pendingRung = buildMainHealthRung(OWNER, REPO, {
    fetch: pendingFetch,
    issues: {
      create: () => {
        throw new Error("must not create");
      },
      listOpen: () => f.created,
      closeWithComment: () => {
        throw new Error("must not close");
      },
    },
    ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-main-health-pending-")), "ledger.ndjson"),
    runId: "DAEMON-PENDING",
    log: (step, extra = {}) => pendingLogs.push({ step, extra }),
  });

  await pendingRung();

  assert.equal(f.created.length, createdBefore);
  assert.equal(f.closed.length, closedBefore);
  assert.equal(pendingLogs.find((entry) => entry.step === "main.health.observed")?.extra.state, "undetermined");
});

test("a GitHub read failure is named and swallowed so the PR sweep can continue", async () => {
  const f = fixture();
  f.failReads();

  await assert.doesNotReject(f.rung());

  assert.equal(f.created.length, 0);
  assert.equal(f.logs.at(-1)?.step, "main.health.error");
  assert.match(String(f.logs.at(-1)?.extra.error), /GitHub unavailable/);
  assert.equal(MAIN_HEALTH_TASK_ID, "MAIN-HEALTH");
});

test("the full sweep contains an injected main-health failure and continues its PR reconciliation", async () => {
  const bin = mkdtempSync(join(tmpdir(), "rmd-main-health-gh-"));
  const root = mkdtempSync(join(tmpdir(), "rmd-main-health-sweep-"));
  writeFileSync(join(bin, "gh"), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  const steps: string[] = [];
  try {
    const hook = buildSweepHook(
      "o",
      "r",
      { root, claudeBin: "/bin/true" } as Config,
      join(root, "ledger.ndjson"),
      "DAEMON-TEST",
      { tasks: [], byId: new Map() },
      (step) => steps.push(step),
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {
        throw new Error("observer exploded");
      },
    );

    await assert.doesNotReject(hook());

    assert.ok(steps.includes("main.health.error"));
    assert.ok(!steps.includes("sweep.error"), "the PR sweep's own boundary was never tripped");
  } finally {
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemonCommand supplies the real REST and issue gateways to the one event-and-sweep observer", () => {
  const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const observerStart = source.indexOf("const mainHealthRung = buildMainHealthRung(");
  const call = source.slice(observerStart, source.indexOf("sweepLight: buildSweepLightHook(", observerStart));

  assert.ok(observerStart > 0, "one observer is constructed before both production call sites");
  assert.match(call, /buildMainHealthRung\(target\.owner, target\.repo/);
  assert.match(call, /fetch: ghJson/);
  assert.match(call, /issues: ghIssueGateway\(target\.owner, target\.repo\)/);
  assert.match(call, /readCiFailures:\s*\(rollup\)\s*=>\s*fetchCiFailures/);
  // W1-T3194: the endpoint literal moved into `requeueActionsJob` when it was extracted so its
  // three arms could be unit-tested. The INVARIANT is unchanged and still asserted, one hop over:
  // the wiring delegates to that function, and that function targets ONE job by id, never the
  // whole-run `rerun-failed-jobs` endpoint.
  assert.match(call, /requeueCheck:\s*\(failure\)\s*=>\s*requeueActionsJob\(target\.owner, target\.repo, failure, log\)/);
  const requeueFn = source.slice(source.indexOf("export function requeueActionsJob("));
  const requeueBody = requeueFn.slice(0, requeueFn.indexOf("\nexport "));
  assert.match(requeueBody, /actions\/jobs\/\$\{failure\.jobId\}\/rerun/);
  assert.doesNotMatch(requeueBody, /rerun-failed-jobs/);
  assert.match(call, /onCheckBurstSettled:\s*\(\)\s*=>\s*void mainHealthRung\(\)/);
  assert.match(call, /buildSweepHook\([\s\S]*?mainHealthRung[\s\S]*?\)/);
});

// W1-T3194 — the PRODUCTION `requeueCheck`, which no test above reaches: every one of them
// supplies its own, so `daemonCommand`'s real closure was unreachable and diff-coverage flagged
// all three of its arms. Extracted to `requeueActionsJob` with an injectable `exec` so the real
// body runs here against a recorder rather than a real POST.
test("requeueActionsJob: a resolvable job id reruns exactly that job, by its own id", () => {
  const calls: string[][] = [];
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  const ok = requeueActionsJob(
    "acme",
    "scratch",
    { name: "ci-shard (2/4)", jobId: "34249290033" },
    (step: string, extra?: Record<string, unknown>) => logged.push([step, extra]),
    (args: string[]) => calls.push(args),
  );
  assert.equal(ok, true);
  assert.deepEqual(calls, [["api", "-X", "POST", "repos/acme/scratch/actions/jobs/34249290033/rerun"]]);
  assert.equal(logged.length, 0, "a clean rerun says nothing — the caller ledgers the outcome");
});

test("requeueActionsJob: no resolvable job id reruns nothing and never throws", () => {
  const calls: string[][] = [];
  const ok = requeueActionsJob("acme", "scratch", { name: "ci-shard (2/4)" }, () => {}, (args: string[]) => calls.push(args));
  assert.equal(ok, false);
  assert.deepEqual(calls, [], "there is nothing to address the API call to");
});

test("requeueActionsJob: a refused API call is ledgered and returns false, never thrown", () => {
  // The arm that matters most: a rerun that cannot happen must not take down the health rung
  // that asked for it.
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  const ok = requeueActionsJob(
    "acme",
    "scratch",
    { name: "ci-shard (4/4)", jobId: "999" },
    (step: string, extra?: Record<string, unknown>) => logged.push([step, extra]),
    () => {
      throw new Error("403 rate limited");
    },
  );
  assert.equal(ok, false);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "main.health.ci_requeue.error");
  assert.equal(logged[0][1]?.check_name, "ci-shard (4/4)");
  assert.equal(logged[0][1]?.job_id, "999");
  assert.match(String(logged[0][1]?.error), /403 rate limited/);
});
