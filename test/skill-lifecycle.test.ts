import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProposalRegistry, classifyProposal, proposalsNeedingDraft, type Proposal } from "../src/lib/inbox.js";
import {
  buildSkillEffectivenessReport,
  skillLifecycleProposalId,
  stageSkillLifecycleProposal,
  type SkillEffectivenessReport,
} from "../src/lib/skill-workshop.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { applySkillLifecycleRemoval, skillLifecycleCommand } from "../src/run-task.js";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
}

function approveSkill(skillsDir: string, name = "procedure"): string {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, ["---", `name: ${name}`, "applies-to: implement", "---", "", "## Procedure", "", "- Do the thing."].join("\n"), "utf8");
  return path;
}

function selectionRow(runId: string, selected: boolean, skill = "procedure"): Record<string, unknown> {
  return {
    step: "skills.selection",
    run_id: runId,
    task_type: "implement",
    approved_eligible_names: [skill],
    selected_names: selected ? [skill] : [],
    budget_omitted_names: [],
    budget_chars: 1000,
    zero_selection: !selected,
  };
}

function verdictRow(runId: string, verdict: string): Record<string, unknown> {
  return { step: "verdict", run_id: runId, verdict };
}

function rows(selected: string[], control: string[], skill = "procedure"): Record<string, unknown>[] {
  return [
    ...selected.flatMap((verdict, i) => [selectionRow(`selected-${i}`, true, skill), verdictRow(`selected-${i}`, verdict)]),
    ...control.flatMap((verdict, i) => [selectionRow(`control-${i}`, false, skill), verdictRow(`control-${i}`, verdict)]),
  ];
}

function report(selected: string[], control: string[], skill = "procedure"): SkillEffectivenessReport {
  return buildSkillEffectivenessReport(rows(selected, control, skill), skill);
}

function union(records: Record<string, unknown>[], over: Record<string, unknown> = {}): any {
  return {
    stateDir: "/state",
    archiveFiles: [],
    archiveCount: 0,
    liveFileRead: true,
    unread: [],
    unclassified: [],
    ok: true,
    rows: records,
    torn: 0,
    filesRead: 1,
    ...over,
  };
}

test("W1-T3413 refuses untrusted lifecycle input", () => {
  const root = tmpDir("skill-lifecycle-refuse-");
  const skillsDir = join(root, "skills");
  const registryPath = join(root, "inbox-proposals.json");
  const skillPath = approveSkill(skillsDir);
  const output: string[] = [];
  const errors: string[] = [];
  const deps = {
    stateDir: "/state",
    registryPath,
    approvedSkillsDir: skillsDir,
    write: (line: string) => output.push(line),
    error: (line: string) => errors.push(line),
  };

  assert.equal(skillLifecycleCommand(["procedure"], {
    ...deps,
    readLedger: (() => union([], { ok: false, unread: ["/state/ledger.bad.ndjson.gz"] })) as any,
  }), 1);
  assert.match(errors.pop() ?? "", /REFUSED incomplete ledger union/);

  assert.equal(skillLifecycleCommand(["missing"], {
    ...deps,
    readLedger: (() => union(rows(Array(10).fill("blocked_ci"), Array(10).fill("merged"), "missing"))) as any,
  }), 1);
  assert.match(errors.pop() ?? "", /not approved and opted in/);

  assert.equal(skillLifecycleCommand(["procedure"], {
    ...deps,
    readLedger: (() => union(rows(Array(9).fill("merged"), Array(10).fill("blocked_ci")))) as any,
  }), 1);
  assert.match(errors.pop() ?? "", /below horizon/);
  assert.equal(loadProposalRegistry(registryPath).length, 0);
  assert.equal(readFileSync(skillPath, "utf8").includes("Do the thing."), true);
});

test("W1-T3413 stages one retire proposal", () => {
  const root = tmpDir("skill-lifecycle-stage-");
  const skillsDir = join(root, "skills");
  const registryPath = join(root, "inbox-proposals.json");
  approveSkill(skillsDir);

  const first = stageSkillLifecycleProposal(
    registryPath,
    skillsDir,
    report([...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")], [...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")]),
  );
  assert.equal(first.refused, false);
  assert.equal(first.staged, true);
  assert.equal(first.alreadyStaged, false);

  const second = stageSkillLifecycleProposal(
    registryPath,
    skillsDir,
    report([...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")], [...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")]),
  );
  assert.equal(second.staged, false);
  assert.equal(second.alreadyStaged, true);

  const proposals = loadProposalRegistry(registryPath);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].id, skillLifecycleProposalId("procedure"));
  assert.equal(proposals[0].lifecycleAction?.kind, "skill-retirement");
  assert.match(proposals[0].summary, /Basis: not-better-than-control/);
});

