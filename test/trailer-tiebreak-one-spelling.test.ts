import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  acceptanceAuthorTimeCheck,
  extractTaskTrailerId,
  resolvePlanCriteriaAtHead,
} from "../src/lib/review.js";
import { reviewTaskIdFromBody } from "../src/run-task.js";

// `scripts/**` sits outside tsconfig's `include` (see tsconfig.json), so a static specifier is a
// TS7016 — reached via dynamic import instead, same as test/a-worker-branch-must-be-shaped-for-
// dispatch.test.ts and test/credit-surface-gate.test.ts already do for these same two scripts.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const { trailerTaskIds } = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "worker-branch-shape.mjs")).href)) as {
  trailerTaskIds: (commitMessages: string | undefined) => string[];
};
const { hasCreditTrailer } = (await import(pathToFileURL(join(REPO_ROOT, "scripts", "credit-surface-gate.mjs")).href)) as {
  hasCreditTrailer: (commitMessage: string | undefined) => boolean;
};

// ── W1-T2624: TWO TIE-BREAKS ANSWERED "WHICH ID DOES THIS BODY NAME" AND DISAGREED ───────────────
//
// `TASK_TRAILER_RE.exec` (a non-global, anchored regex) took the FIRST anchored `Remudero-Task:`
// trailer at both `acceptanceAuthorTimeCheck` and `resolvePlanCriteriaAtHead`, while
// `reviewTaskIdFromBody` (run-task.ts) took the LAST, per W1-T70's ratified reading of the worker
// prompt's own contract ("Include this exact trailer as the LAST line of the PR body") — and that
// is also what `ensureTaskTrailer`'s append-at-the-end stamping produces by construction. So a body
// carrying two anchored trailers named DIFFERENT ids depending on which of the three read it.
//
// THE FIX: one exported extractor, `extractTaskTrailerId` (src/lib/review.ts), anchored + last-wins.
// Both `acceptanceAuthorTimeCheck` and `resolvePlanCriteriaAtHead` now resolve through it, and
// `reviewTaskIdFromBody` is a thin re-export over it — never a second, independently-drifting regex.
//
// These tests probe a body carrying TWO anchored trailers (the disagreement case), a body carrying
// ONE (the overwhelming majority — unchanged), a body with NONE (unchanged), and a body that only
// mentions the trailer format mid-prose (never anchored — must not outrank the genuine line).

const TWO_TRAILER_BODY = [
  "## Acceptance",
  "",
  "- the claim | unit test: test/x.test.ts",
  "",
  "Remudero-Task: W1-T-EARLIER",
  "",
  "some more prose written after the first stamp",
  "",
  "Remudero-Task: W1-T-LAST",
].join("\n");

const ONE_TRAILER_BODY = [
  "## Acceptance",
  "",
  "- the claim | unit test: test/x.test.ts",
  "",
  "Remudero-Task: W1-T-ONLY",
].join("\n");

const NO_TRAILER_BODY = ["## Acceptance", "", "- the claim | unit test: test/x.test.ts"].join("\n");

const MID_PROSE_QUOTE_BODY = [
  "This PR discusses the trailer format, e.g. a line that reads `Remudero-Task: W1-T-QUOTED`",
  "in prose, but never stamps one anchored at end of line by itself.",
  "",
  "Remudero-Task: W1-T-GENUINE",
].join("\n");

const resolvesEverything = () => true;

// ── criterion 1: a two-trailer body resolves to the SAME (last) id everywhere ────────────────────

test("extractTaskTrailerId takes the LAST anchored trailer on a two-trailer body", () => {
  assert.equal(extractTaskTrailerId(TWO_TRAILER_BODY), "W1-T-LAST");
});

test("reviewTaskIdFromBody agrees with extractTaskTrailerId on a two-trailer body (both LAST)", () => {
  assert.equal(reviewTaskIdFromBody(TWO_TRAILER_BODY), "W1-T-LAST");
  assert.equal(reviewTaskIdFromBody(TWO_TRAILER_BODY), extractTaskTrailerId(TWO_TRAILER_BODY));
});

test("acceptanceAuthorTimeCheck's bare-trailer exemption reads the LAST id on a two-trailer body", () => {
  const seen: string[] = [];
  const r = acceptanceAuthorTimeCheck(TWO_TRAILER_BODY, {
    trailerResolves: (id) => {
      seen.push(id);
      return true;
    },
  });
  assert.deepEqual(seen, ["W1-T-LAST"]);
  assert.equal(r.ok, true);
  assert.match(r.message, /W1-T-LAST/);
  assert.doesNotMatch(r.message, /W1-T-EARLIER/);
});

test("acceptanceAuthorTimeCheck's expectedTaskId arm also matches against the LAST id, never the first", () => {
  const r = acceptanceAuthorTimeCheck(TWO_TRAILER_BODY, { expectedTaskId: "W1-T-LAST" });
  assert.equal(r.ok, true);

  const wrong = acceptanceAuthorTimeCheck(TWO_TRAILER_BODY, { expectedTaskId: "W1-T-EARLIER" });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.defect, "no-trailer");
  assert.match(wrong.message, /found "Remudero-Task: W1-T-LAST" instead/);
});

