/**
 * test/a-retracted-fact-is-pulled-from-what-cites-it.test.ts — W1-T4682.
 *
 * `src/lib/learnings.ts` already gives a learning a lifecycle (`active` / `superseded` /
 * `quarantined` / `contested`) and a reverted-source-PR recall, but nothing ever read that back OUT
 * of the artifacts that CITE a learning, a run or a PR — an approved skill's own `## Evidence`
 * (skill-workshop.ts's `renderSkillDraft`) or a doctrine rule body. A fact retracted upstream kept
 * being repeated downstream as if it still held, exactly the gap Hindsight's retractions.py closes
 * for its own corpus. This file proves the gardener's new STALE-CITATION class:
 *
 *   - reads the SAME `[src: <kind>#<id>]` token provenance.ts's CONTEXT linter already enforces on
 *     a rendered prompt, off the artifact itself;
 *   - flags a citation whose learning is superseded/quarantined/contested, or whose run/PR was
 *     reverted, and stages ONE reviewed inbox proposal per stale citation — never a silent rewrite,
 *     since there is no single correct replacement text;
 *   - leaves an artifact whose citations are all still live with nothing staged at all;
 *   - is idempotent: an unchanged status stages nothing new, and a changed one refreshes the SAME
 *     proposal id rather than minting a second one.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadProposalRegistry } from "../src/lib/inbox.js";
import type { KnowledgeItem } from "../src/lib/knowledge-inventory.js";
import {
  citationStatus,
  CITATION_TOKEN_RE,
  evidenceCitations,
  staleCitationCandidates,
  staleCitationProposalId,
  stageStaleCitationProposal,
  type Citation,
} from "../src/lib/knowledge-gardener.js";
import type { InjectableSkill } from "../src/lib/skill-workshop.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
}

function skill(name: string, body: string): InjectableSkill {
  return { name, appliesTo: ["implement"], body };
}

function learningItem(id: string, lifecycle: string): KnowledgeItem {
  return { id: `learnings#${id}`, kind: "learning", path: "learnings", bytes: 0, text: id, lifecycle };
}

// ── parsing: the SAME `[src: …]` token provenance.ts's CONTEXT linter already enforces ──────────

test("W1-T4682: evidenceCitations reads every [src: learnings#|run#|PR#] token in an artifact's own text", () => {
  const text = [
    "## Evidence",
    "",
    "- [src: run#W1-T4429-1790239902874]",
    "- [src: learnings#sdk-result-envelope]",
    "- [src: PR#7220]",
    "- Filed under: W1-T4429",
  ].join("\n");
  assert.deepEqual(evidenceCitations(text), [
    { kind: "run", id: "W1-T4429-1790239902874" },
    { kind: "learnings", id: "sdk-result-envelope" },
    { kind: "PR", id: "7220" },
  ]);
  // A body with no citation at all reads as no citations, not an error.
  assert.deepEqual(evidenceCitations("## Procedure\n\n- Do the thing.\n"), []);
});

test("W1-T4682: CITATION_TOKEN_RE itself rejects plain prose and matches a real [src: …] token", () => {
  // Both arms, directly on the real pattern `evidenceCitations` runs — negative-reachability-
  // ratchet.test.ts's own fixture-less bar (a global regex, so lastIndex is reset before each use).
  CITATION_TOKEN_RE.lastIndex = 0;
  assert.equal(CITATION_TOKEN_RE.test("Filed under: W1-T4429, no bracketed source here"), false);
  CITATION_TOKEN_RE.lastIndex = 0;
  assert.equal(CITATION_TOKEN_RE.test("- [src: run#W1-T4429-1790239902874]"), true);
  // Leave the shared module singleton's state clean: `evidenceCitations` (below) drives the SAME
  // regex through `matchAll`, which copies `lastIndex` at call time.
  CITATION_TOKEN_RE.lastIndex = 0;
});

test("W1-T4682: citationStatus flags a superseded/quarantined/contested learning or a reverted run/PR, and nothing else", () => {
  const lifecycle = new Map([
    ["active-one", "active"],
    ["superseded-one", "superseded"],
    ["quarantined-one", "quarantined"],
    ["contested-one", "contested"],
  ]);
  const runs = new Set(["reverted-run"]);
  const prs = new Set([42]);
  const check = (c: Citation) => citationStatus(c, lifecycle, runs, prs);
  assert.equal(check({ kind: "learnings", id: "active-one" }), undefined);
  assert.equal(check({ kind: "learnings", id: "superseded-one" }), "superseded");
  assert.equal(check({ kind: "learnings", id: "quarantined-one" }), "quarantined");
  assert.equal(check({ kind: "learnings", id: "contested-one" }), "contested");
  // An id this function has no evidence about is never flagged — unknown is not stale.
  assert.equal(check({ kind: "learnings", id: "never-heard-of-it" }), undefined);
  assert.equal(check({ kind: "run", id: "reverted-run" }), "reverted");
  assert.equal(check({ kind: "run", id: "live-run" }), undefined);
  assert.equal(check({ kind: "PR", id: "42" }), "reverted");
  assert.equal(check({ kind: "PR", id: "43" }), undefined);
});

// ── the two acceptance behaviours ────────────────────────────────────────────────────────────────

test("W1-T4682: a skill citing a reverted run gets a repair proposal", () => {
  const approvedSkills = [
    skill(
      "implement-clean-single-strike-8aa4458e",
      ["## Procedure", "", "- Resolve the task on the first attempt.", "", "## Evidence", "", "- [src: run#W1-T4429-1790239902874]"].join("\n"),
    ),
  ];
  const actions = staleCitationCandidates({
    items: [],
    approvedSkills,
    revertedRunIds: new Set(["W1-T4429-1790239902874"]),
  });
  assert.equal(actions.length, 1);
  const [action] = actions;
  assert.equal(action.class, "stale-citation");
  assert.equal(action.target, "implement-clean-single-strike-8aa4458e");
  assert.equal(action.at, ".claude/skills/implement-clean-single-strike-8aa4458e/SKILL.md");
  assert.equal(action.citedId, "run#W1-T4429-1790239902874");
  assert.match(action.reason, /run#W1-T4429-1790239902874, now reverted/);

  // Staging turns the flagged citation into one reviewed inbox proposal — the repair is a proposal
  // a person ratifies, never a rewrite this class performs on its own.
  const root = tmpRoot("w1t4682-reverted-run-");
  const registryPath = join(root, "inbox-proposals.json");
  stageStaleCitationProposal(registryPath, action);
  const staged = loadProposalRegistry(registryPath);
  assert.equal(staged.length, 1);
  assert.equal(staged[0]!.id, staleCitationProposalId(action));
  assert.match(staged[0]!.summary, /implement-clean-single-strike-8aa4458e/);
  assert.match(staged[0]!.summary, /run#W1-T4429-1790239902874/);
  assert.match(staged[0]!.summary, /reverted/);
});

test("W1-T4682: a skill whose citations are all live gets none", () => {
  const approvedSkills = [
    skill(
      "a-live-skill",
      ["## Evidence", "", "- [src: run#a-live-run]", "- [src: learnings#a-live-learning]", "- [src: PR#1]"].join("\n"),
    ),
  ];
  const actions = staleCitationCandidates({
    items: [learningItem("a-live-learning", "active")],
    approvedSkills,
    revertedRunIds: new Set(["some-other-run"]),
    revertedPrNumbers: new Set([2]),
  });
  assert.deepEqual(actions, []);
});

// ── doctrine bodies cite too, and a superseded learning flags there just the same ───────────────

test("W1-T4682: a doctrine rule citing a superseded learning gets a repair proposal", () => {
  const items: KnowledgeItem[] = [
    learningItem("dead-fact", "superseded"),
    {
      id: "doctrine/s/a.md",
      kind: "doctrine",
      path: "doctrine/s/a.md",
      bytes: 0,
      text: "- **A rule resting on a retracted fact.** Its body. [src: learnings#dead-fact]\n",
    },
  ];
  const actions = staleCitationCandidates({ items, approvedSkills: [] });
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.target, "A rule resting on a retracted fact.");
  assert.equal(actions[0]!.at, "doctrine/s/a.md");
  assert.equal(actions[0]!.citedId, "learnings#dead-fact");
});

// ── one proposal per stale citation, and staging is idempotent ──────────────────────────────────

test("W1-T4682: a skill citing two dead ids gets two proposals, and staging is idempotent until the status changes", () => {
  const approvedSkills = [
    skill("two-dead-citations", ["## Evidence", "", "- [src: learnings#dead-one]", "- [src: run#dead-run]"].join("\n")),
  ];
  const items = [learningItem("dead-one", "quarantined")];
  const actions = staleCitationCandidates({ items, approvedSkills, revertedRunIds: new Set(["dead-run"]) });
  assert.equal(actions.length, 2, "each stale citation in the same body gets its own action");

  const root = tmpRoot("w1t4682-idempotent-");
  const registryPath = join(root, "inbox-proposals.json");
  for (const a of actions) stageStaleCitationProposal(registryPath, a);
  assert.equal(loadProposalRegistry(registryPath).length, 2);

  // Staging the SAME actions again changes nothing.
  for (const a of actions) stageStaleCitationProposal(registryPath, a);
  assert.equal(loadProposalRegistry(registryPath).length, 2);

  // The learning is later superseded instead of quarantined: the SAME proposal id is refreshed,
  // never duplicated.
  const changed = staleCitationCandidates({
    items: [learningItem("dead-one", "superseded")],
    approvedSkills,
    revertedRunIds: new Set(["dead-run"]),
  }).find((a) => a.citedId === "learnings#dead-one")!;
  stageStaleCitationProposal(registryPath, changed);
  const refreshed = loadProposalRegistry(registryPath);
  assert.equal(refreshed.length, 2, "still two proposals, not three");
  const refreshedOne = refreshed.find((p) => p.id === staleCitationProposalId(changed))!;
  assert.match(refreshedOne.summary, /now superseded/);
});
