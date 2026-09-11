import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadProposalRegistry, writeSkillLifecycleRetirement, type Proposal } from "../src/lib/inbox.js";
import {
  buildSkillEffectivenessReport,
  stageSkillLifecycleRetirement,
  type InjectableSkill,
  type SkillEffectivenessReport,
} from "../src/lib/skill-workshop.js";
import { approveCommand, materializeApprovedSkillLifecycleRetirement, skillLifecycleCommand } from "../src/run-task.js";

const approved: InjectableSkill = { name: "proven-procedure", appliesTo: ["implement"], body: "Use evidence." };

function report(over: Partial<SkillEffectivenessReport> = {}): SkillEffectivenessReport {
  return {
    skill_name: approved.name,
    task_type: "implement",
    horizon: 10,
    status: "RETIRE-CANDIDATE",
    basis: "zero-selection",
    selected: { observed_eligible_runs: 0, terminal_runs: 0, merged_runs: 0, harmful_terminal_runs: 0, outcomes: {} },
    control: { observed_eligible_runs: 10, terminal_runs: 10, merged_runs: 8, harmful_terminal_runs: 0, outcomes: { merged: 8, blocked: 2 } },
    harm_outcomes: ["failed"],
    ...over,
  };
}

function registryFixture(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-skill-lifecycle-"));
  return { dir, path: join(dir, "inbox-proposals.json") };
}

function rows(selectedCount: number, selectedVerdict: string, controlCount: number, controlVerdict: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < selectedCount; i++) {
    const run = `selected-${i}`;
    out.push({ step: "skills.selection", run_id: run, task_type: "implement", approved_eligible_names: [approved.name], selected_names: [approved.name] });
    out.push({ step: "verdict", run_id: run, verdict: selectedVerdict });
  }
  for (let i = 0; i < controlCount; i++) {
    const run = `control-${i}`;
    out.push({ step: "skills.selection", run_id: run, task_type: "implement", approved_eligible_names: [approved.name], selected_names: [] });
    out.push({ step: "verdict", run_id: run, verdict: controlVerdict });
  }
  return out;
}

const completeUnion = (inputRows: Record<string, unknown>[]) => () => ({ ok: true, unread: [], rows: inputRows });

test("W1-T3413 refuses untrusted lifecycle input", () => {
  const errors: string[] = [];
  let stages = 0;
  const common = {
    stateDir: "/unused",
    registryPath: "/unused/inbox-proposals.json",
    error: (text: string) => errors.push(text),
    write: () => {},
    loadApprovedSkills: () => [approved],
    stageRetirement: () => { stages++; return { refused: false, staged: true, refreshed: false, alreadyStaged: false }; },
  };
  assert.equal(
    skillLifecycleCommand([approved.name], { ...common, readLedger: () => ({ ok: false, unread: ["ledger.bad"], rows: [] }) } as never),
    1,
  );
  assert.equal(
    skillLifecycleCommand([approved.name], { ...common, readLedger: completeUnion(rows(1, "merged", 1, "merged")), loadApprovedSkills: () => [] } as never),
    1,
  );
  assert.equal(
    skillLifecycleCommand([approved.name], { ...common, readLedger: completeUnion(rows(1, "merged", 1, "merged")) } as never),
    1,
  );
  assert.equal(stages, 0, "none of the refused inputs stages a lifecycle proposal");
  assert.ok(errors.some((text) => text.includes("incomplete ledger union")));
  assert.ok(errors.some((text) => text.includes("absent from the approved")));
  assert.ok(errors.some((text) => text.includes("below horizon")));
});

