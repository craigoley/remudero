import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { lintTask, proofGrepAlreadyTrueViolations } from "../src/lib/task-linter.js";
import type { AcceptanceCriterion, Task } from "../src/lib/plan.js";
import { lintPlanCommand } from "../src/run-task.js";
import { isolatedCheckout } from "./helpers/isolated-checkout.js";

const FIXTURE = isolatedCheckout(process.cwd());

test.after(() => FIXTURE.cleanup());

const TARGET = "plan/tasks.d/W1-T3529-run-review-evidence-target.yaml";
const TARGET_TEXT = "- id: W1-T3529\n  rationale: |\n    a target is never re-derived from a bare repo name\n";
const PRESENT = "a target is never re-derived from a bare repo name";
const ABSENT = "text the build will add and no file holds yet";

const reader = (files: Record<string, string>) => (rel: string) => files[rel];

function task(acceptance: AcceptanceCriterion[], over: Partial<Task> = {}): Task {
  return {
    id: "W1-T4904",
    title: "fixture",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    files: ["src/lib/example.ts"],
    acceptance,
    ...over,
  };
}

const crit = (claim: string, pattern: string, extra: object = {}): AcceptanceCriterion =>
  ({ claim, proof: `grep: ${pattern} in ${TARGET}`, ...extra }) as AcceptanceCriterion;

const opts = (baseAcceptance: AcceptanceCriterion[]) => ({
  readGrepProofFile: reader({ [TARGET]: TARGET_TEXT }),
  baseAcceptance,
});

test("W1-T4904: a grep proof that already matches its target is reported on a new task", () => {
  const t = task([crit("c1", PRESENT), crit("c2", ABSENT)]);
  const found = lintTask(t, opts([])).violations.filter((v) => v.check === "proof-grep-already-true");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, "warn");
  assert.match(found[0]!.message, /criterion 1 /);
  assert.match(found[0]!.message, /kind: guard/);
  assert.match(found[0]!.message, /ADDS/);
});

test("W1-T4904: a criterion declared kind guard is not reported as already matching", () => {
  const t = task([crit("c1", PRESENT, { kind: "guard" }), crit("c2", ABSENT)]);
  assert.deepEqual(proofGrepAlreadyTrueViolations(t, opts([])), []);
});

test("W1-T4904: an unchanged criterion on an amended task is not reported", () => {
  const inherited = crit("c1", PRESENT);
  const unchanged = task([inherited, crit("c2", ABSENT)]);
  assert.deepEqual(proofGrepAlreadyTrueViolations(unchanged, opts([inherited])), []);
  const swapped = task([crit("c1", "a target is never re-derived")]);
  assert.equal(proofGrepAlreadyTrueViolations(swapped, opts([inherited])).length, 1, "a changed proof is judged");
  const addedLater = task([inherited, crit("c3", PRESENT)]);
  assert.equal(proofGrepAlreadyTrueViolations(addedLater, opts([inherited])).length, 1, "a new criterion is judged");
});

test("W1-T4904: the check is silent without a base, a reader, a verify auto task or a present target", () => {
  const t = task([crit("c1", PRESENT)]);
  assert.deepEqual(proofGrepAlreadyTrueViolations(t, { readGrepProofFile: reader({ [TARGET]: TARGET_TEXT }) }), []);
  assert.deepEqual(proofGrepAlreadyTrueViolations(t, { baseAcceptance: [] }), []);
  assert.deepEqual(proofGrepAlreadyTrueViolations(task(t.acceptance!, { verify: "human" }), opts([])), []);
  assert.deepEqual(proofGrepAlreadyTrueViolations(t, { baseAcceptance: [], readGrepProofFile: reader({}) }), []);
  const other = task([{ claim: "c1", proof: "unit test: test/foo.test.ts" }, { claim: "c2", proof: "not a proof", satisfied_by: "#1" }]);
  assert.deepEqual(proofGrepAlreadyTrueViolations(other, opts([])), []);
});

test("W1-T4904: a task's own acceptance block does not count as already matching text", () => {
  const own = "plan/tasks.d/W1-T4904-fixture.yaml";
  const text = `- id: W1-T4904\n  acceptance:\n    - claim: "c1"\n      proof: "grep: ${ABSENT} in ${own}"\n`;
  const t = task([{ claim: "c1", proof: `grep: ${ABSENT} in ${own}` }]);
  assert.deepEqual(proofGrepAlreadyTrueViolations(t, { baseAcceptance: [], readGrepProofFile: reader({ [own]: text }) }), []);
  const prose = `- id: W1-T4904\n  rationale: |\n    ${ABSENT}\n  acceptance:\n    - claim: "c1"\n      proof: "x"\n`;
  assert.equal(proofGrepAlreadyTrueViolations(t, { baseAcceptance: [], readGrepProofFile: reader({ [own]: prose }) }).length, 1);
});

function shard(id: string, proofLine: string): string {
  return [
    `- id: ${id}`,
    '  title: "already-true fixture"',
    "  repo: remudero",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  risk: low",
    "  status: queued",
    "  attempts: 0",
    "  origin: architect",
    "  files: [src/lib/task-linter.ts]",
    "  acceptance:",
    '    - claim: "the fixture claim"',
    proofLine,
    "",
  ].join("\n");
}

async function lintFiling(id: string, proofLine: string): Promise<{ exitCode: number; output: string }> {
  const shardDir = join(FIXTURE.root, "plan", "tasks.d");
  mkdirSync(shardDir, { recursive: true });
  const rel = `plan/tasks.d/${id}-fixture.yaml`;
  writeFileSync(join(FIXTURE.root, rel), shard(id, proofLine));
  const base = execFileSync("git", ["-C", FIXTURE.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", FIXTURE.root, "add", rel]);
  execFileSync("git", ["-C", FIXTURE.root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", `fixture(plan): file ${id}`]);
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (m?: unknown) => void lines.push(String(m));
  console.warn = (m?: unknown) => void lines.push(String(m));
  console.error = (m?: unknown) => void lines.push(String(m));
  try {
    const exitCode = await lintPlanCommand(["--plan", join(FIXTURE.root, "plan", "tasks.yaml"), "--base", base], {
      repoRoot: FIXTURE.root,
      offline: true,
    });
    return { exitCode, output: lines.join("\n") };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

test("W1-T4904: a plan-only filing that introduces an already matching grep proof is refused", async () => {
  const { exitCode, output } = await lintFiling(
    "W1-T4904-A",
    '      proof: "grep: export interface AcceptanceCriterion in src/lib/plan.ts"',
  );
  assert.equal(exitCode, 1, output);
  assert.match(output, /\[proof-grep-already-true\]/);
  assert.match(output, /introduced by this plan-only shard/);
});

test("W1-T4904: a plan-only filing whose grep proof is a declared guard or a forward reference is not refused", async () => {
  const guard = await lintFiling(
    "W1-T4904-B",
    ['      proof: "grep: export interface AcceptanceCriterion in src/lib/plan.ts"', "      kind: guard"].join("\n"),
  );
  assert.doesNotMatch(guard.output, /proof-grep-already-true/);
  const forward = await lintFiling("W1-T4904-C", '      proof: "grep: a line no file holds yet in src/lib/plan.ts"');
  assert.doesNotMatch(forward.output, /proof-grep-already-true/);
});
