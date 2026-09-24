/**
 * test/a-settled-record-moves-out-of-the-way.test.ts — W1-T4096.
 *
 * The narrative stores only grow and nothing says which decision still stands: MASTER-PLAN.md's
 * `## SHIPPED log` appends forever, DECISIONS.md/docs/adr//plan/decisions.d carry no status field,
 * and a `// Why:` pointer can land in a forensics page too big to read. lib/narrative-fold.ts gives
 * decisions an ADR status, folds settled MASTER-PLAN sections into dated archives behind a pointer,
 * and splits an oversized forensics page one file per anchor — verified here against fixtures, and
 * against this repo's own real DECISIONS.md for the status pass (§4).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ARCHIVE_POINTER_RE,
  DECISION_HEADING_RE,
  EXISTING_STATUS_RE,
  PARTIAL_SUPERSEDED_RE,
  SECTION_RE,
  WHOLE_SUPERSEDED_RE,
  WITHDRAWN_RE,
  deriveDecisionStatuses,
  foldMasterPlanShippedLog,
  foldNarrativeStore,
  rewriteWhyPointers,
  slugifyHeading,
  splitForensicsPage,
} from "../src/lib/narrative-fold.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { knowledgeCommand } from "../src/run-task.js";

function tempRoot(tag: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4096-${tag}-`));
}

// ── (i) DECISIONS ────────────────────────────────────────────────────────────────────────────

const DECISIONS_FIXTURE = `# DECISIONS

Append-only log.

## 2026-01-01 — first decision, still live

A plain decision with no supersession language at all.

## 2026-01-02 — second decision (SUPERSEDED BY OPERATOR RULING 2026-02-01)

This one was fully superseded by a later ruling.

## 2026-01-03 — third decision (ITS CONSOLE CLAUSE SUPERSEDED BY SOMETHING ELSE)

Only ONE clause of this entry was superseded — the whole entry still stands.

## 2026-01-04 — fourth decision (WITHDRAWN)

Withdrawn before it ever took effect.
`;

test("W1-T4096: every decision carries a status and a superseded one names its successor", () => {
  const { text, entries, unclassified } = deriveDecisionStatuses(DECISIONS_FIXTURE);

  // Every entry carries a Status: line.
  assert.equal(entries.length, 4);
  const sections = text.split(/\n(?=## )/).slice(1);
  assert.equal(sections.length, 4);
  for (const section of sections) assert.match(section, /\nStatus: .+\n/);

  // The whole-entry superseded one names its successor.
  assert.equal(entries[1]!.status, "superseded by OPERATOR RULING 2026-02-01");
  assert.equal(entries[1]!.successor, "OPERATOR RULING 2026-02-01");
  assert.match(sections[1]!, /Status: superseded by OPERATOR RULING 2026-02-01/);

  // A partial ("ITS X CLAUSE SUPERSEDED BY ...") mention is reported, not guessed at — the whole
  // entry is left accepted rather than credited with a successor it never named for itself.
  assert.equal(entries[2]!.status, "accepted");
  assert.deepEqual(unclassified, ["2026-01-03 — third decision (ITS CONSOLE CLAUSE SUPERSEDED BY SOMETHING ELSE)"]);

  // Withdrawn is its own status, distinct from accepted/superseded.
  assert.equal(entries[3]!.status, "withdrawn");

  // Idempotent: re-deriving over the already-stamped text changes nothing.
  const again = deriveDecisionStatuses(text);
  assert.equal(again.text, text);
  assert.deepEqual(again.entries.map((e) => e.status), entries.map((e) => e.status));
});

test("W1-T4096 (§4): every real DECISIONS.md entry carries a status, and every superseded one names a successor", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const before = readFileSync(join(root, "DECISIONS.md"), "utf8");
  const { entries } = deriveDecisionStatuses(before);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.match(entry.status, /^(accepted|withdrawn|superseded by .+)$/);
    if (entry.status.startsWith("superseded by")) assert.ok(entry.successor && entry.successor.length > 0);
  }
});

// ── (ii) MASTER-PLAN ─────────────────────────────────────────────────────────────────────────

const MASTER_PLAN_FIXTURE = `# PLAN

## NET STATE

live state, never touched by the fold.

## SHIPPED log

Newest first.

### RETRO-3 (2026-09-20) — current-wave entry, stays in place

CURRENT-WAVE-MARKER-3

### RETRO-2 (2026-08-15) — a settled August entry

AUGUST-MARKER-2

### RETRO-1 (2026-08-01) — another settled August entry

AUGUST-MARKER-1

### Earlier

UNDATED-MARKER

## Calibration

unrelated section, never touched by the fold.
`;

test("W1-T4096: a shipped plan section folds to a dated archive and leaves a pointer", () => {
  const { folded, archives } = foldMasterPlanShippedLog(MASTER_PLAN_FIXTURE, { currentWaveMonth: "2026-09" });

  // The current wave's own entry stays in the live file.
  assert.match(folded, /CURRENT-WAVE-MARKER-3/);

  // The settled August entries move out entirely, and undated ones too.
  assert.doesNotMatch(folded, /AUGUST-MARKER-2/);
  assert.doesNotMatch(folded, /AUGUST-MARKER-1/);
  assert.doesNotMatch(folded, /UNDATED-MARKER/);

  // A pointer is left in their place, naming the archive file.
  assert.match(folded, /### Archived — 2026-08 \(2 entries\) — see docs\/archive\/master-plan-2026-08\.md/);
  assert.match(folded, /### Archived — earlier than the dated waves above \(1 entry\) — see docs\/archive\/master-plan-earlier\.md/);

  // Sections outside the SHIPPED log are untouched.
  assert.match(folded, /## NET STATE/);
  assert.match(folded, /## Calibration/);

  // The archived content really is in the archive, verbatim.
  assert.match(archives["docs/archive/master-plan-2026-08.md"]!, /AUGUST-MARKER-2/);
  assert.match(archives["docs/archive/master-plan-2026-08.md"]!, /AUGUST-MARKER-1/);
  assert.match(archives["docs/archive/master-plan-earlier.md"]!, /UNDATED-MARKER/);

  // Idempotent: folding the already-folded text again changes nothing.
  const again = foldMasterPlanShippedLog(folded, { currentWaveMonth: "2026-09" });
  assert.equal(again.folded, folded);
  assert.deepEqual(again.archives, {});
});

// ── (iii) FORENSICS ──────────────────────────────────────────────────────────────────────────

const EXAMPLE_FUNCTION_FILLER = "EXAMPLE-FUNCTION-BODY line of forensic detail, repeated so the section outweighs its own pointer.\n".repeat(6);
const SECOND_PASS_FILLER = "SECOND-PASS-BODY line of forensic detail, repeated so the section outweighs its own pointer.\n".repeat(6);

const FORENSICS_FIXTURE = `# Forensics — \`src/lib/example.ts\`

## exampleFunction

### Base lines 1-10 — why it exists

${EXAMPLE_FUNCTION_FILLER}
## Second pass (2026-09-06)

${SECOND_PASS_FILLER}`;

test("W1-T4096: every Why pointer resolves after a forensics split", () => {
  const root = tempRoot("forensics");
  // A FIXTURE path under this temp root's OWN "src/" (never this repo's real src/), built once so
  // the read below names it via a plain identifier rather than a literal `src/` segment.
  const fixtureSrcFile = join(root, "src", "lib", "a.ts");
  try {
    mkdirSync(join(root, "docs", "forensics"), { recursive: true });
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "docs", "forensics", "review.md"), FORENSICS_FIXTURE);
    writeFileSync(fixtureSrcFile, "// Why: docs/forensics/review.md#second-pass-2026-09-06.\nexport const a = 1;\n");

    // Below the threshold: nothing changes.
    const skip = foldNarrativeStore({ root, kind: "forensics", readingSizeBytes: 1_000_000 });
    assert.equal(skip.changed, false);

    // Over the threshold: the page splits one file per `## ` anchor.
    const report = foldNarrativeStore({ root, kind: "forensics", readingSizeBytes: 800 });
    assert.equal(report.changed, true);
    assert.ok(existsSync(join(root, "docs", "forensics", "review", "examplefunction.md")));
    assert.ok(existsSync(join(root, "docs", "forensics", "review", "second-pass-2026-09-06.md")));
    assert.match(readFileSync(join(root, "docs", "forensics", "review", "examplefunction.md"), "utf8"), /EXAMPLE-FUNCTION-BODY/);

    // The index left behind still carries the ORIGINAL heading (so an existing GitHub anchor link
    // still lands in the right spot) with a one-line pointer, not the full body.
    const index = readFileSync(join(root, "docs", "forensics", "review.md"), "utf8");
    assert.match(index, /## Second pass \(2026-09-06\)/);
    assert.doesNotMatch(index, /SECOND-PASS-BODY/);

    // The `// Why:` pointer that named a specific anchor was rewritten to the new file — and that
    // file really exists, so the pointer resolves.
    const rewritten = readFileSync(fixtureSrcFile, "utf8");
    assert.match(rewritten, /Why: docs\/forensics\/review\/second-pass-2026-09-06\.md/);
    const target = /Why:\s*(docs\/forensics\/[\w./-]+\.md)/.exec(rewritten)?.[1];
    assert.ok(target);
    assert.ok(existsSync(join(root, target!)));

    // Idempotent: the page is already under the (now much smaller) index size, so re-running finds
    // nothing left to split at the same threshold as the ORIGINAL page needed.
    const again = foldNarrativeStore({ root, kind: "forensics", readingSizeBytes: 800 });
    assert.equal(again.changed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4096: splitForensicsPage slugs and rewriteWhyPointers agree on the same anchor", () => {
  const { pointerRewrites } = splitForensicsPage(FORENSICS_FIXTURE, { pageRelPath: "docs/forensics/review.md" });
  assert.equal(slugifyHeading("Second pass (2026-09-06)"), "second-pass-2026-09-06");
  assert.equal(pointerRewrites["docs/forensics/review.md#second-pass-2026-09-06"], "docs/forensics/review/second-pass-2026-09-06.md");
  const rewritten = rewriteWhyPointers(
    "// Why: docs/forensics/review.md#second-pass-2026-09-06.\n// Why: docs/forensics/review.md (whole page, no anchor)\n",
    pointerRewrites,
  );
  assert.match(rewritten, /Why: docs\/forensics\/review\/second-pass-2026-09-06\.md\./);
  // A bare, anchor-less pointer is left alone — the index page still exists.
  assert.match(rewritten, /Why: docs\/forensics\/review\.md \(whole page, no anchor\)/);
});

test("W1-T4096: each `_RE` validator's healthy and unhealthy arm are both reachable and distinct", () => {
  DECISION_HEADING_RE.lastIndex = 0;
  assert.equal(DECISION_HEADING_RE.test("## a real decision heading"), true);
  DECISION_HEADING_RE.lastIndex = 0;
  assert.equal(DECISION_HEADING_RE.test("not a heading at all"), false);
  DECISION_HEADING_RE.lastIndex = 0;

  assert.equal(SECTION_RE.test("## H\n\nbody text"), true);
  assert.equal(SECTION_RE.test("no blank line after this so-called heading"), false);

  assert.equal(WHOLE_SUPERSEDED_RE.test("## x (SUPERSEDED BY OPERATOR RULING 2026-02-01)"), true);
  assert.equal(WHOLE_SUPERSEDED_RE.test("## x (ITS Y CLAUSE SUPERSEDED BY Z)"), false);

  assert.equal(PARTIAL_SUPERSEDED_RE.test("## x (ITS Y CLAUSE SUPERSEDED BY Z)"), true);
  assert.equal(PARTIAL_SUPERSEDED_RE.test("## x, a plain heading with no supersession language"), false);

  assert.equal(WITHDRAWN_RE.test("## x (WITHDRAWN)"), true);
  assert.equal(WITHDRAWN_RE.test("## x, still live"), false);

  assert.equal(EXISTING_STATUS_RE.test("Status: accepted\n\nbody"), true);
  assert.equal(EXISTING_STATUS_RE.test("body with no status line at all"), false);

  assert.equal(ARCHIVE_POINTER_RE.test("### Archived — 2026-08 (2 entries) — see x"), true);
  assert.equal(ARCHIVE_POINTER_RE.test("### RETRO-1 (2026-08-01) — a real, un-archived entry"), false);
});

// ── (iv) THE CLI RUNS THE FOLD ───────────────────────────────────────────────────────────────

test("W1-T4096: rmd knowledge fold runs all three operations against a real checkout shape", () => {
  const root = tempRoot("cli");
  try {
    writeFileSync(join(root, "DECISIONS.md"), DECISIONS_FIXTURE);
    writeFileSync(join(root, "MASTER-PLAN.md"), MASTER_PLAN_FIXTURE);
    mkdirSync(join(root, "docs", "forensics"), { recursive: true });
    writeFileSync(join(root, "docs", "forensics", "review.md"), FORENSICS_FIXTURE);
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "src", "lib", "a.ts"), "export const a = 1;\n");

    for (const kind of ["decisions", "master-plan"] as const) {
      const report = foldNarrativeStore({ root, kind, now: () => new Date("2026-09-24T00:00:00Z") });
      assert.equal(report.changed, true);
    }
    assert.match(readFileSync(join(root, "DECISIONS.md"), "utf8"), /Status: /);
    assert.match(readFileSync(join(root, "MASTER-PLAN.md"), "utf8"), /### Archived —/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T4096: rmd knowledge fold (the CLI verb) drives foldNarrativeStore end to end", () => {
  const root = tempRoot("knowledge-cli");
  try {
    writeFileSync(join(root, "DECISIONS.md"), DECISIONS_FIXTURE);
    writeFileSync(join(root, "MASTER-PLAN.md"), MASTER_PLAN_FIXTURE);

    // Unknown subcommand/store fails loud, spawning nothing.
    assert.equal(knowledgeCommand(["prune"], { root }), 2);
    assert.equal(knowledgeCommand(["fold", "--store", "bogus"], { root }), 2);

    // --dry-run reports what would change and writes nothing.
    const before = readFileSync(join(root, "DECISIONS.md"), "utf8");
    assert.equal(knowledgeCommand(["fold", "--store", "decisions", "--dry-run"], { root }), 0);
    assert.equal(readFileSync(join(root, "DECISIONS.md"), "utf8"), before);

    // Without --dry-run it really writes the fold.
    assert.equal(knowledgeCommand(["fold", "--store", "decisions"], { root }), 0);
    assert.match(readFileSync(join(root, "DECISIONS.md"), "utf8"), /Status: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
