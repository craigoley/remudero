// test/a-machine-filed-shard-reads-as-an-operator-ruling.test.ts — W1-T2959.
//
// LAW 5: "RECORDS LAUNDER AUTHORITY UNLESS THE AUTHOR CLASS RIDES THE RECORD — unmarked records
// read as ratified; origin tags carry commission, not intent"
// (docs/research/research-laws-and-gaps-2026-08-05.md, Part 1). Its own prediction names the
// failure this suite exists to prevent: "any new record channel added without a mandatory
// author-class mark will, within weeks, carry a machine conclusion a later reader treats as an
// operator ruling."
//
// THE PROHIBITION IS ON AN UNMARKED RECORD, NOT ON FILING. So the compliant shape already in this
// repo is `rulingVerifyViolation`'s (W1-T326/W1-T353): mark the record, and refuse it at
// `verify: auto` so `isDispatchEligible` PARKS it until a person looks. A marked, parked shard can
// neither present itself as ratified nor dispatch itself.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { machineAuthorVerifyViolation } from "../src/lib/task-linter.js";
import { lintTask } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";
import {
  CI_LEARNING_MINT_CEILING,
  ciLearningCadenceCheck,
  ciLearningCadenceMarkerPath,
  ciLearningShardId,
  mintCiLearningShards,
  recordCiLearningCadenceFire,
} from "../src/lib/measurement-cadence.js";
import type { CiFailureCorpus, CiFailurePair } from "../src/lib/ci-failure-corpus.js";

/** A minimal, otherwise-clean Task fixture — mirrors test/task-linter.test.ts's own helper so a
 *  violation this suite reports is this suite's field and never an unrelated lint. */
function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "queued",
    attempts: 0,
    origin: "architect",
    acceptance: [{ claim: "does the thing", proof: "unit test test/foo.test.ts asserts the thing" }],
    ...over,
  };
}

const pair = (over: Partial<CiFailurePair> & { pr: number; gate: string }): CiFailurePair => ({
  redSha: `red${over.pr}`,
  greenSha: `green${over.pr}`,
  repairFiles: ["src/lib/x.ts"],
  state: "repaired",
  ...over,
});

const corpus = (over: Partial<CiFailureCorpus> = {}): CiFailureCorpus => ({
  status: "populated",
  prsScanned: 4,
  unreadableShas: [],
  pairs: [],
  ...over,
});

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-w1t2959-"));
}

// ── (iii) THE AUTHOR-CLASS MARK IS A FIELD AND A LINT ─────────────────────────────────────────

test("W1-T2959 a shard marked machine-authored is REFUSED at verify:auto — it cannot dispatch itself", () => {
  const v = machineAuthorVerifyViolation(task({ id: "W1-T9001", author_class: "machine", verify: "auto" }));
  assert.ok(v, "a marked shard at verify:auto must be refused");
  assert.equal(v.severity, "block");
  assert.equal(v.check, "machine-author-verify");
  assert.match(v.message, /W1-T9001/);
  assert.match(v.message, /verify: human/, "the message must name the remedy, not merely refuse");
});

test("W1-T2959 the same marked shard at verify:human PASSES — the loop may propose, only a person releases", () => {
  assert.equal(
    machineAuthorVerifyViolation(task({ id: "W1-T9001", author_class: "machine", verify: "human" })),
    undefined,
  );
});

test("W1-T2959 an UNMARKED shard at verify:auto still passes — the mark is load-bearing, not a blanket refusal", () => {
  // Without this the arm would refuse every task in the plan and its green would mean nothing.
  assert.equal(machineAuthorVerifyViolation(task({ id: "W1-T9002", verify: "auto" })), undefined);
  assert.equal(
    machineAuthorVerifyViolation(task({ id: "W1-T9003", author_class: "operator", verify: "auto" })),
    undefined,
    "an operator-authored shard is exactly a person's shard and is graded as one",
  );
});

