/**
 * test/a-silent-daemon-is-noticed-by-another.test.ts — W1-T4418.
 *
 * The gateway reads every other instance's ledger and escalates one that stopped sweeping. The
 * fixture rows are the 2026-09-23 console crash loop's own shapes: each boot wrote `cli.invoked`
 * (verb daemon), `daemon.target`, `daemon.paths` and `github_app.token_refreshed`, and no sweep.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { fixedClock } from "../src/lib/clock.js";
import {
  LIVENESS_WINDOW_MS,
  MAX_BOOTS_WITHOUT_HEARTBEAT,
  STALE_HEARTBEAT_POLL_MULTIPLE,
  evaluateFleetLiveness,
  readLivenessRows,
  type LivenessRow,
} from "../src/lib/fleet-liveness.js";
import { LIVENESS_CHECK_MS, livenessInstances, watchInstanceLiveness } from "../src/lib/instance-gateway.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const HOST = "57f3f3b98b48";
const LAST_SWEEP = "2026-09-23T21:14:42.000Z";
const NOW = Date.parse("2026-09-23T22:04:40.000Z");
const ISSUE = "https://github.com/craigoley/remudero-console/issues/9001";

function sweep(ts: string): LivenessRow {
  return { ts, host: "9e54da4206d7", actor: "daemon", actor_pid: 127482, run_id: "DAEMON-1790197429356", task_id: "DAEMON", step: "sweep.summary", lane: "daemon", total: 1, actions_taken: 0, actions_failed: 0 };
}

/** One crash-loop boot, exactly as the console daemon wrote it before exiting at loadPlan. */
function crashBoot(ms: number, pid: number): LivenessRow[] {
  const ts = new Date(ms).toISOString();
  const daemon = { ts, host: HOST, actor: "daemon", actor_pid: pid, run_id: `DAEMON-${ms}`, task_id: "DAEMON", lane: "daemon" };
  return [
    { ts, host: HOST, actor: "operator", actor_pid: pid, run_id: `CLI-${ms}`, task_id: "CLI", step: "cli.invoked", verb: "daemon", argv_shape: ["--repo", "<arg>", "--allow-self-target"] },
    { ...daemon, step: "daemon.target", repo: "remudero-console", gateway: "craigoley/remudero-console", self_host: false, dry_run: false },
    { ...daemon, step: "daemon.paths", ledger_path: "/home/node/Remudero/state/ledger.ndjson" },
    { ...daemon, step: "github_app.token_refreshed", installation_id: "155256285", expires_at: "2026-09-23T23:04:35Z" },
  ];
}

/** A healthy boot: the same process writes `cli.invoked` and then `daemon.start`. */
function healthyBoot(ms: number): LivenessRow[] {
  const ts = new Date(ms).toISOString();
  return [
    { ts, host: "2f080dbecd31", actor: "operator", actor_pid: 88, run_id: `CLI-${ms}`, task_id: "CLI", step: "cli.invoked", verb: "daemon", argv_shape: ["--repo", "<arg>"] },
    { ts: new Date(ms + 900).toISOString(), host: "2f080dbecd31", actor: "daemon", actor_pid: 88, run_id: `DAEMON-${ms}`, task_id: "DAEMON", step: "daemon.start", lane: "daemon", poll_interval_ms: 60000, repo: "remudero-console" },
  ];
}

/** Twenty boots 150 s apart from 21:16Z: the 2026-09-23 loop's cadence, pid 88/89 reused. */
function crashLoop(): LivenessRow[] {
  const rows: LivenessRow[] = [];
  for (let i = 0; i < 20; i++) rows.push(...crashBoot(Date.parse("2026-09-23T21:16:00.000Z") + i * 150_000, i % 2 === 0 ? 89 : 88));
  return rows;
}

