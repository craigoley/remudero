import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CONVENTIONAL_LIMITS,
  checkCommitMessage,
  checkGeneratedCommitNarrative,
  projectCommitNarrative,
  renderCommitNarrativeParagraphs,
} from "../src/lib/commit-message.js";
import { OPERATOR_MESSAGE_PARTS } from "../src/lib/operator-message.js";
import {
  buildPlanPrBody,
  buildPlanPrBodyChecked,
  buildPlanPrCommitMessage,
  buildPlanPrCommitMessageChecked,
  projectPrBodyNarrative,
  type PlanPrBodyOpts,
  type PlanPrCommitOpts,
} from "../src/lib/plan-pr-emitter.js";
import { parseAcceptanceBlock } from "../src/lib/review.js";

// ── W1-T2807 ────────────────────────────────────────────────────────────────────────────────────
// `shapeCommitMessage` guarantees a header length, a subject case and a wrapped body. Every one of
// those is a commitlint contract about SHAPE, and not one asks whether a reader learns anything —
// so the reader of a generated commit was the one reader no structure was owed to.
//
// The whole difficulty is that this text is ALSO a machine contract: the `Remudero-Task:` trailer
// credits a merge, a `(W1-Tnnn)` subject citation is a second credit path, and
// `parseAcceptanceBlock` fails CLOSED on a PR body it cannot resolve. So the extension is additive
// and the parsed structure is frozen. This suite is the falsifier for both halves of that.

const CRITERIA = [
  { claim: "a thing is true", proof: "unit test: some test title" },
  { claim: "another thing is true", proof: "grep: SOME_TOKEN in src/lib/thing.ts" },
];

function commitOpts(overrides: Partial<PlanPrCommitOpts> = {}): PlanPrCommitOpts {
  return { scope: "plan", subject: "file W1-T2807 under the reserved id", ...overrides };
}

function bodyOpts(overrides: Partial<PlanPrBodyOpts> = {}): PlanPrBodyOpts {
  return { intro: "This files one shard.", criteria: CRITERIA, ...overrides };
}

// ── criterion 1: the standard names both surfaces ───────────────────────────────────────────────

test("the standard names generated commit messages and generated PR bodies as surfaces in scope", () => {
  const doc = readFileSync(new URL("../docs/operator-message-standard.md", import.meta.url), "utf8");
  const surfaces = doc.slice(doc.indexOf("## Surfaces in scope"), doc.indexOf("## Out of scope"));

  assert.ok(surfaces.includes("buildPlanPrCommitMessage"), "the commit surface is not named in scope");
  assert.ok(surfaces.includes("buildPlanPrBody"), "the PR-body surface is not named in scope");
  // Named as NARRATIVE surfaces, with the parsed half frozen in the same breath.
  assert.ok(surfaces.includes("parsed structure is FROZEN"));
  assert.ok(surfaces.includes("parseAcceptanceBlock"));
  assert.ok(surfaces.includes("Remudero-Task:"));
  // ...and the standard's existing exclusion survives the widening.
  assert.ok(doc.includes("## Out of scope: the daemon's stdout"));
});

// ── criterion 2: the commit's narrative half is projected onto the four slots ────────────────────

test("a generated commit's narrative is projected onto exactly the four presence slots, and onto no others", () => {
  const projected = projectCommitNarrative({
    prefix: "chore(plan)",
    subject: "file W1-T2807 under the reserved id",
    whatToDo: "read the shard for the design questions",
    consequence: "the id stays reserved and unbuilt until someone does",
  });
  assert.equal(projected.speaker, "chore(plan)");
  assert.equal(projected.whatHappened, "file W1-T2807 under the reserved id");
  assert.equal(projected.whatIsAsked, "read the shard for the design questions");
  assert.equal(projected.consequenceOfInaction, "the id stays reserved and unbuilt until someone does");
  assert.deepEqual(Object.keys(projected).sort(), [...OPERATOR_MESSAGE_PARTS].sort());
});

