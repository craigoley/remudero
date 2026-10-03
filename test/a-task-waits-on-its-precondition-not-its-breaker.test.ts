import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fixedClock } from "../src/lib/clock.js";
import { loadPlanFromYaml, readTaskPrecondition, unmetTaskPrecondition, PRECONDITION_MAX_BYTES, PRECONDITION_TIMEOUT_MS, PlanError, type Plan } from "../src/lib/plan.js";
import { nextRunnable, runnableCandidates, runDrain, type DrainDeps } from "../src/lib/drain.js";

function plan(fields = ""): Plan {
  return loadPlanFromYaml(`
- id: A
  title: deferred task
  repo: remudero
  type: implement
  files: [src/a.ts]
${fields}
`, "precondition-fixture");
}

function deps(events: Array<{ step: string; detail?: Record<string, unknown> }>, dispatched: string[]): DrainDeps {
  return {
    refreshMerged: () => () => false,
    readUsage: () => undefined,
    runOne: async (id) => {
      dispatched.push(id);
      return { taskId: id, runId: id, verdict: "merged", merged: true, costUsd: 1 };
    },
    log: (step, detail) => events.push({ step, detail }),
  };
}

test("W1-T4843: a task before its not_before date is skipped without a dispatch", async () => {
  const clock = fixedClock(Date.parse("2026-10-01T00:00:00Z"));
  const future = fixedClock(clock.now() + 86_400_000).iso();
  const subject = plan(`  not_before: ${future}`);
  assert.equal(subject.tasks[0].not_before, future);
  for (const options of [{}, { laneCount: 2 }, { curated: ["A"] }]) {
    const events: Array<{ step: string; detail?: Record<string, unknown> }> = [];
    const dispatched: string[] = [];
    const ports = deps(events, dispatched);
    ports.clock = clock;
    ports.isCircuitTripped = () => { assert.fail("the breaker must not be consulted while waiting"); };
    const summary = await runDrain(subject, ports, { ...options, max: 1, headroomEnabled: false });
    assert.deepEqual(dispatched, []);
    assert.deepEqual(summary.attempted, []);
    assert.equal(summary.costUsd, 0);
    assert.equal(summary.stopReason, "no_runnable");
    const held = events.filter((event) => event.step === "dispatch.precondition_unmet");
    assert.equal(held.length, 1);
    assert.equal(held[0].detail?.task, "A");
    assert.equal(held[0].detail?.reason, "not-before");
  }
});

test("W1-T4843: a task whose precondition holds is dispatched", async () => {
  const subject = plan('  precondition: { read: [ledger-grep, traffic.ready], expect: "ready" }');
  assert.deepEqual(subject.tasks[0].precondition, { read: ["ledger-grep", "traffic.ready"], expect: "ready" });
  for (const options of [{}, { laneCount: 2 }, { curated: ["A"] }]) {
    const events: Array<{ step: string; detail?: Record<string, unknown> }> = [];
    const dispatched: string[] = [];
    const ports = deps(events, dispatched);
    let reads = 0;
    ports.readPrecondition = (args) => {
      reads++;
      assert.deepEqual(args, ["ledger-grep", "traffic.ready"]);
      return "ready\n";
    };
    const summary = await runDrain(subject, ports, { ...options, max: 1, headroomEnabled: false });
    assert.equal(reads, 1);
    assert.deepEqual(dispatched, ["A"]);
    assert.deepEqual(summary.attempted, ["A"]);
    assert.deepEqual(summary.merged, ["A"]);
    assert.equal(summary.costUsd, 1);
    assert.equal(events.some((event) => event.step === "dispatch.precondition_unmet"), false);
  }
});

test("W1-T4843: the date boundary opens both selectors and does not read state early", () => {
  const instant = Date.parse("2026-10-01T00:00:00Z");
  for (const date of ["2026-10-01", "2026-10-01T00:00:00Z", "2026-10-01T02:00:00+02:00"]) {
    const subject = plan(`  not_before: ${date}\n  precondition: { read: [status], expect: ready }`);
    let reads = 0;
    const opts = { clock: fixedClock(instant - 1), readPrecondition: () => { reads++; return "ready"; } };
    assert.equal(nextRunnable(subject, () => false, opts), undefined);
    assert.deepEqual(runnableCandidates(subject, () => false, 2, opts), []);
    assert.equal(reads, 0);
    opts.clock = fixedClock(instant);
    assert.equal(nextRunnable(subject, () => false, opts)?.id, "A");
    assert.deepEqual(runnableCandidates(subject, () => false, 2, opts).map((t) => t.id), ["A"]);
    assert.equal(reads, 2);
    opts.clock = fixedClock(instant + 1);
    assert.equal(nextRunnable(subject, () => false, opts)?.id, "A");
  }
});