test("W1-T2959 the arm is WIRED into lintTask, not merely exported", () => {
  // W1-T365's shape: a gate proves a UNIT and never a WIRE. This asserts the wire.
  const marked = lintTask(task({ id: "W1-T9004", author_class: "machine", verify: "auto" }));
  assert.ok(
    marked.violations.some((v) => v.check === "machine-author-verify" && v.severity === "block"),
    "lintTask must surface the refusal",
  );
  assert.equal(marked.ok, false, "and a BLOCKING violation must flip ok false");
  const unmarked = lintTask(task({ id: "W1-T9005", verify: "auto" }));
  assert.equal(
    unmarked.violations.filter((v) => v.check === "machine-author-verify").length,
    0,
    "and must not fire on a person's shard",
  );
});

// ── (i) ONE ROW, ONE MARKER, THE SHARED DECISION FUNCTION ────────────────────────────────────

test("W1-T2959 the rung paces on its OWN marker file, distinct from every sibling cadence", () => {
  const root = tmpRoot();
  const mine = ciLearningCadenceMarkerPath(root);
  assert.match(mine, /state[/\\]/, "the marker lives under state/");
  // A short interval on one rung must never drag another — the reason digestCadence states for
  // not folding into measurementCadence.
  assert.notEqual(mine, join(root, "state", "last-measurement-cadence.json"));
  assert.notEqual(mine, join(root, "state", "last-digest-cadence.json"));
});

test("W1-T2959 the rung decides through the SHARED two-bound function: disabled, then interval, then daily cap", () => {
  const root = tmpRoot();
  const ON = { enabled: true, minIntervalMinutes: 60, maxPerDay: 1 };
  const now = new Date("2026-09-06T12:00:00Z");

  assert.equal(ciLearningCadenceCheck({ root, policy: { ...ON, enabled: false }, now }).fire, false);

  // No marker at all: fires.
  assert.equal(ciLearningCadenceCheck({ root, policy: ON, now }).fire, true);

  // After a fire, the interval bound holds it.
  recordCiLearningCadenceFire(root, now);
  const tooSoon = ciLearningCadenceCheck({ root, policy: ON, now: new Date("2026-09-06T12:30:00Z") });
  assert.equal(tooSoon.fire, false);
  assert.ok(tooSoon.reason, "a refusal names its reason");

  // Past the interval but at the daily cap: still refused, and for a DIFFERENT reason.
  const capped = ciLearningCadenceCheck({ root, policy: ON, now: new Date("2026-09-06T18:00:00Z") });
  assert.equal(capped.fire, false);
  assert.notEqual(capped.reason, tooSoon.reason, "the two bounds must be distinguishable");
});

test("W1-T2959 a corrupt marker fails CLOSED rather than firing", () => {
  const root = tmpRoot();
  const p = ciLearningCadenceMarkerPath(root);
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "{ not json");
  const d = ciLearningCadenceCheck({ root, policy: { enabled: true, minIntervalMinutes: 1, maxPerDay: 99 } });
  assert.equal(d.fire, false);
});

// ── (ii) THE MINT CEILING IS A PRIMARY CONTROL ───────────────────────────────────────────────

test("W1-T2959 one firing files AT MOST the ceiling, and NAMES every finding it excluded", () => {
  const pairs = Array.from({ length: CI_LEARNING_MINT_CEILING + 2 }, (_, i) =>
    pair({ pr: 100 + i, gate: `gate-${i}` }),
  );
  const r = mintCiLearningShards(corpus({ pairs }), []);
  assert.equal(r.status, "backlog");
  assert.equal(r.drafts.length, CI_LEARNING_MINT_CEILING, "the ceiling is a PRIMARY control, not a backstop");
  assert.equal(r.excludedFindings.length, 2, "the excess is NAMED, never silently dropped");
  for (const e of r.excludedFindings) assert.match(e, /gate-/, "an excluded finding names itself");
});