test("W1-T3413 stages one retire proposal", () => {
  const fixture = registryFixture();
  try {
    const first = stageSkillLifecycleRetirement(fixture.path, approved, report());
    const second = stageSkillLifecycleRetirement(fixture.path, approved, report());
    const proposals = loadProposalRegistry(fixture.path);
    assert.deepEqual({ staged: first.staged, refreshed: first.refreshed }, { staged: true, refreshed: false });
    assert.equal(second.alreadyStaged, true);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].id, `skill-lifecycle:${approved.name}`);
    assert.equal(proposals[0].skillLifecycle?.basis, "zero-selection");
    assert.match(proposals[0].summary, /removes exactly '.claude\/skills\/proven-procedure\/SKILL\.md'/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("W1-T3413 refreshes lifecycle evidence", () => {
  const fixture = registryFixture();
  try {
    const first = stageSkillLifecycleRetirement(fixture.path, approved, report());
    const firstFingerprint = loadProposalRegistry(fixture.path)[0].skillLifecycle?.evidenceFingerprint;
    const updatedReport = report({
      basis: "named-harm-signal",
      selected: { observed_eligible_runs: 10, terminal_runs: 10, merged_runs: 7, harmful_terminal_runs: 1, outcomes: { merged: 7, failed: 1, blocked: 2 } },
    });
    const second = stageSkillLifecycleRetirement(fixture.path, approved, updatedReport);
    const proposals = loadProposalRegistry(fixture.path);
    assert.equal(first.staged, true);
    assert.equal(second.refreshed, true);
    assert.equal(proposals.length, 1, "new evidence rewrites the one proposal instead of adding an ask");
    assert.equal(proposals[0].skillLifecycle?.basis, "named-harm-signal");
    assert.notEqual(proposals[0].skillLifecycle?.evidenceFingerprint, firstFingerprint);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("W1-T3413 approve owns precise removal", () => {
  const proposal: Proposal = {
    id: `skill-lifecycle:${approved.name}`,
    summary: "retire",
    evidenceAnchors: [],
    skillLifecycle: {
      kind: "retire",
      skillName: approved.name,
      evidenceFingerprint: "evidence-1",
      basis: "zero-selection",
      horizon: 10,
      selected: {},
      control: {},
    },
  };
  const deleted: string[] = [];
  const materialized = materializeApprovedSkillLifecycleRetirement(proposal, "/worktree", {
    loadApprovedSkills: () => [approved],
    existsSync: () => true,
    unlinkSync: (path) => deleted.push(String(path)),
  });
  assert.deepEqual(materialized, { ok: true, relPath: `.claude/skills/${approved.name}/SKILL.md` });
  assert.deepEqual(deleted, [`/worktree/.claude/skills/${approved.name}/SKILL.md`]);

  const rawDeleted: string[] = [];
  assert.equal(
    writeSkillLifecycleRetirement("/worktree", proposal, { existsSync: () => true, unlinkSync: (path) => rawDeleted.push(path) }, join),
    `.claude/skills/${approved.name}/SKILL.md`,
  );
  assert.deepEqual(rawDeleted, deleted);
});

test("W1-T3413 only rmd approve enters the lifecycle materializer", async () => {
  const fixture = registryFixture();
  const proposal: Proposal = {
    id: `skill-lifecycle:${approved.name}`,
    summary: "retire",
    evidenceAnchors: [],
    skillLifecycle: {
      kind: "retire",
      skillName: approved.name,
      evidenceFingerprint: "evidence-approve-route",
      basis: "zero-selection",
      horizon: 10,
      selected: {},
      control: {},
    },
  };
  try {
    const stateDir = join(fixture.dir, "state");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [proposal] }), "utf8");
    assert.equal(loadProposalRegistry(join(stateDir, "inbox-proposals.json"))[0]?.id, proposal.id);
    let routed: Proposal | undefined;
    const code = await approveCommand([proposal.id], {
      config: { root: fixture.dir } as never,
      approveLifecycleRetirement: async (candidate) => {
        routed = candidate;
        return 0;
      },
    });
    assert.equal(code, 0);
    assert.equal(routed?.id, proposal.id);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("W1-T3413 review stays read only", () => {
  let staged = 0;
  const writes: string[] = [];
  const code = skillLifecycleCommand([approved.name], {
    stateDir: "/unused",
    registryPath: "/unused/inbox-proposals.json",
    readLedger: completeUnion(rows(10, "merged", 10, "blocked")) as never,
    loadApprovedSkills: () => [approved],
    stageRetirement: () => { staged++; return { refused: false, staged: true, refreshed: false, alreadyStaged: false }; },
    write: (text) => writes.push(text),
    error: (text) => { throw new Error(text); },
  });
  assert.equal(code, 0);
  assert.equal(staged, 0);
  assert.ok(writes.some((text) => text.includes("REVIEW-CANDIDATE stays read-only")));
});

test("W1-T3413 mutation rejects arbitrary removal", () => {
  const arbitrary: Proposal = {
    id: "skill-lifecycle:unapproved",
    summary: "retire",
    evidenceAnchors: [],
    skillLifecycle: { kind: "retire", skillName: "unapproved", evidenceFingerprint: "evidence-2", basis: "zero-selection", horizon: 10, selected: {}, control: {} },
  };
  let writerCalled = false;
  const outcome = materializeApprovedSkillLifecycleRetirement(arbitrary, "/worktree", {
    loadApprovedSkills: () => [approved],
    writeRetirement: () => { writerCalled = true; return ".claude/skills/unapproved/SKILL.md"; },
  });
  assert.equal(outcome.ok, false);
  assert.equal(writerCalled, false, "removing the approved-tree check would make this mutation fail");
});

test("the effectiveness reducer still identifies a harmful cohort as RETIRE-CANDIDATE", () => {
  const harmful = buildSkillEffectivenessReport(rows(10, "failed", 10, "merged"), approved.name);
  assert.equal(harmful.status, "RETIRE-CANDIDATE");
  assert.equal(harmful.basis, "named-harm-signal");
});
