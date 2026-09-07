// test/a-draft-nobody-files-is-a-report-nobody-reads.test.ts — W1-T2968.
//
// W1-T2959's acceptance criterion 2 reads "one firing FILES at most the ceiling many records".
// `mintCiLearningShards` returns drafts and `ciLearningCommand` console-logs them: the criterion is
// satisfied by a printed line and nothing enters the plan. This task gives the rung a writer.
//
// THE PREREQUISITE, MEASURED HERE FIRST. Law 5's containment is `author_class: machine` plus
// `verify: human` — the mark rides the record and `machineAuthorVerifyViolation` refuses it at
// `verify: auto`. That argument is only worth anything if the mark SURVIVES BEING WRITTEN TO A
// FILE, and until this task it did not: `parseTasksFromYaml` never read `e.author_class`, so every
// record loaded from disk carried `undefined` and the rule could not fire on any of them.
// W1-T2959's own tests built Task objects in memory and never round-tripped one — the unit passed
// and the wire was never tested, the same shape W1-T2972 was filed to close.
//
// So the first two tests below are not scene-setting. They are the reason a writer is safe to ship.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPlanFromYaml } from "../src/lib/plan.js";
import { lintTask } from "../src/lib/task-linter.js";
import {
  ciLearningRecordVerdict,
  ciLearningShardYaml,
  fileCiLearningShards,
  type CiLearningShardDraft,
  type CiLearningShardWriteFs,
} from "../src/lib/measurement-cadence.js";

/** One draft in the shape `mintCiLearningShards` emits. */
function draft(over: Partial<CiLearningShardDraft> = {}): CiLearningShardDraft {
  return {
    findingId: "ci-learning:4283:coverage-ratchet",
    title:
      "THE coverage-ratchet GATE WENT RED ON #4283 AND WAS REPAIRED — carry the lesson to the lane " +
      "that hit it, so the same gate does not refuse a second pull request for the same reason",
    gate: "coverage-ratchet",
    prs: [4283],
    pr: 4283,
    repairFiles: ["src/lib/rule-efficacy.ts"],
    author_class: "machine",
    verify: "human",
    remedySurface: "learnings/*.yaml",
    ...over,
  };
}

/** A recording writer: every test runs with ZERO real filesystem writes. */
function recorder(): { fs: CiLearningShardWriteFs; written: Map<string, string>; dirs: string[] } {
  const written = new Map<string, string>();
  const dirs: string[] = [];
  return {
    written,
    dirs,
    fs: {
      mkdirSync: (dir) => void dirs.push(dir),
      writeFileSync: (path, data) => void written.set(path, data),
    },
  };
}

/** A minter standing in for the reservation path, counting its calls. */
function minter(ids: string[]): { mint: () => string; calls: () => number } {
  let i = 0;
  return { mint: () => ids[i++] ?? `W1-T-EXHAUSTED-${i}`, calls: () => i };
}

// ── (1) THE PREREQUISITE: the mark must survive being written and read back ──────────────────

test("W1-T2968 the author-class mark SURVIVES a round trip through the plan parser", () => {
  const yaml = ciLearningShardYaml(draft(), "W1-T2994");
  const task = loadPlanFromYaml(yaml, "round-trip").tasks[0];
  assert.equal(
    task.author_class,
    "machine",
    "the mark must survive parsing — a record whose mark the loader discards is UNMARKED on disk, " +
      "and Law 5's whole containment reduces to a field nothing can read",
  );
});

test("W1-T2968 THE FALSIFIER: a machine-authored record at verify:auto is BLOCKED after a round trip", () => {
  // THE BLOCKING CONTROL, and it must run on the PARSED task rather than an in-memory one — that
  // distinction IS the defect this test was written to catch. Measured before the fix: the parsed
  // task linted `ok: true` while the identical in-memory task blocked on `machine-author-verify`.
  const parked = loadPlanFromYaml(ciLearningShardYaml(draft(), "W1-T2994"), "parked").tasks[0];
  assert.equal(lintTask(parked).ok, true, "control: the record this rung actually writes lints CLEAN");

  const selfDispatching = ciLearningShardYaml(draft(), "W1-T2994").replace("verify: human", "verify: auto");
  const escaped = loadPlanFromYaml(selfDispatching, "escaped").tasks[0];
  const result = lintTask(escaped);
  assert.equal(result.ok, false, "a machine-authored record that would DISPATCH ITSELF must be refused");
  assert.ok(
    result.violations.some((v) => v.check === "machine-author-verify" && v.severity === "block"),
    `and refused BY NAME; got: ${result.violations.map((v) => `${v.severity}:${v.check}`).join(", ") || "(none)"}`,
  );
});

