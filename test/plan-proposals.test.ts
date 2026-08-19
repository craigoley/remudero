import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ── W1-T74: proposal-id integrity — the GUARANTEE half ──────────────────────────────────────
//
// GROUND TRUTH (2026-07-16, resolved by #128): RETRO-1784213948025/#125 minted a proposal
// numbered P21 while #118's P21 already sat on main — two active proposals shared one id for
// ~2 hours, and NET STATE cross-references pointed at an ambiguous target. Root cause: the
// retro's synthesis assigned an id without deriving next-unused. run-task.ts's `retroPrompt`
// (this task's PREVENTION half) now instructs the Architect to grep-and-derive next-unused
// itself — prompt discipline, the WEAK half (Standing rule 2: instructions shape, gates
// guarantee). This file is the STRONG half: a deterministic gate that runs in `npm test`,
// hence in the required ci context on EVERY PR — plan PRs included — and would have gone red
// on #125 at its own gate.
//
// PARSING SCOPE, deliberately narrow. `activeProposalIds` matches ONLY lines that themselves
// OPEN a canonical proposal entry: "- **P<N>" or "- **★ P<N>", between the "## Retro proposals"
// heading and the "**Closed proposals" tombstone paragraph. It does NOT match every "P<N>"
// mention in the section body — the "★ LIVE RANKING" line ("P47 > P40 > P38 > ...") and
// evidence citations like "TASK D (P40(i) — ...)" name an EXISTING id, they do not define a
// new one, and counting them would manufacture false duplicates out of ordinary
// cross-references. The Closed-proposals paragraph itself ("**P21**→W1-T76 (#158, absorbed by
// P22)") is prose, not a bullet header, and sits AFTER the boundary — excluded either way, but
// the explicit slice makes that a parse invariant rather than an accident of format.
const SECTION_HEADING = "## Retro proposals";
const CLOSED_BLOCK_MARKER = "\n**Closed proposals";
const PROPOSAL_HEADER_RE = /^-\s+\*\*(?:★\s+)?P(\d+)(?=[\s—)*])/gm;

/** The "## Retro proposals" section's text, from its heading up to (not including) the next
 *  "## " heading. `""` when the heading is absent — an empty section has no duplicates. */
function retroProposalsSection(masterPlanMd: string): string {
  const start = masterPlanMd.indexOf(SECTION_HEADING);
  if (start === -1) return "";
  const rest = masterPlanMd.slice(start);
  const nextHeadingOffset = rest.slice(1).search(/\n## /);
  return nextHeadingOffset === -1 ? rest : rest.slice(0, nextHeadingOffset + 1);
}

/** Every ACTIVE proposal id declared by a canonical bullet header, in file order (duplicates
 *  kept — callers that want uniqueness call {@link duplicateProposalIds}). */
function activeProposalIds(masterPlanMd: string): string[] {
  const section = retroProposalsSection(masterPlanMd);
  const closedAt = section.indexOf(CLOSED_BLOCK_MARKER);
  const active = closedAt === -1 ? section : section.slice(0, closedAt);
  const ids: string[] = [];
  for (const m of active.matchAll(PROPOSAL_HEADER_RE)) ids.push(`P${m[1]}`);
  return ids;
}

/** Proposal ids that own MORE THAN ONE active header — the #125/#118 P21 collision shape. */
function duplicateProposalIds(masterPlanMd: string): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of activeProposalIds(masterPlanMd)) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

// Minimal fixtures, hand-authored — never the live MASTER-PLAN.md (that file is read once,
// below, as its own dedicated proof).
function fixture(bulletsBlock: string, closedBlock = "\n\n**Closed proposals (none)** — none.\n"): string {
  return [
    "# MASTER-PLAN.md\n",
    SECTION_HEADING + " (PROPOSALS ONLY; NOT yet in plan/tasks.yaml)\n",
    bulletsBlock,
    closedBlock,
    "## FIELD FINDINGS\n",
    "unrelated section\n",
  ].join("\n");
}

