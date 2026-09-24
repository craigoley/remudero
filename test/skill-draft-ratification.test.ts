// W1-T4338 — `rmd approve` could not ratify a skill-workshop draft. `stageSkillDraft` promised a PR that writes
// `.claude/skills/<name>/SKILL.md`, but `approveProposal` knew one payload shape, a tasks.yaml fragment, so no
// drafted skill ever reached the approved tree. These pin the write path: the staged proposal carries the file,
// approval routes it to `writeSkillFile`, the writer puts it at its one path verbatim, and every task-filing
// proposal still reaches `createRatificationBranch` exactly as before.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  approveProposal,
  approvedSkillRelPath,
  classifyProposal,
  loadProposalRegistry,
  proposalsNeedingDraft,
  writeApprovedSkillFile,
  type DraftedCandidate,
  type InboxClassification,
  type Proposal,
  type RatificationPayload,
  type RatifyGateway,
  type SkillFilePayload,
} from "../src/lib/inbox.js";
import { stageSkillDraft, workerAllowlistFromSettings, describeWorkerSkillReachability, type SkillDraft } from "../src/lib/skill-workshop.js";
import { parseAcceptanceBlock } from "../src/lib/review.js";
import { skillFileApprovePrBody } from "../src/run-task.js";

const SKILL: SkillFilePayload = {
  name: "implement-clean-single-strike",
  markdown: "---\nname: implement-clean-single-strike\ndescription: d\napplies-to: implement\n---\n\n## Procedure\n- step\n",
};

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
function ledgerPath(): string {
  return join(tmp("rmd-skill-ratify-"), "ledger.ndjson");
}
function readLedger(p: string): Array<Record<string, unknown>> {
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** Records every gateway call, in order, with its arguments. */
function recordingGateway(opts: { withWriter?: boolean } = {}): RatifyGateway & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const gateway: RatifyGateway & { calls: Array<[string, unknown[]]> } = {
    calls,
    createRatificationBranch(payload: RatificationPayload) {
      calls.push(["createRatificationBranch", [payload]]);
      return "run-APPROVE-task-1";
    },
    openPlanPr(branch: string, proposalId: string) {
      calls.push(["openPlanPr", [branch, proposalId]]);
      return "https://github.com/craigoley/remudero/pull/4338";
    },
  };
  if (opts.withWriter !== false) {
    gateway.writeSkillFile = (proposalId: string, skillFile: SkillFilePayload) => {
      calls.push(["writeSkillFile", [proposalId, skillFile]]);
      return "run-APPROVE-skill-1";
    };
  }
  return gateway;
}

const readySkill = (skillFile: SkillFilePayload = SKILL): InboxClassification => ({
  proposalId: "skill-draft:proc-1",
  state: "ready",
  reasons: [],
  skillFile,
});

test("a proposal carrying a skillFile payload routes approval to writeSkillFile and never to createRatificationBranch, before openPlanPr runs", () => {
  const gateway = recordingGateway();
  const ledger = ledgerPath();
  const result = approveProposal(readySkill(), gateway, { ledgerPath: ledger, runId: "R1" });

  assert.equal(result.ok, true);
  assert.deepEqual(
    gateway.calls.map(([name]) => name),
    ["writeSkillFile", "openPlanPr"],
    "the skill is written on its own branch first, then the PR opens on that branch",
  );
  assert.deepEqual(gateway.calls[0][1], ["skill-draft:proc-1", SKILL]);
  assert.deepEqual(gateway.calls[1][1], ["run-APPROVE-skill-1", "skill-draft:proc-1"]);
  const approved = readLedger(ledger).find((l) => l.step === "ratify.approved");
  assert.equal(approved?.skill_file, ".claude/skills/implement-clean-single-strike/SKILL.md");
});

test("writeSkillFile writes the exact path .claude skills <name> SKILL.md with the drafted markdown verbatim", () => {
  const root = tmp("rmd-skill-write-");
  const relPath = writeApprovedSkillFile(root, SKILL, { mkdirSync, writeFileSync }, join);

  assert.equal(relPath, ".claude/skills/implement-clean-single-strike/SKILL.md");
  assert.equal(readFileSync(join(root, relPath), "utf8"), SKILL.markdown, "byte for byte, never re-rendered");
  assert.throws(
    () => writeApprovedSkillFile(root, { name: "../escape", markdown: "x" }, { mkdirSync, writeFileSync }, join),
    /not a single safe path segment/,
  );
  assert.equal(approvedSkillRelPath("a/b"), null);
});

