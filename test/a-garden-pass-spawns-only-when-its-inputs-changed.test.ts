import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "../src/lib/clock.js";
import { GARDEN_HOURLY_FLAG, GARDEN_PASS_STEP, gardenPacingPath, startGardenOffLoop, type GardenPassSpawn } from "../src/lib/garden-registry.js";
import { evidenceCoverageStatePath } from "../src/lib/evidence-coverage-gardener.js";
import { machineJudgeInputs } from "../src/lib/machine-filing-judge.js";
import { CONFIG_TEND_INTERVAL_MS, configCanariesDue, configCanariesPath } from "../src/lib/config-gardener.js";
import { gardenEffectsPath, gardenPassDue, gardenPendingSignal, gardenPendingWatchPath, gardenStatePath } from "../src/lib/gardener.js";
import { boardOpenSnapshotPath } from "../src/lib/board-snapshot-cache.js";
import { readOriginMainSha } from "../src/lib/inbox.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildRegisteredGarden, registeredGardenDueProbe, type GardenBuildContext } from "../src/run-task.js";

// MEASURED 2026-10-01 14:00-15:54Z, after W1-T5114 moved every garden pass into a child process: 322
// garden.pass rows in about two hours (each garden every 3-4 minutes, median 29 s, all exit 0), about 5.4
// garden children alive on average and a host load near 13 on 8 CPUs. The gardener's own "nothing changed"
// skip ran only INSIDE the child, after a full node + tsx boot. The parent now asks first.

const classes = ["a"] as const;
const spec = (cheap: string) => ({ name: "probe", classes, cheapFingerprint: () => cheap });

function stateDir(t: { after: (fn: () => void) => void }, state?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-due-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (state) writeFileSync(gardenStatePath(dir, "probe"), JSON.stringify({ classes: { a: { alpha: 3, beta: 1 } }, ...state }));
  return dir;
}

function spy() {
  const calls: Array<readonly string[]> = [];
  const spawnPass: GardenPassSpawn = async (_name, args) => (calls.push(args), 0);
  return { calls, spawnPass };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an unchanged cheap fingerprint spawns no garden child", async (t) => {
  const dir = stateDir(t, { lastCheap: "same" });
  assert.equal(gardenPassDue(spec("same"), { stateDir: dir }), false, "the child would read nothing more");
  const { calls, spawnPass } = spy();
  const out: string[] = [];
  const garden = startGardenOffLoop("plan", 60 * 60 * 1000, { spawnPass, log: (step) => void out.push(step), due: () => gardenPassDue(spec("same"), { stateDir: dir }) });
  t.after(() => garden.stop());
  await settle();
  assert.equal(calls.length, 0, "no child is spawned for a pass that would skip");
  assert.equal(out.filter((s) => s === GARDEN_PASS_STEP).length, 0, "a skipped tick writes no row");
});

test("a changed cheap fingerprint still spawns a garden child", async (t) => {
  const dir = stateDir(t, { lastCheap: "before" });
  assert.equal(gardenPassDue(spec("after"), { stateDir: dir }), true);
  const { calls, spawnPass } = spy();
  const garden = startGardenOffLoop("plan", 60 * 60 * 1000, { spawnPass, log: () => {}, due: () => gardenPassDue(spec("after"), { stateDir: dir }) });
  t.after(() => garden.stop());
  await settle();
  assert.equal(calls.length, 1);
});

test("a garden with a pending PR, waiting effects or no state yet is always due", (t) => {
  const pending = stateDir(t, { lastCheap: "same", pending: { prUrl: "https://github.com/o/r/pull/1", actionClass: "a", baseline: { trials: 0, successes: 0 } } });
  assert.equal(gardenPassDue(spec("same"), { stateDir: pending }), true, "a pending PR's outcome is judged by the pass");
  const effects = stateDir(t, { lastCheap: "same" });
  writeFileSync(gardenEffectsPath(effects, "probe"), "[]");
  assert.equal(gardenPassDue(spec("same"), { stateDir: effects }), true, "overseer verdicts are folded by the pass");
  assert.equal(gardenPassDue(spec("same"), { stateDir: stateDir(t) }), true, "a first pass has no last look to match");
});

test("a garden inside its filing retry wait is not due", (t) => {
  const now = Date.parse("2026-10-01T16:00:00Z");
  const dir = stateDir(t, { lastCheap: "before", filingFailures: { count: 1, lastAt: new Date(now - 60_000).toISOString(), reason: "x" } });
  assert.equal(gardenPassDue(spec("after"), { stateDir: dir, clock: clockFromMillisFn(() => now) }), false);
});

test("an hourly evidence refresh spawns even when the inputs are unchanged", async (t) => {
  const { calls, spawnPass } = spy();
  const garden = startGardenOffLoop("test", 60 * 60 * 1000, { spawnPass, log: () => {}, due: () => false });
  t.after(() => garden.stop());
  await settle();
  assert.deepEqual(calls, [[GARDEN_HOURLY_FLAG]]);
});

test("a due probe that throws spawns the pass, as before the probe existed", async (t) => {
  const { calls, spawnPass } = spy();
  const out: string[] = [];
  const garden = startGardenOffLoop("plan", 60 * 60 * 1000, { spawnPass, log: (step) => void out.push(step), due: () => { throw new Error("state unreadable"); } });
  t.after(() => garden.stop());
  await settle();
  assert.equal(calls.length, 1, "the child runs and logs the failure itself");
});