test("an omitted commit slot is reported missing, and an explicit null is reported PRESENT — the two are never the same fact", () => {
  const omitted = checkGeneratedCommitNarrative({ prefix: "chore(plan)", subject: "do a thing" });
  assert.equal(omitted?.ok, false);
  assert.deepEqual(omitted?.missing, ["whatIsAsked", "consequenceOfInaction"]);

  const declaredEmpty = checkGeneratedCommitNarrative({
    prefix: "chore(plan)",
    subject: "do a thing",
    whatToDo: null,
    consequence: null,
  });
  assert.equal(declaredEmpty?.ok, true);
  assert.deepEqual(declaredEmpty?.missing, []);
});

test("the commit's narrative slots render as body paragraphs in the standard's order, and render nothing when omitted", () => {
  assert.equal(renderCommitNarrativeParagraphs({ prefix: "chore(plan)", subject: "s" }), "");
  // An explicit null is a statement to the RECORD, not a sentence this module invents for the author.
  assert.equal(
    renderCommitNarrativeParagraphs({ prefix: "chore(plan)", subject: "s", whatToDo: null, consequence: null }),
    "",
  );
  assert.equal(
    renderCommitNarrativeParagraphs({
      prefix: "chore(plan)",
      subject: "s",
      whatToDo: "do this",
      consequence: "otherwise that",
    }),
    "otherwise that\n\ndo this",
  );
});

// ── criterion 3: the PR body's narrative half is projected the same way ──────────────────────────

test("a generated PR body's narrative is projected onto the same four slots, with the intro as whatHappened", () => {
  const projected = projectPrBodyNarrative(
    bodyOpts({ speaker: "plan lane", whatToDo: "review the shard", consequence: "the id stays unbuilt" }),
  );
  assert.equal(projected.speaker, "plan lane");
  assert.equal(projected.whatHappened, "This files one shard.");
  assert.equal(projected.whatIsAsked, "review the shard");
  assert.equal(projected.consequenceOfInaction, "the id stays unbuilt");
  assert.deepEqual(Object.keys(projected).sort(), [...OPERATOR_MESSAGE_PARTS].sort());
});

test("a PR body's narrative slots render inside the INTRO region — never below the Acceptance block, whose bullets must not be interrupted", () => {
  const body = buildPlanPrBody(
    bodyOpts({ whatToDo: "review the shard", consequence: "the id stays unbuilt", taskId: "W1-T2807" }),
  );
  const introEnd = body.indexOf("Acceptance:");
  assert.ok(introEnd > 0);
  assert.ok(body.slice(0, introEnd).includes("review the shard"));
  assert.ok(body.slice(0, introEnd).includes("the id stays unbuilt"));
  // Nothing but the trailer follows the block.
  const afterBlock = body.slice(body.indexOf("Acceptance:"));
  const trailing = afterBlock.split("\n").filter((line) => line.startsWith("Remudero-Task:"));
  assert.deepEqual(trailing, ["Remudero-Task: W1-T2807"]);
});

// ── criterion 4: a non-conforming narrative marks, and never blocks ──────────────────────────────

test("a commit whose narrative is incomplete is still produced in full — the check rides beside the message, never inside it", () => {
  const checked = buildPlanPrCommitMessageChecked(commitOpts({ taskId: "W1-T2807" }));
  assert.equal(checked.messageCheck?.ok, false);
  assert.deepEqual(checked.messageCheck?.missing, ["whatIsAsked", "consequenceOfInaction"]);
  assert.equal(checked.surface, "commit-message");
  // The message is produced anyway, and is BYTE-IDENTICAL to the unchecked builder's.
  assert.equal(checked.text, buildPlanPrCommitMessage(commitOpts({ taskId: "W1-T2807" })));
  // ...and the mark is nowhere in the text, above all not in the trailer region.
  assert.ok(!checked.text.includes("operator-message"));
  assert.ok(checked.text.trimEnd().endsWith("Remudero-Task: W1-T2807"));
});

