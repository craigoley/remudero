import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  deployFailedAlertPath,
  deployLastFailedPath,
  deployRefusalStreakPath,
  realDeployDeps,
  runDeployCycle,
} from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const CURRENT_HEAD = "current-healthy-head";
const FAILED_HEAD = "previous-refused-head";
const ISSUE = "https://github.com/fixture/remudero/issues/1";

function fixture(t: TestContext, markers = true) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6250-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"));
  const rows: Array<{ step: string; data: Record<string, unknown> }> = [];
  const closed: Array<{ url: string; comment: string }> = [];
  const subprocesses: string[] = [];
  const paths = [deployFailedAlertPath(root), deployLastFailedPath(root), deployRefusalStreakPath(root)];
  const deps = realDeployDeps({
    installPath: root, stateRoot: root, instance: "core",
    daemonLabel: "fixture-daemon", serveLabel: "fixture-serve", servePort: 4317, uid: 501,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    log: (step, data = {}) => rows.push({ step, data }),
    execFile: (cmd) => { subprocesses.push(cmd); throw new Error(`unexpected subprocess: ${cmd}`); },
    closeRefusalIssue: (url, comment) => closed.push({ url, comment }),
  });
  Object.assign(deps, {
    fetch: () => {}, installHead: () => CURRENT_HEAD, originMain: () => CURRENT_HEAD,
    runningHead: () => CURRENT_HEAD, daemonAlive: () => true, stopPresent: () => false,
    imageBakedCommitsBehind: () => 0, resourcePolicyDrift: () => [], mountPlanDrift: () => [],
  });
  if (markers) {
    deps.alert("recycle refused", FAILED_HEAD, "restart-refused");
    writeFileSync(paths[2]!, JSON.stringify({
      key: "fixture-refusal", count: 3, firstAtMs: Date.now(), lastAtMs: Date.now(),
      issueUrl: ISSUE, failedHead: FAILED_HEAD,
    }));
  }
  return { deps, rows, closed, paths, subprocesses };
}

test("W1-T6250: a healthy current skip retracts every stale deploy failure marker", (t) => {
  const h = fixture(t);
  const result = runDeployCycle(h.deps, { imageDriftOnly: true });
  assert.equal(result.deployed, false);
  assert.match(result.reason, /^up-to-date/);
  assert.deepEqual(h.paths.map((path) => existsSync(path)), [false, false, false]);
  assert.equal(h.deps.lastFailedAtMs!(), undefined);
  assert.equal(h.closed.length, 1);
  assert.equal(h.closed[0]!.url, ISSUE);
  assert.ok(h.closed[0]!.comment.includes(CURRENT_HEAD.slice(0, 9)));
  assert.deepEqual(h.rows.filter((row) => row.step === "deploy.failure_retracted").map((row) => row.data), [
    { marker: "DEPLOY_FAILED", failed_head: FAILED_HEAD, observed_current_head: CURRENT_HEAD },
    { marker: "DEPLOY_LAST_FAILED", failed_head: FAILED_HEAD, observed_current_head: CURRENT_HEAD },
    { marker: "DEPLOY_REFUSAL_STREAK", failed_head: FAILED_HEAD, observed_current_head: CURRENT_HEAD },
  ]);
  runDeployCycle(h.deps, { imageDriftOnly: true });
  assert.equal(h.closed.length, 1);
  assert.equal(h.rows.filter((row) => row.step === "deploy.failure_retracted").length, 3);
  assert.deepEqual(h.subprocesses, []);
});

test("W1-T6250: an unobserved-liveness skip keeps the failure markers", (t) => {
  const h = fixture(t);
  h.deps.daemonAlive = () => undefined;
  const before = h.paths.map((path) => readFileSync(path, "utf8"));
  const result = runDeployCycle(h.deps, { imageDriftOnly: true });
  assert.equal(result.deployed, false);
  assert.match(result.reason, /liveness not observed/);
  assert.deepEqual(h.paths.map((path) => readFileSync(path, "utf8")), before);
  assert.deepEqual(h.closed, []);
  assert.deepEqual(h.rows.filter((row) => row.step === "deploy.failure_retracted"), []);
  assert.deepEqual(h.subprocesses, []);
});

test("W1-T6250: a healthy current skip without markers emits no retraction row", (t) => {
  const h = fixture(t, false);
  assert.match(runDeployCycle(h.deps, { imageDriftOnly: true }).reason, /^up-to-date/);
  assert.deepEqual(h.rows.filter((row) => row.step === "deploy.failure_retracted"), []);
  assert.deepEqual(h.closed, []);
  assert.deepEqual(h.subprocesses, []);
});

test("W1-T6250: stale code, stale images and STOP skips keep the failure markers", (t) => {
  const cases = [
    { runningHead: () => "stale-running-head" },
    { installHead: () => "stale-install", runningHead: () => "stale-install" },
    { imageBakedCommitsBehind: () => 1 },
    { stopPresent: () => true },
    { stopPresent: () => undefined },
    { daemonAlive: () => false, stopPresent: () => true },
  ];
  for (const overrides of cases) {
    const h = fixture(t);
    Object.assign(h.deps, overrides);
    const before = h.paths.map((path) => readFileSync(path, "utf8"));
    assert.equal(runDeployCycle(h.deps, { imageDriftOnly: true }).deployed, false);
    assert.deepEqual(h.paths.map((path) => readFileSync(path, "utf8")), before);
    assert.deepEqual(h.closed, []);
    assert.deepEqual(h.rows.filter((row) => row.step === "deploy.failure_retracted"), []);
  }
});

