// test/an-inherited-red-is-not-the-authors.test.ts — W1-T3037.
//
// MEASURED 2026-09-07. `source-size-ratchet` was BLOCKED on `src/run-task.ts` on a CLEAN
// origin/main checkout, so EVERY open pull request inherited the failure whatever its own diff
// contained. It surfaced on a branch touching only `src/lib/review.ts` — a diff with no possible
// relationship to the violation — and six PRs were red on it at once while nothing said why.
//
// Nobody's individual mistake: several PRs each grew that file, each recorded the ceiling its OWN
// tree measured, and the sum crossed a bucket boundary after they merged. The bucket debounces
// concurrent growth WITHIN a boundary; it cannot debounce a crossing no individual run ever saw.
//
// THE TEST IS THE ONE THE REVIEWER ALREADY MAKES FOR PROOFS: `classifyBaseProofOutcome` re-runs a
// proof against the merge base and calls a pass there STALE, because a check holding on both sides
// discriminates nothing. A violation reproducing on the base is that same shape.
//
// IT LABELS, IT NEVER SILENCES — an inherited violation still blocks. Main being broken is not a
// licence to merge past a gate; what changes is that the author learns whose repair it is.

import assert from "node:assert/strict";
import { test } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = (await import(pathToFileURL(join(REPO_ROOT, "scripts/lib/inherited-violation.mjs")).href)) as {
  contentAtRef: (run: unknown, ref: string, path: string) => { kind: string; text?: string; why?: string };
  splitInheritedViolations: (v: unknown[], o: Record<string, unknown>) => {
    inherited: { path: string }[];
    introduced: { path: string }[];
    undetermined: { path: string }[];
  };
  inheritedNotice: (v: { path: string }[], ref: string, tool: string) => string | undefined;
};
const { contentAtRef, splitInheritedViolations, inheritedNotice } = mod;

/** A `run` that answers one canned spawnSync-shaped result. */
const runner = (status: number | null, stdout = "") => () => ({ status, stdout });

const opts = (run: unknown, measure: (t: string) => number, baseline: Record<string, number>) => ({
  run,
  ref: "origin/main",
  measure,
  baselineFor: (p: string) => baseline[p],
});

test("W1-T3037: a violation that already holds at the base is INHERITED, not introduced", () => {
  const split = splitInheritedViolations([{ path: "src/big.ts" }], opts(runner(0, "x\n".repeat(500)), (t) => t.split("\n").length - 1, { "src/big.ts": 100 }));
  assert.deepEqual(split.inherited.map((v) => v.path), ["src/big.ts"]);
  assert.deepEqual(split.introduced, []);
});

test("W1-T3037: a file WITHIN its ceiling at the base was grown by this diff — INTRODUCED", () => {
  const split = splitInheritedViolations([{ path: "src/big.ts" }], opts(runner(0, "x\n".repeat(50)), (t) => t.split("\n").length - 1, { "src/big.ts": 100 }));
  assert.deepEqual(split.introduced.map((v) => v.path), ["src/big.ts"]);
  assert.deepEqual(split.inherited, []);
});

test("W1-T3037: a file ABSENT at the base is new here, so its violation cannot be inherited", () => {
  const split = splitInheritedViolations([{ path: "src/new.ts" }], opts(runner(128), (t) => t.length, {}));
  assert.deepEqual(split.introduced.map((v) => v.path), ["src/new.ts"]);
  assert.deepEqual(split.inherited, []);
});

test("W1-T3037: a NULL exit status is UNREADABLE, never absent — the defect this helper shipped with", () => {
  // spawnSync returns status null when the child is killed or its output exceeds maxBuffer, which
  // is not hypothetical: src/run-task.ts is over 1MB at the base and blew the 1MB default. The
  // first draft read that as "absent" and reported the INHERITED violation as INTRODUCED —
  // silently, in the exact case the helper was written for.
  assert.equal(contentAtRef(runner(null, "partial"), "origin/main", "src/huge.ts").kind, "unreadable");

  const split = splitInheritedViolations([{ path: "src/huge.ts" }], opts(runner(null, "partial"), (t) => t.length, { "src/huge.ts": 1 }));
  assert.deepEqual(split.undetermined.map((v) => v.path), ["src/huge.ts"], "an unaskable base is undetermined");
  assert.deepEqual(split.introduced, [], "and must NEVER be blamed on this diff");
  assert.deepEqual(split.inherited, []);
});

