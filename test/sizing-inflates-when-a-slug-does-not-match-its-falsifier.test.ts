import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Task } from "../src/lib/plan.js";
import {
  moduleIdFromPath,
  ownFalsifierRenameCandidates,
  shardSlugFromPath,
  sizingViolation,
  subsystemsOf,
} from "../src/lib/task-linter.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHARD_DIR = join(REPO_ROOT, "plan", "tasks.d");

/**
 * test/sizing-inflates-when-a-slug-does-not-match-its-falsifier.test.ts — W1-T2814.
 *
 * `subsystemsOf` counts a test file's stem as a distinct subsystem. W1-T2525 added a carve-out
 * discounting a `test/` path whose `moduleIdFromPath` EQUALS the shard's own filename slug, on the
 * principle that a task's own falsifier is not a second concern. The carve-out is right. But it
 * keys on STRING EQUALITY between two names a filer chooses independently, so a few words'
 * difference defeats it and a one-source-one-test task reads as spanning two subsystems.
 *
 * MEASURED: W1-T2809's filing tripped `[sizing] spans 2 distinct subsystems/concerns
 * (census-discovery-is-blind-to-a-second-idiom, ci-parity) at risk:medium` over exactly that
 * shape. Renaming the shard so its slug matched the test made it pass at `risk: medium` WITH NO
 * OTHER CHANGE.
 *
 * WHY THAT MATTERS, AND IT IS NOT THE ANNOYANCE. The violation names two exits — "raise to
 * risk:high or decompose". REGRADING SILENCES IT IDENTICALLY and looks like the intended fix, so a
 * lane that does not open `subsystemsOf` inflates the band and receives no signal it did anything
 * wrong: no second message, no warning, no ledger row. `risk` drives sizing exemptions, dispatch
 * ordering and effort routing, so a downstream reader may be reading a FILENAME MISMATCH encoded
 * as real span.
 *
 * THIS TASK CHANGES THE MESSAGE AND MEASURES THE POPULATION. It does NOT widen the carve-out
 * (fuzzy or prefix matching, "any single test file" — that is weakening a gate W1-T2525 narrowed
 * deliberately), and it edits no existing shard's `risk` band.
 */

/** The two fixtures differ in ONE respect: whether the declared test's module id equals the slug
 *  passed as `duplicateSlug`. Everything else — files, risk, acceptance — is identical, which is
 *  what makes the pair a controlled comparison rather than two anecdotes. */
const SOURCE_FILE = "src/lib/census-discovery.ts";
const TEST_FILE = "test/census-discovery-is-blind-to-a-second-idiom.test.ts";
const MATCHING_SLUG = "census-discovery-is-blind-to-a-second-idiom";
const DIFFERING_SLUG = "census-discovery-single-idiom-blindness";

function fixture(): Task {
  return {
    id: "W1-T9001",
    title: "a one-source-one-test task",
    risk: "medium",
    files: [SOURCE_FILE, TEST_FILE],
    acceptance: [{ claim: "the second idiom is discovered", proof: `unit test: ${TEST_FILE}` }],
  } as unknown as Task;
}

// ── acceptance 1: the carve-out is what does the work, proved by a controlled pair ─────────────

test("W1-T2814 (acceptance 1): the SAME task passes sizing when its slug matches the declared test and is refused when it differs by a few words", () => {
  const matching = sizingViolation(fixture(), { duplicateSlug: MATCHING_SLUG });
  assert.equal(matching, undefined, "the own-falsifier discount fires and one source stem is one concern");

  const differing = sizingViolation(fixture(), { duplicateSlug: DIFFERING_SLUG });
  assert.ok(differing, "a few words' difference between two independently-chosen names defeats it");
  assert.equal(differing.severity, "block");
  assert.match(differing.message, /spans 2 distinct subsystems\/concerns/);

  // THE CONTROL that makes this a pair rather than two fixtures: the only input that changed is the
  // slug, and `subsystemsOf` — the predicate itself — is what answers differently.
  assert.equal(subsystemsOf(fixture(), undefined, undefined, MATCHING_SLUG).size, 1);
  assert.equal(subsystemsOf(fixture(), undefined, undefined, DIFFERING_SLUG).size, 2);
});

// ── acceptance 2: the message names the third exit AND the condition on it ────────────────────

