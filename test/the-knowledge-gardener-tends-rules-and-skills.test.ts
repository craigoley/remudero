/**
 * test/the-knowledge-gardener-tends-rules-and-skills.test.ts — W1-T4114.
 *
 * The knowledge gardener (W1-T4095/W1-T4110) inventoried doctrine, skills and guards but only ever
 * ACTED on learnings: `buildSkillEffectivenessReport`/`stageSkillLifecycleProposal` ran only by hand
 * (`rmd skill effectiveness`), `retro-closure.ts` only NAMED a guard's retirement streak, and skill
 * effectiveness was measured by SELECTION, never USE. This file proves:
 *
 *   - a worker's `SKILLS_USED` report is ledgered, the same shape `LEARNINGS_USED` already is;
 *   - a RULE-MERGE folds a near-duplicate doctrine rule with every id (old and canonical) still
 *     resolving, and nothing on disk is ever deleted;
 *   - SKILL-LIFECYCLE finds a candidate from `skills.used` (not selection) and stages it through the
 *     SAME `stageSkillLifecycleProposal` the manual command already uses;
 *   - GUARD-RETIREMENT reads the retro pipeline's own streak record and proposes retirement through
 *     the ratification inbox, idempotently;
 *   - REPAIR-REFERENCE rewrites an unambiguous dangling `Why:` pointer to its moved target.
 *
 * `startKnowledgeGardener(` in src/lib/daemon.ts is unchanged by this task — that acceptance claim
 * is a source grep, not a behaviour this file re-proves.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { outputContractLines } from "../src/lib/compaction.js";
import { parseSkillsUsed, type SkillsUsedResult } from "../src/lib/worker.js";
import { logSkillsUsed } from "../src/run-task.js";
import { loadProposalRegistry } from "../src/lib/inbox.js";
import { GUARD_RETIREMENT_ZERO_STREAK } from "../src/lib/retro-closure.js";
import { slugifyRuleId } from "../src/lib/doctrine-lifecycle.js";
import { buildKnowledgeInventory, danglingWhyPointers } from "../src/lib/knowledge-inventory.js";
import {
  applyRepairReferenceActions,
  applyRuleMergeActions,
  doctrineDuplicatePairs,
  gardenMarker,
  guardRetirementCandidates,
  guardRetirementProposalId,
  initialGardenerState,
  knowledgeGardenSpec,
  MERGED_RULES_FILE,
  planGardenPass,
  readSkillUsage,
  recordSkillUsage,
  repairReferenceCandidates,
  resolveMergedRuleId,
  skillLifecycleCandidates,
  skillUsagePath,
  stageGuardRetirementProposal,
  stageSkillLifecycleForAction,
} from "../src/lib/knowledge-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
}

// ── SKILLS_USED: the mirror of LEARNINGS_USED ──────────────────────────────────────────────────

test("W1-T4114: outputContractLines asks for an anchored SKILLS_USED report line, required (`none` is a valid, distinct answer)", () => {
  const lines = outputContractLines("W1-T4114").join("\n");
  assert.match(lines, /SKILLS_USED: skill#<name>/);
  assert.match(lines, /SKILLS_USED: none/);
  // PR_URL stays the contract's LAST line — SKILLS_USED must not have displaced it.
  const trimmed = outputContractLines("W1-T4114");
  assert.equal(trimmed[trimmed.length - 1], "- End with a REPORT whose LAST line is exactly: PR_URL: <the pull request url>");
});

test("W1-T4114: parseSkillsUsed ledgers an injected skill as used and refuses a never-injected one by name", () => {
  const text = ["REPORT", "did the work", "SKILLS_USED: skill#ci-state-forensics, skill#ghost-skill", "PR_URL: https://github.com/o/r/pull/1"].join("\n");
  const result = parseSkillsUsed(text, ["ci-state-forensics"]);
  assert.ok(result);
  assert.deepEqual((result as SkillsUsedResult).usedNames, ["ci-state-forensics"]);
  assert.deepEqual((result as SkillsUsedResult).refused, [{ name: "ghost-skill", reason: "never injected into this run" }]);
  assert.deepEqual((result as SkillsUsedResult).injectedNames, ["ci-state-forensics"]);
  // An explicit `none` is a valid, distinct claim from a silent report.
  assert.deepEqual(parseSkillsUsed("REPORT\nSKILLS_USED: none", ["a"]), { usedNames: [], refused: [], injectedNames: ["a"] });
  assert.equal(parseSkillsUsed("REPORT\nno anchored line here", ["a"]), null);
});

test("W1-T4114: a worker's SKILLS_USED report is ledgered", () => {
  const root = tmpRoot("w1t4114-skills-used-");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const usagePath = skillUsagePath(stateDir);
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const text = ["REPORT", "SKILLS_USED: skill#proof-preflight", "PR_URL: https://github.com/o/r/pull/1"].join("\n");
  logSkillsUsed((step, extra) => rows.push([step, extra]), text, ["proof-preflight", "ci-state-forensics"], usagePath);
  const row = rows.find(([s]) => s === "skills.used")?.[1];
  assert.deepEqual(row, { used_names: ["proof-preflight"], injected_names: ["proof-preflight", "ci-state-forensics"], refused: [] });
  const usage = readSkillUsage(usagePath);
  assert.deepEqual(usage, { "proof-preflight": { offered: 1, used: 1 }, "ci-state-forensics": { offered: 1, used: 0 } });
  // A silent report (no anchored line) is distinguishable from an explicit `none`: neither offered
  // nor used counts move, but the ledger row itself still says `silent: true`.
  logSkillsUsed((step, extra) => rows.push([step, extra]), "REPORT\nno skills line here", ["proof-preflight"], usagePath);
  const silentRow = rows.filter(([s]) => s === "skills.used").at(-1)?.[1];
  assert.deepEqual(silentRow, { silent: true, injected_names: ["proof-preflight"] });
  assert.deepEqual(readSkillUsage(usagePath), { "proof-preflight": { offered: 1, used: 1 }, "ci-state-forensics": { offered: 1, used: 0 } });
  // An explicit `none` DOES move the offered denominator, with zero used.
  recordSkillUsage(usagePath, { used_names: [], injected_names: ["proof-preflight"], refused: [] });
  assert.deepEqual(readSkillUsage(usagePath)["proof-preflight"], { offered: 2, used: 1 });
});

// ── RULE-MERGE: a near-duplicate doctrine rule, folded, every id still resolving ────────────────

function doctrineRoot(): string {
  const root = tmpRoot("w1t4114-doctrine-");
  mkdirSync(join(root, "doctrine", "s"), { recursive: true });
  const body =
    "Read the union of every rotation, because compaction prunes the live file and a live-only read undercounts badly.\n";
  writeFileSync(join(root, "doctrine", "s", "a.md"), `- **A rule about reading the ledger.** ${body}`);
  writeFileSync(join(root, "doctrine", "s", "b.md"), `- **A rule about reading ledgers.** ${body}`);
  return root;
}

test("W1-T4114: near-duplicate doctrine rules are merged with every id still resolving", () => {
  const root = doctrineRoot();
  const items = buildKnowledgeInventory(root);
  const pairs = doctrineDuplicatePairs(items);
  assert.equal(pairs.length, 1, "the two near-identical bodies form exactly one pair");
  const [newer, older] = pairs[0]!;
  assert.equal(newer.path, "doctrine/s/b.md");
  assert.equal(older.path, "doctrine/s/a.md");

  // Force RULE-MERGE to act, and only it, so the resulting plan is attributable.
  const plan = planGardenPass({
    items,
    usage: {},
    state: initialGardenerState(),
    rng: () => 0.99,
    switchedOff: (c) => c !== "rule-merge",
  });
  assert.deepEqual(plan.acting, ["rule-merge"]);
  const merge = plan.actions[0]!;
  assert.equal(merge.class, "rule-merge");
  const newerId = slugifyRuleId("A rule about reading ledgers.");
  const olderId = slugifyRuleId("A rule about reading the ledger.");
  assert.equal(merge.target, newerId);
  assert.equal(merge.into, olderId);

  const changed = applyRuleMergeActions(root, plan.actions);
  assert.deepEqual(changed, [MERGED_RULES_FILE, "doctrine/s/b.md"].sort());

  // Every id — the folded rule's own, and the canonical rule it folded into — still resolves, and
  // resolves to the SAME canonical id.
  assert.equal(resolveMergedRuleId(root, newerId), olderId);
  assert.equal(resolveMergedRuleId(root, olderId), olderId);
  // An id no merge ever touched resolves to itself.
  assert.equal(resolveMergedRuleId(root, "some-unrelated-rule"), "some-unrelated-rule");

  // Nothing is ever deleted: both bodies still exist, and the folded body still opens with its OWN
  // headline (test/the-doctrine-index-points-at-every-body.test.ts's invariant over the real corpus).
  assert.ok(existsSync(join(root, "doctrine", "s", "a.md")));
  const folded = readFileSync(join(root, "doctrine", "s", "b.md"), "utf8");
  assert.ok(folded.startsWith("- **A rule about reading ledgers.**"));
  assert.match(folded, new RegExp(`${gardenMarker(merge)}$`, "m"));

  // A second pass over the same pair changes nothing further (idempotent).
  assert.deepEqual(applyRuleMergeActions(root, plan.actions), [MERGED_RULES_FILE]);
});

// ── SKILL-LIFECYCLE: judged by skills.used, not skills.selection ────────────────────────────────

test("W1-T4114: skillLifecycleCandidates finds a skill workers rarely report using, compared with the corpus", () => {
  const usage = {
    "rarely-used-skill": { offered: 200, used: 1 },
    "often-used-skill": { offered: 50, used: 40 },
  };
  const names = skillLifecycleCandidates(usage, ["rarely-used-skill", "often-used-skill"], () => 0.5).map((a) => a.target);
  assert.deepEqual(names, ["rarely-used-skill"]);
  // Selection alone (no `skills.used` history at all) never manufactures a candidate.
  assert.deepEqual(skillLifecycleCandidates({}, ["a-skill"], () => 0.5), []);
});

test("W1-T4114: stageSkillLifecycleForAction is best-effort — an unreadable ledger stages nothing and never throws", () => {
  const root = tmpRoot("w1t4114-skill-stage-");
  assert.doesNotThrow(() => stageSkillLifecycleForAction(join(root, "state"), root, { class: "skill-lifecycle", target: "a-skill", reason: "r" }));
});

// ── GUARD-RETIREMENT: propose through the ratification inbox, operator review ───────────────────

test("W1-T4114: guardRetirementCandidates names only a guard at or past the retirement streak", () => {
  const below = GUARD_RETIREMENT_ZERO_STREAK - 1;
  const at = GUARD_RETIREMENT_ZERO_STREAK;
  const actions = guardRetirementCandidates({ "quiet-guard": at, "busy-guard": 0, "almost-quiet-guard": below });
  assert.deepEqual(actions.map((a) => a.target), ["quiet-guard"]);
  assert.match(actions[0]!.reason, new RegExp(`${at} consecutive`));
});

test("W1-T4114: a guard retirement candidate is staged as one reviewed inbox proposal, idempotently", () => {
  const root = tmpRoot("w1t4114-guard-");
  const registryPath = join(root, "inbox-proposals.json");
  const action = guardRetirementCandidates({ "quiet-guard": GUARD_RETIREMENT_ZERO_STREAK })[0]!;
  stageGuardRetirementProposal(registryPath, action);
  const staged = loadProposalRegistry(registryPath);
  assert.equal(staged.length, 1);
  assert.equal(staged[0]!.id, guardRetirementProposalId("quiet-guard"));
  assert.match(staged[0]!.summary, /Retire guard 'quiet-guard'/);
  // A second pass with the SAME streak stages nothing new.
  stageGuardRetirementProposal(registryPath, action);
  assert.equal(loadProposalRegistry(registryPath).length, 1);
  // A risen streak refreshes the SAME proposal id rather than minting a second one.
  const worse = guardRetirementCandidates({ "quiet-guard": GUARD_RETIREMENT_ZERO_STREAK + 5 })[0]!;
  stageGuardRetirementProposal(registryPath, worse);
  const refreshed = loadProposalRegistry(registryPath);
  assert.equal(refreshed.length, 1);
  assert.match(refreshed[0]!.summary, new RegExp(`${GUARD_RETIREMENT_ZERO_STREAK + 5} consecutive`));
});

// ── REPAIR-REFERENCE: a dangling Why: pointer rewritten to its moved target ─────────────────────

test("W1-T4114: an unambiguous dangling Why: pointer is rewritten to its moved target, and a second pass finds nothing left to repair", () => {
  const root = tmpRoot("w1t4114-repair-");
  // The page moved into a subdirectory, keeping its own basename — the shape a REPAIR-REFERENCE
  // pass can resolve unambiguously without knowing anything about WHY it moved.
  mkdirSync(join(root, "docs", "forensics", "archive"), { recursive: true });
  writeFileSync(join(root, "docs", "forensics", "archive", "moved.md"), "# moved\n");
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  writeFileSync(join(root, "src", "lib", "x.ts"), "// Why: docs/forensics/moved.md\nexport const x = 1;\n");

  const before = danglingWhyPointers(root);
  assert.deepEqual(before, [{ file: "src/lib/x.ts", line: 1, target: "docs/forensics/moved.md" }]);

  const actions = repairReferenceCandidates(root);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.to, "docs/forensics/archive/moved.md");
  assert.equal(actions[0]!.at, "src/lib/x.ts");

  const changed = applyRepairReferenceActions(root, actions);
  assert.deepEqual(changed, ["src/lib/x.ts"]);
  assert.deepEqual(danglingWhyPointers(root), [], "nothing dangling is left to repair");
  assert.deepEqual(repairReferenceCandidates(root), [], "a second pass proposes nothing further");
  // The pointer now names the MOVED page, read back through the scanner itself: remove that page
  // and the same line dangles again, at its new target, not its old one.
  rmSync(join(root, "docs", "forensics", "archive", "moved.md"));
  assert.deepEqual(danglingWhyPointers(root), [{ file: "src/lib/x.ts", line: 1, target: "docs/forensics/archive/moved.md" }]);
});

test("W1-T4114: an ambiguous or genuinely-gone dangling pointer is left alone", () => {
  const root = tmpRoot("w1t4114-repair-ambiguous-");
  mkdirSync(join(root, "docs", "forensics"), { recursive: true });
  mkdirSync(join(root, "src", "lib"), { recursive: true });
  // Genuinely gone: no same-named page exists anywhere.
  writeFileSync(join(root, "src", "lib", "gone.ts"), "// Why: docs/forensics/nowhere.md\nexport const g = 1;\n");
  assert.deepEqual(repairReferenceCandidates(root), []);
});

// ── every new store reads an unreadable file as no history — one assertion per catch arm ────────

test("W1-T4114: an unreadable skills-usage store, merged-rules registry or retro marker reads as no history", () => {
  const root = tmpRoot("w1t4114-unreadable-");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "doctrine"), { recursive: true });

  writeFileSync(skillUsagePath(stateDir), "{not json");
  assert.deepEqual(readSkillUsage(skillUsagePath(stateDir)), {});

  writeFileSync(join(root, MERGED_RULES_FILE), "{not json");
  assert.equal(resolveMergedRuleId(root, "some-rule"), "some-rule");

  const spec = knowledgeGardenSpec({
    repoRoot: root,
    stateDir,
    openWorkspace: () => {
      throw new Error("inventory must not open a workspace");
    },
    log: () => {},
  });
  writeFileSync(join(stateDir, "last-retro.json"), JSON.stringify({ guard_zero_streak: { "quiet-guard": GUARD_RETIREMENT_ZERO_STREAK } }));
  assert.deepEqual(spec.inventory().guardZeroStreak, { "quiet-guard": GUARD_RETIREMENT_ZERO_STREAK });
  writeFileSync(join(stateDir, "last-retro.json"), "{not json");
  assert.deepEqual(spec.inventory().guardZeroStreak, {});
});