test("W1-T3037: a file with no recorded ceiling entered at zero, so any content at the base is inherited", () => {
  const split = splitInheritedViolations([{ path: "src/unlisted.ts" }], opts(runner(0, "a\n"), (t) => t.length, {}));
  assert.deepEqual(split.inherited.map((v) => v.path), ["src/unlisted.ts"]);
});

test("W1-T3037: the notice names the ref and every inherited path, and says recording repairs the base", () => {
  const n = inheritedNotice([{ path: "src/a.ts" }, { path: "src/b.ts" }], "origin/main", "source-size-ratchet");
  assert.ok(n);
  assert.match(n!, /INHERITED/);
  assert.match(n!, /origin\/main/, "a reader must be able to check the claim against a named ref");
  assert.match(n!, /src\/a\.ts, src\/b\.ts/);
  assert.match(n!, /real repair/, "and be told recording it fixes the base, not their own growth");
});

test("W1-T3037: nothing inherited prints no notice at all, so a clean refusal is not diluted", () => {
  assert.equal(inheritedNotice([], "origin/main", "source-size-ratchet"), undefined);
});

// ── THE TWO CATCH ARMS ───────────────────────────────────────────────────────────────────────
//
// Every test above injects a `run` and a `measure` that RETURN, so neither throwing arm is
// reachable from them — the all-fakes shape CLAUDE.md names ("write one test that really shells
// out, and one per catch arm"), and diff-coverage caught it: lines 33 and 79-80 of
// scripts/lib/inherited-violation.mjs were added with zero covering tests.
//
// Both arms decide the SAME question this module exists to answer — whose repair is this — and
// both must answer "we could not tell" rather than guessing. That is the module's own stated
// hazard: its first draft read unreadable as absent and reported an INHERITED violation as
// INTRODUCED, silently.

test("W1-T3037: a `run` that THROWS reads as unreadable, never as absent — the arm that once blamed the author", () => {
  const thrower = () => {
    throw new Error("spawn ENOMEM");
  };

  const read = contentAtRef(thrower, "origin/main", "src/huge.ts");

  assert.equal(read.kind, "unreadable", "a throw is git NOT ANSWERING, which is not the same as the path being absent");
  assert.notEqual(read.kind, "absent", "reading it as absent is what reports an INHERITED violation as INTRODUCED");
  assert.match(String(read.why), /threw/, "and it must say WHY it could not tell");
});

test("W1-T3037: a `run` that throws leaves the violation UNDETERMINED, so no side is claimed on no evidence", () => {
  const thrower = () => {
    throw new Error("spawn ENOMEM");
  };

  const split = splitInheritedViolations([{ path: "src/huge.ts" }], opts(thrower, (t) => t.length, { "src/huge.ts": 1 }));

  assert.deepEqual(split.undetermined.map((v) => v.path), ["src/huge.ts"]);
  assert.deepEqual(split.inherited, [], "an unreadable base cannot substantiate INHERITED");
  assert.deepEqual(split.introduced, [], "and must not fall through to INTRODUCED either");
});

test("W1-T3037: a `measure` that THROWS on the base content leaves the violation undetermined too", () => {
  // The base content read fine; it is the MEASUREMENT of it that failed. Same answer, because the
  // question is still unanswerable — and a measurement that throws is not evidence of a small file.
  const measureThrows = () => {
    throw new Error("unparseable at base");
  };

  const split = splitInheritedViolations(
    [{ path: "src/odd.ts" }],
    opts(runner(0, "content\n"), measureThrows, { "src/odd.ts": 1 }),
  );

  assert.deepEqual(split.undetermined.map((v) => v.path), ["src/odd.ts"]);
  assert.deepEqual(split.inherited, []);
  assert.deepEqual(split.introduced, [], "a throwing measure must never be read as 'small at base', which would blame the author");
});
