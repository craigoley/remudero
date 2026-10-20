import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runDaemon, type DaemonFreshness } from "../src/lib/daemon.js";
import { decideFreshnessRestart, DEPLOY_RESTART_RATE_CEILING_MS, DEPLOY_RESTART_SCORE_THRESHOLD } from "../src/lib/deploy-judge.js";
import { loadPlan } from "../src/lib/plan.js";
import { checkServiceFreshness, checkServiceFreshnessAsync, daemonFreshnessFromService, type ServiceFreshness } from "../src/lib/self-sync.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const START = Date.now();
const HORIZON = DEPLOY_RESTART_RATE_CEILING_MS;
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const NEXT = "c".repeat(40);
const PATHS = ["src/lib/daemon.ts", "README.md"];
const changes = (sha: string) => [{ sha, files: ["src/lib/inbox.ts"] }];
const service = (newSha = NEW, dirty = true): Extract<ServiceFreshness, { status: "assessed" }> => ({
  status: "assessed", dirty, dirty_paths: dirty ? PATHS : [],
  behind: { oldSha: OLD, newSha, changedPaths: ["src/lib/inbox.ts"], changes: changes(newSha) },
});
type Row = { step: string; at: number; extra: Record<string, unknown> };

async function daemon(read: (elapsed: number) => DaemonFreshness, steps: number, stepMs = HORIZON) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}dirty-freshness-`));
  const file = join(root, "tasks.yaml");
  writeFileSync(file, "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  let now = START;
  const rows: Row[] = [];
  try {
    const summary = await runDaemon(loadPlan(file), {
      refreshMerged: () => () => true,
      runOne: async (taskId) => ({ taskId, runId: "unused", merged: true, costUsd: 0, verdict: "merged" }),
      now: () => new Date(now),
      sleep: async () => { now += stepMs; },
      checkStop: () => now >= START + steps * stepMs ? "fixture complete" : undefined,
      checkFreshness: () => read(now - START),
      log: (step, extra = {}) => rows.push({ step, at: now, extra }),
      readLedgerLines: () => [],
    });
    return { summary, rows };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T7851: a dirty tree behind main is behind but never stale", () => {
  const reading = daemonFreshnessFromService(service());
  assert.equal(reading.stale, false);
  assert.ok(!reading.stale && reading.notStale.arm === "dirty");
  assert.equal(reading.notStale.behind, true);
  assert.equal(reading.notStale.oldSha, OLD);
  assert.equal(reading.notStale.newSha, NEW);
  assert.deepEqual(reading.notStale.changes, changes(NEW));
  const docs = daemonFreshnessFromService({ ...service(), behind: { oldSha: OLD, newSha: NEW, changedPaths: ["docs/guide.md"] } });
  assert.ok(!docs.stale && docs.notStale.arm === "dirty");
  assert.equal(docs.notStale.behind, false);
  const current = daemonFreshnessFromService({ ...service(), behind: null });
  assert.ok(!current.stale && current.notStale.arm === "dirty");
  assert.equal(current.notStale.behind, false);
  const unreadable = daemonFreshnessFromService({ ...service(), behind: { oldSha: OLD, newSha: NEW } });
  assert.ok(!unreadable.stale && unreadable.notStale.arm === "dirty");
  assert.equal(unreadable.notStale.behind, true);
});

test("W1-T7851: age pressure accrues while the checkout is dirty and behind", async () => {
  const { summary, rows } = await daemon((elapsed) => daemonFreshnessFromService(service(NEW, elapsed < 2 * HORIZON)), 4);
  assert.equal(summary.stopReason, "stale");
  const dirty = rows.filter((r) => r.step === "daemon.freshness_not_stale");
  assert.equal(dirty[0]!.extra.behind, true);
  assert.equal(dirty[0]!.extra.stale_since_ms, START);
  const aged = dirty.find((r) => r.at === START + HORIZON)!;
  const expected = decideFreshnessRestart({ changes: changes(NEW), busy: false, staleSinceMs: START,
    nowMs: START + 2 * HORIZON, state: { total: 0, scoredShas: [] } });
  assert.ok(Number(aged.extra.age_pressure) > 0);
  const clean = rows.find((r) => r.step === "daemon.freshness_decision")!;
  assert.equal(clean.at, START + 2 * HORIZON);
  assert.equal(clean.extra.age_pressure, expected.agePressure);
  assert.equal(clean.extra.pressure, expected.pressure, "repeated dirty readings score each commit only once");
  assert.equal(rows.filter((r) => r.step === "daemon_selfrestart_for_freshness").length, 1);
});

test("W1-T7851: a dirty reading names the tracked paths that make it dirty", async (t) => {
  const origin = gitRepo();
  writeFileSync(join(origin.dir, "README.md"), "tracked\n");
  writeFileSync(join(origin.dir, "with spaces.txt"), "tracked\n");
  origin.git("add", ".");
  origin.git("commit", "-qm", "test: tracked files");
  const repo = gitRepo({ cloneFrom: origin.dir });
  t.after(() => { repo.cleanup(); origin.cleanup(); });
  mkdirSync(join(origin.dir, "src"));
  writeFileSync(join(origin.dir, "src", "inbox.ts"), "export const version = 2;\n");
  origin.git("add", ".");
  origin.git("commit", "-qm", "feat: advance");
  writeFileSync(join(repo.dir, "README.md"), "local edit\n");
  writeFileSync(join(repo.dir, "with spaces.txt"), "local edit\n");
  writeFileSync(join(repo.dir, "untracked.txt"), "must stay absent\n");
  for (const check of [checkServiceFreshness, checkServiceFreshnessAsync]) {
    const svc = await check(repo.dir, {});
    assert.ok(svc.status === "assessed");
    assert.deepEqual(svc.dirty_paths, ["README.md", '"with spaces.txt"']);
    const read = daemonFreshnessFromService(svc);
    assert.ok(!read.stale && read.notStale.arm === "dirty");
    assert.deepEqual(read.notStale.dirty_paths, svc.dirty_paths);
    const { rows } = await daemon(() => read, 2);
    assert.deepEqual(rows.find((r) => r.step === "daemon.freshness_not_stale")!.extra.dirty_paths, svc.dirty_paths);
  }
  const many = daemonFreshnessFromService({ ...service(), dirty_paths: Array.from({ length: 30 }, (_, i) => `file-${i}.ts`) });
  assert.ok(!many.stale && many.notStale.arm === "dirty");
  assert.deepEqual(many.notStale.dirty_paths, Array.from({ length: 20 }, (_, i) => `file-${i}.ts`));
});

test("W1-T7851: a restart withheld by a dirty tree is named once per new sha", async () => {
  const { summary, rows } = await daemon((elapsed) => daemonFreshnessFromService(service(
    elapsed < 3 * HORIZON || elapsed >= 5 * HORIZON ? NEW : NEXT,
  )), 6);
  assert.notEqual(summary.stopReason, "stale");
  const blocked = rows.filter((r) => r.step === "daemon.freshness_blocked_dirty");
  assert.equal(blocked.length, 2);
  assert.deepEqual(blocked.map((r) => r.extra.new_sha), [NEW, NEXT]);
  assert.equal(blocked[0]!.at, START + HORIZON, "idle alone does not report a threshold-blocked restart");
  for (const row of blocked) {
    assert.equal(row.extra.old_sha, OLD);
    assert.equal(row.extra.stale_since_ms, START);
    assert.deepEqual(row.extra.dirty_paths, PATHS);
    assert.ok(Number(row.extra.age_pressure) > 0);
    assert.ok(Number(row.extra.pressure) > 0);
  }
  const control = await daemon(() => daemonFreshnessFromService({ ...service(), behind: null }), 3);
  assert.equal(control.rows.some((r) => r.step === "daemon.freshness_blocked_dirty"), false);
  assert.equal(control.rows.some((r) => r.extra.stale_since_ms !== undefined), false);
  const urgentService = service();
  // W1-T9089: the daemon's own code weighs the source floor of 1; change pressure reaches the threshold on its worth of commits.
  urgentService.behind!.changes = Array.from({ length: DEPLOY_RESTART_SCORE_THRESHOLD.value }, (_, index) => ({
    sha: index === 0 ? NEW : String(index).padStart(40, "f"), files: ["src/lib/daemon.ts"],
  }));
  const urgent = await daemon(() => daemonFreshnessFromService(urgentService), 2);
  const urgentBlocked = urgent.rows.filter((r) => r.step === "daemon.freshness_blocked_dirty");
  assert.equal(urgentBlocked.length, 1);
  assert.equal(urgentBlocked[0]!.at, START, "change pressure can reach the threshold before any age accrues");
  assert.equal(urgentBlocked[0]!.extra.age_pressure, 0);
  assert.notEqual(urgent.summary.stopReason, "stale");
});

test("dirty age preserves an earlier live-edit observation when the checkout becomes clean", async () => {
  const { rows } = await daemon((elapsed) => elapsed < HORIZON
    ? daemonFreshnessFromService(service())
    : { stale: true, oldSha: OLD, newSha: NEW, changes: changes(NEW), staleSinceMs: START - HORIZON }, 3);
  const expected = decideFreshnessRestart({ changes: changes(NEW), busy: false, staleSinceMs: START - HORIZON,
    nowMs: START + HORIZON, state: { total: 0, scoredShas: [] } });
  assert.equal(rows.find((r) => r.step === "daemon.freshness_not_stale")!.extra.stale_since_ms, START);
  assert.equal(rows.find((r) => r.step === "daemon.freshness_decision")!.extra.age_pressure, expected.agePressure);
});
