import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  REFUSAL_ESCALATE_AT,
  deployRefusalStreakPath,
  escalatePersistingRefusal,
  realDeployDeps,
  refusalReasonKey,
  runDeployCycle,
  type DeployDeps,
  type RefusalStreak,
} from "../src/lib/deployer.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// MEASURED 2026-10-04..06: site and console refused every image recycle for two days while their
// images fell 46 baked commits behind; the only trace was state/DEPLOY_FAILED and an hourly
// `deploy.restart_refused` row. A refusal that recurs must be counted, logged as persisting with the
// image's lag, escalated ONCE per instance and reason, and closed by a verified recycle.

const REFUSAL = "recycle-container.sh refused: 2 workers still running past the wait\nRemedy: stop the workers or raise --wait";

interface Harness {
  deps: DeployDeps;
  rows: Array<{ step: string; data: Record<string, unknown> }>;
  issues: Array<OpenIssue & { open: boolean; comments: string[]; closedWith?: string }>;
  gateway: IssueGateway;
  setRefusing(message: string | undefined): void;
  setLag(n: number | undefined): void;
  setHealthy(h: boolean): void;
  streak(): RefusalStreak | undefined;
}

function harness(ledgerPath: string, withGateway = true): Harness {
  const rows: Harness["rows"] = [];
  const issues: Harness["issues"] = [];
  let refusing: string | undefined = REFUSAL;
  let lag: number | undefined = 46;
  let healthy = true;
  let streak: RefusalStreak | undefined;
  let clock = Date.parse("2026-10-04T00:00:00Z");
  const gateway: IssueGateway = {
    create: (title, body) => {
      const n = issues.length + 1;
      issues.push({ number: n, url: `https://github.com/o/r/issues/${n}`, title, body, open: true, comments: [] });
      return `https://github.com/o/r/issues/${n}`;
    },
    listOpen: () => issues.filter((i) => i.open),
    comment: (url, body) => {
      issues.find((i) => i.url === url)!.comments.push(body);
    },
    closeWithComment: (url, comment) => {
      const i = issues.find((x) => x.url === url)!;
      i.open = false;
      i.closedWith = comment;
    },
  };
  const deps = {
    log: (step: string, data: Record<string, unknown> = {}) => rows.push({ step, data }),
    now: () => (clock += 60 * 60_000),
    fetch: () => {},
    installHead: () => "oldhead",
    runningHead: () => "oldhead",
    originMain: () => "newhead",
    markerPresent: () => true,
    autoMode: () => false,
    lastFailedHead: () => undefined,
    dirtyFiles: () => [],
    incomingFiles: () => [],
    pullFf: () => {},
    resetHard: () => {},
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    kickstart: () => {},
    restartBackends: () => [
      {
        name: "recycle-container",
        probe: () => true,
        describe: () => "recycle-container",
        restart: () => {
          if (refusing !== undefined) throw new Error(refusing);
        },
      },
    ],
    waitBootHealth: () => ({ bootObserved: healthy, crashCount: 0 }),
    alert: () => {},
    clearMarker: () => {},
    clearFailure: () => {},
    kickstartConsole: () => {},
    consolePid: () => 1,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
    imageBakedCommitsBehind: () => lag,
    refusalInstance: () => "site",
    refusalStreak: () => streak,
    setRefusalStreak: (s: RefusalStreak | undefined) => {
      streak = s;
    },
    ...(withGateway
      ? {
          escalateRefusal: (r: Parameters<typeof escalatePersistingRefusal>[0]) =>
            escalatePersistingRefusal(r, { issues: gateway, ledgerPath, runId: "DEPLOY-test" }),
          closeRefusalIssue: (url: string, comment: string) => gateway.closeWithComment!(url, comment),
        }
      : {}),
  } as unknown as DeployDeps;
  return {
    deps,
    rows,
    issues,
    gateway,
    setRefusing: (m) => {
      refusing = m;
    },
    setLag: (n) => {
      lag = n;
    },
    setHealthy: (h) => {
      healthy = h;
    },
    streak: () => streak,
  };
}

function scratch(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}refusal-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "ledger.ndjson");
}

test("W1-T6062: a refusal that recurs is recorded as persisting with its lag", (t) => {
  const h = harness(scratch(t));
  runDeployCycle(h.deps);
  assert.equal(h.rows.filter((r) => r.step === "deploy.restart_refused").length, 1);
  assert.equal(
    h.rows.filter((r) => r.step === "deploy.refusal_persisting").length,
    0,
    "the first refusal keeps today's row and nothing more",
  );

  h.setLag(47);
  runDeployCycle(h.deps);
  const second = h.rows.filter((r) => r.step === "deploy.refusal_persisting");
  assert.equal(second.length, 1);
  assert.equal(second[0]!.data.count, 2);
  assert.equal(second[0]!.data.baked_commits_behind, 47);
  assert.equal(second[0]!.data.instance, "site");

  runDeployCycle(h.deps);
  const third = h.rows.filter((r) => r.step === "deploy.refusal_persisting");
  assert.equal(third.length, 2);
  assert.equal(third[1]!.data.count, 3);
});

