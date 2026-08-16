/**
 * THE RETRO'S ACCEPTANCE-BLOCK REPAIR RUNG (repairRetroAcceptanceBlock, run-task.ts).
 *
 * The widened trigger (`bodyNeedsAcceptanceRepair`) is unit-tested in test/plan-pr-emitter.test.ts.
 * This file covers the PRODUCTION DECISION at the only place it fires: the retro's repair rung. It
 * exists because diff-coverage flagged that call site as a wiring line with `DA:0` — a predicate
 * widened and never reached is this repo's documented "seam built but never called" hazard, aimed
 * squarely at the thing being changed.
 *
 * WHAT THESE DRIVE, stated rather than implied: `repairRetroAcceptanceBlock` is the real production
 * function and its DECISION (trigger, repair, ledger step, both catch arms) is executed here. Most
 * tests inject the two gh leaves; the LAST test injects nothing and drives the real
 * `defaultRetroFetchBody`/`defaultRetroEditBody` against a stub `gh` on PATH, so the shell-out, the
 * argv and the JSON parse are covered too.
 * THE CALL SITE inside `retroCommand` is covered too, but by the retro suites rather than this file
 * (measured: 16 hits on that line with test/retro.test.ts + test/retro-marker-atomic.test.ts in the
 * lcov). A lcov scoped to THIS file alone shows it as DA:0, which is a property of the scoping and
 * not of the code — stated so the next reader does not mistake a narrow run for a real gap.
 * NOTHING in this diff is left unproven.
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts, which
 * intermittently crashes at FILE level under --experimental-test-coverage.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repairRetroAcceptanceBlock, repairRetroChangesetClaim } from "../src/run-task.js";
import { bodyContradictsDiff, parseAcceptanceBlock } from "../src/lib/review.js";

const PR = "https://github.com/craigoley/remudero/pull/999";

function recorder() {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const edits: Array<{ url: string; body: string }> = [];
  return {
    logged,
    edits,
    log: (step: string, extra?: Record<string, unknown>) => logged.push({ step, extra }),
    editBody: (url: string, body: string) => edits.push({ url, body }),
  };
}

/** 3 bullets written; the first wraps, so parseAcceptanceBlock resolves 1 with an EMPTY proof. */
const WRAPPED_BODY = [
  "## Acceptance",
  "- claim: the first claim is long enough that a worker wraps it onto a second",
  "  line for readability",
  "  proof: grep: alpha in src/a.ts",
  "- claim: second",
  "  proof: grep: beta in src/b.ts",
  "",
].join("\n");

const HEALTHY_BODY = ["Acceptance:", "- a claim | grep: needle in src/x.ts", ""].join("\n");

test("the rung REPAIRS a body that parses to one criterion with an empty proof — the case the old trigger walked past", () => {
  const r = recorder();
  // Confirm the premise inside the test rather than trusting the fixture.
  const before = parseAcceptanceBlock(WRAPPED_BODY);
  assert.equal(before.length, 1);
  assert.equal(before[0].proof, "");

  const outcome = repairRetroAcceptanceBlock(PR, r.log, { fetchBody: () => WRAPPED_BODY, editBody: r.editBody });

  assert.equal(outcome, "repaired");
  assert.equal(r.edits.length, 1, "the PR body was actually edited");
  assert.equal(r.edits[0].url, PR);
  const after = parseAcceptanceBlock(r.edits[0].body);
  assert.ok(after.length > 0, "and the body it wrote PARSES");
  assert.equal(after.every((c) => c.proof.trim().length > 0), true, "with no empty proofs left");
  assert.ok(r.logged.some((l) => l.step === "acceptance.repaired"), "and the repair is ledgered");
});

test("REGRESSION LOCK: the rung leaves a HEALTHY body alone — no edit, no ledger line", () => {
  // This matters more than the repair: a rung that rewrites correct bodies is worse than one that
  // misses defective ones, and it would mutate every retro PR on every run.
  const r = recorder();
  const outcome = repairRetroAcceptanceBlock(PR, r.log, { fetchBody: () => HEALTHY_BODY, editBody: r.editBody });

  assert.equal(outcome, "healthy");
  assert.equal(r.edits.length, 0, "no gh pr edit is issued");
  assert.equal(r.logged.length, 0, "and nothing is ledgered — silence is the correct trace here");
});