test("W1-T2814 (acceptance 2): the violation names the rename exit, the file to rename toward, and the condition that makes it legitimate", () => {
  const v = sizingViolation(fixture(), { duplicateSlug: DIFFERING_SLUG });
  assert.ok(v);
  // The two exits that were always there.
  assert.match(v.message, /raise to risk:high or decompose into one task per concern/);
  // The third, and the ACTIONABLE parts of it: which file, which name to rename toward.
  assert.match(v.message, /rename this shard so its filename slug is/, "names the action, not just the possibility");
  assert.ok(v.message.includes(TEST_FILE), "and names WHICH declared file the span turns on");
  assert.ok(v.message.includes(MATCHING_SLUG), "and the exact slug that would resolve it");
  // THE CONDITION. A reader must be able to tell "the carve-out applies to me" from "rename to
  // make this go away" without opening subsystemsOf — this is the text they would act on.
  assert.match(v.message, /ONLY IF/, "the exit is conditional on its face");
  assert.match(
    v.message,
    /the suite written to prove THESE acceptance criteria/,
    "states the property that makes the discount legitimate",
  );
  assert.match(v.message, /not a suite that already exists for another concern/, "and its negation");
  assert.match(v.message, /gaming Rule 19, not\s+satisfying it/, "and names the misuse outright");
  assert.match(v.message, /decompose instead/, "pointing a reader who does NOT qualify back to the real exit");
});

// ── acceptance 3: the new text is load-bearing, not decorative ────────────────────────────────

test("W1-T2814 (acceptance 3): deleting the third exit reds THIS test by name — the message is asserted on its actionable content, never on 'a string changed'", () => {
  const v = sizingViolation(fixture(), { duplicateSlug: DIFFERING_SLUG });
  assert.ok(v);
  // Every clause below is one a reader acts on. If `ownFalsifierRenameExit` is deleted or reduced
  // to a bare suggestion, this assertion names which clause went missing rather than reporting a
  // length change — measured: removing the append takes this file from `# fail 0` to `# fail 2`, and this
  // test is one of the two.
  for (const clause of [
    "ONLY IF",
    TEST_FILE,
    "rename this shard so its filename slug is",
    MATCHING_SLUG,
    "the suite written to prove THESE acceptance criteria",
    "gaming Rule 19",
    "decompose instead",
  ]) {
    assert.ok(v.message.includes(clause), `the third exit lost its "${clause}" clause`);
  }
});

// ── acceptance 5: the carve-out itself is untouched — the message never widened the gate ──────

test("W1-T2814 (acceptance 5a): a declared test that is NOT this task's own falsifier still spans two subsystems and is still REFUSED", () => {
  const someoneElses = {
    id: "W1-T9002",
    title: "a task listing another concern's suite",
    risk: "medium",
    files: ["src/lib/alpha.ts", "src/lib/beta.ts", "test/unrelated-suite.test.ts"],
    acceptance: [{ claim: "c", proof: "unit test: test/unrelated-suite.test.ts" }],
  } as unknown as Task;
  const v = sizingViolation(someoneElses, { duplicateSlug: "a-task-listing-another-concerns-suite" });
  assert.ok(v, "two real source stems still span two concerns");
  assert.equal(v.severity, "block", "still refused — explaining a gate is not relaxing it");
});

test("W1-T2814 (acceptance 5b): a task spanning two REAL source stems is offered NO rename exit, so the third exit cannot become a dodge", () => {
  const twoRealStems = {
    id: "W1-T9003",
    title: "two genuine concerns",
    risk: "medium",
    files: ["src/lib/escalate.ts", "src/run-task.ts", "test/some-suite.test.ts"],
    acceptance: [{ claim: "c", proof: "unit test: test/some-suite.test.ts" }],
  } as unknown as Task;
  assert.deepEqual(
    ownFalsifierRenameCandidates(twoRealStems, "two-genuine-concerns"),
    [],
    "renaming resolves nothing here, so nothing is offered",
  );
  const v = sizingViolation(twoRealStems, { duplicateSlug: "two-genuine-concerns" });
  assert.ok(v);
  assert.doesNotMatch(v.message, /rename this shard/, "the exit appears only where it would actually apply");
  assert.match(v.message, /raise to risk:high or decompose/, "the two real exits are unchanged");
});

test("W1-T2814 (acceptance 5c): with NO slug known there is nothing to rename toward, and the message is byte-identical to before this task", () => {
  // The pre-dispatch call site threads no duplicateCorpusOpts, so this is the common path.
  const v = sizingViolation(fixture(), {});
  // With no slug, W1-T2543's unconditional companion discount applies and this fixture passes —
  // which is itself the point: the message change cannot reach a caller that has no slug.
  assert.equal(v, undefined);
  const twoStems = {
    id: "W1-T9004",
    title: "t",
    risk: "medium",
    files: ["src/lib/alpha.ts", "src/lib/beta.ts"],
    acceptance: [{ claim: "c", proof: "unit test: test/x.test.ts" }],
  } as unknown as Task;
  const noSlug = sizingViolation(twoStems, {});
  assert.ok(noSlug);
  assert.equal(
    noSlug.message,
    "spans 2 distinct subsystems/concerns (alpha, beta) at risk:medium — Rule 19: raise to risk:high " +
      "or decompose into one task per concern",
    "byte-identical to the pre-W1-T2814 text",
  );
});