test("a proposal with no skillFile field is byte-for-byte unaffected — createRatificationBranch is invoked exactly as it is today", () => {
  const draft: DraftedCandidate = {
    proposalId: "P25",
    fragmentYaml: "- id: NEW-1\n  title: \"t\"\n",
    stampLine: "- P25 (plan) — RATIFIED -> NEW-1.",
    anchorFingerprint: "",
  };
  const gateway = recordingGateway();
  const ledger = ledgerPath();
  const result = approveProposal({ proposalId: "P25", state: "ready", reasons: [], draft, draftStale: false }, gateway, {
    ledgerPath: ledger,
    runId: "R2",
  });

  assert.deepEqual(gateway.calls, [
    ["createRatificationBranch", [{ proposalId: "P25", fragmentYaml: draft.fragmentYaml, stampLine: draft.stampLine }]],
    ["openPlanPr", ["run-APPROVE-task-1", "P25"]],
  ]);
  assert.deepEqual(result, {
    ok: true,
    proposalId: "P25",
    branch: "run-APPROVE-task-1",
    prUrl: "https://github.com/craigoley/remudero/pull/4338",
    prNumber: 4338,
    payload: { proposalId: "P25", fragmentYaml: draft.fragmentYaml, stampLine: draft.stampLine },
  });
  assert.equal("skill_file" in (readLedger(ledger).find((l) => l.step === "ratify.approved") ?? {}), false);
});

test("stageSkillDraft populates the proposal s skillFile field with the SkillDraft's own name and markdown, not a re-parse of the summary", () => {
  const registryPath = join(tmp("rmd-skill-stage-"), "inbox-proposals.json");
  const draft: SkillDraft = {
    name: SKILL.name,
    description: "d",
    markdown: SKILL.markdown,
    candidateHash: "c0ffee",
    procedureKey: "proc-1",
    supportingRuns: 3,
  };
  const allowlist = workerAllowlistFromSettings({
    permissions: { deny: [], allow: [], ask: [] },
    sandbox: { enabled: true, filesystem: { denyRead: [] }, network: { allowedDomains: ["github.com"] } },
  });
  const staged = stageSkillDraft(registryPath, draft, allowlist, describeWorkerSkillReachability([]));
  assert.equal(staged.staged, true);

  const proposal = loadProposalRegistry(registryPath)[0] as Proposal;
  assert.deepEqual(proposal.skillFile, { name: draft.name, markdown: draft.markdown });
});

test("a staged skill draft is READY with no Architect draft, is never queued for one, and refuses without a writer or with an unsafe name", () => {
  const proposal: Proposal = { id: "skill-draft:proc-1", summary: "s", evidenceAnchors: [], skillFile: SKILL };
  const classification = classifyProposal(proposal, undefined, {
    plan: { tasks: [], byId: new Map() },
    isMerged: () => true,
    grepAnchorTrue: () => true,
    openProposalIds: new Set([proposal.id]),
    isRatified: () => false,
  });
  assert.equal(classification.state, "ready");
  assert.equal(classification.draft, undefined);
  assert.deepEqual(classification.skillFile, SKILL);
  assert.deepEqual(proposalsNeedingDraft([proposal], {}), []);

  const noWriter = recordingGateway({ withWriter: false });
  const refused = approveProposal(readySkill(), noWriter, { ledgerPath: ledgerPath(), runId: "R3" });
  assert.equal(refused.ok, false);
  assert.match((refused as { refusal: string }).refusal, /cannot write a skill file/);
  assert.deepEqual(noWriter.calls, [], "a refusal makes no gateway call");

  const unsafe = recordingGateway();
  const refusedName = approveProposal(readySkill({ name: "../x", markdown: "m" }), unsafe, { ledgerPath: ledgerPath(), runId: "R4" });
  assert.match((refusedName as { refusal: string }).refusal, /not a single safe path segment/);
  assert.deepEqual(unsafe.calls, []);
});

test("the skill PR body carries an executable grep proof on the one file it adds", () => {
  const relPath = ".claude/skills/implement-clean-single-strike/SKILL.md";
  const body = skillFileApprovePrBody("skill-draft:proc-1", SKILL.name, relPath);
  assert.deepEqual(parseAcceptanceBlock(body), [
    { claim: `${relPath} is the approved skill draft implement-clean-single-strike`, proof: `grep: name: implement-clean-single-strike in ${relPath}` },
  ]);
});
