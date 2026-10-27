import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProposalRegistry, type Proposal } from "#src/lib/inbox.js";
import { stageSkillLifecycleForAction } from "#src/lib/knowledge-gardener.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import {
  buildSkillEffectivenessReport,
  recheckSkillRetirement,
  SKILL_EFFECTIVENESS_LEDGER_STEPS,
  skillLifecycleProposalId,
  stageSkillLifecycleProposal,
} from "#src/lib/skill-workshop.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { approveCommand, skillLifecycleCommand } from "#src/run-task.js";

// A retirement proposal carries the evidence as it stood when it was staged. Approval deleted the skill on that
// proposal alone, and staging never removed one the ledger had since turned against. Approval now re-judges the
// evidence from a complete ledger read, and a refused report withdraws the staged proposal.

type Row = Record<string, unknown>;

const SKILL = "procedure";
const PROPOSAL_ID = skillLifecycleProposalId(SKILL);
const ACTION = {
  kind: "skill-retirement" as const,
  skillName: SKILL,
  skillPath: `.claude/skills/${SKILL}/SKILL.md`,
  evidenceFingerprint: "fp-staged",
};
/** A rotation that cannot be decompressed: a complete read refuses it, so the union is incomplete. */
const CORRUPT_ROTATION = "ledger.2026-10-01T00-00-00-000Z.ndjson.gz";

const runRows = (arm: "selected" | "control", verdicts: readonly string[]): Row[] =>
  verdicts.flatMap((verdict, i) => {
    const runId = `${arm}-${i}`;
    const selected = arm === "selected";
    return [
      {
        ts: "2026-10-20T10:00:00.000Z", run_id: runId, step: "skills.selection", task_type: "implement",
        approved_eligible_names: [SKILL], selected_names: selected ? [SKILL] : [], budget_omitted_names: [],
        withheld_names: selected ? [] : [SKILL],
      },
      { ts: "2026-10-20T10:30:00.000Z", run_id: runId, step: "verdict", verdict },
    ];
  });

/** Zero selection at the horizon: a retirement the evidence supports. */
const QUALIFYING = runRows("control", Array<string>(10).fill("no_diff"));
/** The selected arm merges far more often than the control: a review candidate, not a retirement. */
const FAVORABLE = [
  ...runRows("selected", [...Array<string>(8).fill("merged"), ...Array<string>(2).fill("no_diff")]),
  ...runRows("control", [...Array<string>(3).fill("merged"), ...Array<string>(7).fill("no_diff")]),
];

const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));

function approveSkill(skillsDir: string): void {
  mkdirSync(join(skillsDir, SKILL), { recursive: true });
  writeFileSync(
    join(skillsDir, SKILL, "SKILL.md"),
    ["---", `name: ${SKILL}`, "applies-to: implement", "---", "", "## Procedure", "", "- Do the thing."].join("\n"),
    "utf8",
  );
}

function writeLedger(stateDir: string, rows: readonly Row[]): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "ledger.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function stageRetirement(registryPath: string): void {
  const proposal: Proposal = { id: PROPOSAL_ID, summary: "retire procedure", evidenceAnchors: [], lifecycleAction: ACTION };
  mkdirSync(join(registryPath, ".."), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ proposals: [proposal] }, null, 2), "utf8");
}

