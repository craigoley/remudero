import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CONVENTIONAL_LIMITS,
  checkCommitMessage,
  renderCommitNarrativeParagraphs,
} from "../src/lib/commit-message.js";
import { OPERATOR_MESSAGE_PARTS } from "../src/lib/operator-message.js";
import {
  buildPlanPrBody,
  buildPlanPrCommitMessage,
  type PlanPrBodyOpts,
  type PlanPrCommitOpts,
} from "../src/lib/plan-pr-emitter.js";
import { parseAcceptanceBlock } from "../src/lib/review.js";

// ── W1-T2807 ────────────────────────────────────────────────────────────────────────────────────
// `shapeCommitMessage` guarantees a header length, a subject case and a wrapped body. Every one of
// those is a commitlint contract about SHAPE, and not one asks whether a reader learns anything —
// so the reader of a generated commit was the one reader no structure was owed to.
//
// SCOPE NOTE (2026-09-04): the check-and-report layer this suite once also covered — the two
// `*Checked` builders, their projections and their safe wrapper — was removed because nothing in
// production ever called it; the unwired-export advisory on #3926 named it and was not acted on.
// What remains is the half that IS reachable: the narrative slots and the paragraphs they render
// into a commit body and a PR intro. See W1-T2826's design for the measurement.
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

// ── the removed check layer stays removed ────────────────────────────────────────────────────────

test("the unreachable check-and-report layer is gone from both writers, and nothing it fed was left orphaned", () => {
  const emitter = readFileSync(new URL("../src/lib/plan-pr-emitter.ts", import.meta.url), "utf8");
  const commit = readFileSync(new URL("../src/lib/commit-message.ts", import.meta.url), "utf8");

  // A grep proof cannot demonstrate an absence — it reads 0 and grades `no-match`. This is where
  // the deletion is pinned instead. `buildPlanPrCommitMessageChecked` is the symbol the
  // unwired-export advisory named on #3926; the other five went with it because removing only the
  // two it could see would have orphaned the three that fed them.
  for (const gone of [
    "CheckedGeneratedText",
    "buildPlanPrBodyChecked",
    "buildPlanPrCommitMessageChecked",
    "projectPrBodyNarrative",
  ]) {
    assert.ok(!emitter.includes(gone), `plan-pr-emitter.ts still carries ${gone}`);
  }
  for (const gone of ["projectCommitNarrative", "checkGeneratedCommitNarrative"]) {
    assert.ok(!commit.includes(gone), `commit-message.ts still carries ${gone}`);
  }

  // POSITIVE CONTROL for all six zeros: this scan can read both files and DOES see the half that
  // was deliberately kept. Without this, six absent strings are indistinguishable from a failed read.
  assert.ok(emitter.includes("renderPrNarrativeParagraphs"), "scan could not read plan-pr-emitter.ts");
  assert.ok(commit.includes("renderCommitNarrativeParagraphs"), "scan could not read commit-message.ts");
  assert.ok(commit.includes("GeneratedCommitNarrative"), "the kept narrative record went missing too");
});

test("the kept half is still reachable from the live builders — the removal took no wiring with it", () => {
  const emitter = readFileSync(new URL("../src/lib/plan-pr-emitter.ts", import.meta.url), "utf8");
  /** One exported function's body: from its signature to the next top-level `export`. A fixed
   *  character window silently truncates — a first draft of this test used 900 and its own control
   *  fell outside it, which is how the window was found to be wrong rather than the code. */
  const bodyOf = (signature: string): string => {
    const start = emitter.indexOf(signature);
    assert.ok(start > 0, `${signature} not found`);
    const rest = emitter.slice(start + signature.length);
    const end = rest.indexOf("\nexport ");
    return rest.slice(0, end === -1 ? undefined : end);
  };

  // Each surviving renderer is CALLED by the builder production actually uses, not merely exported.
  assert.ok(bodyOf("export function buildPlanPrCommitMessage(").includes("renderCommitNarrativeParagraphs("));
  const prBody = bodyOf("export function buildPlanPrBody(");
  assert.ok(prBody.includes("renderPrNarrativeParagraphs("));
  // Control: the same extraction finds a call that IS there and misses one that is not.
  assert.ok(prBody.includes("renderAcceptanceBlock("), "the body extraction truncated before the block it renders");
  assert.ok(!prBody.includes("buildPlanPrBodyChecked("));
});
