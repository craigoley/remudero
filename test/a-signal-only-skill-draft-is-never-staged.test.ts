import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { classifyProposal, ledgerProposalVerdicts, loadProposalRegistry, type ReadinessContext } from "#src/lib/inbox.js";
import { appendLedger, ledgerRotationLockPath, tryAcquireRotationLock } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import {
  PROCEDURAL_STEP_TEXT,
  renderSkillDraft,
  skillDraftProposalId,
  stageSkillDraft,
  stageSkillDrafts,
  workerAllowlistFromCapabilityContext,
  workerAllowlistFromSettings,
  type SkillDraft,
} from "#src/lib/skill-workshop.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const reachability = () => ({ reachable: false, reason: "unapproved proposals are not injected" });
const allowlist = workerAllowlistFromSettings(undefined);
const missingContext = workerAllowlistFromCapabilityContext(undefined, undefined);
const clock = { iso: () => "2026-11-19T10:00:00.000Z" };

/** W1-T13857: run-a and run-b (two tasks) both ran the type check and then changed a lib file. */
const MINED = {
  runs: ["run-a", "run-b"].map((runId, i) => ({ runId, taskId: `W1-T${i + 1}`, type: "implement", verdict: "merged" })),
  records: ["run-a", "run-b"].flatMap((runId) => ["Bash:npm run typecheck", "Edit:src/lib/plan.ts"].map((tool_signature) =>
    ({ run_id: runId, step: "worker.activity", event_kind: "tool-executing", tool_name: tool_signature.split(":")[0], tool_signature }))),
};

/** The draft the workshop renders now: the recurring commands of run-a and run-b. */
function minedDraft(): SkillDraft {
  const draft = renderSkillDraft({
    shapeKey: "implement:fully_executed_proof",
    taskType: "implement",
    signals: ["fully_executed_proof"],
    runIds: ["run-a", "run-b"],
    taskIds: ["W1-T1", "W1-T2"],
    supportingRuns: 2,
  }, MINED);
  assert.ok(draft, "a two-run candidate renders a draft");
  return draft;
}

