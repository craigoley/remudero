import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  approveProposal,
  loadProposalRegistry,
  type InboxClassification,
  type Proposal,
  type RatifyGateway,
} from "../src/lib/inbox.js";
import {
  describeWorkerSkillReachability,
  skillDraftProposalId,
  stageSkillDraft,
  workerAllowlistFromSettings,
  type SkillDraft,
} from "../src/lib/skill-workshop.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// After W1-T4338, approving a skill draft writes its SKILL.md — but only if the staged proposal carries the file.
// One staged before that change carries none, and approving it would file a TASK about the skill instead. The
// workshop's next pass now backfills the file onto the same id, and approval refuses a skill draft still missing it.

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
const DRAFT: SkillDraft = {
  name: "implement-clean-single-strike",
  description: "d",
  markdown: "---\nname: implement-clean-single-strike\ndescription: d\napplies-to: implement\n---\n\n## Procedure\n- step\n",
  candidateHash: "c0ffee",
  procedureKey: "proc-1",
  supportingRuns: 3,
};
const ALLOWLIST = workerAllowlistFromSettings({
  permissions: { deny: [], allow: [], ask: [] },
  sandbox: { enabled: true, filesystem: { denyRead: [] }, network: { allowedDomains: ["github.com"] } },
});

test("a skill draft staged before W1-T4338 gains its skill file on the workshop's next staging pass, and only once", () => {
  const registryPath = join(tmp("skill-backfill-"), "inbox-proposals.json");
  const id = skillDraftProposalId(DRAFT.procedureKey);
  writeFileSync(registryPath, JSON.stringify({ proposals: [{ id, summary: "staged before the file existed", evidenceAnchors: [] }] }), "utf8");

  const first = stageSkillDraft(registryPath, DRAFT, ALLOWLIST, describeWorkerSkillReachability([]));
  assert.deepEqual(first, { refused: false, staged: false, alreadyStaged: true, backfilled: true, reason: "already staged; skill file backfilled" });
  const [proposal] = loadProposalRegistry(registryPath) as Proposal[];
  assert.deepEqual(proposal.skillFile, { name: DRAFT.name, markdown: DRAFT.markdown });
  assert.match(proposal.summary, /writes '\.claude\/skills\/implement-clean-single-strike\/SKILL\.md'/);

  const bytes = readFileSync(registryPath, "utf8");
  const second = stageSkillDraft(registryPath, DRAFT, ALLOWLIST, describeWorkerSkillReachability([]));
  assert.deepEqual(second, { refused: false, staged: false, alreadyStaged: true, reason: "already staged" });
  assert.equal(readFileSync(registryPath, "utf8"), bytes, "an entry that already has its file is never rewritten");
});

test("approving a skill draft that carries no skill file is refused, names why, and makes no gateway call", () => {
  const ledgerPath = join(tmp("skill-legacy-refuse-"), "ledger.ndjson");
  const calls: string[] = [];
  const gateway: RatifyGateway = {
    createRatificationBranch: () => (calls.push("createRatificationBranch"), "b"),
    openPlanPr: () => (calls.push("openPlanPr"), "https://github.com/craigoley/remudero/pull/1"),
    writeSkillFile: () => (calls.push("writeSkillFile"), "b"),
  };
  const classification: InboxClassification = {
    proposalId: "skill-draft:095bf3e60137974c",
    state: "ready",
    reasons: [],
    draft: { proposalId: "skill-draft:095bf3e60137974c", fragmentYaml: "- id: NEW-1\n  title: \"t\"\n", stampLine: "- s", anchorFingerprint: "" },
    draftStale: false,
  };

  const result = approveProposal(classification, gateway, { ledgerPath, runId: "R" });
  assert.equal(result.ok, false);
  assert.match((result as { refusal: string }).refusal, /skill draft staged without its skill file — approving it would file a task/);
  assert.deepEqual(calls, []);
  assert.ok(existsSync(ledgerPath));
  const refused = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(refused[0].step, "ratify.approve_refused");
});
