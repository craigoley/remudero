// W1-T4338 — `rmd approve` could not ratify a skill-workshop draft. `stageSkillDraft` promised a PR that writes
// `.claude/skills/<name>/SKILL.md`, but `approveProposal` knew one payload shape, a tasks.yaml fragment, so no
// drafted skill ever reached the approved tree. These pin the write path: the staged proposal carries the file,
// approval routes it to `writeSkillFile`, the writer puts it at its one path verbatim, and every task-filing
// proposal still reaches `createRatificationBranch` exactly as before.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

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
import { approveCommand, skillFileApproveCommitMessage, skillFileApprovePrBody } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SKILL: SkillFilePayload = {
  name: "implement-clean-single-strike",
  markdown: "---\nname: implement-clean-single-strike\ndescription: d\napplies-to: implement\n---\n\n## Procedure\n- step\n",
};

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
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

test("the skill commit names the one file it adds and carries no Remudero-Task trailer", () => {
  const message = skillFileApproveCommitMessage("skill-draft:proc-1", ".claude/skills/implement-clean-single-strike/SKILL.md");
  assert.match(message, /^chore\(skill\): add approved skill via rmd approve$/m);
  assert.match(message, /adds exactly \.claude\/skills\/implement-clean-single-strike\/SKILL\.md/);
  assert.doesNotMatch(message, /Remudero-Task:/);
});

/** A bare origin whose main holds a minimal plan, and no skills. */
function skillOrigin() {
  const bare = gitRepo({ bare: true, branch: "main", kind: "skill-draft-origin" });
  const seed = gitRepo({ branch: "main", seedCommit: false, kind: "skill-draft-seed" });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "- id: W1-T4\n  title: seed task\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n", "utf8");
  writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# MASTER PLAN\n\nfixture\n", "utf8");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed skill-draft fixture");
  seed.addRemote("origin", bare.dir);
  seed.git("push", "--quiet", "origin", "main");
  seed.cleanup();
  return bare;
}

test("rmd approve pushes the staged skill draft's SKILL.md verbatim on its own branch and opens the skill PR", async () => {
  const bare = skillOrigin();
  const root = tmp("rmd-skill-approve-command-");
  const shim = ghShim([
    { when: "headRefName", stdout: '{"headRefName":"main"}' },
    { when: "pulls", stdout: '{"html_url":"https://github.com/craigoley/remudero/pull/74338","number":74338}' },
  ], { kind: "skill-draft-gh" });
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${savedPath}`;
    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoDir = join(root, "repos", originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2]);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare.dir, repoDir], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });
    mkdirSync(join(root, "state"), { recursive: true });
    const proposal: Proposal = { id: "skill-draft:proc-1", summary: "s", evidenceAnchors: [], skillFile: SKILL };
    writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [proposal] }, null, 2), "utf8");

    const code = await withLiveWritesAllowed(() =>
      approveCommand(["skill-draft:proc-1"], { config: { claudeBin: "/usr/bin/true", root } as never }),
    );

    assert.equal(code, 1, "the ownership guard stops the offline fixture after the skill PR is opened");
    const refs = execFileSync("git", ["-C", bare.dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/run-*"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    assert.equal(refs.length, 1, `expected one skill approve branch, got ${JSON.stringify(refs)}`);
    const written = execFileSync("git", ["-C", bare.dir, "show", `${refs[0]}:.claude/skills/implement-clean-single-strike/SKILL.md`], { encoding: "utf8" });
    assert.equal(written, SKILL.markdown, "the pushed file is the staged draft, byte for byte");
    const changed = execFileSync("git", ["-C", bare.dir, "diff", "--name-only", `main...${refs[0]}`], { encoding: "utf8" }).trim();
    assert.equal(changed, ".claude/skills/implement-clean-single-strike/SKILL.md", "no plan shard, no MASTER-PLAN stamp");
    assert.ok(shim.calls().some((c) => c.includes("chore(skill): add approved skill implement-clean-single-strike via rmd approve")));
    const lines = readLedger(join(root, "state", "ledger.ndjson"));
    assert.ok(lines.some((l) => l.step === "approve.skill_written" && l.path === ".claude/skills/implement-clean-single-strike/SKILL.md"));
    assert.ok(lines.some((l) => l.step === "ratify.approved" && l.skill_file === ".claude/skills/implement-clean-single-strike/SKILL.md"));
  } finally {
    process.env.PATH = savedPath;
    bare.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
