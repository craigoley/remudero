import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  anchorFingerprint,
  approveProposal,
  classifyProposal,
  draftPlaceholderIds,
  inboxDraftPrompt,
  materializeDraftTaskIds,
  substitutePlaceholderIds,
  type DraftedCandidate,
  type InboxClassification,
  type Proposal,
  type RatificationPayload,
  type RatifyGateway,
  type ReadinessContext,
} from "../src/lib/inbox.js";
import type { Task } from "../src/lib/plan.js";
import { reserveTaskIdBlock, TaskIdReservationError } from "../src/lib/task-id-reservation.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-inbox-approve-mint-")), "ledger.ndjson");
}

function reservationsDir(): string {
  return mkdtempSync(join(tmpdir(), "rmd-task-id-reservations-"));
}

const P34_STYLE_FRAGMENT = [
  "- id: NEW-1",
  "  title: first drafted task",
  "  repo: remudero",
  "  depends_on: [W1-T5]",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  status: queued",
  "  attempts: 0",
  "  origin: feedback#fb-example",
  "  files: [src/lib/example.ts]",
  "- id: NEW-2",
  "  title: second drafted task, depends on the first",
  "  repo: remudero",
  '  depends_on: ["NEW-1"]',
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  status: queued",
  "  attempts: 0",
  "  origin: feedback#fb-example",
  "  files: [src/lib/example.ts]",
  "",
].join("\n");

const P34_STYLE_STAMP = "- P34 (plan) — RATIFIED 2026-08-03 -> NEW-1/NEW-2.";

// ── Acceptance 1: a cached draft carries placeholder ids only ──────────────────────────────

test("inboxDraftPrompt instructs NEW-<n> placeholder ids (never a real W1-T id) for new tasks, and placeholders for intra-fragment depends_on", () => {
  const proposal: Proposal = { id: "P34", summary: "s", evidenceAnchors: [] };
  const prompt = inboxDraftPrompt(proposal, "- id: W1-T5\n  title: existing\n  repo: remudero\n", "run-1");
  assert.match(prompt, /NEW-1, NEW-2, NEW-3/, "the prompt must name the NEW-<n> placeholder shape");
  assert.match(prompt, /never a real W1-Tnnn id/i);
  assert.match(prompt, /depends_on: \[NEW-1\]/, "the prompt must show placeholder-form depends_on for intra-fragment refs");
  assert.match(prompt, /EXISTING task already in plan\/tasks\.yaml/i, "depends_on on an existing task must stay a real id");
});

test("draftPlaceholderIds extracts NEW-<n> ids from `id:` DECLARATIONS only, in first-appearance order, deduplicated — never from a depends_on mention", () => {
  assert.deepEqual(draftPlaceholderIds(P34_STYLE_FRAGMENT), ["NEW-1", "NEW-2"]);
  // depends_on: ["NEW-1"] must not be double-counted or picked up as its own declaration.
  const withRepeatMention = "- id: NEW-1\n  depends_on: [NEW-1]\n- id: NEW-2\n";
  assert.deepEqual(draftPlaceholderIds(withRepeatMention), ["NEW-1", "NEW-2"]);
});

test("a placeholder-carrying draft contains NO W1-Tnnn id in any `id:` position — only NEW-<n>", () => {
  const idLines = P34_STYLE_FRAGMENT.split("\n").filter((l) => /^\s*(?:-\s*)?id:/.test(l));
  assert.ok(idLines.length > 0);
  for (const line of idLines) assert.doesNotMatch(line, /W1-T\d/, `no concrete id may appear at draft time: ${line}`);
});

// ── Acceptance 2: rmd approve materializes concrete consecutive ids and rewrites everything ──