test("W1-T4843: unmet state is logged and held before the breaker on every drain path", async () => {
  const subject = plan('  precondition: { read: [status], expect: "ready" }');
  for (const options of [{}, { laneCount: 2 }, { curated: ["A"] }]) {
    const events: Array<{ step: string; detail?: Record<string, unknown> }> = [];
    const dispatched: string[] = [];
    const ports = deps(events, dispatched);
    ports.readPrecondition = () => "not ready";
    ports.isCircuitTripped = () => { assert.fail("no breaker budget while waiting"); };
    const summary = await runDrain(subject, ports, { ...options, headroomEnabled: false });
    assert.deepEqual(dispatched, []);
    assert.equal(summary.costUsd, 0);
    assert.deepEqual(events.find((event) => event.step === "dispatch.precondition_unmet")?.detail,
      { task: "A", reason: "unexpected-result", expected: "ready", actual: "not ready" });
  }
});

test("W1-T4843: a waiting task cannot starve another runnable task or be released past its precondition", async () => {
  const subject = plan('  not_before: 2099-01-01');
  const other = { ...subject.tasks[0], id: "B", files: ["src/b.ts"], not_before: undefined };
  subject.tasks.push(other);
  subject.byId.set("B", other);
  assert.equal(nextRunnable(subject, () => false, { clock: fixedClock(0), releasedIds: new Set(["A"]) })?.id, "B");
  assert.deepEqual(runnableCandidates(subject, () => false, 2, { clock: fixedClock(0) }).map((t) => t.id), ["B"]);
  for (const laneCount of [1, 2]) {
    const events: Array<{ step: string; detail?: Record<string, unknown> }> = [];
    const dispatched: string[] = [];
    const ports = deps(events, dispatched);
    ports.clock = fixedClock(0);
    await runDrain(subject, ports, { laneCount, max: 1, headroomEnabled: false });
    assert.deepEqual(dispatched, ["B"]);
  }
});

test("W1-T4843: fieldless tasks retain eligibility without a reader or clock call", () => {
  const subject = plan();
  const opts = { clock: { ...fixedClock(0), now: () => { assert.fail("unused clock"); } }, readPrecondition: () => { assert.fail("unused reader"); } };
  assert.equal(nextRunnable(subject, () => false, opts)?.id, "A");
  assert.deepEqual(runnableCandidates(subject, () => false, 1, opts).map((t) => t.id), ["A"]);
});

test("W1-T4843: invalid dates and precondition shapes are refused at plan load", () => {
  for (const fields of [
    "not_before: null", "not_before: 123", "not_before: tomorrow", "not_before: 2026-02-30",
    "not_before: 2026-13-01", "not_before: 2026-10-01T00:00:00", "not_before: 2026-10-01T24:00:00Z",
    "precondition: null", "precondition: ready", "precondition: {read: [], expect: ready}",
    "precondition: {read: status, expect: ready}", "precondition: {read: [status, 1], expect: ready}",
    "precondition: {read: [status], expect: 1}", "precondition: {read: [status], expect: ''}",
    "precondition: {read: [drain, --dry-run], expect: ready}", "precondition: {read: [doctor, --fix], expect: ready}",
    "precondition: {read: [status, --help, --fix], expect: ready}", "precondition: {read: [sh, -c, echo], expect: ready}",
    "precondition: {read: [trace, --follow], expect: ready}",
  ]) assert.throws(() => plan(`  ${fields}`), PlanError, fields);
});

test("W1-T4843: every allowed read survives plan parsing", () => {
  for (const read of [["--help"], ["status"], ["status", "--json"], ["doctor"], ["doctor", "--json"],
    ["ledger-grep", "traffic.ready"], ["trace", "A"], ["pr-owner", "1"]]) {
    const subject = plan(`  precondition: {read: ${JSON.stringify(read)}, expect: ready}`);
    assert.deepEqual(subject.tasks[0].precondition?.read, read);
  }
});

test("W1-T4843: argument and expected-output bounds are enforced", () => {
  for (const precondition of [
    { read: ["ledger-grep", "x".repeat(1025)], expect: "ready" },
    { read: ["ledger-grep", "x\0y"], expect: "ready" },
    { read: ["ledger-grep", ""], expect: "ready" },
    { read: Array(33).fill("status"), expect: "ready" },
    { read: ["status"], expect: "x".repeat(PRECONDITION_MAX_BYTES + 1) },
    { read: ["status"], expect: " " },
  ]) assert.throws(() => plan(`  precondition: ${JSON.stringify(precondition)}`), PlanError);
});