test("W1-T3413 refreshes lifecycle evidence", () => {
  const root = tmpDir("skill-lifecycle-refresh-");
  const skillsDir = join(root, "skills");
  const registryPath = join(root, "inbox-proposals.json");
  approveSkill(skillsDir);

  const first = stageSkillLifecycleProposal(
    registryPath,
    skillsDir,
    report([...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")], [...Array(5).fill("merged"), ...Array(5).fill("blocked_ci")]),
  );
  const refreshed = stageSkillLifecycleProposal(
    registryPath,
    skillsDir,
    report([...Array(9).fill("merged"), "failed"], Array(10).fill("blocked_ci")),
  );

  assert.equal(refreshed.refreshed, true);
  assert.notEqual(refreshed.evidenceFingerprint, first.evidenceFingerprint);
  const proposals = loadProposalRegistry(registryPath);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].lifecycleAction?.evidenceFingerprint, refreshed.evidenceFingerprint);
  assert.match(proposals[0].summary, /Basis: named-harm-signal/);
});

test("W1-T3413 approve owns precise removal", () => {
  const root = tmpDir("skill-lifecycle-approve-");
  const skillsDir = join(root, ".claude", "skills");
  const skillPath = approveSkill(skillsDir);
  const keepPath = approveSkill(skillsDir, "keep");
  const staged = stageSkillLifecycleProposal(
    join(root, "inbox-proposals.json"),
    skillsDir,
    report([], Array(10).fill("blocked_ci")),
  );
  assert.equal(staged.staged, true);
  const proposal = loadProposalRegistry(join(root, "inbox-proposals.json"))[0] as Proposal;
  const classification = classifyProposal(proposal, undefined, {
    plan: { tasks: [], byId: new Map() },
    isMerged: () => true,
    grepAnchorTrue: () => true,
    openProposalIds: new Set([proposal.id]),
    isRatified: () => false,
  });

  assert.equal(classification.state, "ready");
  assert.equal(classification.draft, undefined);
  assert.equal(classification.lifecycleAction?.skillPath, ".claude/skills/procedure/SKILL.md");
  assert.deepEqual(proposalsNeedingDraft([proposal], {}), []);

  const removed = applySkillLifecycleRemoval(root, classification.lifecycleAction!);
  assert.deepEqual(removed, { ok: true, removedPath: ".claude/skills/procedure/SKILL.md" });
  assert.equal(existsSync(skillPath), false);
  assert.equal(existsSync(keepPath), true);
});

test("W1-T3413 review stays read only", () => {
  const root = tmpDir("skill-lifecycle-review-");
  const skillsDir = join(root, "skills");
  const registryPath = join(root, "inbox-proposals.json");
  const skillPath = approveSkill(skillsDir);

  const result = stageSkillLifecycleProposal(
    registryPath,
    skillsDir,
    report([...Array(8).fill("merged"), ...Array(2).fill("blocked_ci")], [...Array(3).fill("merged"), ...Array(7).fill("blocked_ci")]),
  );

  assert.equal(result.refused, true);
  assert.match(result.reason ?? "", /REVIEW-CANDIDATE is read-only/);
  assert.equal(loadProposalRegistry(registryPath).length, 0);
  assert.equal(existsSync(skillPath), true);
});

test("W1-T3413 mutation rejects arbitrary removal", () => {
  const root = tmpDir("skill-lifecycle-mutation-");
  const skillsDir = join(root, ".claude", "skills");
  const skillPath = approveSkill(skillsDir);
  const otherPath = approveSkill(skillsDir, "other");
  const badPath = applySkillLifecycleRemoval(root, {
    kind: "skill-retirement",
    skillName: "procedure",
    skillPath: ".claude/skills/other/SKILL.md",
    evidenceFingerprint: "bad",
  });
  const badName = applySkillLifecycleRemoval(root, {
    kind: "skill-retirement",
    skillName: "not-approved",
    skillPath: ".claude/skills/not-approved/SKILL.md",
    evidenceFingerprint: "bad",
  });

  assert.equal(badPath.ok, false);
  assert.equal(badName.ok, false);
  assert.equal(existsSync(skillPath), true);
  assert.equal(existsSync(otherPath), true);
});