/** The one-line draft the Azure host holds for four procedures: only the fully_executed_proof line. */
function signalOnlyDraft(): SkillDraft {
  const draft = minedDraft();
  return { ...draft, markdown: draft.markdown.replace(/## Procedure\n[\s\S]*?(?=## Evidence)/, `## Procedure\n\n- ${PROCEDURAL_STEP_TEXT.fully_executed_proof}\n\n`) };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}signal-only-skill-draft-`));
  const registryPath = join(root, "state", "inbox-proposals.json");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: "RETRO-1", task_id: "RETRO", step, lane: "retro", ...extra });
  const rows = () => (existsSync(ledgerPath) ? [...readLedgerLines(ledgerPath)] : []);
  return { root, registryPath, ledgerPath, log, rows, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** Seed the registry with a staged entry holding `markdown`, as the 2026-10-14 pass left it. */
function seedStaged(registryPath: string, draft: SkillDraft): string {
  const id = skillDraftProposalId(draft.procedureKey);
  writeFileSync(registryPath, JSON.stringify({ proposals: [{ id, summary: draft.markdown, evidenceAnchors: [],
    skillFile: { name: draft.name, markdown: draft.markdown }, skillFileStagedAt: "2026-10-14T00:00:00.000Z" }] }));
  return id;
}

function declines(rows: Array<Record<string, unknown>>, id: string) {
  return rows.filter((r) => r.step === "panel.proposal_declined" && r.task_id === id);
}

function treeOf(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${relative(dir, p)}:${readFileSync(p, "utf8")}`);
    }
  };
  walk(dir);
  return out;
}

test("W1-T13858 criterion 1: a draft whose every step is a signal-table line is refused as outcome-only and the registry is not written", () => {
  const f = fixture();
  try {
    const oneLine = signalOnlyDraft();
    const r = stageSkillDraft(f.registryPath, oneLine, allowlist, reachability(), {}, clock);
    assert.equal(r.refused, true);
    assert.equal(r.staged, false);
    assert.match(r.reason ?? "", /^outcome-only:/);
    assert.equal(existsSync(f.registryPath), false, "a refusal never writes the registry");

    assert.equal(missingContext.contextRefusal, "worker-capability-context:missing");
    const withMissingContext = stageSkillDraft(f.registryPath, oneLine, missingContext, reachability(), {}, clock);
    assert.equal(withMissingContext.refused, true);
    assert.equal(withMissingContext.staged, false);
    assert.match(withMissingContext.reason ?? "", /^outcome-only:.*worker-capability-context:missing.*<worker-capability-context>/);
    assert.equal(existsSync(f.registryPath), false);

    const both = { ...oneLine, markdown: oneLine.markdown.replace(`- ${PROCEDURAL_STEP_TEXT.fully_executed_proof}`,
      `- ${PROCEDURAL_STEP_TEXT.fully_executed_proof}\n- ${PROCEDURAL_STEP_TEXT.clean_single_strike}`) };
    const r2 = stageSkillDraft(f.registryPath, both, allowlist, reachability(), {}, clock);
    assert.equal(r2.refused, true);
    assert.match(r2.reason ?? "", /^outcome-only:/);
    assert.equal(existsSync(f.registryPath), false);
  } finally { f.done(); }
});

test("W1-T13858 criterion 2: a draft with the fully_executed_proof line and a transcript-mined step still stages", () => {
  const f = fixture();
  try {
    const draft = minedDraft();
    const proofAction = "- Run `./bin/rmd check-acceptance <body file>` to check the proof declarations.";
    const mixed = { ...draft, markdown: draft.markdown.replace("## Procedure\n\n",
      `## Procedure\n\n${proofAction} ${PROCEDURAL_STEP_TEXT.fully_executed_proof}\n`) };
    const r = stageSkillDraft(f.registryPath, mixed, allowlist, reachability(), {}, clock);
    assert.equal(r.refused, false, r.reason);
    assert.equal(r.staged, true);
    const entry = loadProposalRegistry(f.registryPath).find((p) => p.id === skillDraftProposalId(draft.procedureKey));
    assert.ok(entry?.skillFile?.markdown.includes("- Run `npm run typecheck`."), "the mined command is the staged step");
    assert.ok(entry?.skillFile?.markdown.includes(proofAction));
    assert.ok(entry?.skillFile?.markdown.includes(PROCEDURAL_STEP_TEXT.fully_executed_proof), "the staged action retains the signal text");
  } finally { f.done(); }
});

test("W1-T13858 criterion 3: a staged draft the scan now refuses closes once with a withdrawn decline from skill-workshop", () => {
  const f = fixture();
  try {
    const draft = signalOnlyDraft();
    const id = seedStaged(f.registryPath, draft);
    stageSkillDrafts(f.registryPath, [draft], allowlist, reachability, f.log);
    const first = declines(f.rows(), id);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.origin, "skill-workshop");
    assert.match(String(first[0]!.reason), /^withdrawn: outcome-only:/);
    const entry = loadProposalRegistry(f.registryPath).find((p) => p.id === id);
    assert.ok(entry, "the closed entry stays in the registry");
    assert.match(entry.skillDraftClose?.reason ?? "", /^withdrawn:/);
    const verdicts = ledgerProposalVerdicts(f.rows());
    const ctx = { isRatified: verdicts.isRatified, isDeclined: verdicts.isDeclined } as unknown as ReadinessContext;
    assert.equal(classifyProposal(entry, undefined, ctx).state, "declined");

    stageSkillDrafts(f.registryPath, [draft], allowlist, reachability, f.log);
    assert.equal(declines(f.rows(), id).length, 1, "a second pass writes no second decline row");
  } finally { f.done(); }
});