test("resolvePlanCriteriaAtHead resolves the LAST id on a two-trailer body — never touching git for a stale first id", () => {
  const result = resolvePlanCriteriaAtHead(TWO_TRAILER_BODY, "/nonexistent-repo-root", "plan/tasks.yaml", "deadbeef");
  assert.equal(result.taskId, "W1-T-LAST");
});

// ── criterion 2: a one-trailer body is unaffected — the majority case sees no behaviour change ────

test("a single-trailer body resolves identically everywhere, exactly as before", () => {
  assert.equal(extractTaskTrailerId(ONE_TRAILER_BODY), "W1-T-ONLY");
  assert.equal(reviewTaskIdFromBody(ONE_TRAILER_BODY), "W1-T-ONLY");

  const r = acceptanceAuthorTimeCheck(ONE_TRAILER_BODY, { trailerResolves: resolvesEverything });
  assert.equal(r.ok, true);
  assert.match(r.message, /W1-T-ONLY/);

  const resolved = resolvePlanCriteriaAtHead(ONE_TRAILER_BODY, "/nonexistent-repo-root", "plan/tasks.yaml", "deadbeef");
  assert.equal(resolved.taskId, "W1-T-ONLY");
});

// ── criterion 3: no trailer at all — unchanged, no git object ever touched ────────────────────────

test("a trailer-less body: extractor returns undefined and callers fall through unchanged", () => {
  assert.equal(extractTaskTrailerId(NO_TRAILER_BODY), undefined);
  assert.equal(reviewTaskIdFromBody(NO_TRAILER_BODY), undefined);
});

test("a trailer-less body: resolvePlanCriteriaAtHead returns empty criteria without touching git", () => {
  // A repoRoot/headSha that do not exist would throw if any git object were ever probed — reaching
  // `return { criteria: [] }` before that is exactly claim 4.
  const result = resolvePlanCriteriaAtHead(NO_TRAILER_BODY, "/nonexistent-repo-root", "plan/tasks.yaml", "deadbeef");
  assert.deepEqual(result, { criteria: [] });
});

test("a trailer-less body: acceptanceAuthorTimeCheck falls through to the body's own Acceptance block", () => {
  const r = acceptanceAuthorTimeCheck(NO_TRAILER_BODY);
  assert.equal(r.ok, true, "the body's own well-formed Acceptance block judges it, with no trailer needed");
  assert.doesNotMatch(r.message, /trailer/);
});

// ── criterion 4: a mid-prose quotation never outranks the genuine anchored final line ─────────────

test("a mid-prose mention of the trailer format never wins over the genuine anchored trailer", () => {
  assert.equal(extractTaskTrailerId(MID_PROSE_QUOTE_BODY), "W1-T-GENUINE");
  assert.equal(reviewTaskIdFromBody(MID_PROSE_QUOTE_BODY), "W1-T-GENUINE");

  const r = acceptanceAuthorTimeCheck(MID_PROSE_QUOTE_BODY, { trailerResolves: resolvesEverything });
  assert.match(r.message, /W1-T-GENUINE/);
  assert.doesNotMatch(r.message, /W1-T-QUOTED/);

  const resolved = resolvePlanCriteriaAtHead(MID_PROSE_QUOTE_BODY, "/nonexistent-repo-root", "plan/tasks.yaml", "deadbeef");
  assert.equal(resolved.taskId, "W1-T-GENUINE");
});

// ── criterion 5: exactly one implementation, review.ts stays the leaf ─────────────────────────────

test("reviewTaskIdFromBody IS extractTaskTrailerId (a re-export, not a second regex) — same answer on every fixture above", () => {
  for (const body of [TWO_TRAILER_BODY, ONE_TRAILER_BODY, NO_TRAILER_BODY, MID_PROSE_QUOTE_BODY]) {
    assert.equal(reviewTaskIdFromBody(body), extractTaskTrailerId(body));
  }
});

test("review.ts does not import from run-task.ts (leaf direction preserved)", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/lib/review.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /from ["']\.\.\/run-task\.js["']/);
  assert.doesNotMatch(source, /from ["']\.\/run-task\.js["']/);
});

// ── criterion 6: the deliberately different trailer questions are untouched ───────────────────────

test("worker-branch-shape's trailerTaskIds still returns EVERY id a body/commit-log claims, as a union", () => {
  const commitMessages = ["fix: something\n\nRemudero-Task: W1-T-EARLIER", "chore: stamp\n\nRemudero-Task: W1-T-LAST"].join("\n\n");
  assert.deepEqual(trailerTaskIds(commitMessages), ["W1-T-EARLIER", "W1-T-LAST"], "a union of both ids, never a single winner");
});

test("credit-surface-gate's hasCreditTrailer still answers any-id existence, unaffected by a tie-break", () => {
  assert.equal(hasCreditTrailer("chore: x\n\nRemudero-Task: W1-T-EARLIER\n\nRemudero-Task: W1-T-LAST"), true);
  assert.equal(hasCreditTrailer("chore: x\n\nno trailer here"), false);
});
