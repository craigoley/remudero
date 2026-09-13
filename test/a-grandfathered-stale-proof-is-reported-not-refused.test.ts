import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(), "..");
function dirname(): string {
  return fileURLToPath(new URL(".", import.meta.url));
}
const GATE = pathToFileURL(join(REPO_ROOT, "scripts", "proof-discrimination-gate.mjs")).href;

const { judgeStaleAgainstAllowance, main, readStaleBaseline, staleAllowanceFor } = (await import(GATE)) as {
  judgeStaleAgainstAllowance: (n: number, allowed: number) => { ok: boolean; staleCount: number; allowed: number; excess: number };
  staleAllowanceFor: (taskId: string | undefined, baseline: Record<string, unknown>) => number;
  readStaleBaseline: (root?: string) => Record<string, number>;
  main: (argv: string[], deps: Record<string, unknown>) => number;
};

// ── a required gate that refuses two thirds of its corpus is a wall, not a signal ────────────────
//
// MEASURED on origin/main 2026-09-13: a whole-file `unit test: <path>` proof is stale BY CONSTRUCTION —
// `check-proof --base` returns exit 5 for it every time, sampled on test/plan.test.ts (hits 100),
// test/daemon.test.ts (820) and test/mounts.test.ts (256), all `verdict: pass`, all exit 5. And that
// shape is the repo's DOMINANT idiom: 5,368 such proofs across 1,214 tasks, ~69% of all 7,767 proofs.
//
// So proof-discrimination, which is REQUIRED and had no allowance, refused the majority of the plan on
// arrival. The gate is not wrong — a proof that passes at the base cannot establish a PR's work — the
// corpus simply predates it. The repo's own answer to that is a ratchet, and this is one.

const FIXED_BASELINE = { "W1-T900": 2, "W1-T901": 0 };

/** One stale proof, shaped as `evaluateProofDiscrimination` returns them. */
const staleRow = (proof: string) => ({ proof, head: "5", base: "5", output: "" });

function runGate(over: Record<string, unknown>) {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = main(["--event-path", "/dev/null"], {
    root: REPO_ROOT,
    readPayload: () => ({ readable: true, baseSha: "b", headSha: "h", body: "Remudero-Task: W1-T900" }),
    mergeBase: () => ({ ok: true, mergeBase: "deadbeef" }),
    resolveCriteria: () => ({ criteria: [{ claim: "c", proof: "unit test: test/plan.test.ts" }], source: "task acceptance" }),
    runProof: () => ({ status: 5, stdout: "hits: 100\nbase hits: 100\n" }),
    baseline: () => FIXED_BASELINE,
    log: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) },
    ...over,
  });
  return { code, logs, errors };
}

test("a stale proof INSIDE its task's allowance passes, and is still reported so the backlog stays visible", () => {
  const { code, logs, errors } = runGate({});
  assert.equal(code, 0, `expected pass within allowance; errors: ${errors.join(" | ")}`);
  const joined = logs.join("\n");
  assert.match(joined, /OK \(grandfathered\)/);
  assert.match(joined, /W1-T900/, "the row that admitted it must be named");
  assert.match(joined, /allowance of 2/);
  assert.match(joined, /stale \(allowed\): unit test: test\/plan\.test\.ts/, "silence would hide a backlog that only shrinks if visible");
});

test("FALSIFIER: one MORE stale proof than the allowance is refused, and the refusal names the row and the excess", () => {
  // Without this the grandfather would be an exemption rather than a ratchet: the whole point is that
  // adding a new non-discriminating proof still fails.
  const { code, errors } = runGate({
    resolveCriteria: () => ({
      criteria: [
        { claim: "a", proof: "unit test: test/plan.test.ts" },
        { claim: "b", proof: "unit test: test/daemon.test.ts" },
        { claim: "c", proof: "unit test: test/mounts.test.ts" },
      ],
      source: "task acceptance",
    }),
  });
  assert.equal(code, 1, "three stale against an allowance of two must refuse");
  const joined = errors.join("\n");
  assert.match(joined, /Allowance for W1-T900: 2/);
  assert.match(joined, /carries 3, 1 over/);
});