test("W1-T2959 a rerun over the same corpus files NOTHING new — idempotent by deterministic id", () => {
  const pairs = [pair({ pr: 100, gate: "coverage-ratchet" }), pair({ pr: 101, gate: "source-size" })];
  const first = mintCiLearningShards(corpus({ pairs }), []);
  assert.equal(first.drafts.length, 2);

  const already = first.drafts.map((d) => d.findingId);
  const second = mintCiLearningShards(corpus({ pairs }), already);
  assert.equal(second.drafts.length, 0, "the second fire over an unchanged corpus files nothing");
  assert.equal(second.status, "clear", "and reports a measured absence rather than a backlog");
});

test("W1-T2959 the dedup id is deterministic and discriminating", () => {
  const a = ciLearningShardId({ pr: 100, gate: "coverage-ratchet" });
  assert.equal(a, ciLearningShardId({ pr: 100, gate: "coverage-ratchet" }), "same finding, same id");
  assert.notEqual(a, ciLearningShardId({ pr: 100, gate: "source-size" }), "a different gate is a different finding");
  assert.notEqual(a, ciLearningShardId({ pr: 101, gate: "coverage-ratchet" }), "a different PR is a different finding");
});

// ── (iv) EVERY DRAFT THE RUNG PRODUCES CARRIES THE MARK AND PARKS ────────────────────────────

test("W1-T2959 every draft the rung produces is MARKED and PARKED, and the linter agrees", () => {
  const r = mintCiLearningShards(corpus({ pairs: [pair({ pr: 100, gate: "coverage-ratchet" })] }), []);
  assert.equal(r.drafts.length, 1);
  const d = r.drafts[0];
  assert.equal(d.author_class, "machine", "Law 5: the author class rides the record");
  assert.equal(d.verify, "human", "isDispatchEligible refuses verify !== auto, so this PARKS");

  // The two halves must agree: a draft flipped to auto is refused by the linter that ships.
  const asFiled = task({ id: "W1-T9100", author_class: d.author_class, verify: d.verify });
  assert.equal(machineAuthorVerifyViolation(asFiled), undefined, "as produced, it lints clean");
  assert.ok(
    machineAuthorVerifyViolation({ ...asFiled, verify: "auto" }),
    "and the instant anything flips it to auto, the linter refuses it",
  );
});

test("W1-T2959 only a repaired pair is mintable — an open failure has no fix to learn from yet", () => {
  const r = mintCiLearningShards(
    corpus({ pairs: [pair({ pr: 100, gate: "still-red", state: "open", greenSha: undefined, repairFiles: undefined })] }),
    [],
  );
  assert.equal(r.drafts.length, 0);
  assert.equal(r.status, "clear");
});

// ── (v) A MEASURED ABSENCE, NEVER A BARE ZERO (P48) ──────────────────────────────────────────

test("W1-T2959 an EMPTY corpus and an UNREADABLE one are different answers", () => {
  const empty = mintCiLearningShards(corpus({ status: "clear", pairs: [] }), []);
  assert.equal(empty.status, "clear");
  assert.equal(empty.drafts.length, 0);
  assert.deepEqual(empty.unreadableShas, []);

  const blind = mintCiLearningShards(
    corpus({ status: "unreadable", pairs: [], unreadableShas: ["deadbeef"] }),
    [],
  );
  assert.equal(blind.status, "unreadable", "a window never seen is NOT a window with nothing in it");
  assert.deepEqual(blind.unreadableShas, ["deadbeef"], "the unreadable shas are NAMED");
  assert.notEqual(blind.status, empty.status, "the two must be distinguishable by a caller");
});

test("W1-T2959 an unreadable corpus that DID yield a repaired pair still names what it could not read", () => {
  // Partial blindness is the dangerous case: something was found, so a caller could read the
  // result as complete. The unreadable shas must survive onto the result either way.
  const r = mintCiLearningShards(
    corpus({ status: "unreadable", pairs: [pair({ pr: 100, gate: "coverage-ratchet" })], unreadableShas: ["cafe"] }),
    [],
  );
  assert.equal(r.drafts.length, 1, "what WAS read is still mined");
  assert.deepEqual(r.unreadableShas, ["cafe"], "and the blindness is still reported");
  assert.equal(r.status, "unreadable", "status reports the weaker claim, never the stronger");
});

// ── (v) THE OUTPUT MUST REACH THE LANE THAT OPENS THE PRs ────────────────────────────────────

