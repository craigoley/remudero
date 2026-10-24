import assert from "node:assert/strict";
import { test } from "node:test";
import { runPreflight, type PreflightSpawn } from "#src/lib/commit-message.js";

test("preflight phase progress starts before each original check and preserves its result", () => {
  const order: string[] = [];
  const spawn: PreflightSpawn = (_file, args) => {
    const name = args.some(a => a.includes("commitlint")) || (args[0] === "log" && !args.includes("--no-merges"))
      ? "commitlint" : args[0] === "log" ? "emitter-checks" : "typecheck";
    order.push(`body:${name}`);
    return { status: name === "commitlint" && args[0] !== "log" ? 7 : 0,
      stdout: args[0] === "log" ? "\0fix(preflight): preserve the verdict\n" : "", stderr: "original failure" };
  };
  const baseline = runPreflight("/fixture", { spawn });
  order.length = 0;
  const events: Array<{phase: string; event: string; phaseId: number; durationMs: number | null}> = [];
  const observed = runPreflight("/fixture", {
    spawn,
    onPhase: event => { events.push(event); order.push(`${event.event}:${event.phase}`); },
  });
  assert.deepEqual(observed, baseline, "diagnostics cannot change the original verdict or details");
  assert.equal(events.length, 6, "the existing production API must deliver all three start/end pairs");
  for (const name of ["commitlint", "typecheck", "emitter-checks"]) {
    const pair = events.filter(event => event.phase === name);
    assert.deepEqual(pair.map(event => event.event), ["started", "returned"]);
    assert.equal(pair[0].phaseId, pair[1].phaseId);
    assert(order.indexOf(`started:${name}`) < order.indexOf(`body:${name}`));
    assert(order.indexOf(`body:${name}`) < order.indexOf(`returned:${name}`));
  }
  assert.equal(new Set(events.map(event => event.phaseId)).size, 3);
  assert.equal(observed.ok, false);
  assert.match(observed.steps[0].detail, /original failure/);
});

test("preflight phase progress cannot skip checks when its reporter throws", () => {
  const calls: string[] = [];
  const spawn: PreflightSpawn = (file, args) => {
    calls.push(file === "git" ? "range" : args.some(arg => arg.includes("commitlint")) ? "commitlint" : "typecheck");
    return {status: 0, stdout: "\0fix(preflight): retained checks\n", stderr: ""};
  };
  const result = runPreflight("/fixture", {spawn, onPhase: () => { throw new Error("diagnostic unavailable"); }});
  assert.deepEqual(calls, ["range", "commitlint", "typecheck", "range"]);
  assert.equal(result.steps.length, 3);
  assert.equal(result.ok, true);
});

test("preflight command connects the data observer without replacing its executor", async () => {
  const {preflightCommand} = await import("#src/run-task.js");
  const phases: string[] = [];
  const calls: string[] = [];
  const spawn: PreflightSpawn = (file, args) => {
    // Run-context Git reads are additional observations, not one of the three checks.
    if (file.endsWith("tsc")) calls.push("typecheck");
    else if (args.some(arg => arg.includes("commitlint"))) calls.push("commitlint");
    else if (args[0] === "log") calls.push("range");
    return {status: 0, stdout: "\0fix(preflight): original executor\n", stderr: ""};
  };
  const code = await preflightCommand(["--no-fast"], {spawn, loadavg: () => [0, 0, 0], cpuCount: 1,
    onPhase: event => { if (event.event === "started") phases.push(event.phase); }});
  assert.equal(code, 0);
  assert.deepEqual(phases, ["default", "commitlint", "typecheck", "emitter-checks"]);
  assert.deepEqual(calls, ["range", "commitlint", "typecheck", "range"]);
});