// ── (2) THE WRITER: a draft becomes a real record on disk ────────────────────────────────────

test("W1-T2968 a firing WRITES each draft as a plan record, and the written bytes parse back as a task", () => {
  const r = recorder();
  const m = minter(["W1-T2994"]);
  const out = fileCiLearningShards([draft()], "/wt", {
    mintTaskId: m.mint,
    fs: r.fs,
    join: (...p) => p.join("/"),
    planOrigins: [],
  });

  assert.equal(out.filed.length, 1, "the draft was filed");
  assert.deepEqual(out.refused, [], "and nothing was refused");
  assert.equal(out.filed[0].taskId, "W1-T2994");
  assert.match(out.filed[0].relPath, /^plan\/tasks\.d\/W1-T2994-.*\.yaml$/, "under the shard path convention");

  // ASSERT ON THE BYTES THAT LAND, never on the draft object — a writer that returned a correct
  // result while writing nothing is exactly the defect this task closes.
  const [path, contents] = [...r.written.entries()][0];
  assert.ok(path.endsWith(out.filed[0].relPath), `the file landed at the reported path; got ${path}`);
  const task = loadPlanFromYaml(contents, path).tasks[0];
  assert.equal(task.id, "W1-T2994");
  assert.equal(task.origin, "ci-learning:4283:coverage-ratchet", "the finding id rides the record as its origin");
});

test("W1-T2968 every written record carries the MARK and PARKS, asserted on the bytes", () => {
  const r = recorder();
  fileCiLearningShards([draft()], "/wt", {
    mintTaskId: minter(["W1-T2994"]).mint,
    fs: r.fs,
    join: (...p) => p.join("/"),
    planOrigins: [],
  });
  const contents = [...r.written.values()][0];
  const task = loadPlanFromYaml(contents, "bytes").tasks[0];
  assert.equal(task.author_class, "machine", "LAW 5: the author class rides the record");
  assert.equal(task.verify, "human", "and it parks — isDispatchEligible refuses verify !== auto");
});

test("W1-T2968 a record the rung writes passes the repository's OWN task linter", () => {
  const r = recorder();
  fileCiLearningShards([draft()], "/wt", {
    mintTaskId: minter(["W1-T2994"]).mint,
    fs: r.fs,
    join: (...p) => p.join("/"),
    planOrigins: [],
  });
  const task = loadPlanFromYaml([...r.written.values()][0], "lint").tasks[0];
  const result = lintTask(task);
  assert.equal(
    result.ok,
    true,
    `a rung must never file a record the plan would refuse; got: ${result.violations.map((v) => `${v.severity}:${v.check}`).join(", ")}`,
  );
});

// ── (3) FAIL CLOSED: a record that would not lint is REFUSED, not written ────────────────────

test("W1-T2968 a draft whose record would NOT lint is refused and NOTHING is written for it", () => {
  const r = recorder();
  // A GATE NAME CARRYING A GLOB, which is a real hazard rather than a contrived one: the finding id
  // rides the record's `grep:` proof, a grep proof is a BASIC REGEX, and a glob matches nothing —
  // so the linter refuses it on `proof-grep-safety`. MEASURED: this exact draft blocks, and a
  // plain-title defect (an empty title) does NOT, which is why the test uses this one.
  const out = fileCiLearningShards([draft({ findingId: "ci-learning:*:*", gate: "*" })], "/wt", {
    mintTaskId: minter(["W1-T2994"]).mint,
    fs: r.fs,
    join: (...p) => p.join("/"),
    planOrigins: [],
  });
  assert.equal(out.filed.length, 0, "nothing was filed");
  assert.equal(r.written.size, 0, "and nothing reached the writer at all — validation precedes the write");
  assert.equal(out.refused.length, 1, "the refusal is NAMED rather than silently dropped");
  assert.equal(out.refused[0].findingId, "ci-learning:*:*");
  assert.match(out.refused[0].reason, /proof-grep-safety/, "and names the check that refused it");
});

test("W1-T2968 a record missing its provenance is refused too — the guard is not one special case", () => {
  // A second, independent refusal, so the fail-closed claim does not rest on a single check. An
  // empty finding id leaves `origin:` empty and the proof pattern empty at once.
  const r = recorder();
  const out = fileCiLearningShards([draft({ findingId: "" })], "/wt", {
    mintTaskId: minter(["W1-T2994"]).mint,
    fs: r.fs,
    join: (...p) => p.join("/"),
    planOrigins: [],
  });
  assert.equal(r.written.size, 0, "nothing written");
  assert.equal(out.refused.length, 1);
  assert.match(out.refused[0].reason, /provenance/, "Rules 16/17: a record with no origin is refused");
});

