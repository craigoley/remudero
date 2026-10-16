// test/an-engine-on-main-newer-than-the-daemon-checkout-qualifies.test.ts — W1-T9906.
//
// A run child's engine is judged against origin/main's tip, not the daemon checkout's HEAD. The fixture is a real
// repository: HEAD at H, refs/remotes/origin/main at D (a child of H), and a side commit W on D that the ref does not
// reach. On 2026-10-16 boot 3's checkout sat at e539a44a5 while engines fed973ff and 479b097d, both on main and both
// newer, were on disk, and every probe was skipped "no current engine tree for main".
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { LearnedReservation } from "../src/lib/host-memory-learning.js";
import type { TreePeakSampler } from "../src/lib/host-memory-learning.js";
import { createAdmittedPlanSlot, spawnRunChild, startRunChildProbe, type SpawnRunChildPorts } from "../src/lib/run-child.js";
import type { RunChildProbe } from "../src/lib/run-child-contract.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

const scratch: string[] = [];
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

type Row = { step: string } & Record<string, unknown>;
const TASKS = [{ id: "T-1", title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", status: "queued" }];

interface Fixture { repo: GitRepo; state: string; head: string; tip: string; side: string; rows: Row[] }

/** H (HEAD), D on H (origin/main), W on D (reached by no ref named here). */
function fixture(label: string): Fixture {
  const repo = gitRepo({ kind: `engine-tip-${label}` });
  const head = repo.git("rev-parse", "HEAD");
  const tree = repo.git("rev-parse", "HEAD^{tree}");
  const tip = repo.git("commit-tree", tree, "-p", head, "-m", "D: main moved on");
  const side = repo.git("commit-tree", tree, "-p", tip, "-m", "W: a worker's own commit");
  repo.git("update-ref", "refs/remotes/origin/main", tip);
  const state = join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}engine-tip-${label}-`)), "state");
  scratch.push(join(state, ".."));
  return { repo, state, head, tip, side, rows: [] };
}

/** Publishes an engine record at `sha` (no node_modules entry: `absent`, which the modules check accepts). */
function publish(fx: Fixture, sha: string, fill: string, builtAt: number): void {
  const hash = fill.repeat(64);
  const root = join(fx.state, "engines", hash);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "engine.json"), JSON.stringify({ sha, sourceHash: hash, builtAt }));
}

const log = (fx: Fixture) => (step: string, extra?: Record<string, unknown>): void => { fx.rows.push({ step, ...extra }); };
const reasons = (fx: Fixture, step: string): string[] => fx.rows.filter((r) => r.step === step).map((r) => String(r.reason));

class FakeChild extends EventEmitter {
  pid: number | undefined = 424_242;
  unref(): void {}
}
const aliveProbe: RunChildProbe = { process: () => ({ state: "alive", start: "proc:1" }), generation: () => ({ containerId: "c", initStart: "i" }) };
const reservation = {
  id: "reservation-1", workerClass: "implement", estimateMib: 1, estimateSource: "default",
  bindRoot: () => {}, releaseOccupancy: () => {},
} as unknown as LearnedReservation;

async function spawnOn(fx: Fixture): Promise<Awaited<ReturnType<typeof spawnRunChild>>> {
  const ports: SpawnRunChildPorts = {
    engine: { isCurrent: () => true }, reserve: async () => reservation, probe: aliveProbe, pollMs: 20, abort: { pollMs: 20 },
    launch: (engine, args) => ({ kind: "tsx", reason: "test", argv: [...args], cwd: fx.repo.dir, engineRoot: engine.root }),
    spawn: () => new FakeChild() as never,
  };
  const launched = await spawnRunChild({
    taskId: "T-1", stateRoot: fx.state, repoDir: fx.repo.dir, root: join(fx.state, ".."),
    options: { skipGitSync: false, handOffAtPrOpen: true, pairedTrialHost: "daemon" },
    plan: async () => ({ plan: { tasks: TASKS } }) as never, log: log(fx),
  }, ports);
  if (launched.started) {
    launched.settled.catch(() => {});
    launched.detach?.();
  }
  return launched;
}

async function probeOn(fx: Fixture): Promise<Awaited<ReturnType<typeof startRunChildProbe>>> {
  const slot = createAdmittedPlanSlot();
  slot.offer({ plan: { tasks: TASKS } } as never);
  const sampler = { sampleNow: () => {}, finish: () => 1 } as unknown as TreePeakSampler;
  return startRunChildProbe({
    taskId: "T-1", stateRoot: fx.state, repoDir: fx.repo.dir, root: join(fx.state, ".."), plan: slot.promise, options: { owner: "o" },
    log: log(fx),
  }, {
    readMode: () => "shadow", engine: { isCurrent: () => true }, sampler, reserve: () => reservation,
    launch: (engine, args) => ({ kind: "tsx", reason: "test", argv: ["-e", "process.exit(0)", "--", ...args], cwd: fx.repo.dir, engineRoot: engine.root }),
  });
}

test("W1-T9906: a run child spawns on an engine at origin/main tip newer than the checkout HEAD", async () => {
  const fx = fixture("spawn");
  publish(fx, fx.tip, "d", 2);
  const launched = await spawnOn(fx);
  assert.ok(launched.started, `spawned, not ${JSON.stringify(launched)}; rows ${JSON.stringify(fx.rows)}`);
  const spawned = fx.rows.find((r) => r.step === "run_child.spawned");
  assert.equal(spawned?.engine_sha, fx.tip, "the child runs on D, the engine at origin/main's tip");
  assert.notEqual(fx.head, fx.tip, "the checkout's HEAD is behind main");
  assert.deepEqual(reasons(fx, "run_child.fallback"), []);
});

test("W1-T9906: the shadow probe starts on an engine newer than the checkout HEAD", async () => {
  const fx = fixture("probe");
  publish(fx, fx.tip, "d", 2);
  const outcome = await probeOn(fx);
  assert.ok(outcome.started, `started, not skipped: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.row.engine_sha, fx.tip, JSON.stringify(outcome.row));
  assert.deepEqual(reasons(fx, "run_child.shadow_skipped"), []);
  const lag = fx.rows.filter((r) => r.step === "engine.lag");
  assert.deepEqual(lag, [], "an engine at main's tip does not lag");
});

