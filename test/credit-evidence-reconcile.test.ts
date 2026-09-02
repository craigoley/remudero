// test/credit-evidence-reconcile.test.ts
//
// W1-T2729's falsifier. The module's whole value is that it separates two SURFACES that read
// overlapping-but-different evidence, so every test here fixes one surface and varies the other:
// a test that supplied all three signals together could not tell the surfaces apart at all.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  type CreditEvidenceRow,
  gatherCreditEvidence,
  reconcileCreditEvidence,
  renderCreditReconciliation,
  subjectPrNumber,
  trailerCreditedIds,
} from "../src/lib/credit-evidence-reconcile.js";

const row = (over: Partial<CreditEvidenceRow> & { taskId: string }): CreditEvidenceRow => ({
  trailer: false,
  headBranch: false,
  subject: false,
  ...over,
});

// ── the two surfaces ─────────────────────────────────────────────

test("subject-only evidence is a disagreement: lint sees it merged, dispatch does not", () => {
  // The 380-task case. This is the shape that leaves W1-T419/W1-T420 at the head of the frontier.
  const r = reconcileCreditEvidence([row({ taskId: "W1-T419", subject: true, subjectPr: 1609 })]);
  assert.equal(r.agreed, 0);
  assert.equal(r.disagreements.length, 1);
  assert.equal(r.disagreements[0]!.lintSees, true, "lint reads a non-filing subject");
  assert.equal(r.disagreements[0]!.dispatchSees, false, "dispatch cannot see a subject at all");
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0]!.correctCommand, "rmd correct W1-T419 --pr 1609");
});

test("head-branch-only evidence is the MIRROR disagreement, and is NOT correctable", () => {
  // The opposite blind spot: dispatch credits a run- branch the linter cannot see. `rmd correct`
  // names a task's true merged PR, which would be meaningless here — dispatch already has it.
  const r = reconcileCreditEvidence([row({ taskId: "W1-T444", headBranch: true })]);
  assert.equal(r.disagreements.length, 1);
  assert.equal(r.disagreements[0]!.dispatchSees, true);
  assert.equal(r.disagreements[0]!.lintSees, false);
  assert.equal(r.disagreements[0]!.correctCommand, undefined, "nothing to correct in this direction");
  assert.equal(r.candidates.length, 0, "it is reported, but it is not an action");
});

test("a trailer satisfies BOTH surfaces, so it is agreement and never a disagreement", () => {
  const r = reconcileCreditEvidence([row({ taskId: "W1-T418", trailer: true })]);
  assert.equal(r.agreed, 1);
  assert.deepEqual(r.disagreements, []);
});

test("no evidence at all is agreement — both surfaces correctly read it as open", () => {
  // The precision falsifier: if absence counted as a disagreement, every unbuilt task in the plan
  // would be proposed for correction and the report would be worthless.
  const r = reconcileCreditEvidence([row({ taskId: "W1-T2731" })]);
  assert.equal(r.agreed, 1);
  assert.deepEqual(r.disagreements, []);
});

test("a disagreement with no recoverable PR is reported but withheld from candidates", () => {
  // It must not be dropped: the operator still needs to know, they just have to find the PR.
  const r = reconcileCreditEvidence([row({ taskId: "W1-T99", subject: true })]);
  assert.equal(r.disagreements.length, 1, "still reported");
  assert.equal(r.candidates.length, 0, "but not offered as a runnable command");
  assert.equal(r.disagreements[0]!.correctCommand, undefined);
});

// ── the PR number a correction needs ─────────────────────────────

test("the PR number is taken from the END of the subject, never a mid-sentence reference", () => {
  assert.equal(subjectPrNumber("feat(learnings): close the citation loop (W1-T419) (#1609)"), 1609);
  assert.equal(subjectPrNumber("fix: follow up on #1234 after the revert (#4321)"), 4321);
  assert.equal(subjectPrNumber("chore: no pr reference here"), undefined);
  assert.equal(subjectPrNumber("fix: mentions (#12) mid-line and ends elsewhere"), undefined);
});

test("an anchored trailer is required — a mention inside prose is not credit", () => {
  const log = [
    "feat: something",
    "",
    "Remudero-Task: W1-T100",
    "",
    "and a body that discusses Remudero-Task: W1-T200 inline",
  ].join("\n");
  const ids = trailerCreditedIds(log);
  assert.ok(ids.has("W1-T100"), "the anchored line credits");
  assert.ok(!ids.has("W1-T200"), "the inline mention does not");
});

