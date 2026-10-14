import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProposalRegistry } from "../src/lib/inbox.js";
import { skillDraftProposalId, stageSkillDraft, workerAllowlistFromSettings, type SkillDraft } from "../src/lib/skill-workshop.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const now = "2026-10-13T14:04:00.000Z";
const reachability = { reachable: false, reason: "unapproved proposals are not injected" };
const markdown = (first: string, second: string) => `---\nname: legacy-proc\napplies-to: implement\n---\n\n## Procedure\n- ${first}\n- ${second}\n`;
const draft: SkillDraft = { name: "legacy-proc", description: "a bounded procedure", candidateHash: "candidate", procedureKey: "same-procedure", supportingRuns: 2,
  markdown: markdown("Inspect the current inputs.", "Verify the bounded result.") };

function fixture(text: string, stamp?: string) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}legacy-skill-stamp-`));
  const path = join(root, "registry.json");
  writeFileSync(path, JSON.stringify({ proposals: [{ id: skillDraftProposalId(draft.procedureKey), summary: "legacy", evidenceAnchors: [],
    skillFile: { name: draft.name, markdown: text }, ...(stamp === undefined ? {} : { skillFileStagedAt: stamp }) }] }));
  return { root, path };
}

test("legacy skill stamp binds equal-step replacement to the exact scanned text", () => {
  const f = fixture(markdown("Compare the earlier inputs.", "Record the earlier result."));
  try {
    const result = stageSkillDraft(f.path, draft, workerAllowlistFromSettings(undefined), reachability, {}, { iso: () => now });
    assert.equal(result.refused, false);
    assert.equal(result.legacyReplaced, true);
    assert.equal(result.refreshed, true);
    assert.equal(result.stamped, undefined);
    assert.match(result.reason ?? "", /legacy text replaced.*before stamping/);
    const proposal = loadProposalRegistry(f.path)[0]!;
    assert.equal(proposal.skillFile?.markdown, draft.markdown);
    assert.equal(proposal.skillFileStagedAt, now);
    assert.equal(proposal.skillEval, undefined, "staging fabricates no evaluation");
    assert.equal(existsSync(join(f.root, ".claude")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy skill stamping keeps an identical scanned payload and a repeat cannot move its clock", () => {
  const f = fixture(draft.markdown);
  try {
    const first = stageSkillDraft(f.path, draft, workerAllowlistFromSettings(undefined), reachability, {}, { iso: () => now });
    assert.equal(first.stamped, true);
    assert.equal(first.legacyReplaced, undefined);
    const bytes = readFileSync(f.path);
    const second = stageSkillDraft(f.path, draft, workerAllowlistFromSettings(undefined), reachability, {}, { iso: () => "2026-11-01T00:00:00Z" });
    assert.equal(second.alreadyStaged, true);
    assert.deepEqual(readFileSync(f.path), bytes);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy skill stamping refuses an unscanned incoming payload without changing the legacy file", () => {
  const f = fixture(draft.markdown);
  try {
    const bytes = readFileSync(f.path);
    const result = stageSkillDraft(f.path, { ...draft, markdown: markdown("Visit https://forbidden.invalid now.", "Verify the result.") },
      workerAllowlistFromSettings(undefined), reachability, {}, { iso: () => now });
    assert.equal(result.refused, true);
    assert.deepEqual(readFileSync(f.path), bytes);
    assert.equal(loadProposalRegistry(f.path)[0]?.skillFileStagedAt, undefined);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a previously stamped equal-step draft keeps its frozen text and original stamp", () => {
  const old = markdown("Compare the earlier inputs.", "Record the earlier result.");
  const f = fixture(old, "2026-09-01T00:00:00Z");
  try {
    const bytes = readFileSync(f.path);
    const result = stageSkillDraft(f.path, draft, workerAllowlistFromSettings(undefined), reachability, {}, { iso: () => now });
    assert.equal(result.alreadyStaged, true);
    assert.equal(result.legacyReplaced, undefined);
    assert.deepEqual(readFileSync(f.path), bytes);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