test("the daemon builds each spec garden's due probe from the same registry", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-due-registry-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { config: { root: dir }, repoRoot: process.cwd(), owner: "o", repo: "r", log: () => {}, raiseDuplicate: () => "" } as unknown as GardenBuildContext;
  for (const name of ["plan", "export"] as const) {
    const pass = await buildRegisteredGarden(name, ctx);
    assert.equal(typeof pass.due, "function", `${name} exposes its due probe`);
    assert.equal(pass.due!(), true, `${name} with no state yet is due`);
  }
});

test("the daemon's due probe answers from the built garden and is due until it is built", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-due-probe-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { config: { root: dir }, repoRoot: process.cwd(), owner: "o", repo: "r", log: () => {}, raiseDuplicate: () => "" } as unknown as GardenBuildContext;
  const due = registeredGardenDueProbe("plan", ctx);
  assert.equal(due(), true, "before the garden is built the tick spawns, as it always has");
  await settle();
  assert.equal(due(), true, "a plan garden with no state yet is due");
  const overseer = registeredGardenDueProbe("overseer", ctx);
  await settle();
  assert.equal(overseer(), true, "a garden with no due probe of its own always spawns");
});

test("config is due only while an active canary's tend interval has elapsed", (t) => {
  const now = Date.parse("2026-10-01T16:00:00Z");
  const clock = clockFromMillisFn(() => now);
  const dir = stateDir(t);
  const write = (state: string, lastTendMs?: number) =>
    writeFileSync(configCanariesPath(dir), JSON.stringify({ canaries: [{ promotion: { state } }], ...(lastTendMs === undefined ? {} : { lastTendMs }) }));
  assert.equal(configCanariesDue(dir, clock), false, "no canaries, nothing to tend");
  write("rolled_back");
  assert.equal(configCanariesDue(dir, clock), false, "a finished canary needs no tending");
  write("shadow");
  assert.equal(configCanariesDue(dir, clock), true, "an active canary never tended is due");
  write("shadow", now - 60_000);
  assert.equal(configCanariesDue(dir, clock), false, "tended a minute ago, not due");
  write("shadow", now - CONFIG_TEND_INTERVAL_MS);
  assert.equal(configCanariesDue(dir, clock), true, "its tend interval has elapsed");
});

test("the daemon builds due probes for evidence-coverage, selector-shadow and machine-judge", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-due-paced-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const ctx = { config: { root }, repoRoot: process.cwd(), owner: "o", repo: "r", log: () => {}, raiseDuplicate: () => "" } as unknown as GardenBuildContext;
  for (const name of ["evidence-coverage", "selector-shadow", "machine-judge"] as const) {
    const pass = await buildRegisteredGarden(name, ctx);
    assert.equal(typeof pass.due, "function", `${name} exposes a due probe`);
    assert.equal(pass.due!(), true, `${name} with nothing recorded is due`);
  }
  writeFileSync(evidenceCoverageStatePath(stateDir), JSON.stringify({ version: 1, cells: {}, lastPassAt: new Date().toISOString() }));
  assert.equal((await buildRegisteredGarden("evidence-coverage", ctx)).due!(), false, "measured just now");
  const judge = await buildRegisteredGarden("machine-judge", ctx);
  writeFileSync(gardenPacingPath(stateDir, "machine-judge"), JSON.stringify({
    lastPassAt: new Date(Date.now() - 60_000).toISOString(), lastNewAt: new Date(Date.now() - 3_600_000).toISOString(),
    inputs: machineJudgeInputs(process.cwd(), stateDir),
  }));
  assert.equal(judge.due!(), false, "nothing new for an hour, and the inputs are unchanged");
  writeFileSync(join(stateDir, "operator-releases.json"), JSON.stringify({ releases: { "W1-T1": "2026-10-09T12:00:00Z" } }));
  assert.equal(judge.due!(), true, "an operator release is judged now");
});

test("the daemon's export garden paces a pending PR on the board's open-PR snapshot", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-due-pending-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const prUrl = "https://github.com/o/r/pull/9";
  const ctx = { config: { root: dir }, repoRoot: process.cwd(), owner: "o", repo: "r", log: () => {}, raiseDuplicate: () => "" } as unknown as GardenBuildContext;
  const pass = await buildRegisteredGarden("export", ctx);
  writeFileSync(gardenStatePath(stateDir, "export"), JSON.stringify({ classes: { "delete-unreferenced-export": { alpha: 3, beta: 1 } }, lastCheap: "none",
    pending: { prUrl, actionClass: "delete-unreferenced-export", baseline: { trials: 0, successes: 0 } } }));
  const snapshot = (head: string) => {
    const path = boardOpenSnapshotPath(dir, "o", "r");
    mkdirSync(dirname(path), { recursive: true });
    const rows = [{ number: 9, url: prUrl, state: "OPEN", headRefName: "b", headRefOid: head, body: "", title: "t", updatedAt: `u-${head}`, autoMergeRequest: null }];
    writeFileSync(path, JSON.stringify({ type: "board-open-snapshot", schema: 1, repository: "o/r", savedAt: new Date().toISOString(), rows }));
    return gardenPendingSignal(prUrl, rows, readOriginMainSha(process.cwd()));
  };
  const now = Date.now();
  writeFileSync(gardenPendingWatchPath(stateDir, "export"), JSON.stringify({ prUrl, signal: snapshot("aaa"),
    lastPassAt: new Date(now).toISOString(), quietSince: new Date(now - 3_600_000).toISOString() }));
  assert.equal(pass.due!(), false, "a quiet pending PR whose snapshot row has not moved is not due");
  snapshot("bbb");
  assert.equal(pass.due!(), true, "a moved head in the daemon's own snapshot makes it due");
});