const ledgerSteps = (stateDir: string): Row[] =>
  readFileSync(join(stateDir, "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row)
    .filter((row) => typeof row.step === "string" && /^(ratify|approve)\./.test(row.step));

test("a staged retirement the fresh evidence no longer supports is withdrawn at staging", () => {
  const root = tmp("stale-retirement-stage-");
  try {
    const skillsDir = join(root, "skills");
    const registryPath = join(root, "inbox-proposals.json");
    approveSkill(skillsDir);
    const staged = stageSkillLifecycleProposal(registryPath, skillsDir, buildSkillEffectivenessReport(QUALIFYING, SKILL));
    assert.equal(staged.staged, true);
    assert.equal(staged.withdrawn, false);
    assert.equal(loadProposalRegistry(registryPath).length, 1);

    const turned = stageSkillLifecycleProposal(registryPath, skillsDir, buildSkillEffectivenessReport(FAVORABLE, SKILL));
    assert.equal(turned.refused, true);
    assert.equal(turned.withdrawn, true);
    assert.deepEqual(loadProposalRegistry(registryPath), []);

    // Nothing left to withdraw: refused again, and the registry is not rewritten.
    const before = readFileSync(registryPath, "utf8");
    const again = stageSkillLifecycleProposal(registryPath, skillsDir, buildSkillEffectivenessReport(FAVORABLE, SKILL));
    assert.equal(again.withdrawn, false);
    assert.equal(readFileSync(registryPath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approval refuses and withdraws a staged retirement whose evidence no longer qualifies", async () => {
  const root = tmp("stale-retirement-approve-");
  try {
    const stateDir = join(root, "state");
    const registryPath = join(stateDir, "inbox-proposals.json");
    writeLedger(stateDir, FAVORABLE);
    stageRetirement(registryPath);

    const code = await approveCommand([PROPOSAL_ID], { config: { claudeBin: "/usr/bin/true", root } as never });

    assert.equal(code, 1);
    const rows = ledgerSteps(stateDir);
    assert.deepEqual(rows.map((row) => row.step), ["ratify.approve_refused"], "refused before any branch or PR");
    assert.equal(rows[0]!.state, "evidence_stale");
    assert.equal(rows[0]!.withdrawn, true);
    assert.match(String(rows[0]!.reason), /no longer supports retiring 'procedure': REVIEW-CANDIDATE \(favorable-comparison\)/);
    assert.deepEqual(loadProposalRegistry(registryPath), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approval refuses an unreadable ledger and keeps the staged retirement", async () => {
  const root = tmp("stale-retirement-unverifiable-");
  try {
    const stateDir = join(root, "state");
    const registryPath = join(stateDir, "inbox-proposals.json");
    writeLedger(stateDir, QUALIFYING);
    writeFileSync(join(stateDir, CORRUPT_ROTATION), "not gzip", "utf8");
    stageRetirement(registryPath);
    // Positive control: the corrupt rotation really makes a complete read refuse.
    assert.equal(readLedgerUnionRecordsSync(stateDir, { step: SKILL_EFFECTIVENESS_LEDGER_STEPS, refuseIncomplete: true }).ok, false);

    const code = await approveCommand([PROPOSAL_ID], { config: { claudeBin: "/usr/bin/true", root } as never });

    assert.equal(code, 1);
    const rows = ledgerSteps(stateDir);
    assert.deepEqual(rows.map((row) => row.step), ["ratify.approve_refused"]);
    assert.equal(rows[0]!.state, "evidence_unverifiable");
    assert.equal(rows[0]!.withdrawn, false);
    assert.match(String(rows[0]!.reason), /incomplete ledger union .*1 unread rotation/);
    assert.equal(loadProposalRegistry(registryPath).length, 1, "an unverifiable read is not evidence of staleness");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retirement recheck names an unreadable ledger as unverifiable, never as a pass", () => {
  const thrown = recheckSkillRetirement("/state", ACTION, () => {
    throw new Error("EACCES: permission denied");
  });
  assert.equal(thrown.verdict, "unverifiable");
  assert.match(thrown.verdict === "unverifiable" ? thrown.reason : "", /unreadable ledger union under \/state: Error: EACCES/);

  const root = tmp("stale-retirement-recheck-");
  try {
    writeLedger(join(root, "state"), QUALIFYING);
    assert.deepEqual(recheckSkillRetirement(join(root, "state"), ACTION), { verdict: "qualifies" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the gardener withdraws a stale staged retirement only from a complete ledger read", () => {
  const root = tmp("stale-retirement-gardener-");
  try {
    const stateDir = join(root, "state");
    const registryPath = join(stateDir, "inbox-proposals.json");
    approveSkill(join(root, ".claude", "skills"));
    writeLedger(stateDir, FAVORABLE);
    stageRetirement(registryPath);
    const action = { class: "skill-lifecycle" as const, target: SKILL, reason: "rarely used" };

    writeFileSync(join(stateDir, CORRUPT_ROTATION), "not gzip", "utf8");
    stageSkillLifecycleForAction(stateDir, root, action);
    assert.equal(loadProposalRegistry(registryPath).length, 1, "a partial ledger is not evidence either way");

    rmSync(join(stateDir, CORRUPT_ROTATION));
    stageSkillLifecycleForAction(stateDir, root, action);
    assert.deepEqual(loadProposalRegistry(registryPath), [], "the same pass over a complete read withdraws it");
    assert.equal(existsSync(join(root, ".claude", "skills", SKILL, "SKILL.md")), true, "withdrawal deletes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rmd skill lifecycle reports the stale staged retirement it withdrew", () => {
  const root = tmp("stale-retirement-cli-");
  try {
    const stateDir = join(root, "state");
    const registryPath = join(stateDir, "inbox-proposals.json");
    const skillsDir = join(root, "skills");
    approveSkill(skillsDir);
    writeLedger(stateDir, FAVORABLE);
    stageRetirement(registryPath);
    const errors: string[] = [];

    const code = skillLifecycleCommand([SKILL], {
      stateDir, registryPath, approvedSkillsDir: skillsDir, write: () => {}, error: (text) => errors.push(text),
    });

    assert.equal(code, 0, "a review candidate is not a failure");
    assert.match(errors.join("\n"), /REFUSED REVIEW-CANDIDATE is read-only.*; withdrew the stale staged retirement from the inbox/);
    assert.deepEqual(loadProposalRegistry(registryPath), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