test("W1-T13858 criterion 4: an unchanged staged draft and a refusal with nothing to close write no skill.staged row", () => {
  const f = fixture();
  try {
    const good = minedDraft();
    stageSkillDrafts(f.registryPath, [good], allowlist, reachability, f.log);
    const staged = f.rows().filter((r) => r.step === "skill.staged");
    assert.equal(staged.length, 1, "a pass that stages still writes its row");
    assert.equal(staged[0]!.staged, true);

    const bytes = readFileSync(f.registryPath);
    const mtime = statSync(f.registryPath).mtimeMs;
    stageSkillDrafts(f.registryPath, [good], allowlist, reachability, f.log);
    assert.equal(f.rows().filter((r) => r.step === "skill.staged").length, 1, "an already-staged, unchanged pass writes no row");
    assert.deepEqual(readFileSync(f.registryPath), bytes);
    assert.equal(statSync(f.registryPath).mtimeMs, mtime, "the registry is not written");

    const other = { ...signalOnlyDraft(), procedureKey: "never-staged-procedure" };
    stageSkillDrafts(f.registryPath, [other], allowlist, reachability, f.log);
    assert.equal(f.rows().length, 1, "a refusal with no staged proposal to close writes no row");
  } finally { f.done(); }
});

test("W1-T13858 criterion 4: a pass that stamps an unstamped entry still writes its skill.staged row", () => {
  const f = fixture();
  try {
    const good = minedDraft();
    writeFileSync(f.registryPath, JSON.stringify({ proposals: [{ id: skillDraftProposalId(good.procedureKey), summary: "s", evidenceAnchors: [],
      skillFile: { name: good.name, markdown: good.markdown } }] }));
    stageSkillDrafts(f.registryPath, [good], allowlist, reachability, f.log);
    const staged = f.rows().filter((r) => r.step === "skill.staged");
    assert.equal(staged.length, 1);
    assert.equal(staged[0]!.reason, "already staged; staged-at stamp added");
  } finally { f.done(); }
});

test("W1-T13858 criterion 5: an operator restore after a workshop close is not undone while the stored text is the same", () => {
  const f = fixture();
  try {
    const draft = signalOnlyDraft();
    const id = seedStaged(f.registryPath, draft);
    stageSkillDrafts(f.registryPath, [draft], allowlist, reachability, f.log);
    assert.equal(declines(f.rows(), id).length, 1);
    appendLedger(f.ledgerPath, { run_id: "PANEL-1", task_id: id, step: "panel.proposal_restored", origin: "rmd-cli", reason: "keep it" });
    stageSkillDrafts(f.registryPath, [draft], allowlist, reachability, f.log);
    stageSkillDrafts(f.registryPath, [draft], allowlist, reachability, f.log);
    assert.equal(declines(f.rows(), id).length, 1, "no second close");
    assert.equal(ledgerProposalVerdicts(f.rows()).isDeclined(id), undefined, "the restored draft stays open");
  } finally { f.done(); }
});

test("W1-T13858 criterion 6: invariant:approve-only-writes-skills a close writes nothing under .claude/skills", () => {
  const f = fixture();
  try {
    const skills = join(f.root, ".claude", "skills");
    mkdirSync(join(skills, "existing"), { recursive: true });
    writeFileSync(join(skills, "existing", "SKILL.md"), "---\nname: existing\n---\n");
    const before = treeOf(join(f.root, ".claude"));
    const draft = signalOnlyDraft();
    const id = seedStaged(f.registryPath, draft);
    stageSkillDrafts(f.registryPath, [draft], allowlist, reachability, f.log);
    assert.equal(declines(f.rows(), id).length, 1, "the pass did close the draft");
    assert.deepEqual(treeOf(join(f.root, ".claude")), before);
  } finally { f.done(); }
});