test("a PR with NO task trailer gets zero allowance — it authors its own criteria and inherits no backlog", () => {
  const { code, errors } = runGate({
    readPayload: () => ({ readable: true, baseSha: "b", headSha: "h", body: "no trailer here" }),
  });
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /No resolvable Remudero-Task trailer/);
});

test("a task recorded at zero is refused like any other — a row is an allowance, not membership", () => {
  const { code } = runGate({
    readPayload: () => ({ readable: true, baseSha: "b", headSha: "h", body: "Remudero-Task: W1-T901" }),
  });
  assert.equal(code, 1, "W1-T901 is recorded at 0, so one stale proof already exceeds it");
});

test("no stale proofs still passes plainly, with no grandfather wording", () => {
  const { code, logs } = runGate({ runProof: () => ({ status: 0, stdout: "hits: 3\n" }) });
  assert.equal(code, 0);
  assert.doesNotMatch(logs.join("\n"), /grandfathered/, "a clean PR must not be described as grandfathered");
});

test("staleAllowanceFor refuses every non-count: absent, zero, negative, fractional, string, and no task id", () => {
  assert.equal(staleAllowanceFor("W1-T900", FIXED_BASELINE), 2);
  assert.equal(staleAllowanceFor("W1-T901", FIXED_BASELINE), 0);
  assert.equal(staleAllowanceFor("W1-TMISSING", FIXED_BASELINE), 0);
  assert.equal(staleAllowanceFor(undefined, FIXED_BASELINE), 0, "no task id means no backlog to inherit");
  assert.equal(staleAllowanceFor("x", { x: -3 }), 0, "a negative row must never widen the gate");
  assert.equal(staleAllowanceFor("x", { x: 1.5 }), 0, "a fractional row is not a count");
  assert.equal(staleAllowanceFor("x", { x: "9" } as unknown as Record<string, number>), 0, "a string row is not a count");
});

test("judgeStaleAgainstAllowance is a ratchet at the boundary, not a range", () => {
  assert.deepEqual(judgeStaleAgainstAllowance(2, 2), { ok: true, staleCount: 2, allowed: 2, excess: 0 });
  assert.deepEqual(judgeStaleAgainstAllowance(3, 2), { ok: false, staleCount: 3, allowed: 2, excess: 1 });
  assert.deepEqual(judgeStaleAgainstAllowance(0, 0), { ok: true, staleCount: 0, allowed: 0, excess: 0 });
});

test("an UNREADABLE baseline grandfathers nothing — a fault cannot admit a stale proof", () => {
  // Fail-closed is the only safe direction for a required check: the alternative is a missing file
  // silently opening the gate for every task at once.
  assert.deepEqual(readStaleBaseline("/nonexistent-root-for-this-test"), {});
  const { code } = runGate({ baseline: () => ({}) });
  assert.equal(code, 1, "with nothing grandfathered, the stale proof must refuse as before");
});

test("the committed baseline is a real census, and its metadata matches its rows", () => {
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "proof-discrimination-baseline.json"), "utf8")) as Record<string, unknown>;
  const rows = Object.entries(raw).filter(([k]) => !k.startsWith("_"));
  assert.ok(rows.length > 1000, `expected the measured corpus, saw ${rows.length} row(s)`);
  assert.equal(rows.length, raw._measuredTasks, "the recorded task count must match the rows actually present");
  const total = rows.reduce((n, [, v]) => n + (v as number), 0);
  assert.equal(total, raw._measuredTotal, "the recorded total must match the rows actually present");
  for (const [task, n] of rows) {
    // A letter suffix is real: `W1-T54b` is in the live corpus (1 of 1,214). Asserting the strict
    // `W1-T<digits>` shape failed on it, and widening to match the plan is the correction — not
    // dropping the assertion, which is what keeps a stray key out of a table the gate trusts.
    assert.match(task, /^W1-T\d+[a-z]?$/, `${task} is not a task id`);
    assert.ok(Number.isInteger(n) && (n as number) > 0, `${task} must record a positive integer, got ${n}`);
  }
});