test("W1-T6062: a different refusal reason restarts the count rather than extending it", (t) => {
  const h = harness(scratch(t));
  runDeployCycle(h.deps);
  h.setRefusing("image-id mismatch after pull");
  runDeployCycle(h.deps);
  assert.equal(h.rows.filter((r) => r.step === "deploy.refusal_persisting").length, 0);
  assert.equal(h.streak()!.count, 1);
  assert.notEqual(refusalReasonKey(REFUSAL), refusalReasonKey("image-id mismatch after pull"));
  // a changing number inside the same refusal is still the same reason
  assert.equal(refusalReasonKey("2 workers past 600s"), refusalReasonKey("5 workers past 900s"));
});

test("W1-T6062: a persisting refusal opens one issue and a verified recycle closes it", (t) => {
  const h = harness(scratch(t));
  for (let i = 1; i < REFUSAL_ESCALATE_AT; i += 1) runDeployCycle(h.deps);
  assert.equal(h.issues.length, 0, "no issue before the refusal has persisted long enough");

  runDeployCycle(h.deps); // window REFUSAL_ESCALATE_AT
  assert.equal(h.issues.length, 1);
  const issue = h.issues[0]!;
  assert.match(issue.title ?? "", /site/);
  assert.match(issue.body ?? "", /Remedy: stop the workers or raise --wait/);
  assert.match(issue.body ?? "", /46 baked-path commit\(s\)/);
  assert.equal(h.streak()!.issueUrl, issue.url);

  // the refusal keeps persisting: the SAME issue is updated, never a second opened
  runDeployCycle(h.deps);
  runDeployCycle(h.deps);
  assert.equal(h.issues.length, 1);
  assert.ok(issue.comments.length >= 2, "persisting windows update the open issue");
  assert.equal(issue.open, true);

  // a verified recycle retracts the streak and closes the issue
  h.setRefusing(undefined);
  const out = runDeployCycle(h.deps);
  assert.equal(out.deployed, true, out.reason);
  assert.equal(issue.open, false);
  assert.match(issue.closedWith ?? "", /verified healthy/);
  assert.equal(h.streak(), undefined);
  assert.equal(h.rows.filter((r) => r.step === "deploy.refusal_cleared").length, 1);
});

test("W1-T6062: a different instance opens its own issue for the same reason", (t) => {
  const ledgerPath = scratch(t);
  const a = harness(ledgerPath);
  for (let i = 0; i < REFUSAL_ESCALATE_AT; i += 1) runDeployCycle(a.deps);
  const gateway = a.gateway;
  const key = refusalReasonKey(REFUSAL);
  const base = {
    key,
    count: 3,
    firstAtMs: 0,
    lastAtMs: 1,
    lagCommits: 46,
    message: REFUSAL,
    remedy: "Remedy: x",
    toHead: "newhead",
    backend: "recycle-container",
  };
  escalatePersistingRefusal({ ...base, instance: "console" }, { issues: gateway, ledgerPath, runId: "r" });
  assert.equal(a.issues.length, 2);
  escalatePersistingRefusal({ ...base, instance: "console" }, { issues: gateway, ledgerPath, runId: "r" });
  assert.equal(a.issues.length, 2, "the same instance and reason updates, never reopens");
});

test("W1-T6062: with no issue gateway the refusal is still counted and logged", (t) => {
  const h = harness(scratch(t), false);
  for (let i = 0; i < REFUSAL_ESCALATE_AT; i += 1) runDeployCycle(h.deps);
  assert.equal(h.issues.length, 0);
  assert.equal(h.streak()!.count, REFUSAL_ESCALATE_AT);
  assert.equal(h.rows.filter((r) => r.step === "deploy.refusal_persisting").length, REFUSAL_ESCALATE_AT - 1);
});

test("W1-T6062: an escalation that throws never breaks the cycle", (t) => {
  const h = harness(scratch(t));
  (h.deps as { escalateRefusal?: unknown }).escalateRefusal = () => {
    throw new Error("gh down");
  };
  for (let i = 0; i < REFUSAL_ESCALATE_AT; i += 1) {
    const out = runDeployCycle(h.deps);
    assert.match(out.reason, /restart-refused/);
  }
  const failed = h.rows.filter((r) => r.step === "deploy.refusal_escalation_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.data.error, "gh down");
});

test("W1-T6062: the shipped streak survives a fresh process and clears on retraction", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}refusal-streak-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  const make = () =>
    realDeployDeps({
      installPath: root,
      stateRoot: root,
      daemonLabel: "com.remudero.daemon",
      serveLabel: "com.remudero.serve",
      servePort: 4317,
      uid: 501,
      ledgerPath: join(root, "ledger.ndjson"),
      log: () => {},
      sleep: () => {},
    });
  assert.equal(make().refusalStreak!(), undefined);
  const streak: RefusalStreak = { key: "abc", count: 2, firstAtMs: 1, lastAtMs: 2 };
  make().setRefusalStreak!(streak);
  assert.deepEqual(make().refusalStreak!(), streak);
  make().setRefusalStreak!(undefined);
  assert.equal(existsSync(deployRefusalStreakPath(root)), false);
  assert.equal(make().refusalStreak!(), undefined);
});