test("W1-T2959 a draft names a surface a DISPATCHED WORKER can actually read", () => {
  // WHY THE SURFACE MATTERS: spawnWorker passes `settingSources: []`, the SDK's isolation mode, so a
  // dispatched worker NEVER reads CLAUDE.md. A shard whose remedy were "add a CLAUDE.md bullet"
  // would improve interactive sessions and change nothing about the fleet's own pull requests.
  //
  // THAT INVARIANT IS NOT RE-ASSERTED HERE, DELIBERATELY. `claims`' own `worker-loads-no-claude-md`
  // (W1-T2759) already holds it as a shipped gate. Reading src/lib/worker.ts as TEXT here would add
  // no coverage the gate does not have, and would be the exact defect W1-T2905's census refuses: a
  // test that passes when the prose is right and the behaviour wrong, and breaks on a refactor that
  // moved the prose and nothing else.
  const r = mintCiLearningShards(corpus({ pairs: [pair({ pr: 100, gate: "coverage-ratchet" })] }), []);
  const d = r.drafts[0];
  assert.match(d.remedySurface, /learnings\//, "the remedy must name the surface that reaches the fleet");
  assert.doesNotMatch(d.remedySurface, /CLAUDE\.md/, "and never CLAUDE.md, which no dispatched worker reads");
});

// ── THE COMMAND SURFACE, over an INJECTED window — zero network ──────────────────────────────
// The defaults these functions carry (`ghJson`, the real config root) are the one line each a unit
// test cannot reach; the dispatch case names that boundary explicitly.

import { ciLearningCommand } from "../src/run-task.js";
import { loadPolicy } from "../src/lib/policy.js";

/** Capture console.log/error for one call — mirrors the sibling corpus suite's own helper. */
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

/** A window shaped like `loadCiFailureWindow`'s output: one PR whose gate goes red then green. */
const repairedWindow = () => ({
  prs: [
    {
      number: 42,
      commits: [
        { sha: "redsha01", rollup: [{ name: "coverage-ratchet", conclusion: "FAILURE" as const }] },
        { sha: "greensha1", rollup: [{ name: "coverage-ratchet", conclusion: "SUCCESS" as const }], files: ["src/lib/x.ts"] },
      ],
    },
  ],
});

test("W1-T2959 the rung is REACHABLE from the command surface and renders a MARKED, PARKED draft", () => {
  // BEHAVIOUR, NOT SOURCE TEXT (W1-T2905): rendering a draft only the minter can produce IS the
  // proof it is wired. An unwired minter renders no draft at all.
  const r = captured(() =>
    ciLearningCommand(["--force"], { root: tmpRoot(), loadWindow: () => repairedWindow() as never }),
  );
  assert.equal(r.code, 0);
  assert.match(r.out, /DRAFT ci-learning:42:coverage-ratchet/);
  assert.match(r.out, /author_class=machine verify=human/, "Law 5's mark must reach the operator's screen");
  assert.match(r.out, /learnings\//, "and the remedy surface a dispatched worker can actually read");
});

test("W1-T2959 the command WRITES NOTHING — no plan record, no working-tree file (Law 5)", () => {
  const planBefore = readFileSync("plan/tasks.yaml");
  const treeBefore = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  ciLearningCommand(["--force"], { root: tmpRoot(), loadWindow: () => repairedWindow() as never });
  assert.ok(planBefore.equals(readFileSync("plan/tasks.yaml")), "the rung must not touch the plan");
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }),
    treeBefore,
    "and must leave no file behind — filing is a separate operator step",
  );
});