test("a PR body whose narrative is incomplete is still produced in full, with the check beside it and no mark in the text", () => {
  const checked = buildPlanPrBodyChecked(bodyOpts({ taskId: "W1-T2807" }));
  assert.equal(checked.messageCheck?.ok, false);
  assert.deepEqual(checked.messageCheck?.missing, ["speaker", "whatIsAsked", "consequenceOfInaction"]);
  assert.equal(checked.surface, "pr-body");
  assert.equal(checked.text, buildPlanPrBody(bodyOpts({ taskId: "W1-T2807" })));
  assert.ok(!checked.text.includes("operator-message"));
});

test("a checker fault yields undefined rather than a synthesised verdict — the safe wrapper, proved directly", () => {
  const exploding = { prefix: "chore(plan)", subject: "do a thing" };
  Object.defineProperty(exploding, "whatToDo", {
    get() {
      throw new Error("checker read blew up");
    },
    enumerable: true,
  });
  let result: ReturnType<typeof checkGeneratedCommitNarrative> | undefined;
  assert.doesNotThrow(() => {
    result = checkGeneratedCommitNarrative(exploding);
  });
  // Undefined, NOT a fabricated "incomplete": "could not be read" and "was read and found thin"
  // are different facts, and part (iv) of the standard is about never conflating them.
  assert.equal(result, undefined);
});