test("W1-T13858 criterion 3: a production capability-context refusal closes matching staged text once", () => {
  const f = fixture();
  try {
    const good = minedDraft();
    const stored = { ...good, markdown: `${good.markdown}\n- [src: run#run-c]` };
    const id = seedStaged(f.registryPath, stored);
    const reason = 'withdrawn: worker-capability-context:missing (offending line: "<worker-capability-context>")';
    stageSkillDrafts(f.registryPath, [good], missingContext, reachability, f.log);
    const rows = f.rows();
    const [decline] = declines(rows, id);
    assert.deepEqual(rows.map((row) => row.step), ["panel.proposal_declined", "skill.staged"]);
    assert.equal(decline?.origin, "skill-workshop");
    assert.equal(decline?.reason, reason);
    const entry = loadProposalRegistry(f.registryPath).find((p) => p.id === id);
    assert.ok(entry);
    assert.equal(entry.skillDraftClose?.reason, reason);
    assert.equal(entry.skillDraftClose?.at, decline?.ts);
    assert.equal(entry.skillDraftClose?.skillSha256, createHash("sha256").update(stored.markdown).digest("hex"));
    const { isRatified, isDeclined } = ledgerProposalVerdicts(rows);
    assert.equal(classifyProposal(entry, undefined, { isRatified, isDeclined } as ReadinessContext).state, "declined");
    stageSkillDrafts(f.registryPath, [good], missingContext, reachability, f.log);
    assert.deepEqual(f.rows(), rows);
  } finally { f.done(); }
});

test("W1-T13858 criterion 3: an unterminated decline cannot close a draft and the next pass can retry", () => {
  const f = fixture();
  try {
    const draft = signalOnlyDraft();
    const id = seedStaged(f.registryPath, draft);
    const before = readFileSync(f.registryPath, "utf8");
    stageSkillDrafts(f.registryPath, [draft], allowlist, reachability, (step, extra) => {
      if (step === "panel.proposal_declined") {
        appendFileSync(f.ledgerPath, JSON.stringify({ step, ...extra }));
      } else {
        f.log(step, extra);
      }
    });

    assert.equal(readFileSync(f.registryPath, "utf8"), before);
    assert.deepEqual(f.rows(), [], "the short decline and the next append did not form a readable row");
    stageSkillDrafts(f.registryPath, [draft], allowlist, reachability, f.log);
    const rows = f.rows();
    assert.deepEqual(rows.map((row) => row.step), ["panel.proposal_declined", "skill.staged"]);
    assert.equal(declines(rows, id).length, 1);
    assert.match(loadProposalRegistry(f.registryPath).find((p) => p.id === id)?.skillDraftClose?.reason ?? "", /^withdrawn:/);
  } finally { f.done(); }
});

test("the legacy withdrawal retries after the verdict ledger can be read safely", () => {
  const f = fixture();
  try {
    stageSkillDrafts(f.root, [], allowlist, reachability, f.log);
    assert.match(String(f.rows().at(-1)?.error), /EISDIR/);

    const id = seedStaged(f.registryPath, signalOnlyDraft());
    const stage = () => stageSkillDrafts(f.registryPath, [], allowlist, reachability, f.log);
    const unlock = tryAcquireRotationLock(ledgerRotationLockPath(f.ledgerPath));
    assert.ok(unlock);
    try {
      stage();
      assert.match(String(f.rows().at(-1)?.error), /the ledger is being rotated or compacted/);
      assert.equal(loadProposalRegistry(f.registryPath)[0]?.skillDraftClose, undefined);
    } finally {
      unlock();
    }

    const readable = readFileSync(f.ledgerPath);
    appendFileSync(f.ledgerPath, `{"step":"ratify.approved","task_id":"${id}",\n`);
    stage();
    assert.match(String(f.rows().at(-1)?.error), /could not verify the ledger verdict/);
    assert.equal(loadProposalRegistry(f.registryPath)[0]?.skillDraftClose, undefined);

    writeFileSync(f.ledgerPath, readable);
    stage();
    assert.equal(declines(f.rows(), id).length, 1);
    assert.match(loadProposalRegistry(f.registryPath)[0]?.skillDraftClose?.reason ?? "", /^withdrawn: outcome-only:/);
  } finally { f.done(); }
});