// ── (4) IDEMPOTENCY, against a plan that ALREADY HOLDS the record ────────────────────────────

test("W1-T2968 a second firing over the same corpus writes NOTHING, because the writer reads the plan", () => {
  const first = recorder();
  const out1 = fileCiLearningShards([draft()], "/wt", {
    mintTaskId: minter(["W1-T2994"]).mint,
    fs: first.fs,
    join: (...p) => p.join("/"),
    planOrigins: [],
  });
  assert.equal(out1.filed.length, 1, "control: the first firing really did file it");

  // FIRED AGAINST A PLAN THAT ALREADY HOLDS IT — not against an empty one, which passes trivially.
  const second = recorder();
  const m = minter(["W1-T2995"]);
  const out2 = fileCiLearningShards([draft()], "/wt", {
    mintTaskId: m.mint,
    fs: second.fs,
    join: (...p) => p.join("/"),
    planOrigins: ["ci-learning:4283:coverage-ratchet"],
  });
  assert.equal(out2.filed.length, 0, "the second firing files nothing");
  assert.equal(second.written.size, 0, "and writes nothing");
  assert.deepEqual(out2.skipped, ["ci-learning:4283:coverage-ratchet"], "the skip is reported, not silent");
  assert.equal(m.calls(), 0, "AND NO ID IS BURNED — a skipped draft must not consume a reservation");
});

// ── (5) THE ID COMES FROM THE RESERVATION PATH, NOT A COUNT ──────────────────────────────────

test("W1-T2968 the identifier comes from the injected minter, never from a count of existing records", () => {
  const r = recorder();
  const m = minter(["W1-T4242", "W1-T4243"]);
  const out = fileCiLearningShards(
    [draft(), draft({ findingId: "ci-learning:4290:policy-surface-census", pr: 4290, gate: "policy-surface-census" })],
    "/wt",
    { mintTaskId: m.mint, fs: r.fs, join: (...p) => p.join("/"), planOrigins: [] },
  );
  assert.equal(m.calls(), 2, "one mint per filed record");
  assert.deepEqual(
    out.filed.map((f) => f.taskId),
    ["W1-T4242", "W1-T4243"],
    "the ids are the MINTER's, and they are not consecutive-from-a-max by construction — " +
      "a counter would have produced something derived from the plan instead",
  );
});

// ── (6) THE REAL WRITER REACHES A REAL FILESYSTEM ────────────────────────────────────────────