// ── acceptance 4: the census, re-measured here through the linter's own predicate ──────────────

/** The task's stated abandonment floor: below this many `risk: high` shards whose span would
 *  vanish on a rename alone, the design says CLOSE THIS TASK UNBUILT and record the measurement —
 *  at that size it is a message fix nobody needs a task for. The floor binds on what THIS
 *  measurement reads, never on the number in the filing note. */
const ABANDONMENT_FLOOR = 20;

interface Census {
  high: number;
  highWithFiles: number;
  spanning: number;
  removableByRename: number;
}

/** Walk every shard through the LINTER'S OWN `subsystemsOf` / `moduleIdFromPath` /
 *  `shardSlugFromPath` — never a hand-rolled re-derivation, which is what the filing note used and
 *  what the design explicitly forbids for the build. */
function census(): Census {
  const out: Census = { high: 0, highWithFiles: 0, spanning: 0, removableByRename: 0 };
  for (const file of readdirSync(SHARD_DIR).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort()) {
    const slugEntry = shardSlugFromPath(`plan/tasks.d/${file}`);
    if (!slugEntry) continue;
    let parsed: unknown;
    try {
      parsed = parse(readFileSync(join(SHARD_DIR, file), "utf8"));
    } catch {
      continue; // an unparseable shard is plan-coherence's finding, not this census's
    }
    const slug = slugEntry.text.trim().toLowerCase();
    for (const record of (Array.isArray(parsed) ? parsed : [parsed]) as Task[]) {
      if (!record || record.risk !== "high") continue;
      out.high += 1;
      if (!Array.isArray(record.files) || record.files.length === 0) continue;
      out.highWithFiles += 1;
      if (subsystemsOf(record, undefined, undefined, slug).size < 2) continue;
      out.spanning += 1;
      if (ownFalsifierRenameCandidates(record, slug).length > 0) out.removableByRename += 1;
    }
  }
  return out;
}

test("W1-T2814 (acceptance 4): the census re-runs at BUILD TIME through the linter's own subsystemsOf, and the abandonment floor is asserted against THAT reading", () => {
  const c = census();
  // The measurement is printed so the number reaching a reviewer is the one this run took, not one
  // copied forward from the filing note (which read 309 of 876 at 7a13b300 — a different tree).
  console.log(`W1-T2814 census: risk:high ${c.high}, with files ${c.highWithFiles}, spanning ${c.spanning}, removable by rename alone ${c.removableByRename}`);

  // POSITIVE CONTROLS FIRST — a zero from a walk that read nothing looks exactly like a zero from a
  // clean corpus, and the floor below is only meaningful once the walk is known to have run.
  assert.ok(c.high > 100, `the walk must actually read the corpus — saw ${c.high} risk:high shards`);
  assert.ok(c.highWithFiles > 0, "and shards carrying a files: list");
  assert.ok(c.spanning > c.removableByRename, "and the predicate must REJECT some spanning shards, not accept every one");

  assert.ok(
    c.removableByRename >= ABANDONMENT_FLOOR,
    `the design's floor: below ${ABANDONMENT_FLOOR} removable-by-rename shards this task closes UNBUILT. ` +
      `Measured ${c.removableByRename} of ${c.highWithFiles} risk:high shards carrying files.`,
  );
});

test("W1-T2814 (acceptance 4b): the census's own predicate is exact — a removable shard's rename target is a declared companion whose module id is not the slug", () => {
  // Drives the same predicate over the fixtures rather than the corpus, so the corpus walk above is
  // measuring something whose definition is pinned here rather than inferred from its own output.
  assert.deepEqual(ownFalsifierRenameCandidates(fixture(), DIFFERING_SLUG), [TEST_FILE]);
  assert.deepEqual(ownFalsifierRenameCandidates(fixture(), MATCHING_SLUG), [], "already matching — nothing to rename");
  assert.equal(moduleIdFromPath(TEST_FILE), MATCHING_SLUG, "the target IS the test's module id, not a paraphrase");
});

// ── the shard's own self-referential check, kept honest in the suite ───────────────────────────

test("W1-T2814: this task's OWN shard does not trip the rule it is about — its slug equals this suite's module id", () => {
  const own = readdirSync(SHARD_DIR).find((f) => f.startsWith("W1-T2814-"));
  assert.ok(own, "the shard is on disk");
  const entry = shardSlugFromPath(`plan/tasks.d/${own}`);
  assert.ok(entry);
  assert.equal(
    entry.text,
    moduleIdFromPath("test/sizing-inflates-when-a-slug-does-not-match-its-falsifier.test.ts"),
    "a shard filed about this defect that tripped the defect would be its own counter-argument",
  );
});