// ── the gatherer's seams ─────────────────────────────────────────

test("gatherCreditEvidence asks each evidence path independently and pairs the PR to its own subject", () => {
  const rows = gatherCreditEvidence(["W1-T419", "W1-T444", "W1-T418"], {
    trailerLog: () => "feat: x\n\nRemudero-Task: W1-T418\n",
    subjectLog: () =>
      ["a1 feat(learnings): close the citation loop (W1-T419) (#1609)", "b2 chore: unrelated (#9999)"].join("\n"),
    evidenceDump: () => "IGNORED-BY-THE-FAKE",
    classify: (ids) => ({ withImpl: ids.filter((i) => i === "W1-T419"), without: [] as string[] }),
    hasMergedRunBranch: (id) => id === "W1-T444",
  });
  const byId = new Map(rows.map((r) => [r.taskId, r]));
  assert.deepEqual(byId.get("W1-T419"), {
    taskId: "W1-T419",
    trailer: false,
    headBranch: false,
    subject: true,
    subjectPr: 1609,
  });
  assert.equal(byId.get("W1-T444")!.headBranch, true, "the run- branch seam is read");
  assert.equal(byId.get("W1-T444")!.subject, false, "and does not leak into subject evidence");
  assert.equal(byId.get("W1-T418")!.trailer, true);
});

test("gatherCreditEvidence reuses the injected classifier rather than re-deriving the filing rule", () => {
  // If this module ever re-implemented LINT_FILING_SUBJECT_RE, a filing subject would read as
  // implementation evidence and every filed-but-unbuilt task would be proposed for credit.
  let sawIds: readonly string[] = [];
  let sawDump = "";
  gatherCreditEvidence(["W1-T1"], {
    trailerLog: () => "",
    subjectLog: () => "",
    evidenceDump: () => "THE-DUMP",
    classify: (ids, dump) => {
      sawIds = ids;
      sawDump = dump;
      return { withImpl: [], without: [...ids] };
    },
  });
  assert.deepEqual([...sawIds], ["W1-T1"], "the ids go to the injected classifier");
  assert.equal(sawDump, "THE-DUMP", "and so does the dump, unmodified");
});

// ── the report, and the thing it must never do ───────────────────

test("the report names each disagreement, its evidence and its command, and says nothing was written", () => {
  const r = reconcileCreditEvidence([
    row({ taskId: "W1-T419", subject: true, subjectPr: 1609 }),
    row({ taskId: "W1-T418", trailer: true }),
  ]);
  const text = renderCreditReconciliation(r);
  assert.match(text, /1 agreed, 1 disagreed, 1 correctable/);
  assert.match(text, /W1-T419\s+dispatch=open lint=merged/);
  assert.match(text, /rmd correct W1-T419 --pr 1609/);
  assert.match(text, /Nothing above was written/);
  assert.ok(!text.includes("W1-T418"), "an agreeing task is not listed as a finding");
});

test("an empty disagreement set renders the agreement explicitly, never a bare empty report", () => {
  // A silent empty report and a broken scan look identical; the count line is the control.
  const text = renderCreditReconciliation(reconcileCreditEvidence([row({ taskId: "W1-T1", trailer: true })]));
  assert.match(text, /1 open task\(s\): 1 agreed, 0 disagreed, 0 correctable/);
  assert.match(text, /agree on every open task/);
});

test("the module exports no writer — reconciliation cannot append a ledger line", async () => {
  // Rule: this task REPORTS and PROPOSES. The absence of a write path is a claim under test, not
  // a convention, because auto-crediting from a commit subject is the design it deliberately refuses.
  const mod = (await import("../src/lib/credit-evidence-reconcile.js")) as Record<string, unknown>;
  const writers = Object.keys(mod).filter((k) => /^(write|append|record|commit|correct|log)/i.test(k));
  assert.deepEqual(writers, [], `the module must export no writer, found: ${writers.join(", ")}`);
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/lib/credit-evidence-reconcile.ts", import.meta.url), "utf8"),
  );
  assert.ok(!/appendLedger|writeFileSync|correction\.provenance"/.test(src), "and no write call site");
});
