/**
 * PRESERVED WORK SURVIVES A HOST LOSS. The live-edit ladder (#10799) and the fix-owner recovery arms
 * (W1-T6362, W1-T7719) wrote `refs/rmd-recovery/*` into the host checkout only. On 2026-10-11 the core
 * daemon checkout held 332 of them and origin held none. The daemon now publishes them to origin on its
 * ladder pass, create-only, through the same runner its dispatch claims push with, and keeps them by
 * evidence tier: never by count or age, and never dropping a record that was not both escalated and
 * restored. These suites drive it over real git trees: a bare origin, a live clone behind it carrying
 * a tracked edit, and a state root.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { clockFromMillisFn, fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import type { DaemonFreshness } from "#src/lib/daemon.js";
import { gitClaimRunnerAsync } from "#src/lib/dispatch-claim.js";
import { withLiveEditLadders } from "#src/lib/live-edit-ladder.js";
import { RECOVERY_REF_STEPS, readRecoveryRecords, recoveryRefMaintainer, recoveryTier } from "#src/lib/recovery-refs.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { liveEditLadderWiring } from "#src/run-task.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-11T00:17:00Z");
const ISSUE = "https://github.com/example/fleet/issues/7";

interface World {
  live: GitRepo;
  origin: GitRepo;
  author: GitRepo;
  state: string;
  setNow: (ms: number) => void;
  pass: () => Promise<DaemonFreshness>;
  rows: () => Array<Record<string, unknown>>;
  originRefs: () => Map<string, string>;
  localRefs: () => Map<string, string>;
}

function refs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split(/\s+/);
    out.set(ref!, sha!);
  }
  return out;
}

/** A live clone one commit behind origin, carrying one hand edit, and the daemon's ladder pass over it. */
function world(t: TestContext, escalateUrl = ISSUE): World {
  const origin = gitRepo({ bare: true, kind: "recovery-origin" });
  const author = gitRepo({ kind: "recovery-author" });
  writeFileSync(join(author.dir, "app.txt"), "v1\n");
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "seed");
  author.addRemote("origin", origin.dir);
  author.git("push", "--quiet", "origin", "main");
  const live = gitRepo({ cloneFrom: origin.dir, kind: "recovery-live" });
  writeFileSync(join(author.dir, "other.txt"), "main moves on\n");
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "feat: main moves on");
  author.git("push", "--quiet", "origin", "main");
  live.git("fetch", "--quiet", "origin", "main");
  writeFileSync(join(live.dir, "app.txt"), "hand edit\n");
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recovery-state-`));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  let now = T0;
  const ledger = join(state, "ledger.ndjson");
  const log = (step: string, extra: Record<string, unknown>) => writeFileSync(ledger, `${JSON.stringify({ step, ...extra })}\n`, { flag: "a" });
  const pass = withLiveEditLadders(async () => ({ stale: false }), {
    daemonRepoDir: live.dir, stateDir: state, host: "fleet-host", clock: clockFromMillisFn(() => now),
    escalate: async () => escalateUrl,
    comment: async () => {},
    recovery: recoveryRefMaintainer((dir) => gitClaimRunnerAsync(dir), state, log),
  });
  return {
    live, origin, author, state, pass,
    setNow: (ms) => { now = ms; },
    rows: () => existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [],
    originRefs: () => refs(origin.git("for-each-ref", "--format=%(objectname) %(refname)", "refs/rmd-recovery/")),
    localRefs: () => refs(live.git("for-each-ref", "--format=%(objectname) %(refname)", "refs/rmd-recovery/")),
  };
}

test("the daemon's ladder pass publishes a preserved live edit's recovery ref to origin", async (t) => {
  const w = world(t);
  await w.pass();
  const local = w.localRefs();
  assert.equal(local.size, 1, "the ladder preserved the edit as one recovery ref");
  const [ref, sha] = [...local][0]!;
  assert.match(ref, /^refs\/rmd-recovery\/live-edits\/fleet-host\//);
  assert.equal(w.originRefs().get(ref), sha, "origin holds the same commit, so the edit outlives this host");
  assert.equal(w.origin.git("show", `${ref}:app.txt`), "hand edit");
  assert.deepEqual(w.rows().filter((r) => r.step === RECOVERY_REF_STEPS.published).map((r) => r.refs), [[ref]]);
  await w.pass();
  assert.equal(w.rows().filter((r) => r.step === RECOVERY_REF_STEPS.published).length, 1, "a durable ref is not pushed again");
});

test("a fix-owner recovery ref with no record is published and then held on both sides", async (t) => {
  const w = world(t);
  const head = w.live.git("rev-parse", "HEAD");
  const ref = `refs/rmd-recovery/fix-dirty/run-W1-T1-1/${head}/${w.live.git("rev-parse", "HEAD^{tree}")}`;
  w.live.git("update-ref", ref, head);
  await w.pass();
  assert.equal(w.originRefs().get(ref), head, "the fix-owner ref reached origin");
  w.setNow(T0 + 2 * HOUR);
  await w.pass();
  assert.equal(w.localRefs().get(ref), head, "a ref with no escalated and restored record is never pruned from the host");
  assert.equal(w.originRefs().get(ref), head, "nor from origin");
});

test("publishing is create-only: a name origin holds at another commit is never moved", async (t) => {
  const w = world(t);
  const ref = "refs/rmd-recovery/fix/run-W1-T2-1/collide";
  const theirs = w.author.git("rev-parse", "HEAD");
  w.author.git("push", "--quiet", "origin", `${theirs}:${ref}`);
  const ours = w.live.git("rev-parse", "HEAD");
  assert.notEqual(ours, theirs);
  w.live.git("update-ref", ref, ours);
  await w.pass();
  assert.equal(w.originRefs().get(ref), theirs, "origin's ref is untouched");
  assert.equal(w.localRefs().get(ref), ours, "and the host keeps its own copy");
  assert.deepEqual(w.rows().filter((r) => r.step === RECOVERY_REF_STEPS.conflict).map((r) => r.refs), [[ref]]);
});

test("recovery retention tiers by evidence: only an escalated and restored record leaves the host, and origin only once landed", () => {
  const tier = (published: boolean, escalated: boolean, restored: boolean, landed: boolean) => recoveryTier({ published, escalated, restored, landed });
  assert.equal(tier(false, true, true, true), "unpublished");
  assert.equal(tier(true, false, true, true), "held", "an unescalated record is held even when its edits landed");
  assert.equal(tier(true, true, false, true), "held", "an unrestored record is held even when its edits landed");
  assert.equal(tier(true, true, true, false), "resolved");
  assert.equal(tier(true, true, true, true), "landed");
});

test("an escalated and restored live edit leaves the host first, and origin only after its edits land on main", async (t) => {
  const w = world(t);
  await w.pass();
  const [ref, sha] = [...w.localRefs()][0]!;
  w.setNow(T0 + 2 * HOUR);
  await w.pass();
  assert.equal(readFileSync(join(w.live.dir, "app.txt"), "utf8"), "v1\n", "tier 3 restored the tree");
  const [{ record }] = readRecoveryRecords(w.state, "daemon-checkout");
  assert.equal(record!.escalatedUrl, ISSUE, "the record notes its escalation");
  assert.equal(typeof record!.restoredAtMs, "number", "and its restore");
  assert.equal(w.localRefs().has(ref), false, "resolved: the host copy is dropped");
  assert.equal(w.originRefs().get(ref), sha, "origin keeps the only copy while the edits are not on main");
  for (const file of record!.files) assert.ok(existsSync(join(w.state, file)), `${file} is kept while origin holds the copy`);

  writeFileSync(join(w.author.dir, "app.txt"), "hand edit\n");
  w.author.git("commit", "--quiet", "-am", "fix: land the hand edit");
  w.author.git("push", "--quiet", "origin", "main");
  w.live.git("fetch", "--quiet", "origin", "main");
  await w.pass();
  assert.equal(w.originRefs().has(ref), false, "landed: the origin copy goes once main holds the edits");
  for (const file of record!.files) assert.equal(existsSync(join(w.state, file)), false, `${file} goes with it`);
  assert.ok(w.rows().some((r) => r.step === RECOVERY_REF_STEPS.pruned && (r.origin as string[]).includes(ref)));
});

test("a restored edit whose escalation never opened is held on both sides, even after its edits land", async (t) => {
  const w = world(t, "");
  await w.pass();
  const [ref, sha] = [...w.localRefs()][0]!;
  w.setNow(T0 + 2 * HOUR);
  await w.pass();
  assert.equal(readFileSync(join(w.live.dir, "app.txt"), "utf8"), "v1\n", "tier 3 restored the tree");
  writeFileSync(join(w.author.dir, "app.txt"), "hand edit\n");
  w.author.git("commit", "--quiet", "-am", "fix: land the hand edit");
  w.author.git("push", "--quiet", "origin", "main");
  w.live.git("fetch", "--quiet", "origin", "main");
  await w.pass();
  assert.equal(w.localRefs().get(ref), sha, "an unescalated record stays on the host");
  assert.equal(w.originRefs().get(ref), sha, "and on origin");
  const [{ record }] = readRecoveryRecords(w.state, "daemon-checkout");
  assert.equal(record!.escalatedUrl, undefined, "the record was never escalated");
  assert.equal(typeof record!.restoredAtMs, "number", "though it was restored");
});

test("the daemon's own live-edit wiring publishes recovery refs and ledgers it under its state root", async (t) => {
  const w = world(t);
  const head = w.live.git("rev-parse", "HEAD");
  const ref = `refs/rmd-recovery/fix/run-W1-T3-1/${head}`;
  w.live.git("update-ref", ref, head);
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}recovery-wiring-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const wiring = liveEditLadderWiring({ root, claudeBin: "/bin/true" } as Config, fixedClock(42));
  assert.ok(wiring.recovery, "the daemon wiring carries the recovery pass");
  await wiring.recovery(w.live.dir, "daemon-checkout");
  assert.equal(w.originRefs().get(ref), head, "the production runner pushed the ref to origin");
  const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(rows.some((r) => r.step === RECOVERY_REF_STEPS.published && r.task_id === "RECOVERY-REFS"), JSON.stringify(rows));
});

test("an unreachable origin, a torn record and an unreadable checkout are logged, and nothing is dropped", async (t) => {
  const w = world(t);
  await w.pass();
  const [ref, sha] = [...w.localRefs()][0]!;
  writeFileSync(join(w.state, "recovery", "live-edits", "daemon-checkout", "torn.json"), "{ not json");
  assert.equal(readRecoveryRecords(w.state, "daemon-checkout").length, 1, "a torn record is skipped, so its refs stay held");
  const rows: Array<Record<string, unknown>> = [];
  const log = (step: string, extra: Record<string, unknown>) => void rows.push({ step, ...extra });
  w.live.git("remote", "set-url", "origin", join(w.state, "no-such-origin"));
  w.live.git("update-ref", "refs/rmd-recovery/fix/run-W1-T4-1/kept", sha);
  await recoveryRefMaintainer((dir) => gitClaimRunnerAsync(dir), w.state, log)(w.live.dir, "daemon-checkout");
  assert.deepEqual(rows.map((r) => [r.step, r.reason]), [[RECOVERY_REF_STEPS.publishFailed, "ls-remote origin failed"]]);
  assert.equal(w.localRefs().get(ref), sha, "the host copy is untouched while origin is unreachable");
  await recoveryRefMaintainer((dir) => gitClaimRunnerAsync(dir), w.state, log)(join(w.state, "not-a-checkout"), "install-checkout");
  assert.equal(rows.at(-1)!.step, RECOVERY_REF_STEPS.publishFailed);
  assert.match(String(rows.at(-1)!.reason), /for-each-ref failed/);
});