test("the record is built BEFORE its own check is consulted, so no conformance result can stand between a caller and its text", () => {
  // Ordering asserted at the source, because it is the guarantee and it is invisible in the output:
  // a future edit that moved the build below the check would still pass every behavioural test here.
  const emitter = readFileSync(new URL("../src/lib/plan-pr-emitter.ts", import.meta.url), "utf8");
  for (const [fn, build] of [
    ["buildPlanPrBodyChecked", "const text = buildPlanPrBody(opts);"],
    ["buildPlanPrCommitMessageChecked", "const text = buildPlanPrCommitMessage(opts);"],
  ] as const) {
    const start = emitter.indexOf(`export function ${fn}`);
    assert.ok(start > 0, `${fn} not found`);
    const body = emitter.slice(start, emitter.indexOf("\n}", start));
    const buildAt = body.indexOf(build);
    const checkAt = body.search(/check(OperatorMessage|GeneratedCommitNarrative)\(/);
    assert.ok(buildAt > 0, `${fn} no longer builds its record with ${JSON.stringify(build)}`);
    assert.ok(checkAt > 0, `${fn} no longer runs a conformance check`);
    assert.ok(buildAt < checkAt, `${fn} runs its check BEFORE building the record`);
  }
});

// ── criterion 5: the parsed structure is unchanged ───────────────────────────────────────────────

test("omitting the new narrative slots leaves both records BYTE-IDENTICAL — every existing caller keeps what it produced", () => {
  // The discriminating pair: same opts minus the new fields, on both surfaces.
  assert.equal(
    buildPlanPrCommitMessage({ scope: "plan", subject: "file a shard", extraBody: "why", taskId: "W1-T1" }),
    buildPlanPrCommitMessage({
      scope: "plan",
      subject: "file a shard",
      extraBody: "why",
      taskId: "W1-T1",
      whatToDo: undefined,
      consequence: undefined,
    }),
  );
  assert.equal(
    buildPlanPrBody({ intro: "i", criteria: CRITERIA, taskId: "W1-T1" }),
    buildPlanPrBody({ intro: "i", criteria: CRITERIA, taskId: "W1-T1", speaker: undefined, whatToDo: undefined }),
  );
});

test("the trailer, the subject citation and the Acceptance block parse exactly as they do today — through the REAL parsers, with the new slots filled", () => {
  const body = buildPlanPrBody(
    bodyOpts({
      intro: "Files W1-T2807 (W1-T2807).",
      whatToDo: "review the shard",
      consequence: "the id stays unbuilt",
      taskId: "W1-T2807",
    }),
  );
  // parseAcceptanceBlock is the real reader, and it fails CLOSED — so a non-empty parse IS the proof.
  const parsed = parseAcceptanceBlock(body);
  assert.equal(parsed.length, CRITERIA.length);
  assert.deepEqual(
    parsed.map((c) => c.claim),
    CRITERIA.map((c) => c.claim),
  );
  assert.ok(parsed.every((c) => (c.proof ?? "").trim() !== ""), "a criterion lost its proof");

  // The trailer still matches ANCHORED, which is how a merge is credited.
  assert.match(body, /(?:^|\n)Remudero-Task: W1-T2807(?:\n|$)/);
  // ...and the subject citation, the second credit path.
  const message = buildPlanPrCommitMessage(
    commitOpts({ subject: "file W1-T2807 (W1-T2807)", whatToDo: "review it", taskId: "W1-T2807" }),
  );
  assert.match(message, /\(W1-T2807\)/);
  assert.match(message, /(?:^|\n)Remudero-Task: W1-T2807(?:\n|$)/);
});

// ── criterion 6: every commitlint guarantee still holds ──────────────────────────────────────────

test("every commitlint guarantee shapeCommitMessage makes still holds with the narrative slots filled — including a long slot that must WRAP", () => {
  const long = "the reader who finds this commit later is doing archaeology and needs to know why it exists ".repeat(4);
  const message = buildPlanPrCommitMessage(
    commitOpts({
      subject: "file W1-T2807 under the reserved id",
      extraBody: long,
      whatToDo: long,
      consequence: long,
      taskId: "W1-T2807",
    }),
  );
  assert.deepEqual(checkCommitMessage(message), []);
  // Asserted directly too, so a change in checkCommitMessage's own vocabulary cannot hide a regression.
  const lines = message.split("\n");
  assert.ok((lines[0] ?? "").length <= CONVENTIONAL_LIMITS.headerMaxLength);
  for (const line of lines) {
    assert.ok(
      line.length <= CONVENTIONAL_LIMITS.bodyMaxLineLength,
      `body line exceeds ${CONVENTIONAL_LIMITS.bodyMaxLineLength}: ${JSON.stringify(line)}`,
    );
  }
  // Positive control: the wrapped narrative really IS in there, so the zero violations are not
  // vacuous over a message the slots never reached.
  assert.ok(message.includes("archaeology"));
});

test("a subject long enough to be TRIMMED still preserves its overflow when the narrative slots are filled", () => {
  const subject = "file the shard that records why the generated commit surface was governed for shape and nothing else at all";
  const message = buildPlanPrCommitMessage(commitOpts({ subject, whatToDo: "read it", taskId: "W1-T2807" }));
  assert.deepEqual(checkCommitMessage(message), []);
  assert.ok(message.includes("nothing else at all"), "trimmed subject overflow was discarded");
});

// ── criterion 7: no score ────────────────────────────────────────────────────────────────────────

test("the extension introduces no readability, length or vocabulary score on either writer", () => {
  const forbidden = [
    "fleschKincaid",
    "flesch",
    "gunningFog",
    "readingLevel",
    "readabilityScore",
    "gradeLevel",
    "syllable",
    "wordCount",
    "sentenceLength",
  ];
  for (const rel of ["../src/lib/commit-message.ts", "../src/lib/plan-pr-emitter.ts"]) {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8");
    for (const token of forbidden) {
      assert.ok(!source.includes(token), `${rel} introduced a prose score (${token})`);
    }
    // Positive control per file: the scan can read this file, so the zeros are absence.
    assert.ok(source.includes("OperatorMessage"), `forbidden-token scan could not read ${rel}`);
  }
});

test("the wrapping the narrative goes through is shapeCommitMessage's own — neither writer re-implements a limit", () => {
  const emitter = readFileSync(new URL("../src/lib/plan-pr-emitter.ts", import.meta.url), "utf8");
  assert.ok(emitter.includes("shapeCommitMessage("));
  // A second, local copy of either limit is how a writer and its gate drift apart.
  assert.ok(!emitter.includes("headerMaxLength:"));
  assert.ok(!emitter.includes("bodyMaxLineLength:"));
});
