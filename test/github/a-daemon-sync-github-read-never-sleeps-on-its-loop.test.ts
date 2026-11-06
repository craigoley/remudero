import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as transport from "#src/lib/github-transport.js";
import { configureEscalationTriage, escalate, escalateAsync, ghIssueGateway } from "#src/lib/escalate.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY, type OpenPrView } from "#src/lib/sweep.js";
import { appendLedger } from "#src/lib/ledger.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";

function cache() {
  const root = mkdtempSync(join(tmpdir(), "rmd-loop-gh-"));
  const env = { RMD_GH_CACHE_HOME: root, RMD_GH_TRANSPORT_FLOOR: "advisory", RMD_GH_SHARED_READ_GAP_MS: "100" };
  const stamp = transport.ghReadCadenceStampPath(env, "core")!;
  let now = Date.now();
  transport.stampGhRead(stamp, "advisory\n", now);
  const waits: number[] = [];
  const deps = { env, nowMs: () => now, bucketOverride: "core", warn: () => {}, sleepSync: (ms: number) => { waits.push(ms); now += ms; } };
  return { root, env, stamp, waits, deps };
}

const read = ["api", "repos/fixture/loop/pulls/1"];
test("W1-T11458 criterion 1: a marked loop refuses a pending gap without sleeping or stamping; CLI still waits", async () => {
  const c = cache();
  try {
    const before = transport.readGhReadCadenceStampMs(c.stamp);
    await transport.withDaemonGhTransportFloor(async () => {
      assert.throws(() => transport.applyGhReadCadence(read, c.deps), transport.GhPaceWouldBlockError, "loop cadence must refuse before sleeping");
      assert.deepEqual(c.waits, []);
      assert.equal(transport.readGhReadCadenceStampMs(c.stamp), before);
      assert.equal(existsSync(`${c.stamp}.lock`), false);
      await transport.withGhTransportFloor(() => {
        assert.throws(() => transport.applyGhReadCadence(read, c.deps), transport.GhPaceWouldBlockError, "nested command still runs on the loop");
      }, c.env);
    }, c.env);
    transport.applyGhReadCadence(read, c.deps);
    assert.deepEqual(c.waits, [100], "standalone CLI keeps its existing positive wait");
    await transport.withDaemonGhTransportFloor(() => {
      transport.applyGhReadCadence(read, { ...c.deps, env: { ...c.env, RMD_GH_SHARED_READ_GAP_MS: "0" } });
    }, c.env);
  } finally { rmSync(c.root, { recursive: true, force: true }); }
});

test("W1-T11458 criterion 1: loop pacers constructed before boot refuse wait and refusal-backoff sleeps", async () => {
  let now = 0;
  const waits: number[] = [];
  const pacer = transport.createGhCallPacer({ minGapMs: 100, now: () => now, sleepSync: (ms) => { waits.push(ms); now += ms; } });
  pacer.wait();
  await transport.withDaemonGhTransportFloor(() => {
    assert.throws(() => pacer.wait(), transport.GhPaceWouldBlockError, "pre-existing pacer must observe loop context at invocation");
    assert.throws(() => pacer.sleepSync!(100), transport.GhPaceWouldBlockError, "refusal backoff must not bypass the loop guard");
    assert.deepEqual(waits, []);
  }, {});
  pacer.wait();
  assert.deepEqual(waits, [100]);
});

test("W1-T11458 criterion 1: lock contention refusal propagates instead of failing open into a stamped read", async () => {
  const c = cache();
  const lock = `${c.stamp}.lock`;
  mkdirSync(lock);
  try {
    const deps = { ...c.deps, env: { ...c.env, RMD_GH_SHARED_READ_GAP_MS: "0" }, sleepSync: (ms: number) => { c.waits.push(ms); rmSync(lock, { recursive: true }); } };
    await transport.withDaemonGhTransportFloor(() => {
      assert.throws(() => transport.applyGhReadCadence(read, deps), transport.GhPaceWouldBlockError, "lock wait must not be swallowed by fail-open IO handling");
      assert.deepEqual(c.waits, []);
      assert.equal(existsSync(lock), true, "foreign lock remains owned by its holder");
    }, c.env);
  } finally { rmSync(c.root, { recursive: true, force: true }); }
});

