import assert from "node:assert/strict";
import { test } from "node:test";
import {
  correctionWithoutPromptViolation,
  lintTask,
  mergedFieldChangeViolations,
  RATIONALE_CORRECTION_MARKER,
  rationaleRecordsCorrection,
} from "../src/lib/task-linter.js";
import type { LintOpts, PostMergeAmendmentContext } from "../src/lib/task-linter.js";
import type { Task } from "../src/lib/plan.js";
import { implementPromptParts, renderImplementPrompt } from "../src/run-task.js";

/**
 * W1-T2438: THE FROZEN TITLE IS THE ONLY FIELD A WORKER READS.
 *
 * `renderImplementPrompt` renders `task.prompt ?? task.title` — the frozen title, unconditionally
 * — and 0 of 681 shards on main declare `prompt:`, so for every dispatched build the title IS the
 * entire brief. `design:` is read by nothing and `acceptance:` goes only to the reviewer, so when
 * a later measurement falsifies a title-level claim, Rule 21 lets the correction land in
 * `rationale:` — but `rationale:` reaches no dispatched build. The fix is NOT to unfreeze the
 * title (Rule 21 stays exactly as it is): it is a linter check that NAMES a merged task whose
 * rationale records a correction but carries no `prompt:`, and `prompt:` itself is confirmed
 * unfrozen and unread by anything but the render path.
 */

/** A minimal, otherwise-clean Task fixture — every test overrides only what it needs. */
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
    acceptance: [{ claim: "does the thing", proof: "unit test: test/foo.test.ts" }],
    ...over,
  };
}

const MERGED_CTX: PostMergeAmendmentContext = { statusResolvable: true, merged: true, followUpFiled: false };

// ── ACCEPTANCE 1: a merged task whose rationale records a correction and carries no prompt ────

test("ACCEPTANCE 1: a merged task whose rationale records a correction and carries no prompt is named by the linter", () => {
  const t = task({
    id: "W1-T2427",
    title: "the retry path has FOUR ARMS",
    rationale: `${RATIONALE_CORRECTION_MARKER} #3183 records a FIFTH site the merged title misses.`,
  });
  const res = lintTask(t, { postMergeAmendment: MERGED_CTX });
  const v = res.violations.find((x) => x.check === "post-merge-correction-without-prompt");
  assert.ok(v, "expected a post-merge-correction-without-prompt violation");
  assert.equal(v?.severity, "warn", "reported, never blocked — it never gates a merge");
  assert.match(v!.message, /W1-T2427/);
  assert.match(v!.message, /prompt/);
  // The helper the check is built on agrees directly, with no lint plumbing involved.
  assert.equal(rationaleRecordsCorrection(t), true);
  assert.ok(correctionWithoutPromptViolation(t));
});

test("ACCEPTANCE 1: absent the marker, or absent merge context, or with a prompt already set — no violation", () => {
  const noMarker = task({ id: "W1-T1", rationale: "just ordinary prose, no correction recorded here" });
  assert.equal(lintTask(noMarker, { postMergeAmendment: MERGED_CTX }).violations.some((v) => v.check === "post-merge-correction-without-prompt"), false);

  const markerButNotMerged = task({ id: "W1-T2", rationale: `${RATIONALE_CORRECTION_MARKER} not merged yet` });
  assert.equal(
    lintTask(markerButNotMerged, { postMergeAmendment: { statusResolvable: true, merged: false, followUpFiled: false } }).violations.some(
      (v) => v.check === "post-merge-correction-without-prompt",
    ),
    false,
    "an open/queued task's rationale is ordinary authoring, not a post-merge amendment",
  );

  const markerNoContext = task({ id: "W1-T3", rationale: `${RATIONALE_CORRECTION_MARKER} no context supplied` });
  assert.equal(lintTask(markerNoContext).violations.some((v) => v.check === "post-merge-correction-without-prompt"), false);

  const markerWithPrompt = task({
    id: "W1-T4",
    rationale: `${RATIONALE_CORRECTION_MARKER} corrected`,
    prompt: "the corrected brief the worker should actually read",
  });
  assert.equal(
    lintTask(markerWithPrompt, { postMergeAmendment: MERGED_CTX }).violations.some((v) => v.check === "post-merge-correction-without-prompt"),
    false,
    "a prompt already carries the correction to the worker — nothing left to name",
  );
  assert.equal(correctionWithoutPromptViolation(markerWithPrompt), undefined);
});

// ── ACCEPTANCE 2/3: renderImplementPrompt's existing precedence, asserted rather than assumed ─

test("ACCEPTANCE 2: a task carrying a prompt renders THAT prompt to the worker, while its title stays byte-identical", () => {
  const title = "the retry path has FOUR ARMS";
  const prompt = "the retry path in fact has FIVE arms (see #3183) — implement against five";
  const t = task({ id: "W1-T2427", title, prompt });

  const rendered = renderImplementPrompt(t, "", "RUN-1");
  assert.match(rendered, /the retry path in fact has FIVE arms/, "the worker's TASK body is the prompt");
  assert.doesNotMatch(rendered, /the retry path has FOUR ARMS/, "the stale title text never reaches the worker's brief");

  // Byte-identical: the render path is not permitted to mutate or paraphrase the frozen title.
  assert.equal(t.title, title, "the title field itself is untouched by rendering");
  const parts = implementPromptParts(t, "", "RUN-1");
  assert.equal(parts.find((p) => p.name === "task_body")?.value, prompt);
});

