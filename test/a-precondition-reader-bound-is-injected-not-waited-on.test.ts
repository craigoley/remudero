import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { loadPlanFromYaml, readTaskPrecondition, unmetTaskPrecondition, PRECONDITION_MAX_BYTES, PRECONDITION_TIMEOUT_MS } from "../src/lib/plan.js";

// W1-T5632: the reader's kill bound is a parameter. A test injects it instead of waiting out the
// production 5 s, and a real child that must NOT be killed gets a bound load cannot reach.
const GENEROUS_MS = 120_000;
const INJECTED_MS = 200;

const subject = loadPlanFromYaml(`
- id: A
  title: deferred task
  repo: remudero
  type: implement
  files: [src/a.ts]
  precondition: {read: [status], expect: ready}
`, "precondition-bound-fixture").tasks[0];

/** The cause a failed read names: its own exit, its own output cap, or the kill bound. */
function causeOf(error: unknown): "exit-1" | "max-buffer" | "timeout" | "other" {
  const e = error as NodeJS.ErrnoException & { status?: number | null };
  if (e.code === "ETIMEDOUT") return "timeout";
  if (e.code === "ENOBUFS") return "max-buffer";
  if (e.status === 1) return "exit-1";
  return "other";
}

test("W1-T5632: the production bound stays PRECONDITION_TIMEOUT_MS when no bound is passed", () => {
  assert.equal(PRECONDITION_TIMEOUT_MS, 5_000);
  const output = readTaskPrecondition(["status"], (_file, _args, options) => {
    assert.equal(options.timeout, PRECONDITION_TIMEOUT_MS);
    assert.equal(options.killSignal, "SIGKILL");
    return "ready";
  });
  assert.equal(output, "ready");
});

test("W1-T5632: a fixture-spawned hung child is killed at the injected bound", () => {
  let seen: number | undefined;
  assert.throws(() => readTaskPrecondition(["status"], (_file, _args, options) => {
    seen = options.timeout;
    assert.equal(options.timeout, INJECTED_MS, "the injected bound must reach the runner");
    return execFileSync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
  }, INJECTED_MS), (error: unknown) => causeOf(error) === "timeout");
  assert.equal(seen, INJECTED_MS);
});

test("W1-T5632: failing and oversized real children fail on their own cause, never the kill bound", () => {
  for (const [script, cause] of [
    ["process.stdout.write('ready');process.exit(1)", "exit-1"],
    [`process.stdout.write('x'.repeat(${PRECONDITION_MAX_BYTES + 1}))`, "max-buffer"],
    [`process.stderr.write('x'.repeat(${PRECONDITION_MAX_BYTES + 1}))`, "max-buffer"],
  ] as const) {
    const errors: unknown[] = [];
    const result = unmetTaskPrecondition(subject, { readPrecondition: (args) => readTaskPrecondition(args, (_file, _args, options) => {
      assert.equal(options.timeout, GENEROUS_MS);
      try {
        return execFileSync(process.execPath, ["-e", script], options);
      } catch (error) {
        errors.push(error);
        throw error;
      }
    }, GENEROUS_MS) });
    assert.equal(result?.reason, "read-failed", script);
    assert.equal(errors.length, 1, script);
    assert.equal(causeOf(errors[0]), cause, `${script}: ${String(errors[0])}`);
  }
});

test("W1-T5632: a timeout cannot pass for a failing child's cause", () => {
  const timedOut = Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT", status: 1 });
  assert.equal(causeOf(timedOut), "timeout");
  assert.notEqual(causeOf(timedOut), "exit-1");
  assert.notEqual(causeOf(timedOut), "max-buffer");
  assert.equal(causeOf(new Error("unrelated")), "other");
  const result = unmetTaskPrecondition(subject, { readPrecondition: (args) => readTaskPrecondition(args, () => { throw timedOut; }, GENEROUS_MS) });
  assert.deepEqual(result, { reason: "read-failed", error: String(timedOut) });
});