test("W1-T11458 criterion 2: async escalation promotes a real sync gateway to its same-repository async transport", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-loop-issue-"));
  const bin = join(root, "bin"); mkdirSync(bin);
  const calls = join(root, "calls");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s %s %s\\n' start "$1" "$2" >> "$LOOP_GH_CALLS"\nsleep 0.03\ncase "$1" in\n api) case "$2" in repos/fixture/loop/issues*) ;; *) exit 91;; esac;;\n label|issue) good=0; prev=; for arg in "$@"; do if [ "$prev" = --repo ] && [ "$arg" = fixture/loop ]; then good=1; fi; prev=$arg; done; [ "$good" = 1 ] || exit 92;;\nesac\ncase "$1 $2" in\n  'api '* ) printf '[]\\n';;\n  'issue create') printf 'https://github.com/fixture/loop/issues/7\\n';;\nesac\nprintf '%s %s %s\\n' end "$1" "$2" >> "$LOOP_GH_CALLS"\n`, { mode: 0o755 });
  const changes = { PATH: `${bin}:${process.env.PATH}`, LOOP_GH_CALLS: calls, RMD_GH_CACHE_HOME: join(root, "cache"), RMD_GH_SHARED_READ_GAP_MS: "0", RMD_GH_TRANSPORT_FLOOR: "advisory" };
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  const during = new Set<string>();
  const timer = setInterval(() => {
    if (!existsSync(calls)) return;
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    const last = lines[lines.length - 1];
    if (last.startsWith("start ")) during.add(last.slice(6));
  }, 1);
  try {
    const url = await withLiveWritesAllowed(() => transport.withDaemonGhTransportFloor(() => escalateAsync({
      class: "MANUAL", taskId: "LOOP-FIXTURE", summary: "fixture delivery", detail: "Private fake child only.",
      options: [{ label: "inspect", detail: "Inspect the fixture." }], recommendation: "inspect",
    }, { issues: ghIssueGateway("fixture", "loop"), ledgerPath: join(root, "ledger.ndjson"), runId: "LOOP-FIXTURE", triage: { mode: "shadow" } })));
    assert.equal(url, "https://github.com/fixture/loop/issues/7");
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    const starts = lines.filter((line) => line.startsWith("start ")).map((line) => line.slice(6));
    assert.ok(starts.some((line) => line.startsWith("api ")), "the real issue-list default must execute");
    assert.ok(starts.includes("issue create"), "the real issue-create default must execute");
    for (const command of starts) assert.ok(during.has(command), `loop timer must run during each real default child: ${command}`);
    const injected: string[][] = [];
    const custom = ghIssueGateway("custom", "route", { exec: (args) => {
      injected.push(args);
      return args[0] === "api" ? "[]" : args[0] === "issue" ? "https://github.com/custom/route/issues/8" : "";
    } });
    const ask = { class: "MANUAL" as const, taskId: "LOOP-CUSTOM", summary: "custom delivery", detail: "Fixture only.", options: [{ label: "inspect", detail: "Inspect fixture." }], recommendation: "inspect" };
    const customUrl = await withLiveWritesAllowed(() => transport.withDaemonGhTransportFloor(() => escalateAsync(ask, { issues: custom, ledgerPath: join(root, "custom.ndjson"), runId: "CUSTOM", triage: { mode: "shadow" } })));
    assert.equal(customUrl, "https://github.com/custom/route/issues/8");
    assert.ok(injected.some((args) => args.includes("custom/route")));
    const previousWait = Atomics.wait;
    let legacySleeps = 0;
    process.env.RMD_GH_CACHE_HOME = join(root, "legacy-cache");
    process.env.RMD_GH_SHARED_READ_GAP_MS = "100";
    transport.stampGhRead(transport.ghReadCadenceStampPath(process.env));
    Atomics.wait = (() => { legacySleeps += 1; return "timed-out"; }) as typeof Atomics.wait;
    try {
      const delivered = await withLiveWritesAllowed(() => transport.withDaemonGhTransportFloor(() => escalate({ ...ask, taskId: "LEGACY-LATCH" }, { issues: ghIssueGateway("fixture", "loop"), ledgerPath: join(root, "legacy.ndjson"), runId: "LEGACY", triage: { mode: "shadow" } })));
      assert.equal(typeof delivered, "string", "the documented legacy latch contract stays synchronous");
      assert.equal(delivered, "https://github.com/fixture/loop/issues/7");
      assert.ok(legacySleeps > 0, "retain the explicitly documented unsafe-retry delivery exception until its durable follow-up");
    } finally { Atomics.wait = previousWait; }
    configureEscalationTriage(() => ({ mode: "shadow" }));
    try {
      for (const cached of [true, false]) {
        const mode = cached ? "cached terminal" : "new terminal";
        const terminalRoot = join(root, cached ? "cached-terminal" : "new-terminal");
        const state = join(terminalRoot, "state"); mkdirSync(state, { recursive: true });
        const ledger = join(state, "ledger.ndjson"); writeFileSync(ledger, "");
        const fixtureTask: Task = { id: "W1-T11458", title: "terminal fixture", repo: "loop", type: "implement", risk: "high", budget_usd: 0, verify: "auto", files: [], acceptance: [], status: "queued", depends_on: [], attempts: 0 };
        const plan = { tasks: [fixtureTask], byId: new Map([[fixtureTask.id, fixtureTask]]) } as Plan;
        const pr = { prNumber: cached ? 51 : 52, prUrl: `https://github.com/fixture/loop/pull/${cached ? 51 : 52}`, taskId: fixtureTask.id,
          reviewState: "failure", checksState: "green", unmetCriteria: [], priorStrikes: 0,
          lastActivityAt: new Date().toISOString(), headSha: cached ? "cached-head" : "new-head", autoMergeArmed: false } as OpenPrView;
        if (cached) appendLedger(ledger, { run_id: "PRIOR", task_id: "SWEEP", step: "sweep.fix.uncreditable_head", pr_number: pr.prNumber,
          head_sha: pr.headSha, head: "codex/foreign", reason: "not_a_run_branch", terminal: true, repair_task_id: fixtureTask.id, cause: "review" });
        const effects = buildSweepEffects({ owner: "fixture", repo: "loop", config: { root: terminalRoot } as never,
          ledgerPath: ledger, runId: "TERMINAL-FIXTURE", plan, policy: DEFAULT_SWEEP_POLICY,
          log: (step, fields) => appendLedger(ledger, { ...fields, step, run_id: "TERMINAL-FIXTURE", task_id: "SWEEP" }),
          contributorAdmissionImpl: async () => {}, dispatchFixPreflightStandDownImpl: async () => false,
          ghLiveStateImpl: () => ({ ok: true, state: "OPEN" }), reloadPlanForFixImpl: () => plan,
          ghJsonImpl: () => ({ headRefName: "codex/foreign", headRefOid: pr.headSha, body: "", files: [] }),
          spawnImpl: async () => { throw new Error("fixture must not spawn a repair worker"); },
          createFixRungWorktreeImpl: () => { throw new Error("fixture must not create a repair worktree"); },
        });
        const rows = (): Array<Record<string, unknown>> => readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
        during.clear(); writeFileSync(calls, "");
        try {
          await withLiveWritesAllowed(() => transport.withDaemonGhTransportFloor(() => effects.dispatchFix(pr, { unmetCriteria: [] })));
          assert.ok(effects.terminalFixStandDown?.(pr), `${mode}: parent must await delivered acknowledgement`);
          const delivered = rows().find((row) => row.step === "sweep.fix.uncreditable_head_escalated");
          assert.equal(delivered?.issue_url, "https://github.com/fixture/loop/issues/7", `${mode}: only an actual URL may be acknowledged`);
          const commands = readFileSync(calls, "utf8").trim().split("\n").filter((line) => line.startsWith("start ")).map((line) => line.slice(6));
          assert.ok(commands.includes("issue create"), `${mode}: the real default gateway must create the fixture issue`);
          for (const command of commands) assert.ok(during.has(command), `${mode}: timer must run during the default caller's child ${command}`);
        } finally {
          // A deliberately removed parent await leaves a real private child in flight. Retain its
          // fixture until the existing transport deadline or a final delivery disposition, then clean.
          const deadline = Date.now() + transport.DEFAULT_GH_CALL_TIMEOUT_MS;
          const settled = new Set(["escalation.issue_opened", "escalation.failed", "escalation.dedup_unreadable"]);
          while (!rows().some((row) => typeof row.step === "string" && settled.has(row.step)) && Date.now() < deadline) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    } finally { configureEscalationTriage(undefined); }
  } finally {
    clearInterval(timer);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop scope survives asynchronous work while an independent CLI retains its wait", async () => {
  const c = cache();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let leave!: () => void;
  const waiting = new Promise<void>((resolve) => { leave = resolve; });
  const loop = transport.withDaemonGhTransportFloor(async () => {
    enter(); await waiting;
    const fresh = cache();
    try { assert.throws(() => transport.applyGhReadCadence(read, fresh.deps), transport.GhPaceWouldBlockError); }
    finally { rmSync(fresh.root, { recursive: true, force: true }); }
  }, {});
  try {
    await entered;
    transport.applyGhReadCadence(read, c.deps);
    assert.deepEqual(c.waits, [100], "an independent caller must not inherit another asynchronous context");
  } finally { leave(); await loop; rmSync(c.root, { recursive: true, force: true }); }
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  try {
    const pacer = transport.createGhCallPacer({ minGapMs: 30, now: () => 0 });
    pacer.wait();
    await transport.withDaemonGhTransportFloor(() => pacer.waitAsync!(), {});
    assert.ok(ticks > 0, "the existing async pacer waits on a timer");
  } finally { clearInterval(timer); }
});

test("a loop sync read cannot use a pending async sibling to bypass its required gap", async () => {
  const c = cache();
  let entered!: () => void;
  const sleeping = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await transport.withDaemonGhTransportFloor(async () => {
      const pending = transport.applyGhReadCadenceAsync(read, { ...c.deps, sleep: async () => { entered(); await gate; } });
      try {
        await sleeping;
        const before = transport.readGhReadCadenceStampMs(c.stamp);
        assert.throws(() => transport.applyGhReadCadence(read, c.deps), transport.GhPaceWouldBlockError);
        assert.deepEqual(c.waits, []);
        assert.equal(transport.readGhReadCadenceStampMs(c.stamp), before);
      } finally { release(); await pending; }
    }, c.env);
  } finally { rmSync(c.root, { recursive: true, force: true }); }
});

test("loop wait-mode refusal retires its ticket without consuming a gated read", async () => {
  const c = cache();
  c.env.RMD_GH_TRANSPORT_FLOOR = "wait";
  transport.stampGhRead(c.stamp, "", c.deps.nowMs());
  try {
    await transport.withDaemonGhTransportFloor(() => {
      assert.throws(() => transport.applyGhReadCadence(read, c.deps), transport.GhPaceWouldBlockError);
      assert.deepEqual(c.waits, []);
      assert.deepEqual(transport.readGhReadTickets(c.stamp), [], "a refused loop read must release its queue ticket");
      assert.equal(existsSync(transport.ghGatedStampPath(c.stamp)), false);
    }, c.env);
  } finally { rmSync(c.root, { recursive: true, force: true }); }
});