test("ACCEPTANCE 3: an untouched task with no prompt still renders from its title exactly as it does today", () => {
  const title = "the guard computes the count and throws it away";
  const t = task({ id: "W1-T999", title });
  const rendered = renderImplementPrompt(t, "", "RUN-1");
  assert.match(rendered, /the guard computes the count and throws it away/);
  const parts = implementPromptParts(t, "", "RUN-1");
  assert.equal(parts.find((p) => p.name === "task_body")?.value, title, "task.prompt ?? task.title falls through to the title, unchanged");
});

// ── ACCEPTANCE 4: adding a prompt post-merge trips no blocking and no reported-field check ────

test("ACCEPTANCE 4: adding a prompt to a merged task trips no blocking and no reported-field check", () => {
  const base = task({ id: "W1-T2433", title: "a claim later measurement falsified", files: ["src/lib/example.ts"] });
  const amended: Task = { ...base, prompt: "the corrected brief" };
  const opts: LintOpts = { postMergeAmendment: { statusResolvable: true, merged: true, baseTask: base, followUpFiled: false } };
  const res = lintTask(amended, opts);
  assert.equal(res.ok, true, "adding prompt: alone must never fail the linter");
  assert.equal(res.violations.some((v) => v.check === "post-merge-field-drift"), false, "prompt is not a REPORTED_MERGED_FIELDS member");
  assert.equal(res.violations.some((v) => v.check === "post-merge-amendment"), false, "prompt is not an acceptance criterion — nothing here blocks");
  assert.deepEqual(mergedFieldChangeViolations(amended, base), [], "the field-drift diff itself sees no reportable change");
});

// ── ACCEPTANCE 5: title stays outside REPORTED_MERGED_FIELDS; the list gains no member ────────

test("ACCEPTANCE 5: the title remains outside the reported merged fields, and no member is added to that list", () => {
  const base = task({ id: "W1-T2433", title: "a claim later measurement falsified" });
  const amended: Task = { ...base, title: "the corrected count, byte-different from the merged title" };
  // A changed title alone (no other REPORTED_MERGED_FIELDS entry touched) must still report nothing —
  // if `title` had been added as a member, this would produce a post-merge-field-drift violation.
  assert.deepEqual(mergedFieldChangeViolations(amended, base), []);

  // Cross-check with a field that IS a member, proving the diff machinery is actually exercised
  // (not merely vacuous because baseTask/task are otherwise identical).
  const riskChanged: Task = { ...base, risk: "high" };
  const riskViolations = mergedFieldChangeViolations(riskChanged, base);
  assert.equal(riskViolations.length, 1, "risk IS a reported field — the control proving the diff runs at all");
  assert.equal(riskViolations[0].check, "post-merge-field-drift");
});

// ── ACCEPTANCE 6: the acceptance freeze is untouched — appending a criterion still blocks ─────

test("ACCEPTANCE 6: the acceptance freeze is untouched — appending a criterion to a merged task still blocks", () => {
  const baseAcceptance = [{ claim: "status regresses to queued on a read failure is fixed", proof: "unit test: test/status.test.ts" }];
  const amended = task({
    id: "W1-T155",
    acceptance: [...baseAcceptance, { claim: "a brand new, never-agreed-to criterion", proof: "unit test: test/status.test.ts::new" }],
  });
  const res = lintTask(amended, {
    postMergeAmendment: { statusResolvable: true, merged: true, baseAcceptance, followUpFiled: false },
  });
  assert.equal(res.ok, false, "W1-T2438 must not weaken the existing block");
  const v = res.violations.find((x) => x.check === "post-merge-amendment");
  assert.ok(v, "expected the existing post-merge-amendment block, unmodified by this task");
  assert.equal(v?.severity, "block");
});

// ── ACCEPTANCE 7: nothing added gates the authoring of a title that carries a count ───────────

test("ACCEPTANCE 7: nothing added here gates the authoring of a title that carries a count", () => {
  const countedTitle = "195 of 950 titles carry a falsifiable count, and this one is a fifth of four arms";
  // No rationale marker at all — an ordinary, freshly-authored task with a countful title.
  const fresh = task({ id: "W1-T5000", title: countedTitle, status: "queued", files: ["src/lib/example.ts"] });
  assert.equal(lintTask(fresh).ok, true);
  assert.equal(lintTask(fresh).violations.some((v) => v.check === "post-merge-correction-without-prompt"), false);

  // Even merged, with no marker in the rationale, a countful title alone never trips the new check.
  const mergedCounted = task({ id: "W1-T5001", title: countedTitle, rationale: "no correction marker here" });
  const res = lintTask(mergedCounted, { postMergeAmendment: MERGED_CTX });
  assert.equal(res.violations.some((v) => v.check === "post-merge-correction-without-prompt"), false);
});
