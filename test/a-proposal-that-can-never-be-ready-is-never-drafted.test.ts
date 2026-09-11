import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  anchorFingerprint,
  draftExclusionForProposal,
  draftsDueOnDaemon,
  proposalsNeedingDraft,
  type BoardReferentRead,
  type BoardReferentState,
  type DraftCache,
  type DraftedCandidate,
  type EvidenceAnchor,
  type Proposal,
  type ReadinessContext,
} from "../src/lib/inbox.js";
import type { Config } from "../src/lib/config.js";
import { loadPlanFromYaml, type MergedResolver, type Plan } from "../src/lib/plan.js";
import { buildInboxDraftHook } from "../src/run-task.js";

const BASE_PLAN_YAML = `
- id: W1-T1
  title: "already merged"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: merged
  attempts: 1
  origin: architect
`;

function basePlan(): Plan {
  return loadPlanFromYaml(BASE_PLAN_YAML, "fixture");
}

const yamlIsMerged: MergedResolver = (t) => t.status === "merged" || t.status === "done";

function ctx(overrides: Partial<ReadinessContext> = {}): ReadinessContext {
  return {
    plan: basePlan(),
    isMerged: yamlIsMerged,
    grepAnchorTrue: () => true,
    openProposalIds: new Set(),
    isRatified: () => false,
    ...overrides,
  };
}

function proposal(id: string, overrides: Partial<Proposal> = {}): Proposal {
  return { id, summary: id, evidenceAnchors: [], ...overrides };
}

function referents(states: Record<string, BoardReferentState>): BoardReferentRead {
  return { kind: "ok", states: new Map(Object.entries(states)) };
}

function draftFor(proposalId: string, anchors: EvidenceAnchor[]): DraftedCandidate {
  return {
    proposalId,
    fragmentYaml: BASE_PLAN_YAML,
    stampLine: `- ${proposalId} (plan) - RATIFIED 2026-09-11 -> W1-T1.`,
    anchorFingerprint: anchorFingerprint(anchors),
  };
}

test("an UNREADABLE readiness fact leaves the proposal draftable — the fail-open arm criterion 2 claims", () => {
  // Criterion 2 says an undeterminable never-READY status "stays draftable rather than being
  // silently dropped". readDraftExclusion is the arm that decides it, and nothing reached its
  // catch: every fixture above supplies readers that answer. A reader that THROWS is the case the
  // claim is about — an unreadable fact must read as "no exclusion", never as "excluded".
  const exclusion = draftExclusionForProposal(
    proposal("P-UNREADABLE"),
    ctx({
      isRatified: () => {
        throw new Error("ledger unreadable");
      },
    }),
  );
  assert.equal(exclusion, undefined, "an unreadable fact must not exclude the proposal");

  // CONTROL: the same reader answering TRUE does exclude it, so the assertion above is about the
  // throw and not about this predicate being unreachable.
  assert.equal(
    draftExclusionForProposal(proposal("P-RATIFIED-CTRL"), ctx({ isRatified: () => true }))?.predicate,
    "ratified",
  );
});

test("an UNFIRED trigger excludes the proposal and names the trigger predicate", () => {
  // The trigger arm had no caller either: every fixture proposal above omits `trigger`, so the
  // branch that reports a not-yet-fired trigger was never entered.
  const exclusion = draftExclusionForProposal(
    proposal("P-TRIGGER", { trigger: { fired: false, description: "waiting on the third occurrence" } }),
    ctx(),
  );
  assert.equal(exclusion?.predicate, "trigger");
  assert.equal(exclusion?.detail, "waiting on the third occurrence", "the detail must carry the trigger's own words");

  // CONTROL: a FIRED trigger is not an exclusion — the branch must discriminate, not always fire.
  assert.equal(
    draftExclusionForProposal(
      proposal("P-TRIGGER-FIRED", { trigger: { fired: true, description: "already fired" } }),
      ctx(),
    ),
    undefined,
  );
});