test("W1-T2968 the default writer really writes: a record lands on disk and loads from there", () => {
  // Every test above injects a recorder, which leaves the DEFAULT filesystem seam unexecuted — the
  // all-fakes trap CLAUDE.md's coverage section names. One test does it for real, in a tmp root.
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-learning-file-"));
  try {
    const out = fileCiLearningShards([draft()], root, {
      mintTaskId: minter(["W1-T2994"]).mint,
      planOrigins: [],
    });
    assert.equal(out.filed.length, 1);
    const onDisk = readFileSync(join(root, out.filed[0].relPath), "utf8");
    const task = loadPlanFromYaml(onDisk, "disk").tasks[0];
    assert.equal(task.author_class, "machine", "the mark is on disk, not just in memory");
    assert.equal(task.verify, "human");
    assert.equal(lintTask(task).ok, true, "and the file the rung actually wrote lints clean");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (7) REACHABILITY: the verb actually calls the filer ──────────────────────────────────────

import { ciLearningCommand } from "../src/run-task.js";
import { mkdirSync } from "node:fs";

/** Capture console output for one call. */
function captured(fn: () => number): { code: number; out: string } {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    return { code: fn(), out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

/** A window with one repaired pair, in `loadCiFailureWindow`'s output shape. */
const repairedWindow = () => ({
  prs: [
    {
      number: 4283,
      commits: [
        { sha: "redsha01", rollup: [{ name: "coverage-ratchet", conclusion: "FAILURE" as const }] },
        { sha: "greensha1", rollup: [{ name: "coverage-ratchet", conclusion: "SUCCESS" as const }], files: ["src/lib/x.ts"] },
      ],
    },
  ],
});

test("W1-T2968 REACHABILITY: a firing of the VERB reaches the filer — not just the filer's own unit", () => {
  // W1-T2972's lesson, applied to this task: a suite that only called `fileCiLearningShards` would
  // pass just as happily on a verb that still printed drafts and wrote nothing, which is precisely
  // the defect being closed. So drive the real command and assert on what it hands the filer.
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-learning-wire-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    let handed: readonly CiLearningShardDraft[] | undefined;
    const r = captured(() =>
      ciLearningCommand(["--force"], {
        root,
        loadWindow: () => repairedWindow() as never,
        planOrigins: [],
        fileShards: (drafts, worktree, deps) => {
          handed = drafts;
          assert.equal(worktree, root, "the filer writes under the rung's OWN root");
          assert.equal(typeof deps.mintTaskId, "function", "and is given a minter, not a counter");
          return { filed: [{ relPath: "plan/tasks.d/W1-T2994-x.yaml", taskId: "W1-T2994", findingId: drafts[0].findingId }], skipped: [], refused: [] };
        },
      }),
    );
    assert.equal(r.code, 0);
    assert.ok(handed, "THE CLAIM: the verb reached the filer. Before this task it printed and returned.");
    assert.equal(handed?.length, 1, "and handed it the drafted shard");
    assert.match(r.out, /FILED W1-T2994 -> plan\/tasks\.d\//, "and the filing is reported, not silent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2968 the verb feeds the plan's own origins into the minter, closing the hardcoded empty list", () => {
  // `mintCiLearningShards(corpus, [])` was hardcoded, so idempotency was inert at the call site
  // even once the writer existed. A finding the plan already holds must never be re-drafted.
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-learning-idem-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    let called = false;
    const r = captured(() =>
      ciLearningCommand(["--force"], {
        root,
        loadWindow: () => repairedWindow() as never,
        planOrigins: ["ci-learning:4283:coverage-ratchet"], // the plan ALREADY holds this finding
        fileShards: (drafts) => {
          called = true;
          return { filed: [], skipped: [], refused: [] };
        },
      }),
    );
    assert.equal(r.code, 0);
    assert.equal(called, false, "no drafts survived the dedup, so the filer is never reached");
    assert.doesNotMatch(r.out, /DRAFT ci-learning:4283:coverage-ratchet/, "and nothing is re-drafted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2968 a filer that THROWS does not take the report down with it, and says so", () => {
  // The minter fails CLOSED by inheritance — an unreachable origin or unreadable plan throws rather
  // than minting optimistically, which is right for the claim and wrong for the operator: the
  // drafts are already on screen. MEASURED: before this, an unreadable plan under the run's root
  // took the whole verb out with ENOENT and reddened three of W1-T2959's tests.
  const root = mkdtempSync(join(tmpdir(), "rmd-ci-learning-throw-"));
  try {
    const r = captured(() =>
      ciLearningCommand(["--force"], {
        root,
        loadWindow: () => repairedWindow() as never,
        planOrigins: [],
        fileShards: () => {
          throw new Error("origin unreachable");
        },
      }),
    );
    assert.equal(r.code, 0, "a filing failure is not a failed report");
    assert.match(r.out, /DRAFT ci-learning:4283:coverage-ratchet/, "the drafts still reach the operator");
    assert.match(r.out, /NOT FILED/, "and 'drafted but not filed' is NAMED, never silently equal to 'filed'");
    assert.match(r.out, /origin unreachable/, "carrying the real reason");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T2968 the UNPARSEABLE arm is a guard, not a claim — bytes that will not parse are refused", () => {
  // MEASURED BY CI, not guessed: diff-coverage blocked on this catch arm because every draft the
  // renderer produces parses cleanly and takes the LINT arm instead. A catch no test can enter is a
  // claim rather than a guard, so the verdict is reachable on its own (the catch-arm trap).
  const control = ciLearningRecordVerdict(ciLearningShardYaml(draft(), "W1-T2994"), "control");
  assert.deepEqual(control, { ok: true, reason: "" }, "control: a real rendered record passes both arms");

  const notYaml = ciLearningRecordVerdict("- id: [unclosed\n  title: \"x", "broken");
  assert.equal(notYaml.ok, false, "bytes that will not parse are REFUSED, never written");
  assert.match(notYaml.reason, /unparseable:/, "and named as unparseable, distinct from a lint refusal");

  const notATask = ciLearningRecordVerdict("- id: W1-T1\n  title: t\n", "no-repo");
  assert.equal(notATask.ok, false, "a well-formed document that is not a task is refused too");
  assert.match(notATask.reason, /unparseable:/);
});