test("activeProposalIds: a real-shaped proposals section (★ and non-★ headers, RATIFIED/RETIRED stamps, a LIVE RANKING line, TASK citations) parses without duplicates", () => {
  const md = fixture(
    [
      "**★ LIVE RANKING (the ONE place open proposals are ordered).** `P47 > P40 > P38` — ranking prose only.",
      "- **★ TASK D (P40(i) — TURN COVERAGE IS A DENOMINATOR, NOT AN AVERAGE; UNBUILT).** evidence citing P40.",
      "- **★ P47 (plan + golden; RANK 1) — THE ORPHAN-MERGE CLASS.** GROUND TRUTH: ...",
      "- **P41 — RETIRED 2026-08-03 by its own kill trigger; prose DELETED (git holds it).**",
      "- **★ P40 (measurement) — THE RETRO'S OWN INSTRUMENTS ARE HALF-DARK.** GROUND TRUTH: ...",
      "- **P17 — RATIFIED 2026-07-16 -> W1-T71 (a deterministic attestation).**",
    ].join("\n"),
  );
  assert.deepEqual(activeProposalIds(md), ["P47", "P41", "P40", "P17"]);
  assert.deepEqual(duplicateProposalIds(md), []);
});

test("duplicateProposalIds: the #118/#125 P21 collision fixture (two active P21 headers) reports the duplicated id", () => {
  const md = fixture(
    [
      "- **★ P21 — from #118, still active.** GROUND TRUTH: the original proposal.",
      "- **P17 — RATIFIED 2026-07-16 -> W1-T71.**",
      "- **★ P21 — from #125's synthesis, minted without deriving next-unused.** A second, unrelated proposal.",
    ].join("\n"),
  );
  assert.deepEqual(duplicateProposalIds(md), ["P21"], "P21 was assigned to two distinct active proposals");
});

test("duplicateProposalIds: a RATIFIED stamp and a retired proposal alongside active ids report no duplicate", () => {
  const md = fixture(
    [
      "- **★ P10 — RATIFIED 2026-07-16 -> W1-T71 (a deterministic attestation).**",
      "- **P11 — RETIRED 2026-08-03 by its own kill trigger; prose DELETED (git holds it).**",
      "- **★ P12 (plan + golden) — an ordinary open proposal, unrelated to the stamps above.**",
    ].join("\n"),
  );
  assert.deepEqual(duplicateProposalIds(md), []);
});

test("duplicateProposalIds: ids named only in the Closed-proposals tombstone paragraph never collide with an active header of the same id", () => {
  const md = fixture(
    "- **★ P21 — from #118, RATIFIED -> W1-T76.** the one surviving active P21.",
    "\n\n**Closed proposals (P1–P8, P10, P11, P15, P21) — RETIRED FROM THIS LIST, ids preserved.** " +
      "Per RATIFY-OR-KILL each has a terminal status: **P1**→W1-T59 · **P21**→W1-T76 (#158, absorbed by P22).\n",
  );
  assert.deepEqual(duplicateProposalIds(md), [], "the closed block's inline P21 reference is prose, not a second header");
});

test("duplicateProposalIds: the REAL committed MASTER-PLAN.md's Retro-proposals section reports no duplicate (this is what CI checks on every PR via `npm test`)", () => {
  const masterPlanMd = readFileSync(join(REPO_ROOT, "MASTER-PLAN.md"), "utf8");
  const ids = activeProposalIds(masterPlanMd);
  assert.ok(ids.length > 0, "the parser found zero active proposal headers — the section shape likely drifted; re-check PROPOSAL_HEADER_RE against MASTER-PLAN.md's current format before trusting this test");
  assert.deepEqual(duplicateProposalIds(masterPlanMd), [], "the live proposals section must never regress to the #125/#118 P21 collision shape");
});

test("run-task.ts's retro synthesis prompt carries the next-unused-id derivation instruction (the PREVENTION half)", () => {
  const runTaskSrc = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  assert.match(
    runTaskSrc,
    /next-unused/,
    "retroPrompt should instruct the Architect to derive the next-unused P-number before minting one (W1-T74 design (i))",
  );
});