test("W1-T9906: an engine whose commit is not on origin/main is still refused", async () => {
  const fx = fixture("side");
  publish(fx, fx.side, "e", 3); // newest, but origin/main does not reach W
  const alone = await probeOn(fx);
  assert.equal(alone.started, false);
  assert.deepEqual(reasons(fx, "run_child.shadow_skipped"), ["no current engine tree for main"]);

  publish(fx, fx.head, "f", 1); // an older engine at the checkout's HEAD, an ancestor of main's tip
  fx.rows.length = 0;
  const launched = await spawnOn(fx);
  assert.ok(launched.started, JSON.stringify(fx.rows));
  assert.equal(fx.rows.find((r) => r.step === "run_child.spawned")?.engine_sha, fx.head, "W is passed over for H");
  const lag = fx.rows.find((r) => r.step === "engine.lag");
  assert.equal(lag?.main_sha, fx.tip, "the lag is measured against main's tip, not HEAD");
  assert.equal(lag?.commits_behind, 1);
});

test("W1-T9906: an unreadable origin/main tip skips the probe by name", async () => {
  const fx = fixture("no-tip");
  publish(fx, fx.head, "f", 1); // HEAD itself: the old rule would have taken it
  fx.repo.git("update-ref", "-d", "refs/remotes/origin/main");
  const outcome = await probeOn(fx);
  assert.equal(outcome.started, false, JSON.stringify(outcome));
  const [skipped] = reasons(fx, "run_child.shadow_skipped");
  assert.match(skipped ?? "", /^origin\/main tip unreadable/);
  assert.equal(fx.rows.some((r) => r.step === "run_child.shadow"), false, "no probe row: nothing ran");

  const launched = await spawnOn(fx);
  assert.equal(launched.started, false);
  assert.match(reasons(fx, "run_child.fallback")[0] ?? "", /origin\/main tip unreadable/);
});