test("materializeDraftTaskIds mints+reserves consecutive ids and rewrites the fragment's id: lines, the intra-fragment depends_on reference, and the stamp line — an EXISTING real depends_on is left untouched", () => {
  const result = materializeDraftTaskIds(
    { fragmentYaml: P34_STYLE_FRAGMENT, stampLine: P34_STYLE_STAMP },
    {
      mint: () => ({ n: 250, degraded: [] }),
      reserveBlock: (startId, count) => ({ ids: Array.from({ length: count }, (_, i) => startId + i) }),
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.ids, ["W1-T250", "W1-T251"]);
  assert.match(result.fragmentYaml, /^- id: W1-T250$/m);
  assert.match(result.fragmentYaml, /^- id: W1-T251$/m);
  assert.doesNotMatch(result.fragmentYaml, /NEW-\d/, "no placeholder may survive materialization");
  // The EXISTING task's real id is untouched.
  assert.match(result.fragmentYaml, /depends_on: \[W1-T5\]/);
  // The intra-fragment depends_on, originally ["NEW-1"], is rewritten to the real id.
  assert.match(result.fragmentYaml, /depends_on: \["W1-T250"\]/);
  assert.equal(result.stampLine, "- P34 (plan) — RATIFIED 2026-08-03 -> W1-T250/W1-T251.");
});

test("substitutePlaceholderIds is word-boundary-safe: NEW-1 never eats into NEW-10/NEW-11", () => {
  const mapping = new Map([
    ["NEW-1", "W1-T900"],
    ["NEW-10", "W1-T901"],
    ["NEW-11", "W1-T902"],
  ]);
  const out = substitutePlaceholderIds("[NEW-1, NEW-10, NEW-11]", mapping);
  assert.equal(out, "[W1-T900, W1-T901, W1-T902]");
});

test("materializeDraftTaskIds is a pass-through no-op when the fragment carries no placeholders at all (a pre-existing cached draft)", () => {
  const already = { fragmentYaml: "- id: W1-T900\n  title: x\n  repo: remudero\n", stampLine: "- P1 (plan) — RATIFIED 2026-08-03 -> W1-T900." };
  const result = materializeDraftTaskIds(already, {
    mint: () => {
      throw new Error("must never be called — nothing to mint");
    },
    reserveBlock: () => {
      throw new Error("must never be called — nothing to reserve");
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fragmentYaml, already.fragmentYaml);
  assert.equal(result.stampLine, already.stampLine);
  assert.deepEqual(result.ids, []);
});

// ── Acceptance 3: two independently drafted proposals both starting at NEW-1 approve to
//    DISJOINT ranges — replays the 2026-07-22 P34/P37 W1-T244 overlap over the REAL reservation
//    mechanism (task-id-reservation.ts), not a mock — the whole point of RESERVING what the
//    mint only DERIVES. ────────────────────────────────────────────────────────────────────

test("two proposals whose independent mints both land on the SAME floor (the P34/P37 collision replayed) still reserve DISJOINT id ranges", () => {
  const dir = reservationsDir();
  // Both P34 and P37 minted from the same stale view of main and landed on W1-T244 — replayed
  // here as two calls whose `mint()` both return the SAME n, exactly as the incident recorded.
  const sameStaleMint = () => ({ n: 244, degraded: [] });

  const p34 = materializeDraftTaskIds(
    { fragmentYaml: P34_STYLE_FRAGMENT, stampLine: P34_STYLE_STAMP },
    { mint: sameStaleMint, reserveBlock: (startId, count) => reserveTaskIdBlock(startId, count, dir, { info: { purpose: "P34" } }) },
  );
  const p37Fragment = "- id: NEW-1\n  title: p37 task one\n  repo: remudero\n- id: NEW-2\n  title: p37 task two\n  repo: remudero\n";
  const p37 = materializeDraftTaskIds(
    { fragmentYaml: p37Fragment, stampLine: "- P37 (plan) — RATIFIED 2026-08-03 -> NEW-1/NEW-2." },
    { mint: sameStaleMint, reserveBlock: (startId, count) => reserveTaskIdBlock(startId, count, dir, { info: { purpose: "P37" } }) },
  );

  assert.equal(p34.ok, true);
  assert.equal(p37.ok, true);
  if (!p34.ok || !p37.ok) return;

  assert.deepEqual(p34.ids, ["W1-T244", "W1-T245"]);
  // P37's mint ALSO said 244 — but W1-T244/245 are LIVE-reserved (P34 still holds them, this
  // process's own pid), so the reservation ADVANCES past them rather than colliding.
  assert.deepEqual(p37.ids, ["W1-T246", "W1-T247"]);
  const overlap = p34.ids.filter((id) => p37.ids.includes(id));
  assert.deepEqual(overlap, [], "the two proposals must never share an id — the exact collision this task closes");
});

// ── Acceptance 4: a degraded mint or a failed reservation REFUSES — names the source, opens
//    no PR, leaves the proposal READY (never ledgers ratify.approved). ────────────────────────

test("materializeDraftTaskIds REFUSES, naming the source, when the mint reports a degraded source — never mints/writes anything", () => {
  const result = materializeDraftTaskIds(
    { fragmentYaml: P34_STYLE_FRAGMENT, stampLine: P34_STYLE_STAMP },
    {
      mint: () => ({ n: 250, degraded: [{ source: "shards", reason: "cannot read shard W1-T260-foo.yaml: EACCES" }] }),
      reserveBlock: () => {
        throw new Error("must never be called — the mint already degraded");
      },
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /degraded/i);
  assert.match(result.reason, /shards/);
  assert.match(result.reason, /cannot read shard W1-T260-foo\.yaml/);
});

test("materializeDraftTaskIds REFUSES, naming the failure, when the reservation throws for a non-contention reason", () => {
  const result = materializeDraftTaskIds(
    { fragmentYaml: P34_STYLE_FRAGMENT, stampLine: P34_STYLE_STAMP },
    {
      mint: () => ({ n: 250, degraded: [] }),
      reserveBlock: () => {
        throw new TaskIdReservationError("cannot reserve task id W1-T250 at /no/such/dir/W1-T00250.json: EACCES");
      },
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /reservation failed/i);
  assert.match(result.reason, /W1-T250/);
});

test("a createRatificationBranch that REFUSES (mirrors the real gateway's materialize-failure throw) never reaches openPlanPr, and approveProposal never ledgers ratify.approved — the proposal stays READY", () => {
  const draft: DraftedCandidate = {
    proposalId: "P34",
    fragmentYaml: P34_STYLE_FRAGMENT,
    stampLine: P34_STYLE_STAMP,
    anchorFingerprint: "landed::MASTER-PLAN.md",
  };
  const classification: InboxClassification = { proposalId: "P34", state: "ready", reasons: [], draft, draftStale: false };

  let prCalls = 0;
  const refusingGateway: RatifyGateway = {
    createRatificationBranch(payload: RatificationPayload) {
      // Exactly what run-task.ts's real gateway does: materialize first, throw before any
      // write/commit on a refusal.
      const materialized = materializeDraftTaskIds(payload, {
        mint: () => ({ n: 250, degraded: [{ source: "open-prs", reason: "cannot enumerate open PRs: gh timed out" }] }),
        reserveBlock: () => {
          throw new Error("must never be called");
        },
      });
      if (!materialized.ok) throw new Error(`rmd approve: refusing to materialize task id(s) — ${materialized.reason}`);
      throw new Error("unreachable in this test");
    },
    openPlanPr() {
      prCalls++;
      return "https://github.com/craigoley/remudero/pull/999";
    },
  };

  const path = ledgerPath();
  assert.throws(() => approveProposal(classification, refusingGateway, { ledgerPath: path, runId: "RUN-1" }), /refusing to materialize/);
  assert.equal(prCalls, 0, "no PR may ever be opened on a materialize refusal");

  // The throw happens BEFORE approveProposal's own `ratify.approved` append, so no ledger line
  // — not even the file itself — is ever written on this path; that IS "never ledgered".
  let lines: Array<Record<string, unknown>> = [];
  try {
    lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l: string) => JSON.parse(l));
  } catch (e) {
    assert.equal((e as NodeJS.ErrnoException).code, "ENOENT", "only a never-created ledger file is expected here");
  }
  assert.ok(!lines.some((l) => l.step === "ratify.approved"), "ratify.approved must never be ledgered on a refusal");
});

// ── Acceptance 5: the readiness lint still passes over a placeholder-carrying draft ─────────

test("classifyProposal: a lint-clean, placeholder-carrying drafted fragment classifies READY, not draft-unclean", () => {
  const proposal: Proposal = { id: "P34", summary: "s", evidenceAnchors: [] };
  const draft: DraftedCandidate = {
    proposalId: "P34",
    fragmentYaml: P34_STYLE_FRAGMENT,
    stampLine: P34_STYLE_STAMP,
    anchorFingerprint: anchorFingerprint([]), // matches proposal.evidenceAnchors — not stale
  };
  // W1-T5 (the fragment's one outside dep) must actually EXIST in the base plan, merged, for
  // unmetOutsideDeps to resolve it — a dep pointing nowhere is unmet regardless of isMerged.
  const w1t5: Task = {
    id: "W1-T5",
    title: "existing task",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    risk: "medium",
    status: "merged",
    attempts: 0,
  };
  const ctx: ReadinessContext = {
    plan: { tasks: [w1t5], byId: new Map([["W1-T5", w1t5]]) },
    isMerged: () => true,
    grepAnchorTrue: () => true,
    openProposalIds: new Set(["P34"]),
    isRatified: () => false,
  };
  const classification = classifyProposal(proposal, draft, ctx);
  assert.equal(
    classification.state,
    "ready",
    `expected READY, got ${classification.state}: ${JSON.stringify(classification.reasons)}`,
  );
  assert.deepEqual(classification.reasons, []);
});