test("W1-T2959 the cadence bound HOLDS the command, and --force runs past it without recording", () => {
  const root = tmpRoot();
  // A fire is recorded on a non-forced run, so the next non-forced run is refused by the bound.
  recordCiLearningCadenceFire(root, new Date());
  const ON = { enabled: true, minIntervalMinutes: 1440, maxPerDay: 1 };
  const held = captured(() =>
    ciLearningCommand([], { root, policy: ON, loadWindow: () => repairedWindow() as never }),
  );
  assert.equal(held.code, 0, "being held by the cadence is not an error");
  assert.match(held.out, /not firing/);
  assert.doesNotMatch(held.out, /DRAFT /, "and it drafts nothing while held");

  // --force runs past the same bound.
  const forced = captured(() =>
    ciLearningCommand(["--force"], { root, loadWindow: () => repairedWindow() as never }),
  );
  assert.match(forced.out, /DRAFT ci-learning:42/);
});

test("W1-T2959 an unreadable window exits non-zero rather than rendering as 'nothing to learn'", () => {
  const r = captured(() =>
    ciLearningCommand(["--force"], {
      root: tmpRoot(),
      loadWindow: () => {
        throw new Error("rate limited");
      },
    }),
  );
  assert.equal(r.code, 1, "a window that could not be READ is not a window with nothing in it");
  assert.match(r.out, /could not be read/);
});

test("W1-T2959 bad arguments are refused with exit 2, never a silent default", () => {
  const root = tmpRoot();
  const w = () => repairedWindow() as never;
  assert.equal(captured(() => ciLearningCommand(["--bogus"], { root, loadWindow: w })).code, 2);
  for (const bad of [["--days", "0"], ["--days", "-1"], ["--days", "abc"]]) {
    assert.equal(captured(() => ciLearningCommand([...bad, "--force"], { root, loadWindow: w })).code, 2, bad.join(" "));
  }
});

// ── THE POLICY ROW: present is read, ABSENT defaults OFF ─────────────────────────────────────

test("W1-T2959 an ABSENT ciLearningCadence row defaults DISABLED — the only cadence row that does", () => {
  // Every sibling cadence defaults enabled by being read-only; this rung drafts records, so
  // inheriting a safe-on default would set it without anyone deciding it.
  //
  // THE SHIPPED VALUE IS NO LONGER PINNED HERE, and the DEFAULT still is. The row was switched ON
  // by operator direction (2026-09-07), which is a decision this suite must not veto — but the
  // reason it shipped off is unchanged, so the property that actually protects the plan is the
  // ABSENT-ROW default below: delete the row and the rung goes quiet, never safe-on by inheritance.
  // Pinning the shipped value too would have made an operator's own switch look like a regression.
  const shipped = loadPolicy("plan/policy.yaml").values.ciLearningCadence;
  assert.equal(typeof shipped.enabled, "boolean", "the shipped row still declares the switch explicitly");
  assert.equal(shipped.minIntervalMinutes, 1440, "daily, the operator's own word");
  assert.equal(shipped.maxPerDay, 1);

  // And the absent-row default agrees with the shipped row, so removing it changes nothing.
  const dir = tmpRoot();
  const stripped = readFileSync("plan/policy.yaml", "utf8").replace(
    /\nciLearningCadence:\n(?:[ \t].*\n|\n)*/,
    "\n",
  );
  assert.doesNotMatch(stripped, /ciLearningCadence:/, "the control: the row really is gone");
  const p = join(dir, "policy.yaml");
  writeFileSync(p, stripped);
  const absent = loadPolicy(p).values.ciLearningCadence;
  // THE INVARIANT THIS TEST EXISTS FOR, untouched: no row means NO firing.
  assert.deepEqual(absent, { enabled: false, minIntervalMinutes: 1440, maxPerDay: 1 });
});

test("W1-T2959 an UNREADABLE policy fails CLOSED — a rung that drafts never fires on an unread bound", () => {
  const r = captured(() =>
    // A root with no plan/policy.yaml: loadPolicy throws, and the rung must refuse rather than
    // treat an unreadable bound as an absent one.
    ciLearningCommand([], { root: tmpRoot(), loadWindow: () => repairedWindow() as never }),
  );
  assert.equal(r.code, 1);
  assert.match(r.out, /failing closed/);
});

// ── W1-T3032: the state root and the checkout are two different trees ────────────────────────────