test("the rung is best-effort — a failed body read is ledgered, never thrown into the retro", () => {
  const r = recorder();
  const outcome = repairRetroAcceptanceBlock(PR, r.log, {
    fetchBody: () => {
      throw new Error("gh exploded");
    },
    editBody: r.editBody,
  });

  assert.equal(outcome, "error");
  assert.equal(r.edits.length, 0);
  const line = r.logged.find((l) => l.step === "acceptance.repair.error");
  assert.ok(line, "the failure is named on its own ledger step");
  assert.match(String(line?.extra?.error), /gh exploded/, "carrying the real message, not a placeholder");
});

test("a failed EDIT is also contained — the read succeeded, the write did not", () => {
  const r = recorder();
  const outcome = repairRetroAcceptanceBlock(PR, r.log, {
    fetchBody: () => WRAPPED_BODY,
    editBody: () => {
      throw new Error("edit refused");
    },
  });
  assert.equal(outcome, "error");
  assert.ok(
    r.logged.some((l) => l.step === "acceptance.repair.error"),
    "and acceptance.repaired is NOT claimed for a repair that never landed",
  );
  assert.equal(r.logged.some((l) => l.step === "acceptance.repaired"), false);
});

test("a body with NO block at all still repairs — the original trigger's case is not regressed", () => {
  const r = recorder();
  const outcome = repairRetroAcceptanceBlock(PR, r.log, { fetchBody: () => "just prose", editBody: r.editBody });
  assert.equal(outcome, "repaired");
  assert.ok(parseAcceptanceBlock(r.edits[0].body).length > 0);
});

// ── THE DEFAULT LEAVES — really shelling out, per CLAUDE.md's #977/#978 rule ─────────────────
//
// Every test above injects `fetchBody`/`editBody`, which leaves `defaultRetroFetchBody` and
// `defaultRetroEditBody` unreachable — the exact "when every test injects a fake, the seam's
// DEFAULT implementation is unreachable" shape that rule names. This one drives the REAL defaults
// by putting a stub `gh` on PATH, so the shell-out, the argv and the JSON parse are all exercised
// without a network call. Same pattern test/prune-liveness.test.ts already uses.

test("the DEFAULT leaves really shell out to gh — argv, JSON parse and the edit are all exercised", () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-repair-"));
  const argvLog = join(bin, "argv.txt");
  // A gh stub that records its argv and answers `pr view --json body` with a DEFECTIVE body, so the
  // real default read feeds the real trigger, which then drives the real default edit.
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\n` +
      `case "$*" in\n  *"--json body"*) printf '{"body":"## Acceptance\\\\n- claim: wrapped onto\\\\n  a second line\\\\n  proof: grep: a in b\\\\n"}' ;;\n  *) : ;;\nesac\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const logged: string[] = [];
    // NO deps object at all — the spread defaults are what run.
    const outcome = repairRetroAcceptanceBlock(PR, (s) => logged.push(s));
    assert.equal(outcome, "repaired", "the real default read + trigger + real default edit all ran");
    const argv = readFileSync(argvLog, "utf8");
    assert.match(argv, /pr view .*--json body/, "defaultRetroFetchBody issued the real view argv");
    assert.match(argv, /pr edit .*--body/, "defaultRetroEditBody issued the real edit argv");
    assert.ok(logged.includes("acceptance.repaired"));
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});

// ── W1-T908: THE CHANGESET CLAIM ─────────────────────────────────────────────────────────────
//
// The rung above repairs the ACCEPTANCE block. This one repairs the sentence that says what the
// PR changed — a separate defect with a separate cause. `retroCommand` spawns the Architect, which
// edits MASTER-PLAN.md and OPENS THE PR WITH A BODY IT AUTHORED; only afterwards does the harness
// commit docs/ORIENTATION.md and plan/plan-index.json onto the same PR. So the body is authored
// before two of the three files exist, and every retro claimed one file while writing three:
// #974 merged before the detector existed, #1685's review refused it, #1943 was hand-repaired
// (its own commit list ends "re-head so the corrected body earns a fresh" verdict), and #1944
// carried remudero-review=failure naming the contradiction verbatim.
//
// These drive the REAL production functions. The strongest of them hands the repaired body to the
// REAL `bodyContradictsDiff` — the gate that refused all four — rather than to a restatement of it.

