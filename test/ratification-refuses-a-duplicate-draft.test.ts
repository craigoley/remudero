// W1-T2455: `duplicateTitleViolations` (task-linter.ts) has been WIRED since W1-T1076, but it is
// `warn`, it is scoped to the `--base` pass, and `lint-plan` is not a required check — so
// `rmd approve` could file a task for a defect already on main. MEASURED 2026-08-29 over the 18
// cached drafts in `state/inbox-drafts.json`: of 32 drafted shards, two score a perfect 1.00
// against a shard already on origin/main (W1-T2452, W1-T2453) and one scores 0.57 (W1-T2451) —
// all three already merged.
//
// THE CHECK KEYS ON THE DRAFTED SHARD SLUG, NEVER ON THE PROPOSAL. Claim 3 below is the reason:
// eleven live proposal summaries read literally "board-review: #NNNN carries 1 unhandled
// escalation(s)" and a proposal-level check would collapse all eleven.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  approveProposal,
  draftedDuplicate,
  draftedShardSlugs,
  type DraftedCandidate,
  type InboxClassification,
  type RatifyGateway,
} from "../src/lib/inbox.js";
import { planShardSlugCorpus, DUPLICATE_SLUG_SHINGLE_K } from "../src/lib/task-linter.js";
import { filedShardSlugCorpus } from "../src/run-task.js";
import { bestNearDuplicate, DEFAULT_DUPLICATE_CUTOFF, type DuplicateCorpusEntry } from "../src/lib/knowledge-dedup.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-ratify-dup-")), "ledger.ndjson");
}
function readLedger(p: string): Array<Record<string, unknown>> {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** The already-filed corpus, built the way `approveCommand` builds it. */
const CORPUS: DuplicateCorpusEntry[] = planShardSlugCorpus([
  "plan/tasks.d/W1-T2451-board-review-proposals-outlive-referents.yaml",
  "plan/tasks.d/W1-T2453-a-board-review-escalation-candidate-names-nothing-it-renders-carries-n-u.yaml",
  "plan/tasks.d/W1-T170-per-run-worker-home.yaml",
]);

function fragment(title: string): string {
  return `- id: NEW-1\n  title: "${title}"\n  repo: remudero\n  type: implement\n  verify: auto\n`;
}
function ready(proposalId: string, title: string): InboxClassification {
  const draft: DraftedCandidate = {
    proposalId,
    fragmentYaml: fragment(title),
    stampLine: `- ${proposalId} (plan) — RATIFIED -> NEW-1.`,
    anchorFingerprint: "",
  };
  return { proposalId, state: "ready", reasons: [], draft, draftStale: false };
}

function recordingGateway(): RatifyGateway & { branchCalls: number; prCalls: number } {
  let branchCalls = 0;
  let prCalls = 0;
  return {
    get branchCalls() {
      return branchCalls;
    },
    get prCalls() {
      return prCalls;
    },
    createRatificationBranch() {
      branchCalls++;
      return "run-APPROVE-x-1";
    },
    openPlanPr() {
      prCalls++;
      return "https://github.com/craigoley/remudero/pull/9999";
    },
  };
}

// ── Claim 1: REFUSED — a draft that re-files an already-filed task ──────────────────────────

test("approveProposal REFUSES a READY proposal whose draft duplicates a task record already on main, with ZERO gateway calls", () => {
  const gw = recordingGateway();
  const path = ledgerPath();
  // The real W1-T2453 slug, re-drafted verbatim — the 1.00 case measured on 2026-08-29.
  const c = ready(
    "board-review:escalation:#3043",
    "a board review escalation candidate names nothing it renders carries n u",
  );
  const result = approveProposal(c, gw, { ledgerPath: path, runId: "RUN-1", duplicateCorpus: CORPUS });

  assert.equal(result.ok, false, "a duplicate draft must not ratify");
  if (!result.ok) {
    assert.equal(result.duplicateOf, "W1-T2453", "the refusal must NAME the already-filed task");
    assert.match(result.refusal, /already on origin\/main/);
    assert.match(result.refusal, /REFRAME|RETIRE/, "and must offer the two additive answers");
  }
  assert.equal(gw.branchCalls, 0, "no branch may be cut for a refused ratification");
  assert.equal(gw.prCalls, 0, "and no PR opened");

  const lines = readLedger(path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "ratify.approve_refused");
  assert.equal(lines[0].duplicate_of, "W1-T2453", "the ledger row carries the id structurally, not only in prose");
  assert.equal(typeof lines[0].score, "number");
});

// ── Claim 2: ADMITTED — a genuinely distinct draft still ratifies ───────────────────────────

test("approveProposal ADMITS a genuinely distinct draft against the same corpus — the check refuses duplicates, not work", () => {
  const gw = recordingGateway();
  const path = ledgerPath();
  const c = ready("board-review:escalation:#3256", "the ci log false block escape is rung local and never reaches the sweep");
  const result = approveProposal(c, gw, { ledgerPath: path, runId: "RUN-2", duplicateCorpus: CORPUS });

  assert.equal(result.ok, true, "a distinct draft must still ratify");
  assert.equal(gw.branchCalls, 1);
  assert.equal(gw.prCalls, 1);
  assert.equal(readLedger(path).some((l) => l.step === "ratify.approved"), true);
});

test("an ABSENT or EMPTY corpus fails OPEN — the checker's own blindness never blocks a ratification", () => {
  for (const deps of [{ ledgerPath: ledgerPath(), runId: "R" }, { ledgerPath: ledgerPath(), runId: "R", duplicateCorpus: [] }]) {
    const gw = recordingGateway();
    const c = ready("board-review:escalation:#3043", "a board review escalation candidate names nothing it renders carries n u");
    assert.equal(approveProposal(c, gw, deps).ok, true, "the exact duplicate above ratifies when no corpus is supplied");
    assert.equal(gw.branchCalls, 1);
  }
});

// ── Claim 3: THE ELEVEN NEAR-IDENTICAL PROPOSAL SUMMARIES ARE NOT COLLAPSED ─────────────────

test("the eleven near-identical escalation SUMMARIES all collapse at the PROPOSAL level; scored on the drafted SLUG the check flags only the two that genuinely restate each other", () => {
  // Verbatim from the live registry on 2026-08-29 — legitimately DISTINCT proposals, one per PR.
  const prs = ["#2971", "#3030", "#3059", "#3054", "#3063", "#3194", "#3189", "#3199", "#3205", "#3227", "#3256"];
  const summaries: DuplicateCorpusEntry[] = prs.map((n) => ({
    id: `board-review:escalation:${n}`,
    text: `board-review: ${n} carries 1 unhandled escalation(s)`,
  }));

  // THE FALSIFIER FOR THE DESIGN CHOICE: scored as PROPOSALS they are near-duplicates of each
  // other, so a proposal-level check would refuse ten of the eleven.
  let collapsed = 0;
  for (const s of summaries) {
    const m = bestNearDuplicate(s, summaries, { k: DUPLICATE_SLUG_SHINGLE_K });
    if (m && m.score >= DEFAULT_DUPLICATE_CUTOFF) collapsed++;
  }
  assert.equal(collapsed, summaries.length, "all eleven collapse when the PROPOSAL is what gets scored");

  // Scored as this check does — on the DRAFTED SHARD SLUG — each is distinct work and none is
  // refused against a corpus built from the others' drafts.
  // The REAL drafted titles these eleven proposals produced, read from the live drafts cache on
  // 2026-08-29 — substantively different work, which is the whole point.
  const draftTitles = [
    "board-review's escalation finding NAMES the escalation it found",
    "MINED PROPOSALS CARRY NO CHECKABLE EVIDENCE both machine producers mint",
    "BOARD-REVIEW FINDINGS NEVER RETIRE the rung mints one add-only registry",
    "THE BOARD RUNG ASSERTS MORE THAN IT OBSERVED AND DISCARDS WHAT IT DID",
    "a board-mined proposal cannot expire board-review is the ONE registry producer",
    "BOARD-REVIEW PROPOSALS NEVER EXPIRE the rung mints registry candidates",
    "THE BOARD-REVIEW ESCALATION FINDING RESTATES THE COUNTER THAT PRODUCED IT",
    "the board's escalation arm narrows a NAMED escalation to a bare count",
    "the board-review escalation finding is a bare count run-task reduces",
    "A BOARD-REVIEW FINDING OUTLIVES ITS REFERENT FOREVER the rung mints anchor-free",
    "THE CI-LOG FALSE-BLOCK ESCAPE IS RUNG-LOCAL the rung declines the remaining strike",
  ];
  const draftCorpus = planShardSlugCorpus(
    // Kebabbed the way the shard writer does — case-insensitively, then lowered. A
    // lowercase-only character class here would mangle every capital into a separator and
    // silently change the corpus this test scores against.
    draftTitles.map((t, i) => `plan/tasks.d/W1-T90${i}-${t.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}.yaml`),
  );
  const flagged: Array<{ i: number; of: string; score: number }> = [];
  for (let i = 0; i < draftTitles.length; i++) {
    const dup = draftedDuplicate(fragment(draftTitles[i]), draftCorpus.filter((e) => e.id !== `W1-T90${i}`));
    if (dup) flagged.push({ i, of: dup.duplicateOf, score: dup.score });
  }
  // MEASURED, not asserted at zero: the slug check DISCRIMINATES rather than collapses. It flags
  // exactly the two drafts that genuinely restate each other — both say "the escalation finding
  // is a bare count", which is the already-shipped W1-T2453 cluster — and passes the other nine,
  // which are distinct work. 11 collapse at the proposal level; 2 at the slug level.
  assert.deepEqual(
    flagged.map((f) => f.i),
    [6, 8],
    `expected exactly the two mutual restatements to flag; got ${JSON.stringify(flagged)}`,
  );
  assert.ok(flagged.every((f) => f.score >= DEFAULT_DUPLICATE_CUTOFF));
  assert.equal(draftTitles.length - flagged.length, 9, "nine of the eleven siblings ratify unimpeded");
});

// ── Claim 4: the slug extractor tolerates the NEW-<n> placeholder ids ───────────────────────

test("draftedShardSlugs reads the stem from a placeholder-id path, which shardSlugFromPath cannot", () => {
  const slugs = draftedShardSlugs(fragment("board review proposals outlive their referents"));
  assert.equal(slugs.length, 1);
  assert.match(slugs[0].id, /^plan\/tasks\.d\/NEW-1-/, "at approve time the id is still a placeholder");
  assert.equal(slugs[0].text, "board-review-proposals-outlive-their-referents", "the NEW-1 id must be stripped WHOLE — a lazy split leaves \"1-\" glued to the stem");
  // The measured reason this exists: the filed-shard extractor requires a real W1-T<n> id.
  assert.equal(planShardSlugCorpus([slugs[0].id]).length, 0, "shardSlugFromPath scores a placeholder path at 0");
});

test("a fragment that cannot be split into shards yields no candidates and never refuses", () => {
  assert.deepEqual(draftedShardSlugs(""), []);
  assert.equal(draftedDuplicate("", CORPUS), undefined);
});

// ── Claim 5: A NAMED LIMIT, measured rather than hidden ─────────────────────────────────────

test("KNOWN LIMIT: drafts whose slugs differ ONLY by a number DO collapse — this is a lexical check, and that is stated, not hidden", () => {
  const corpus = planShardSlugCorpus(["plan/tasks.d/W1-T901-the-rung-mishandles-2971-in-its-own-arm.yaml"]);
  const dup = draftedDuplicate(fragment("the rung mishandles 3030 in its own arm"), corpus);
  assert.notEqual(dup, undefined, "two slugs differing only by a number score above the cutoff");
  assert.equal(dup?.duplicateOf, "W1-T901");
  // The remedy is the refusal's own two answers (cite or reframe), never a lowered cutoff.
});

// ── Claim 6: the corpus builder — both arms, no repository ─────────────────────────────────

test("filedShardSlugCorpus turns one git ls-tree into the already-filed slug corpus", () => {
  const corpus = filedShardSlugCorpus("/repo", (args) => {
    assert.deepEqual([...args], ["-C", "/repo", "ls-tree", "origin/main", "--name-only", "--", "plan/tasks.d/"],
      "ONE ls-tree against origin/main — never a git log body walk, never a network call");
    return "plan/tasks.d/W1-T2451-board-review-proposals-outlive-referents.yaml\nplan/tasks.d/W1-T170-per-run-worker-home.yaml\n";
  });
  assert.deepEqual(corpus.map((e) => e.id).sort(), ["W1-T170", "W1-T2451"]);
  assert.equal(corpus.find((e) => e.id === "W1-T2451")?.text, "board-review-proposals-outlive-referents");
});

test("filedShardSlugCorpus FAILS OPEN to an empty corpus when the tree cannot be read, so a ratification is never blocked by the checker's own blindness", () => {
  const corpus = filedShardSlugCorpus("/repo", () => {
    throw new Error("fatal: not a git repository");
  });
  assert.deepEqual(corpus, []);
  // And an empty corpus is exactly what approveProposal treats as "do not check".
  assert.equal(draftedDuplicate(fragment("board review proposals outlive their referents"), corpus), undefined);
});