function ndjson(rows: readonly LivenessRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

interface Fleet {
  base: string;
  stateBase: string;
  registryPath: string;
  ledgerPath: string;
}

/** A registry naming core and console, a state root for each, and the gateway's own ledger. */
function fleet(t: { after: (fn: () => void) => void }, console: { archived?: LivenessRow[]; live: LivenessRow[] }, core: LivenessRow[] = []): Fleet {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4418-`));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const stateBase = join(base, "instances");
  const consoleState = join(stateBase, "console", "state");
  mkdirSync(consoleState, { recursive: true });
  writeFileSync(join(consoleState, "ledger.ndjson"), ndjson(console.live));
  if (console.archived) writeFileSync(join(consoleState, "ledger.2026-09-23T21-30-00-000Z.ndjson.gz"), gzipSync(ndjson(console.archived)));
  mkdirSync(join(stateBase, "core", "state"), { recursive: true });
  writeFileSync(join(stateBase, "core", "state", "ledger.ndjson"), ndjson(core));
  const registryPath = join(base, "daemon-instances.yaml");
  const row = (name: string, repo: string) => [`  ${name}:`, `    repo: ${repo}`, `    project: remudero`, `    github_repo: craigoley/${repo}`, `    state_dir: /host/${name}-state`];
  writeFileSync(registryPath, ["instances:", ...row("core", "remudero"), ...row("console", "remudero-console"), ""].join("\n"));
  const ledgerPath = join(base, "gateway-ledger.ndjson");
  writeFileSync(ledgerPath, "");
  return { base, stateBase, registryPath, ledgerPath };
}

/** A recording `gh`: an empty open-issue list, a created issue URL, and an accepted edit. */
function fakeGh(opts: { failEdit?: boolean; failList?: boolean } = {}): { calls: string[][]; gh: (args: string[]) => string } {
  const calls: string[][] = [];
  return {
    calls,
    gh(args) {
      calls.push(args);
      if (args[0] === "api") {
        if (opts.failList) throw new Error("HTTP 403: secondary rate limit");
        return "[]";
      }
      if (args[0] === "issue" && args[1] === "create") return `${ISSUE}\n`;
      if (args[0] === "issue" && args[1] === "edit" && opts.failEdit) throw new Error("could not assign user");
      return "";
    },
  };
}

function ledgerSteps(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Start the watch on a captured timer; each `tick()` is one minute-timer firing. */
function watch(f: Fleet, gh: (args: string[]) => string, nowMs: () => number, log?: (step: string, extra?: Record<string, unknown>) => void) {
  let run: (() => void) | undefined;
  let interval = 0;
  let stopped = false;
  const stop = watchInstanceLiveness({
    registryPath: f.registryPath,
    stateBase: f.stateBase,
    ledgerPath: f.ledgerPath,
    gh,
    log,
    clock: { now: nowMs, date: () => new Date(nowMs()), iso: () => new Date(nowMs()).toISOString() },
    every: (fn, ms) => {
      run = fn;
      interval = ms;
      return () => {
        stopped = true;
      };
    },
  });
  return { tick: () => withLiveWritesAllowed(() => run?.()), interval: () => interval, stop, stopped: () => stopped };
}

test("a registered instance with a stale sweep and repeated boots is escalated once with its boot error", (t) => {
  const loop = crashLoop();
  const error = { ts: "2026-09-23T22:04:36.000Z", host: HOST, actor_pid: 88, run_id: "CLI-1790201076000", task_id: "CLI", step: "cli.unhandled_rejection", verb: "daemon", error: "PlanError: duplicate task id CONSOLE-T60" };
  // The sweep and the loop's first boots sit in a compacted archive, as they did by 02:06Z.
  const f = fleet(t, { archived: [sweep(LAST_SWEEP), ...loop.slice(0, 20)], live: [...loop.slice(20), error] }, loop);
  const { calls, gh } = fakeGh();
  const w = watch(f, gh, () => NOW);
  assert.equal(w.interval(), LIVENESS_CHECK_MS);

  w.tick();
  w.tick();

  const creates = calls.filter((a) => a[0] === "issue" && a[0] === "issue" && a[1] === "create");
  assert.equal(creates.length, 1, `one escalation across two ticks, got ${JSON.stringify(creates)}`);
  const args = creates[0];
  assert.equal(args[args.indexOf("--repo") + 1], "craigoley/remudero-console");
  const title = args[args.indexOf("--title") + 1];
  const body = args[args.indexOf("--body") + 1];
  assert.match(title, /Fleet instance console is down/);
  assert.match(body, /PlanError: duplicate task id CONSOLE-T60/);
  assert.match(body, /last sweep\.summary: 50 min ago/, "the sweep age is read out of the archived rotation");
  assert.match(body, /daemon boots in the trailing hour: 20 \(20 with no sweep since\)/);
  assert.equal(args[args.indexOf("--label") + 1], "needs-human");
  assert.deepEqual(
    calls.find((a) => a[1] === "edit"),
    ["issue", "edit", ISSUE, "--repo", "craigoley/remudero-console", "--add-assignee", "craigoley"],
    "the issue is assigned to the operator",
  );
  const repos = new Set(calls.map((a) => (a[0] === "api" ? a[1].replace(/^repos\/(.*?)\/issues.*$/, "$1") : a[a.indexOf("--repo") + 1])));
  assert.deepEqual([...repos], ["craigoley/remudero-console"], "the core instance's own crash loop is never watched");
  const opened = ledgerSteps(f.ledgerPath).filter((r) => r.step === "escalation.issue_opened");
  assert.deepEqual(opened.map((r) => [r.task_id, r.issue_url]), [["FLEET-console", ISSUE]]);
});

test("a healthy instance raises nothing", (t) => {
  const rows: LivenessRow[] = [...healthyBoot(NOW - 50 * 60_000)];
  for (let ms = NOW - 60_000; ms >= NOW - 48 * 60_000; ms -= 80_000) rows.push(sweep(new Date(ms).toISOString()));
  const f = fleet(t, { live: rows });
  const { calls, gh } = fakeGh();
  const w = watch(f, gh, () => NOW);

  w.tick();

  assert.deepEqual(calls, [], "no gh call at all");
  assert.deepEqual(ledgerSteps(f.ledgerPath), []);
  const [judged] = evaluateFleetLiveness(livenessInstances({ registryPath: f.registryPath, stateBase: f.stateBase }), readLivenessRows, NOW);
  assert.equal(judged.state, "up");
  assert.equal(judged.bootsLastHour, 1, "cli.invoked and daemon.start of one process are one boot");
  assert.equal(judged.lastSweepAgeMs, 60_000);
});

test("a recovered instance ledgers fleet.instance_recovered", (t) => {
  const f = fleet(t, { live: [sweep(LAST_SWEEP), ...crashLoop()] });
  const { gh } = fakeGh();
  let now = NOW;
  const w = watch(f, gh, () => now);
  w.tick();
  now = NOW + 10 * 60_000;
  writeFileSync(join(f.stateBase, "console", "state", "ledger.ndjson"), ndjson([...healthyBoot(now - 3 * 60_000), sweep(new Date(now - 60_000).toISOString())]), { flag: "a" });
  w.tick();
  w.tick();

  const recovered = ledgerSteps(f.ledgerPath).filter((r) => r.step === "fleet.instance_recovered");
  assert.deepEqual(recovered.map((r) => [r.task_id, r.instance, r.last_sweep_age_ms]), [["FLEET-console", "console", 60_000]]);
  w.stop();
  assert.ok(w.stopped());
});

test("the liveness bounds come from the instance's own poll interval", () => {
  const instance = { name: "console", repo: "craigoley/remudero-console", stateDir: "/unused" };
  const quota = { ts: new Date(NOW - 5 * 60_000).toISOString(), step: "daemon.quota", poll_interval_ms: 120_000 };
  const stale = new Date(NOW - 45 * 60_000).toISOString();
  const [slow] = evaluateFleetLiveness([instance], () => [quota, sweep(stale)], NOW);
  assert.equal(slow.staleBoundMs, 120_000 * STALE_HEARTBEAT_POLL_MULTIPLE);
  assert.equal(slow.state, "up", "45 min is inside a 2-min poll's 60-min bound");
  const [fast] = evaluateFleetLiveness([instance], () => [sweep(stale)], NOW);
  assert.equal(fast.state, "down", "the same 45 min is past a 1-min poll's 30-min bound");
  assert.match(fast.reasons[0], /no sweep for 45 min, past its bound of 30 min \(30 × its 1 min poll\)/);
  const [silent] = evaluateFleetLiveness([instance], () => [], NOW);
  assert.match(silent.reasons[0], /no sweep at all in the trailing 60 min/);
  const [unknowable] = evaluateFleetLiveness([instance], () => [{ ts: new Date(NOW).toISOString(), step: "daemon.quota", poll_interval_ms: 180_000 }], NOW);
  assert.equal(unknowable.state, "up", "a 90-min bound cannot be judged from a 60-min window with no sweep in it");
  assert.equal(LIVENESS_WINDOW_MS, 60 * 60_000);
});

test("boots past the bound with no sweep between are down even while the sweep is fresh", () => {
  const instance = { name: "console", repo: "craigoley/remudero-console", stateDir: "/unused" };
  const lastSweep = sweep(new Date(NOW - 20 * 60_000).toISOString());
  const boots = (n: number) => Array.from({ length: n }, (_, i) => crashBoot(NOW - 18 * 60_000 + i * 150_000, 88)).flat();
  const [at] = evaluateFleetLiveness([instance], () => [lastSweep, ...boots(MAX_BOOTS_WITHOUT_HEARTBEAT)], NOW);
  assert.equal(at.state, "up", `${MAX_BOOTS_WITHOUT_HEARTBEAT} boots is the healthy maximum`);
  const [past] = evaluateFleetLiveness([instance], () => [lastSweep, ...boots(MAX_BOOTS_WITHOUT_HEARTBEAT + 1)], NOW);
  assert.equal(past.state, "down");
  assert.deepEqual(past.reasons, [`booted 6 times with no sweep between (bound ${MAX_BOOTS_WITHOUT_HEARTBEAT})`]);
  const paused = { ts: new Date(NOW - 60_000).toISOString(), step: "daemon.pause", poll_interval_ms: 60000 };
  const [ticking] = evaluateFleetLiveness([instance], () => [sweep(LAST_SWEEP), paused], NOW);
  assert.equal(ticking.state, "up", "a paused daemon still ticks");
});

test("an operator stop is held and not escalated", (t) => {
  const stop = { ts: "2026-09-23T21:15:00.000Z", step: "daemon.stop", detail: "operator hold" };
  const f = fleet(t, { live: [sweep(LAST_SWEEP), stop, ...crashLoop()] });
  const { calls, gh } = fakeGh();
  watch(f, gh, () => NOW).tick();
  assert.deepEqual(calls, []);
  const [judged] = evaluateFleetLiveness(livenessInstances({ registryPath: f.registryPath, stateBase: f.stateBase }), readLivenessRows, NOW);
  assert.deepEqual([judged.state, judged.reasons], ["held", ["stopped by the operator: operator hold"]]);
  const [bare] = evaluateFleetLiveness([{ name: "x", repo: "o/x", stateDir: "/unused" }], () => [{ ...stop, detail: undefined }], NOW);
  assert.deepEqual(bare.reasons, ["stopped by the operator: STOP flag"]);
});

test("an unreadable ledger is logged and never escalated", (t) => {
  const f = fleet(t, { live: [] });
  rmSync(join(f.stateBase, "console", "state", "ledger.ndjson"));
  const { calls, gh } = fakeGh();
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  watch(f, gh, () => NOW, (step, extra) => logged.push([step, extra])).tick();
  assert.deepEqual(calls, []);
  assert.equal(logged[0][0], "fleet.instance_unreadable");
  assert.match(String(logged[0][1]?.reason), /no ledger is readable under .*console/);
});

test("a failed dedup read opens nothing and is retried on the next tick", (t) => {
  const f = fleet(t, { live: [sweep(LAST_SWEEP), ...crashLoop()] });
  let failList = true;
  const listing = fakeGh({ failList: true });
  const ok = fakeGh();
  const w = watch(f, (args) => (failList ? listing.gh(args) : ok.gh(args)), () => NOW);
  w.tick();
  assert.ok(!listing.calls.some((a) => a[0] === "issue" && a[1] === "create"));
  assert.deepEqual(ledgerSteps(f.ledgerPath).map((r) => r.step), ["escalation.dedup_unreadable"]);
  failList = false;
  w.tick();
  assert.equal(ok.calls.filter((a) => a[0] === "issue" && a[1] === "create").length, 1);
});

test("an assignment or escalation failure is logged and never stops the watch", (t) => {
  const f = fleet(t, { live: [sweep(LAST_SWEEP), ...crashLoop()] });
  const logged: string[] = [];
  const { calls, gh } = fakeGh({ failEdit: true });
  const w = watch(f, gh, () => NOW, (step) => logged.push(step));
  w.tick();
  assert.equal(calls.filter((a) => a[0] === "issue" && a[1] === "create").length, 1, "the issue opens even when it cannot be assigned");
  assert.deepEqual(logged, ["fleet.liveness_assign_failed"]);

  const g = fleet(t, { live: [sweep(LAST_SWEEP), ...crashLoop()] });
  const thrown: string[] = [];
  // Outside withLiveWritesAllowed the live-write guard refuses the create, standing in for any escalate() throw.
  let run: (() => void) | undefined;
  watchInstanceLiveness({ registryPath: g.registryPath, stateBase: g.stateBase, ledgerPath: g.ledgerPath, gh: fakeGh().gh, clock: fixedClock(NOW), log: (step) => thrown.push(step), every: (fn) => ((run = fn), () => {}) });
  run?.();
  assert.deepEqual(thrown, ["fleet.liveness_escalation_failed"]);

  let tick: (() => void) | undefined;
  watchInstanceLiveness({ registryPath: g.registryPath, stateBase: g.stateBase, ledgerPath: join(g.base, "no-such-dir", "ledger.ndjson"), readLastRows: () => [sweep(new Date(NOW - 60_000).toISOString())], clock: { now: () => { throw new Error("clock failed"); }, date: () => new Date(0), iso: () => "" }, log: (step) => thrown.push(step), every: (fn) => ((tick = fn), () => {}) });
  tick?.();
  assert.equal(thrown.at(-1), "fleet.liveness_check_failed");
});

test("the watch starts nothing without another instance and runs on a real timer otherwise", (t) => {
  const f = fleet(t, { live: [] });
  let scheduled = false;
  const none = watchInstanceLiveness({ registryPath: join(f.base, "absent.yaml"), ledgerPath: f.ledgerPath, every: () => ((scheduled = true), () => {}) });
  none();
  assert.equal(scheduled, false);
  assert.deepEqual(livenessInstances({ registryPath: f.registryPath }).map((i) => i.stateDir), ["/home/node/rmd-instances/console/state"]);
  const stop = watchInstanceLiveness({ registryPath: f.registryPath, stateBase: f.stateBase, ledgerPath: f.ledgerPath });
  stop();
});