const RETRO_PATHS = ["MASTER-PLAN.md", "docs/ORIENTATION.md", "plan/plan-index.json"];

/** What the Architect actually writes today, quoted from #974's merged body. */
const TEMPLATED_BODY = [
  "This is a retro sync touching exactly one file: MASTER-PLAN.md. No src/, no test/.",
  "",
  "Acceptance:",
  "- the shipped log is updated | grep: SHIPPED in MASTER-PLAN.md",
  "",
].join("\n");

test("W1-T908: the retro body names every path the run wrote and no others", () => {
  const r = recorder();
  const outcome = repairRetroChangesetClaim(PR, r.log, {
    fetchBody: () => TEMPLATED_BODY,
    editBody: r.editBody,
    changedFiles: () => RETRO_PATHS,
  });

  assert.equal(outcome, "repaired");
  assert.equal(r.edits.length, 1, "the body is written back exactly once");
  const body = r.edits[0].body;

  // EVERY path the run wrote is named.
  for (const p of RETRO_PATHS) assert.ok(body.includes(p), `the repaired body must name ${p}`);
  // AND NO OTHERS — the falsifier for "just list something plausible". A path the run did not
  // write must not appear, or the sentence would be a different flavour of the same lie.
  for (const absent of ["src/run-task.ts", "plan/tasks.yaml", "DECISIONS.md"]) {
    assert.ok(!body.includes(absent), `${absent} was not changed and must not be named`);
  }
  assert.ok(!/exactly\s+\w+\s+files?/i.test(body), "the count claim must be gone, not merely joined");
  assert.equal(r.logged.at(-1)?.step, "changeset_claim.repaired");
  assert.deepEqual(r.logged.at(-1)?.extra?.changed_files, RETRO_PATHS, "the row carries what it named");
});

test("W1-T908: a run that writes a different number of files still names them all", () => {
  // A HARDCODED THREE IS THE SAME DEFECT WEARING A NEW NUMBER. If a future retro stops
  // regenerating the index, or gains a fourth artefact, the sentence must still be correct with
  // nobody editing a number — so both arities are driven here, and the ONE-file case is included
  // because that is the arity the old template happened to get right by accident.
  for (const paths of [["MASTER-PLAN.md"], ["MASTER-PLAN.md", "docs/ORIENTATION.md"],
    [...RETRO_PATHS, "plan/tasks.d/W1-T1.yaml"]]) {
    const r = recorder();
    const outcome = repairRetroChangesetClaim(PR, r.log, {
      fetchBody: () => TEMPLATED_BODY,
      editBody: r.editBody,
      changedFiles: () => paths,
    });
    assert.equal(outcome, "repaired", `arity ${paths.length} must still repair`);
    const body = r.edits[0].body;
    for (const p of paths) assert.ok(body.includes(p), `arity ${paths.length} must name ${p}`);
    assert.ok(!/exactly\s+\w+\s+files?/i.test(body), `arity ${paths.length} must carry no count`);
    // And the sentence must not have acquired a count of its own in words either.
    assert.ok(!/\b(one|two|three|four|1|2|3|4)\s+files?\b/i.test(body), `arity ${paths.length} names paths, not a tally`);
  }
});