/*
 * MEASURED on the rung's first real run, a 14-day window over 100 pull requests: three drafts
 * minted and then "NOT FILED — the filer could not run (ENOENT ... '<config.root>/plan/tasks.yaml')",
 * preceded by "the plan could not be read for already-filed findings — proceeding without it".
 *
 * `config.root` is the STATE root; `plan/` lives in the CHECKOUT, which on a fleet host sits one
 * level inside it. Every sibling verb reads its plan through `repoRoot`; this one alone joined
 * `plan/` onto the state root, so it could neither FILE what it drafted nor DEDUP against what it
 * had filed before. Enabled, it would have re-drafted the same findings every day and filed none.
 * The `--force` path hid the third instance — the policy read, which fails closed.
 */

test("W1-T3032: the plan is read from the CHECKOUT, while the cadence marker stays on the state root", () => {
  const stateRoot = tmpRoot();
  const checkoutRoot = tmpRoot();
  mkdirSync(join(checkoutRoot, "plan"), { recursive: true });
  // A plan holding one origin, so a hit proves the read landed HERE and not on the state root.
  writeFileSync(
    join(checkoutRoot, "plan", "tasks.yaml"),
    [
      "- id: W1-T1",
      '  title: "a record whose origin is the finding under test"',
      "  repo: remudero",
      "  depends_on: []",
      "  type: implement",
      "  verify: auto",
      "  principles: {tdd: strict}",
      "  budget_usd: 1.00",
      "  files: [src/x.ts]",
      '  origin: "operator-session#unrelated"',
      "  status: queued",
      "  attempts: 0",
      "",
    ].join("\n"),
  );

  let filedInto: string | undefined;
  const r = captured(() =>
    ciLearningCommand(["--force"], {
      root: stateRoot,
      checkoutRoot,
      loadWindow: () => repairedWindow() as never,
      fileShards: ((_d: unknown, where: string) => {
        filedInto = where;
        return { filed: [], skipped: [], refused: [] };
      }) as never,
    }),
  );

  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /could not be read for already-filed findings/, "the plan must be readable");
  assert.equal(filedInto, checkoutRoot, "filing targets the checkout, never the state root");
  assert.notEqual(filedInto, stateRoot);
});

test("W1-T3032: an origin already in the checkout's plan is not re-drafted — dedup needs the right tree", () => {
  const stateRoot = tmpRoot();
  const checkoutRoot = tmpRoot();
  mkdirSync(join(checkoutRoot, "plan"), { recursive: true });
  writeFileSync(
    join(checkoutRoot, "plan", "tasks.yaml"),
    [
      "- id: W1-T1",
      '  title: "a record whose origin is the finding under test"',
      "  repo: remudero",
      "  depends_on: []",
      "  type: implement",
      "  verify: auto",
      "  principles: {tdd: strict}",
      "  budget_usd: 1.00",
      "  files: [src/x.ts]",
      '  origin: "ci-learning:42:coverage-ratchet"',
      "  status: queued",
      "  attempts: 0",
      "",
    ].join("\n"),
  );

  const r = captured(() =>
    ciLearningCommand(["--force"], {
      root: stateRoot,
      checkoutRoot,
      loadWindow: () => repairedWindow() as never,
      fileShards: (() => ({ filed: [], skipped: [], refused: [] })) as never,
    }),
  );
  assert.doesNotMatch(r.out, /DRAFT ci-learning:42:coverage-ratchet/, "an already-filed finding must not re-draft");
});

test("W1-T3032: an injected root alone keeps the run self-contained, so a suite cannot file into the real plan", () => {
  // The fallback order. Every pre-existing test passes ONLY `root` and asserts the command touches
  // no plan; defaulting the checkout to `repoRoot` would have made them write into the real one.
  const only = tmpRoot();
  let filedInto: string | undefined;
  captured(() =>
    ciLearningCommand(["--force"], {
      root: only,
      loadWindow: () => repairedWindow() as never,
      fileShards: ((_d: unknown, where: string) => {
        filedInto = where;
        return { filed: [], skipped: [], refused: [] };
      }) as never,
    }),
  );
  assert.equal(filedInto, only, "an injected root must resolve the checkout to itself, never to repoRoot");
});
