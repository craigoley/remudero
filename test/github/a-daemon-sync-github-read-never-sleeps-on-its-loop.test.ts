import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as transport from "#src/lib/github-transport.js";
import { configureEscalationTriage, escalate, escalateAsync, ghIssueGateway } from "#src/lib/escalate.js";
import { ARTIFACT_FINALIZE_INTERMEDIARY_403, buildSweepEffects, DEFAULT_SWEEP_POLICY, type OpenPrView } from "#src/lib/sweep.js";
import { appendLedger } from "#src/lib/ledger.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { ghShim } from "#test/helpers/gh-shim.js";

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
  const shim = ghShim([
    { when: "api repos/fixture/loop/issues", stdout: "[]", delaySeconds: 0.1 },
    { when: "issue create", stdout: "https://github.com/fixture/loop/issues/7", delaySeconds: 0.1 },
    { when: "label", delaySeconds: 0.1 },
    { when: "", exit: 93, delaySeconds: 0.1 },
  ]);
  const changes = { PATH: `${shim.dir}:${process.env.PATH}`, RMD_GH_CACHE_HOME: join(root, "cache"), RMD_GH_SHARED_READ_GAP_MS: "0", RMD_GH_TRANSPORT_FLOOR: "advisory" };
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  const during = new Set<number>();
  const timer = setInterval(() => {
    const active = new Set<number>();
    for (const event of shim.events()) {
      if (event.phase === "start") active.add(event.id); else active.delete(event.id);
    }
    for (const id of active) during.add(id);
  }, 1);
  const assertRoute = (args: string[]): void => {
    if (args[0] === "api") assert.ok(args[1].startsWith("repos/fixture/loop/issues"), "every real API child keeps the gateway repository");
    else {
      assert.ok(["issue", "label"].includes(args[0]), "only the private gateway commands may run");
      assert.equal(args[args.indexOf("--repo") + 1], "fixture/loop", "every real mutation child keeps the gateway repository");
    }
  };
  try {
    const url = await withLiveWritesAllowed(() => transport.withDaemonGhTransportFloor(() => escalateAsync({
      class: "MANUAL", taskId: "LOOP-FIXTURE", summary: "fixture delivery", detail: "Private fake child only.",
      options: [{ label: "inspect", detail: "Inspect the fixture." }], recommendation: "inspect",
    }, { issues: ghIssueGateway("fixture", "loop"), ledgerPath: join(root, "ledger.ndjson"), runId: "LOOP-FIXTURE", triage: { mode: "shadow" } })));
    assert.equal(url, "https://github.com/fixture/loop/issues/7");
    const starts = shim.events().filter((event) => event.phase === "start");
    assert.ok(starts.some((event) => event.args[0] === "api"), "the real issue-list default must execute");
    assert.ok(starts.some((event) => event.args.slice(0, 2).join(" ") === "issue create"), "the real issue-create default must execute");
    for (const event of starts) {
      assertRoute(event.args);
      assert.ok(during.has(event.id), `loop timer must run during each real default child: ${event.args.join(" ")}`);
    }
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
      const delivered = await withLiveWritesAllowed(() => escalate({ ...ask, taskId: "LEGACY-LATCH" }, { issues: ghIssueGateway("fixture", "loop"), ledgerPath: join(root, "legacy.ndjson"), runId: "LEGACY", triage: { mode: "shadow" } }));
      assert.equal(typeof delivered, "string", "the documented legacy latch contract stays synchronous");
      assert.equal(delivered, "https://github.com/fixture/loop/issues/7");
      assert.ok(legacySleeps > 0, "standalone CLI callers retain their synchronous wait contract");
      const beforeCustom = legacySleeps;
      let assigned = false;
      shim.addRoute({ when: "issue edit", delaySeconds: 0.03 });
      process.env.RMD_GH_CACHE_HOME = join(root, "legacy-custom-cache");
      transport.stampGhRead(transport.ghReadCadenceStampPath(process.env));
      const routed = ghIssueGateway("fixture", "loop", { exec: args => {
        const out = transport.ghExec(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        if (args[0] === "issue" && args[1] === "create") {
          transport.ghExec(["issue", "edit", out.trim(), "--repo", "fixture/loop", "--add-assignee", "fixture"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          assigned = true;
        }
        return out;
      } });
      const customDelivered = await withLiveWritesAllowed(() => escalate({ ...ask, taskId: "LEGACY-CUSTOM-LATCH" }, { issues: routed,
        ledgerPath: join(root, "legacy-custom.ndjson"), runId: "LEGACY-CUSTOM", triage: { mode: "shadow" } }));
      assert.equal(customDelivered, "https://github.com/fixture/loop/issues/7", "standalone custom callers keep synchronous delivery before consuming the incident");
      assert.equal(assigned, true, "the supplied route retains its real post-create assignment");
      assert.ok(legacySleeps > beforeCustom, "a custom legacy caller keeps its existing positive wait contract");
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
          armImpl: async () => ({ outcome: "plan-pr-held", directMergePreflight: { reason: "plan_pr_refresh_bound", remedy: "operator", planMergeUnsafe: "fixture" } }),
        });
        const rows = (): Array<Record<string, unknown>> => readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
        const cancelBefore = shim.events().length;
        await withLiveWritesAllowed(() => transport.withDaemonGhTransportFloor(() =>
          effects.escalateCancelledCheck!(pr, { name: "required-check" }, "cancelled twice")));
        const cancelCommands = shim.events().slice(cancelBefore).filter((event) => event.phase === "start");
        assert.ok(cancelCommands.some((event) => event.args.slice(0, 2).join(" ") === "issue create"), "the production cancellation callback must deliver through the real default gateway");
        for (const event of cancelCommands) {
          assertRoute(event.args);
          assert.ok(during.has(event.id), `cancellation escalation must yield to the loop timer during ${event.args.join(" ")}`);
        }
        const infraBefore = shim.events().length;
        const infraPr = { ...pr, prNumber: pr.prNumber + 100, headSha: `${pr.headSha}-infra` };
        await withLiveWritesAllowed(() => transport.withDaemonGhTransportFloor(() =>
          effects.escalateInfrastructureCheck!(infraPr, { name: "infrastructure-check", logTail: "fixture failure" },
            "bounded retry refused", ARTIFACT_FINALIZE_INTERMEDIARY_403)));
        const infraCommands = shim.events().slice(infraBefore).filter((event) => event.phase === "start");
        assert.ok(infraCommands.some((event) => event.args.slice(0, 2).join(" ") === "issue create"), "the production infrastructure callback must deliver through the real default gateway");
        for (const event of infraCommands) {
          assertRoute(event.args);
          assert.ok(during.has(event.id), `infrastructure escalation must yield to the loop timer during ${event.args.join(" ")}`);
        }
        const armBefore = shim.events().length;
        await withLiveWritesAllowed(() => transport.withDaemonGhTransportFloor(() => effects.arm(pr)));
        const armCommands = shim.events().slice(armBefore).filter((event) => event.phase === "start");
        assert.ok(armCommands.some((event) => event.args.slice(0, 2).join(" ") === "issue create"), "the production plan-refresh-bound arm route must deliver through the real default gateway");
        for (const event of armCommands) {
          assertRoute(event.args);
          assert.ok(during.has(event.id), `arm escalation must yield to the loop timer during ${event.args.join(" ")}`);
        }
        const beforeEvents = shim.events().length;
        try {
          await withLiveWritesAllowed(() => transport.withDaemonGhTransportFloor(() => effects.dispatchFix(pr, { unmetCriteria: [] })));
          assert.ok(effects.terminalFixStandDown?.(pr), `${mode}: parent must await delivered acknowledgement`);
          const delivered = rows().find((row) => row.step === "sweep.fix.uncreditable_head_escalated");
          assert.equal(delivered?.issue_url, "https://github.com/fixture/loop/issues/7", `${mode}: only an actual URL may be acknowledged`);
          const commands = shim.events().slice(beforeEvents).filter((event) => event.phase === "start");
          assert.ok(commands.some((event) => event.args.slice(0, 2).join(" ") === "issue create"), `${mode}: the real default gateway must create the fixture issue`);
          for (const event of commands) {
            assertRoute(event.args);
            assert.ok(during.has(event.id), `${mode}: timer must run during the default caller's child ${event.args.join(" ")}`);
          }
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
    rmSync(shim.dir, { recursive: true, force: true });
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
