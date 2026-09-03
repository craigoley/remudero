import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMainHealthRung, escalationFor, MAIN_HEALTH_TASK_ID } from "../src/lib/main-health-rung.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { buildSweepHook } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

const OWNER = "craigoley";
const REPO = "remudero";
const RED_SHA = "1111111111111111111111111111111111111111";
const GREEN_SHA = "2222222222222222222222222222222222222222";

interface CreatedIssue extends OpenIssue {
  labels: string[];
}

function fixture() {
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
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "DAEMON-TEST",
    log: (step, extra = {}) => logs.push({ step, extra }),
  });

  return {
    calls,
    closed,
    comments,
    created,
    logs,
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
  assert.match(call, /onCheckBurstSettled:\s*\(\)\s*=>\s*void mainHealthRung\(\)/);
  assert.match(call, /buildSweepHook\([\s\S]*?mainHealthRung[\s\S]*?\)/);
});