test("W1-T908: the templated one-file claim is replaced rather than left standing", () => {
  // THE FALSIFIER, run first: the pre-change template really is refused by the real gate.
  const before = bodyContradictsDiff(TEMPLATED_BODY, RETRO_PATHS);
  assert.ok(before.length > 0, "the pre-change template must contradict the real three-file diff");

  const r = recorder();
  repairRetroChangesetClaim(PR, r.log, {
    fetchBody: () => TEMPLATED_BODY,
    editBody: r.editBody,
    changedFiles: () => RETRO_PATHS,
  });

  // And the repaired body satisfies the SAME detector — not a local restatement of it.
  const after = bodyContradictsDiff(r.edits[0].body, RETRO_PATHS);
  assert.deepEqual(after, [], "the repaired body must not contradict its own diff");

  // A body with no count claim is left completely alone, so the rung discriminates rather than
  // rewriting every retro body it is handed.
  const healthy = recorder();
  const outcome = repairRetroChangesetClaim(PR, healthy.log, {
    fetchBody: () => "Acceptance:\n- a claim | grep: needle in src/x.ts\n",
    editBody: healthy.editBody,
    changedFiles: () => RETRO_PATHS,
  });
  assert.equal(outcome, "healthy");
  assert.equal(healthy.edits.length, 0, "a body with nothing to repair is never rewritten");
});

test("W1-T908: the changeset is read after the harness companions are committed", () => {
  // THE ORDERING IS THE DEFECT, so the ordering is what is pinned. Reading the file set before
  // the harness commits ORIENTATION.md and plan-index.json would reproduce the original bug with
  // a diff read bolted on, which is exactly the wrong fix — this asserts the call site sits
  // after both regenerations in the real production source, not merely that it exists.
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    assert.ok(i > 0, `production source must still contain ${needle}`);
    return i;
  };
  const orientation = at("regenerateOrientation({");
  const planIndex = at("regeneratePlanIndexAndCommit({");
  const repair = at("repairRetroChangesetClaim(prUrl, log)");
  assert.ok(orientation < repair, "docs/ORIENTATION.md is committed before the changeset is read");
  assert.ok(planIndex < repair, "plan/plan-index.json is committed before the changeset is read");

  // CONTROL: the indices are real positions in a real file, not three zeros agreeing by accident.
  assert.notEqual(orientation, planIndex);
  assert.ok(src.indexOf("no such symbol zzq") === -1, "the locator returns -1 for an absent needle");

  // And the seam really is what supplies the paths — injected here, so a future refactor that
  // hardcodes the list fails rather than passing on a coincidence.
  const r = recorder();
  let asked = 0;
  repairRetroChangesetClaim(PR, r.log, {
    fetchBody: () => TEMPLATED_BODY,
    editBody: r.editBody,
    changedFiles: () => { asked += 1; return RETRO_PATHS; },
  });
  assert.equal(asked, 1, "the rung reads the changed paths through the seam, exactly once");
});

test("W1-T908: the real default changed-files seam shells out to gh and its errors are caught", () => {
  // The default is exercised for real (CLAUDE.md: when every test injects a fake, the seam's
  // DEFAULT and each catch arm are unreachable). A stub `gh` on PATH stands in for the binary.
  const bin = mkdtempSync(join(tmpdir(), "rmd-w1t908-gh-"));
  const argvLog = join(bin, "argv.log");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\n` +
      `case "$*" in\n` +
      `  *"--name-only"*) printf 'MASTER-PLAN.md\\ndocs/ORIENTATION.md\\nplan/plan-index.json\\n' ;;\n` +
      `  *"--json body"*) printf '{"body":"touching exactly one file: MASTER-PLAN.md\\\\n"}' ;;\n` +
      `  *) : ;;\nesac\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    // NO deps object at all — every spread default runs, including defaultRetroChangedFiles.
    const outcome = repairRetroChangesetClaim(PR, (step, extra) => logged.push({ step, extra }));
    assert.equal(outcome, "repaired");
    const argv = readFileSync(argvLog, "utf8");
    assert.match(argv, /pr diff .*--name-only/, "the default seam issued the real diff argv");
    assert.match(argv, /pr edit .*--body/, "and the real edit argv");
    assert.deepEqual(logged.at(-1)?.extra?.changed_files, RETRO_PATHS, "the shelled-out paths reached the row");
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }

  // THE CATCH ARM, which no injected-fake test can reach: a throwing read is ledgered, never
  // propagated — `retroCommand` must not fail because a repair attempt failed.
  const errs: string[] = [];
  const outcome = repairRetroChangesetClaim(PR, (s) => errs.push(s), {
    changedFiles: () => { throw new Error("gh exploded"); },
  });
  assert.equal(outcome, "error");
  assert.deepEqual(errs, ["changeset_claim.repair.error"]);
});