test("daemon draft selection excludes every draft-independent never-ready predicate and names the predicate", () => {
  const goodAnchor: EvidenceAnchor = { description: "good", pattern: "present" };
  const driftedAnchor: EvidenceAnchor = { description: "drifted", pattern: "gone" };
  const candidates: Proposal[] = [
    proposal("P-RATIFIED"),
    proposal("P-DECLINED"),
    proposal("P-RETIRED", { originatingItemId: "pr-1" }),
    proposal("P-TRIGGER", { trigger: { description: "wait for operator", fired: false } }),
    proposal("P-DRIFTED", { evidenceAnchors: [driftedAnchor] }),
    proposal("P-CONFLICT", { conflictsWith: ["P-OTHER"] }),
    proposal("P-DRAFTABLE", { evidenceAnchors: [goodAnchor] }),
  ];
  const readiness = ctx({
    boardReferents: referents({ "pr-1": { status: "merged", unhandledEscalations: 0 } }),
    grepAnchorTrue: (anchor) => anchor.pattern === goodAnchor.pattern,
    openProposalIds: new Set(["P-OTHER"]),
    isRatified: (id) => id === "P-RATIFIED",
    isDeclined: (id) => (id === "P-DECLINED" ? "operator declined it" : undefined),
  });

  assert.deepEqual(
    candidates.slice(0, -1).map((p) => draftExclusionForProposal(p, readiness)?.predicate),
    ["ratified", "declined", "referent_resolved", "trigger", "evidence_anchors", "no_conflict"],
  );
  assert.deepEqual(
    draftsDueOnDaemon(candidates, {}, {}, 0, readiness).map((p) => p.id),
    ["P-DRAFTABLE"],
  );
});

test("daemon draft selection keeps a proposal draftable when a never-ready fact is unreadable", () => {
  const uncertainAnchor: EvidenceAnchor = { description: "uncertain", pattern: "maybe" };
  const candidates: Proposal[] = [
    proposal("P-RATIFICATION-UNREADABLE"),
    proposal("P-REFERENT-UNREADABLE", { originatingItemId: "pr-404" }),
    proposal("P-ANCHOR-UNREADABLE", { evidenceAnchors: [uncertainAnchor] }),
  ];
  const readiness = ctx({
    isRatified: () => {
      throw new Error("ledger unavailable");
    },
    boardReferents: { kind: "unreadable" },
    grepAnchorTrue: () => {
      throw new Error("git grep unavailable");
    },
  });

  assert.deepEqual(
    draftsDueOnDaemon(candidates, {}, {}, 0, readiness).map((p) => p.id),
    ["P-ANCHOR-UNREADABLE", "P-RATIFICATION-UNREADABLE", "P-REFERENT-UNREADABLE"],
  );
});

test("daemon draft hook logs readiness-unavailable and falls back to drafting when pre-draft facts cannot be read", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-inbox-readiness-unavailable-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "inbox-proposals.json"),
    JSON.stringify({ proposals: [proposal("P-FALLBACK")] }),
  );
  mkdirSync(join(stateDir, "ledger.ndjson"));

  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const hook = buildInboxDraftHook(
    "owner",
    "repo",
    { root } as Config,
    "RUN-READINESS",
    (step, extra) => logs.push({ step, extra }),
    async (due) =>
      due.map((p) => ({
        proposalId: p.id,
        ok: true as const,
        candidate: { proposalId: p.id, fragmentYaml: BASE_PLAN_YAML, stampLine: "stamp", anchorFingerprint: "" },
      })),
  );

  await hook();

  assert.deepEqual(
    logs.map((l) => l.step),
    ["inbox.draft_readiness_unavailable", "inbox.draft_batch"],
  );
  assert.match(String(logs[0]?.extra?.error), /EISDIR/);
  const drafts = JSON.parse(readFileSync(join(stateDir, "inbox-drafts.json"), "utf8")) as Record<string, unknown>;
  assert.ok(drafts["P-FALLBACK"], "fallback mode must still draft when readiness facts are unreadable");
});

test("manual inbox force still drafts a named proposal that daemon selection excludes", () => {
  const declined = proposal("P-DECLINED");
  const readiness = ctx({ isDeclined: () => "operator declined it" });

  assert.deepEqual(draftsDueOnDaemon([declined], {}, {}, 0, readiness), []);
  assert.deepEqual(
    proposalsNeedingDraft([declined], {}).map((p) => p.id),
    ["P-DECLINED"],
  );
});

test("daemon draft selection ranks stale cached drafts before brand-new drafts when the cap binds", () => {
  const current: EvidenceAnchor = { description: "current", pattern: "current" };
  const old: EvidenceAnchor = { description: "old", pattern: "old" };
  const candidates: Proposal[] = [
    proposal("P-NEW-Z", { evidenceAnchors: [current] }),
    proposal("P-STALE-Z", { evidenceAnchors: [current] }),
    proposal("P-NEW-A", { evidenceAnchors: [current] }),
    proposal("P-STALE-A", { evidenceAnchors: [current] }),
  ];
  const drafts: DraftCache = {
    "P-STALE-Z": draftFor("P-STALE-Z", [old]),
    "P-STALE-A": draftFor("P-STALE-A", [old]),
  };

  assert.deepEqual(
    draftsDueOnDaemon(candidates, drafts, {}, 3, ctx()).map((p) => p.id),
    ["P-STALE-A", "P-STALE-Z", "P-NEW-A"],
  );
});