test("W1-T6250: retraction names each marker's own failed head", (t) => {
  const h = fixture(t);
  writeFileSync(h.paths[0]!, JSON.stringify({ failedHead: "alert-head" }));
  writeFileSync(h.paths[1]!, "last-failed-head\n");
  runDeployCycle(h.deps, { imageDriftOnly: true });
  assert.deepEqual(h.rows.filter((row) => row.step === "deploy.failure_retracted").map((row) => row.data.failed_head),
    ["alert-head", "last-failed-head", FAILED_HEAD]);
});

test("W1-T6250: a lone legacy refusal streak retracts with an unknown failed head", (t) => {
  const h = fixture(t, false);
  writeFileSync(h.paths[2]!, JSON.stringify({ key: "legacy", count: 2, firstAtMs: 1, lastAtMs: 2 }));
  runDeployCycle(h.deps, { imageDriftOnly: true });
  assert.deepEqual(h.rows.filter((row) => row.step === "deploy.failure_retracted").map((row) => row.data), [
    { marker: "DEPLOY_REFUSAL_STREAK", failed_head: null, observed_current_head: CURRENT_HEAD },
  ]);
  assert.deepEqual(h.closed, []);
});

test("W1-T6250: a malformed alert is removed without inventing its failed head", (t) => {
  const h = fixture(t);
  writeFileSync(h.paths[0]!, "invalid json");
  runDeployCycle(h.deps, { imageDriftOnly: true });
  assert.equal(existsSync(h.paths[0]!), false);
  const unreadable = h.rows.find((row) => row.step === "deploy.failure_marker_unreadable");
  assert.equal(unreadable?.data.marker, "DEPLOY_FAILED");
  assert.match(String(unreadable?.data.error), /SyntaxError/);
  assert.equal(h.rows.find((row) => row.step === "deploy.failure_retracted")?.data.failed_head, null);
});

test("W1-T6250: an unreadable failure marker reports its error without claiming removal", (t) => {
  const h = fixture(t);
  rmSync(h.paths[0]!);
  mkdirSync(h.paths[0]!);
  runDeployCycle(h.deps, { imageDriftOnly: true });
  assert.equal(existsSync(h.paths[0]!), true);
  const failure = h.rows.find((row) => row.step === "deploy.failure_retraction_failed");
  assert.equal(failure?.data.marker, "DEPLOY_FAILED");
  assert.match(String(failure?.data.error), /EISDIR/);
  assert.equal(h.rows.filter((row) => row.step === "deploy.failure_retracted" && row.data.marker === "DEPLOY_FAILED").length, 0);
});

test("W1-T6250: a refusal marker unlink failure is reported without claiming retraction", (t) => {
  const h = fixture(t, false);
  mkdirSync(h.paths[2]!);
  assert.equal(h.deps.setRefusalStreak!(undefined), false);
  assert.equal(existsSync(h.paths[2]!), true);
  const failure = h.rows.find((row) => row.step === "deploy.failure_retraction_failed");
  assert.equal(failure?.data.marker, "DEPLOY_REFUSAL_STREAK");
  assert.match(String(failure?.data.error), /EISDIR|EPERM/);
  assert.deepEqual(h.rows.filter((row) => row.step === "deploy.failure_retracted"), []);
});

test("W1-T6250: a failed refusal clear emits no success row in the cycle", (t) => {
  const h = fixture(t);
  h.deps.setRefusalStreak = () => false;
  runDeployCycle(h.deps, { imageDriftOnly: true });
  assert.equal(existsSync(h.paths[2]!), true);
  assert.deepEqual(h.rows.filter((row) => row.step === "deploy.refusal_cleared"), []);
  assert.equal(h.rows.filter((row) => row.step === "deploy.failure_retracted" && row.data.marker === "DEPLOY_REFUSAL_STREAK").length, 0);
});

test("W1-T6250: a refused restart persists its failed head for the next healthy skip", (t) => {
  const h = fixture(t, false);
  let installed = "previous-head";
  let running = installed;
  let requested = true;
  Object.assign(h.deps, {
    installHead: () => installed, runningHead: () => running, markerPresent: () => requested,
    dirtyFiles: () => [], incomingFiles: () => [],
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    pullFf: () => { installed = CURRENT_HEAD; },
    restartBackends: () => [{
      name: "recycle-container", probe: () => true, describe: () => "fixture recycle",
      restart: () => { throw new Error("fixture refused restart"); },
    }],
  });
  const refusal = runDeployCycle(h.deps);
  assert.match(refusal.reason, /restart-refused/);
  assert.equal(h.deps.refusalStreak!()?.failedHead, CURRENT_HEAD);
  assert.deepEqual(h.paths.map((path) => existsSync(path)), [true, true, true]);
  running = installed;
  requested = false;
  assert.match(runDeployCycle(h.deps, { imageDriftOnly: true }).reason, /^up-to-date/);
  assert.deepEqual(h.paths.map((path) => existsSync(path)), [false, false, false]);
  assert.deepEqual(h.rows.filter((row) => row.step === "deploy.failure_retracted").map((row) => row.data.failed_head),
    [CURRENT_HEAD, CURRENT_HEAD, CURRENT_HEAD]);
  assert.deepEqual(h.subprocesses, []);
});