test("W1-T4843: invalid in-memory fields and unavailable reads have distinct outcomes", () => {
  const subject = plan().tasks[0];
  assert.equal(unmetTaskPrecondition({ ...subject, not_before: "tomorrow" })?.reason, "invalid-not-before");
  assert.equal(unmetTaskPrecondition({ ...subject, not_before: "2026-10-01" }, { clock: fixedClock(NaN) })?.reason, "invalid-not-before");
  assert.equal(unmetTaskPrecondition({ ...subject, precondition: { read: ["drain"], expect: "ready" } })?.reason, "invalid-precondition");
  const readyTask = plan('  precondition: {read: [status], expect: ready}').tasks[0];
  for (const error of [new Error("command failed"), Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), new Error("maxBuffer exceeded")]) {
    const result = unmetTaskPrecondition(readyTask, { readPrecondition: () => { throw error; } });
    assert.deepEqual(result, { reason: "read-failed", error: String(error) });
  }
  assert.equal(unmetTaskPrecondition(readyTask, { readPrecondition: () => "x".repeat(PRECONDITION_MAX_BYTES + 1) })?.reason, "read-failed");
  assert.equal(unmetTaskPrecondition(readyTask, { readPrecondition: () => " ready\n" }), undefined);
  assert.equal(unmetTaskPrecondition(readyTask, { readPrecondition: () => "ready plus other state" })?.reason, "unexpected-result");
});

test("W1-T4843: nested precondition reads stand down without spawning", () => {
  const key = "RMD_TASK_PRECONDITION_READ";
  const previous = process.env[key];
  process.env[key] = "1";
  try {
    assert.deepEqual(unmetTaskPrecondition(plan('  precondition: {read: [status], expect: ready}').tasks[0],
      { readPrecondition: () => { assert.fail("recursive read"); } }), { reason: "recursive-read" });
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test("W1-T4843: the default reader really shells out to the shipped rmd help", () => {
  const output = readTaskPrecondition(["--help"]);
  assert.match(output, /rmd run-task/);
  const subject = plan(`  precondition: ${JSON.stringify({ read: ["--help"], expect: output.trim() })}`);
  assert.equal(unmetTaskPrecondition(subject.tasks[0]), undefined);
});

test("W1-T4843: the reader passes literal arguments with timeout, output cap and recursion guards", () => {
  const literal = "$(echo injected); `echo injected`";
  const output = readTaskPrecondition(["ledger-grep", literal], (file, args, options) => {
    assert.match(file, /\/bin\/rmd$/);
    assert.deepEqual(args, ["ledger-grep", literal]);
    assert.equal(options.timeout, PRECONDITION_TIMEOUT_MS);
    assert.equal(options.maxBuffer, PRECONDITION_MAX_BYTES);
    assert.equal(options.killSignal, "SIGKILL");
    assert.equal(options.shell, false);
    assert.equal(options.env?.RMD_SELF_SYNC_DONE, "1");
    assert.equal(options.env?.RMD_TASK_PRECONDITION_READ, "1");
    return execFileSync(process.execPath, ["-e", "process.stdout.write(process.argv[1])", literal], options);
  });
  assert.equal(output, literal);
  assert.throws(() => readTaskPrecondition(["drain"], () => { assert.fail("write verb reached runner"); }), PlanError);
});

test("W1-T4843: failing and oversized real subprocesses cannot satisfy a precondition", () => {
  const subject = plan('  precondition: {read: [status], expect: ready}').tasks[0];
  for (const script of ["process.stdout.write('ready');process.exit(1)", `process.stdout.write('x'.repeat(${PRECONDITION_MAX_BYTES + 1}))`,
    `process.stderr.write('x'.repeat(${PRECONDITION_MAX_BYTES + 1}))`]) {
    const result = unmetTaskPrecondition(subject, { readPrecondition: (args) => readTaskPrecondition(args,
      (_file, _args, options) => execFileSync(process.execPath, ["-e", script], options)) });
    assert.equal(result?.reason, "read-failed");
  }
});

test("W1-T4843: a hung real subprocess is killed within the reader timeout", () => {
  assert.throws(() => readTaskPrecondition(["status"], (_file, _args, options) =>
    execFileSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options)),
  (error: unknown) => (error as NodeJS.ErrnoException).code === "ETIMEDOUT");
});
