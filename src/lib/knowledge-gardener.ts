import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { systemClock } from "./clock.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { buildKnowledgeInventory, danglingWhyPointers, inventoryTotals, type KnowledgeItem } from "./knowledge-inventory.js";
import { resolveCanonicalRuleId, slugifyRuleId, type MergedRuleGroup } from "./doctrine-lifecycle.js";
import { GUARD_RETIREMENT_ZERO_STREAK } from "./retro-closure.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { buildSkillEffectivenessReport, loadInjectableSkills, stageSkillLifecycleProposal } from "./skill-workshop.js";
import { updateProposalRegistry, type Proposal } from "./inbox.js";
import {
  gardenStatePath,
  initialGardenState,
  judgeGardenPending,
  planGarden,
  readGardenState,
  runGarden,
  startGarden,
  type GardenCheckout,
  type GardenerDeps,
  type GardenPlan as GenericPlan,
  type GardenSpec,
  type GardenState,
  type Outcome,
  type PendingVerdict,
  type PrState,
} from "./gardener.js";
import { learningValue, readLearningUsage, sampleBeta, type LearningUsage } from "./knowledge-value.js";
import { lintMemoryDir, textContainment } from "./memory-lint.js";

/**
 * lib/knowledge-gardener.ts (W1-T4095) — the knowledge base tends itself.
 *
 * Knowledge was pruned only when a person noticed. On 2026-09-22 the master plan had grown 87% in 30
 * days, 11 doctrine headlines restated one idea, 39 of 67 memory-index links were dead, and nothing
 * measured whether the whole was getting better. This is the background consolidation pass (Letta's
 * sleep-time idea, Zep's invalidate-don't-delete rule) with a feedback loop on its own choices.
 *
 * EACH PASS: inventory every knowledge item (knowledge-inventory.ts) and each learning's offered/used
 * history (knowledge-value.ts); let ONE action class act — the one with the best draw from its Beta
 * record — among MERGE (a near-duplicate learning is superseded by the older), RETIRE (a learning its
 * posterior says is worse than the corpus's typical one, a relative bar, not a threshold) and REFRESH
 * (re-run every `assertion:`); land the reversible changes as ONE reviewed PR that edits knowledge
 * paths only, with a dated garden-log entry; write a `knowledge.scorecard` row. That class is judged
 * only by its PR ({@link judgePending}): closed is a debit; after a merge, only a used-share change
 * beyond one standard error credits or debits it. No new PR opens while one awaits its outcome.
 *
 * SELF-PACED: a pass runs only when the knowledge or its usage changed. Each class has an off switch,
 * `state/KNOWLEDGE_OFF-<class>`. The loop itself is the general gardener (gardener.ts, W1-T4110); this
 * module is its knowledge spec.
 */

export { gardenPrState, type GardenerDeps, type PendingVerdict, type PrState } from "./gardener.js";

// W1-T4114: four classes joined the original three, APPENDED (never inserted before them) so the
// Beta draws the first three classes get from a pass's shared rng are byte-identical to before —
// every existing seeded test's exact retire/merge choice depends on that draw sequence. Doctrine,
// skills and guards are separate corpora from learnings, so each new class carries its OWN
// candidate detection and, where it lands no PR (skill-lifecycle, guard-retirement propose through
// the existing ratification inbox instead), never competes for the shared `merge`/`retire`/
// `refresh` metric either.
export type GardenActionClass = "merge" | "retire" | "refresh" | "rule-merge" | "skill-lifecycle" | "guard-retirement" | "repair-reference";
export const GARDEN_ACTION_CLASSES: readonly GardenActionClass[] = [
  "merge",
  "retire",
  "refresh",
  "rule-merge",
  "skill-lifecycle",
  "guard-retirement",
  "repair-reference",
];

export interface GardenAction {
  class: GardenActionClass;
  /** The learning id, doctrine rule id, skill name or guard name acted on; empty for refresh. */
  target: string;
  /** For a merge/rule-merge: the entry it is folded into. */
  into?: string;
  /** For a repair-reference: the corrected path the dangling pointer is rewritten to. */
  to?: string;
  /** For a rule-merge/repair-reference: the repo-relative path carrying the entry/pointer. */
  at?: string;
  reason: string;
}

export interface UsageTotals {
  offered: number;
  used: number;
}

/** The knowledge gardener's state, with each class judged on learnings offered and used. */
export interface GardenerState {
  classes: GardenState<GardenActionClass>["classes"];
  lastPass?: { fingerprint: string };
  lastCheap?: string;
  pending?: { prUrl: string; actionClass: GardenActionClass; baseline: UsageTotals; atMerge?: UsageTotals };
}

const toOutcome = (u: UsageTotals): Outcome => ({ trials: u.offered, successes: u.used });
const fromOutcome = (o: Outcome): UsageTotals => ({ offered: o.trials, used: o.successes });

function toGeneric(state: GardenerState): GardenState<GardenActionClass> {
  const p = state.pending;
  return { ...state, pending: p && { ...p, baseline: toOutcome(p.baseline), atMerge: p.atMerge && toOutcome(p.atMerge) } };
}

function fromGeneric(state: GardenState<GardenActionClass>): GardenerState {
  const p = state.pending;
  return { ...state, pending: p && { ...p, baseline: fromOutcome(p.baseline), atMerge: p.atMerge && fromOutcome(p.atMerge) } };
}

/** A new class starts optimistic (Beta(3, 1)): it acts most passes until its outcomes say otherwise. */
export function initialGardenerState(): GardenerState {
  return fromGeneric(initialGardenState(GARDEN_ACTION_CLASSES));
}

export function gardenerStatePath(stateDir: string): string {
  return gardenStatePath(stateDir, "knowledge");
}

export function readGardenerState(path: string): GardenerState {
  return fromGeneric(readGardenState(path, GARDEN_ACTION_CLASSES));
}

/** Share of a fact's phrasing that must repeat another active fact for the two to be merged. A
 *  sensitivity of the similarity measure, not a count threshold: the merge is reversible, reviewed
 *  in a PR, and judged by its outcome like every other action. */
export const MERGE_SIMILARITY = 0.6;

/** Pairs [newer, older] of active learnings that mostly repeat each other, older = earlier in the
 *  inventory (shard order, then position). Each learning is folded at most once. */
export function duplicateLearningPairs(items: KnowledgeItem[]): Array<[KnowledgeItem, KnowledgeItem]> {
  const active = items.filter((i) => i.kind === "learning" && i.lifecycle === "active");
  const pairs: Array<[KnowledgeItem, KnowledgeItem]> = [];
  const folded = new Set<string>();
  for (let j = 1; j < active.length; j++) {
    for (let i = 0; i < j; i++) {
      const [older, newer] = [active[i]!, active[j]!];
      if (folded.has(older.id) || folded.has(newer.id)) continue;
      const similarity = Math.min(textContainment(newer.text, older.text), textContainment(older.text, newer.text));
      if (similarity >= MERGE_SIMILARITY) {
        pairs.push([newer, older]);
        folded.add(newer.id);
        break;
      }
    }
  }
  return pairs;
}

/** Learnings that, with posterior probability of at least `confidence`, are less useful than the
 *  corpus's typical (median posterior-mean) learning. Only learnings with usage history qualify. */
export function retireCandidates(usage: LearningUsage, activeIds: string[], rng: () => number, confidence = 0.95, draws = 400): string[] {
  const measured = activeIds.filter((id) => (usage[id]?.offered ?? 0) > 0);
  if (measured.length < 2) return [];
  const means = measured.map((id) => learningValue(id, usage).mean).sort((a, b) => a - b);
  const median = means[Math.floor(means.length / 2)]!;
  return measured.filter((id) => {
    const value = learningValue(id, usage);
    let below = 0;
    for (let k = 0; k < draws; k++) if (sampleBeta(value, rng) < median) below++;
    return below / draws >= confidence;
  });
}

/** Each learning id a test names as a string literal, mapped to the first test file naming it.
 *  A test that requires a learning (`test/learnings-injection-w1t6.test.ts` requires
 *  `sdk-result-envelope` to be injected) goes red when it is superseded, so the gardener never
 *  retires or folds one away: passes #7101 and #7205 both tried. `test/fixtures` is data, skipped. */
export function testPinnedLearnings(root: string, ids: string[]): Record<string, string> {
  const wanted = new Set(ids);
  const pins: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== "fixtures") walk(path);
      } else if (/\.[cm]?[jt]s$/.test(ent.name)) {
        for (const m of readFileSync(path, "utf8").matchAll(/(["'`])([\w.-]+)\1/g)) {
          if (wanted.has(m[2]!) && !(m[2]! in pins)) pins[m[2]!] = relative(root, path).split("\\").join("/");
        }
      }
    }
  };
  if (existsSync(join(root, "test"))) walk(join(root, "test"));
  return pins;
}

/** Split off each merge or retire that would supersede a test-pinned learning, with the reason. */
function withoutTestPinned(actions: GardenAction[], pins: Record<string, string>): { actions: GardenAction[]; kept: GardenAction[] } {
  const pinned = (a: GardenAction) => (a.class === "merge" || a.class === "retire") && pins[a.target] !== undefined;
  return {
    actions: actions.filter((a) => !pinned(a)),
    kept: actions.filter(pinned).map((a) => ({ class: a.class, target: a.target, reason: `${pins[a.target]} names it, so a test requires it.` })),
  };
}

export function usedShare(usage: LearningUsage): number | null {
  const counts = Object.values(usage);
  const offered = counts.reduce((s, c) => s + c.offered, 0);
  return offered > 0 ? counts.reduce((s, c) => s + c.used, 0) / offered : null;
}

export function usageTotals(usage: LearningUsage): UsageTotals {
  const counts = Object.values(usage);
  return { offered: counts.reduce((s, c) => s + c.offered, 0), used: counts.reduce((s, c) => s + c.used, 0) };
}

// ── W1-T4114: SKILLS_USED — a skill's own offered/used counts, `learnings-usage.json`'s mirror ──
//
// `skills.selection` already ledgers which skills were OFFERED (matched into a task's prompt);
// `run-task.ts`'s `logSkillsUsed` (mirroring `logLearningsUsed`) folds each worker's own
// `SKILLS_USED` report into this store, so SKILL-LIFECYCLE below is judged on USE, not selection.

/** Structurally the same shape as {@link LearningUsageCounts} — a skill offered to an answering
 *  worker and how often that worker's own report named it used. */
export type SkillUsage = LearningUsage;

export function skillUsagePath(stateDir: string): string {
  return join(stateDir, "skills-usage.json");
}

export function readSkillUsage(path: string): SkillUsage {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SkillUsage) : {};
  } catch {
    // deliberate: an unreadable store reads as no history, the same fail-open direction
    // readLearningUsage takes — every skill then gets a wide posterior and is still tried.
    return {};
  }
}

/** Fold `skills.used` ledger rows into per-skill counts — `foldLearningUsage`'s own mirror for the
 *  skills channel (its `injected_names`/`used_names` fields, not `injected_ids`/`used_ids`). */
export function foldSkillUsage(rows: Iterable<Record<string, unknown>>, into: SkillUsage = {}): SkillUsage {
  for (const row of rows) {
    if (row.step !== "skills.used" || row.silent === true) continue;
    const injected = Array.isArray(row.injected_names) ? row.injected_names.filter((x): x is string => typeof x === "string") : [];
    const used = new Set(Array.isArray(row.used_names) ? row.used_names.filter((x): x is string => typeof x === "string") : []);
    for (const name of injected) {
      const c = (into[name] ??= { offered: 0, used: 0 });
      c.offered += 1;
      if (used.has(name)) c.used += 1;
    }
  }
  return into;
}

/** Fold one `skills.used` row into the store — `recordLearningUsage`'s own mirror. */
export function recordSkillUsage(path: string, row: Record<string, unknown>): void {
  const usage = foldSkillUsage([{ step: "skills.used", ...row }], readSkillUsage(path));
  writeAtomic(path, JSON.stringify(usage) + "\n");
}

/** Judge the pending class on the used share of learnings offered (gardener.ts's judgeGardenPending). */
export function judgePending(state: GardenerState, now: UsageTotals, prState: PrState): { state: GardenerState; verdict: PendingVerdict } {
  const judged = judgeGardenPending(toGeneric(state), toOutcome(now), prState);
  return { state: fromGeneric(judged.state), verdict: judged.verdict };
}

export type GardenPlan = GenericPlan<GardenActionClass, GardenAction>;

/** A doctrine item's own headline — every stored body opens `- **HEADLINE**` (the same contract
 *  `test/the-doctrine-index-points-at-every-body.test.ts` holds the real corpus to). */
function doctrineHeadline(text: string): string | undefined {
  return /^-\s+\*\*(.+?)\*\*/.exec(text)?.[1];
}

/** Pairs [newer, older] of doctrine rules whose bodies mostly repeat each other — RULE-MERGE's own
 *  {@link duplicateLearningPairs}, over doctrine's own kind instead of learnings'. Doctrine carries
 *  no `lifecycle` field (every stored body is live), so every item is eligible. */
export function doctrineDuplicatePairs(items: KnowledgeItem[]): Array<[KnowledgeItem, KnowledgeItem]> {
  const active = items.filter((i) => i.kind === "doctrine");
  const pairs: Array<[KnowledgeItem, KnowledgeItem]> = [];
  const folded = new Set<string>();
  for (let j = 1; j < active.length; j++) {
    for (let i = 0; i < j; i++) {
      const [older, newer] = [active[i]!, active[j]!];
      if (folded.has(older.id) || folded.has(newer.id)) continue;
      const similarity = Math.min(textContainment(newer.text, older.text), textContainment(older.text, newer.text));
      if (similarity >= MERGE_SIMILARITY) {
        pairs.push([newer, older]);
        folded.add(newer.id);
        break;
      }
    }
  }
  return pairs;
}

/** The alias registry RULE-MERGE writes: every id a merge ever folded, resolved to the canonical
 *  id doctrine now stores it under. Nothing is ever deleted — the registry only grows. */
export const MERGED_RULES_FILE = "doctrine/merged-rules.json";

function readMergedRuleGroups(root: string): MergedRuleGroup[] {
  const path = join(root, MERGED_RULES_FILE);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as MergedRuleGroup[]) : [];
  } catch {
    // deliberate: an unreadable registry reads as no merges yet — every id resolves to itself,
    // the same fail-open direction every other store in this module takes.
    return [];
  }
}

/** Every id a RULE-MERGE ever folded resolves to its canonical id; an id no merge ever touched
 *  resolves to itself (see {@link resolveCanonicalRuleId}, doctrine-lifecycle.ts, W1-T4097). */
export function resolveMergedRuleId(root: string, id: string): string {
  return resolveCanonicalRuleId(readMergedRuleGroups(root), id);
}

/** Fold RULE-MERGE actions into `doctrine/merged-rules.json`'s alias table and note the folded
 *  rule's OWN file with the gardener's marker — never deleted, never rewritten, so its evidence
 *  and the invariant "every stored body opens with its own headline" both survive untouched.
 *  Returns the paths it changed. */
export function applyRuleMergeActions(root: string, actions: GardenAction[]): string[] {
  const targets = actions.filter((a) => a.class === "rule-merge" && a.into);
  if (targets.length === 0) return [];
  const groups = readMergedRuleGroups(root);
  for (const a of targets) {
    const canonicalId = resolveCanonicalRuleId(groups, a.into!);
    let group = groups.find((g) => g.canonicalId === canonicalId);
    if (!group) {
      group = { canonicalId, aliasIds: [] };
      groups.push(group);
    }
    if (a.target !== group.canonicalId && !group.aliasIds.includes(a.target)) group.aliasIds.push(a.target);
  }
  const changed = new Set<string>([MERGED_RULES_FILE]);
  writeAtomic(join(root, MERGED_RULES_FILE), JSON.stringify(groups, null, 2) + "\n");
  for (const a of targets) {
    const text = a.at ? readFileIfExists(join(root, a.at)) : undefined;
    if (!a.at || text === undefined) continue;
    // Appended, never prepended: `test/the-doctrine-index-points-at-every-body.test.ts` holds every
    // stored body to opening with its OWN headline, and this marker must never be the reason a
    // real merge PR breaks that invariant. A three-line HTML comment, its middle line exactly
    // `gardenMarker(a)` with nothing trailing — the SAME `${gardenMarker(a)}$` anchor prBody's own
    // proof line greps for on the learnings side.
    const marker = `<!--\n${gardenMarker(a)}\n-->\n`;
    if (text.includes(`\n${gardenMarker(a)}\n`)) continue;
    writeAtomic(join(root, a.at), `${text.replace(/\n*$/, "\n")}${marker}`);
    changed.add(a.at);
  }
  return [...changed].sort();
}

/** Every `docs/forensics/**\/*.md` page on disk, repo-relative and forward-slashed — the same walk
 *  `knowledge-inventory.ts`'s `walkMarkdown` does, kept local so this module names its own read. */
function walkForensicsPages(dir: string, root: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkForensicsPages(path, root));
    else if (ent.isFile() && ent.name.endsWith(".md")) out.push(relative(root, path).split("\\").join("/"));
  }
  return out;
}

/** A dangling `Why:` pointer whose page moved: exactly one OTHER `docs/forensics/*.md` file on
 *  disk shares its basename. Ambiguous (more than one same-named page) or genuinely gone (none)
 *  is left alone — REPAIR-REFERENCE only acts where the rewrite is unambiguous. */
export function repairReferenceCandidates(root: string): GardenAction[] {
  const dangling = danglingWhyPointers(root);
  if (dangling.length === 0) return [];
  const onDisk = walkForensicsPages(join(root, "docs", "forensics"), root);
  const actions: GardenAction[] = [];
  for (const d of dangling) {
    const name = basename(d.target);
    const matches = onDisk.filter((f) => basename(f) === name);
    if (matches.length !== 1) continue;
    const to = matches[0]!;
    if (to === d.target) continue;
    actions.push({
      class: "repair-reference",
      target: `${d.file}:${d.line}`,
      to,
      at: d.file,
      reason: `The page moved from ${d.target} to ${to}.`,
    });
  }
  return actions;
}

/** Rewrite each dangling `Why:` pointer this pass repairs to its new target, in place on its own
 *  line. Idempotent: once rewritten, `danglingWhyPointers` no longer names it, so a later pass
 *  proposes nothing further for the same line. */
export function applyRepairReferenceActions(root: string, actions: GardenAction[]): string[] {
  const files = new Set(actions.filter((a) => a.class === "repair-reference" && a.at && a.to).map((a) => a.at!));
  if (files.size === 0) return [];
  const changed: string[] = [];
  for (const file of files) {
    const path = join(root, file);
    const text = readFileIfExists(path);
    if (text === undefined) continue;
    // Re-derive each dangling pointer's ORIGINAL literal from the file itself (never the action's
    // own `target`, which carries `file:line`, not the path text) — the one substring this repair
    // is licensed to touch, so a stale `to` can never clobber an unrelated `Why:` line.
    let rewritten = text;
    for (const d of danglingWhyPointers(root).filter((x) => x.file === file)) {
      const match = actions.find((a) => a.class === "repair-reference" && a.target === `${d.file}:${d.line}`);
      if (match === undefined || !match.to) continue;
      rewritten = rewritten.replace(`Why: ${d.target}`, `Why: ${match.to}`);
    }
    if (rewritten !== text) {
      writeAtomic(path, rewritten);
      changed.push(file);
    }
  }
  return changed.sort();
}

/** `state/last-retro.json`'s own shape (`run-task.ts`'s `retro` command writes it; see
 *  `guard_zero_streak: guardZeroStreakRecord(...)`, W1-T2875) — read here, never re-derived, so
 *  GUARD-RETIREMENT proposes only what the retro pipeline already measured. */
function readGuardZeroStreak(stateDir: string): Record<string, number> {
  const path = join(stateDir, "last-retro.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { guard_zero_streak?: unknown };
    const streak = parsed?.guard_zero_streak;
    return streak && typeof streak === "object" && !Array.isArray(streak) ? (streak as Record<string, number>) : {};
  } catch {
    // deliberate: an unreadable or absent marker reads as no measured streak for any guard — the
    // same fail-open direction every other store in this module takes; the next retro pass rebuilds it.
    return {};
  }
}

/** Guards whose zero-fire streak, as the retro pipeline last measured it, has reached the
 *  retirement bound ({@link GUARD_RETIREMENT_ZERO_STREAK}) — named, never removed: the gardener
 *  only proposes; `rmd approve` is where a person decides. */
export function guardRetirementCandidates(streak: Record<string, number>): GardenAction[] {
  return Object.entries(streak)
    .filter(([, n]) => n >= GUARD_RETIREMENT_ZERO_STREAK)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([guard, n]) => ({
      class: "guard-retirement" as const,
      target: guard,
      reason: `Fired zero times for ${n} consecutive retro cycles (bound ${GUARD_RETIREMENT_ZERO_STREAK}).`,
    }));
}

export function guardRetirementProposalId(guard: string): string {
  return `guard-retirement:${guard}`;
}

/** Stage one guard's retirement as a reviewed inbox proposal — {@link stageBundleProposals}'
 *  (inbox.ts) own idempotency shape: an unchanged streak is left alone, a risen one refreshes the
 *  proposal's own evidence, and nothing here ever removes a guard's mapping row itself. */
export function stageGuardRetirementProposal(registryPath: string, action: GardenAction): void {
  const id = guardRetirementProposalId(action.target);
  const proposal: Proposal = {
    id,
    summary:
      `Retire guard '${action.target}': ${action.reason} Approving this proposal is a record that a person ` +
      `reviewed the streak; it deletes nothing on its own — the guard's own mapping row is a separate, ` +
      `hand-reviewed edit.`,
    evidenceAnchors: [],
  };
  updateProposalRegistry(registryPath, (current) => {
    const idx = current.findIndex((p) => p.id === id);
    if (idx === -1) return [...current, proposal];
    if (current[idx]!.summary === proposal.summary) return null; // already staged with the same streak
    const next = [...current];
    next[idx] = { ...current[idx]!, ...proposal };
    return next;
  });
}

/** Approved, opted-in skills with enough `skills.used` history to judge — {@link retireCandidates}
 *  reused verbatim, since {@link SkillUsage} is {@link LearningUsage}'s own shape: a skill offered
 *  and rarely used, compared with the corpus's typical skill, is a SKILL-LIFECYCLE candidate. */
export function skillLifecycleCandidates(skillUsage: SkillUsage, approvedNames: string[], rng: () => number): GardenAction[] {
  return retireCandidates(skillUsage, approvedNames, rng).map((name) => ({
    class: "skill-lifecycle" as const,
    target: name,
    reason: "Workers offered it have rarely reported using it, compared with other approved skills.",
  }));
}

/** Build this skill's effectiveness report from the ledger and stage its retirement proposal —
 *  `stageSkillLifecycleProposal` ON SCHEDULE instead of only by hand (`rmd skill lifecycle`).
 *  BEST-EFFORT: an unreadable ledger or a report that does not clear `stageSkillLifecycleProposal`'s
 *  own bar (not yet RETIRE-CANDIDATE) stages nothing, silently — the next pass tries again once
 *  more evidence accrues. */
export function stageSkillLifecycleForAction(stateDir: string, repoRoot: string, action: GardenAction): void {
  try {
    const ledger = readLedgerUnionRecordsSync(stateDir, { step: ["skills.selection", "verdict"] });
    const report = buildSkillEffectivenessReport(ledger.rows, action.target);
    stageSkillLifecycleProposal(join(stateDir, "inbox-proposals.json"), join(repoRoot, ".claude", "skills"), report);
  } catch {
    // deliberate: a background proposal attempt never fails the pass it rides in — the next tick
    // tries again, and nothing here has written anything if the ledger could not be read.
  }
}

export function planGardenPass(opts: {
  items: KnowledgeItem[];
  usage: LearningUsage;
  state: GardenerState;
  rng: () => number;
  switchedOff?: (c: GardenActionClass) => boolean;
  skillUsage?: SkillUsage;
  approvedSkillNames?: string[];
  guardZeroStreak?: Record<string, number>;
  root?: string;
  testPins?: Record<string, string>;
}): GardenPlan {
  return planGarden({ classes: GARDEN_ACTION_CLASSES, state: toGeneric(opts.state), rng: opts.rng, switchedOff: opts.switchedOff, candidates: () => candidateActions(opts).actions });
}

function candidateActions(opts: {
  items: KnowledgeItem[];
  usage: LearningUsage;
  rng: () => number;
  skillUsage?: SkillUsage;
  approvedSkillNames?: string[];
  guardZeroStreak?: Record<string, number>;
  root?: string;
  testPins?: Record<string, string>;
}): { actions: GardenAction[]; kept: GardenAction[] } {
  const actions: GardenAction[] = duplicateLearningPairs(opts.items).map(([newer, older]) => ({
    class: "merge" as const,
    target: bare(newer.id),
    into: bare(older.id),
    reason: "Its fact mostly repeats an older learning.",
  }));
  const active = opts.items.filter((i) => i.kind === "learning" && i.lifecycle === "active").map((i) => bare(i.id));
  for (const id of retireCandidates(opts.usage, active, opts.rng)) {
    actions.push({ class: "retire", target: id, reason: "Workers offered it have rarely used it, compared with other learnings." });
  }
  actions.push({ class: "refresh", target: "", reason: "Re-check every learning's assertion." });
  for (const [newer, older] of doctrineDuplicatePairs(opts.items)) {
    const newerHeadline = doctrineHeadline(newer.text);
    const olderHeadline = doctrineHeadline(older.text);
    if (!newerHeadline || !olderHeadline) continue;
    actions.push({
      class: "rule-merge",
      target: slugifyRuleId(newerHeadline),
      into: slugifyRuleId(olderHeadline),
      at: newer.path,
      reason: "Its doctrine body mostly repeats an older rule.",
    });
  }
  if (opts.root) actions.push(...repairReferenceCandidates(opts.root));
  actions.push(...guardRetirementCandidates(opts.guardZeroStreak ?? {}));
  actions.push(...skillLifecycleCandidates(opts.skillUsage ?? {}, opts.approvedSkillNames ?? [], opts.rng));
  return withoutTestPinned(actions, opts.testPins ?? {});
}

const bare = (id: string) => id.replace(/^learnings#/, "");

/** Supersede learnings in their shards by text surgery on each entry's own block, so the diff is
 *  exactly the changed lines. Returns the shard files it changed. */
export function applyLearningActions(learningsDir: string, actions: GardenAction[]): { paths: string[]; located: Record<string, string> } {
  const changed = new Set<string>();
  const located: Record<string, string> = {};
  const targets = actions.filter((a) => a.class === "merge" || a.class === "retire");
  if (targets.length === 0 || !existsSync(learningsDir)) return { paths: [], located };
  for (const name of readdirSync(learningsDir).filter((f) => f.endsWith(".yaml")).sort()) {
    const path = join(learningsDir, name);
    let text = readFileSync(path, "utf8");
    for (const a of targets) {
      const start = text.search(new RegExp(`^- id: ${a.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m"));
      if (start < 0) continue;
      const nextRel = text.slice(start + 1).search(/^- id: /m);
      const end = nextRel < 0 ? text.length : start + 1 + nextRel;
      const block = text.slice(start, end);
      if (!/^\s+lifecycle: active\s*$/m.test(block)) continue;
      // The marker comment names the action and target, so the PR's proof can only pass at its head.
      const updated = block.replace(
        /^(\s+)lifecycle: active\s*$/m,
        a.into
          ? `$1# ${gardenMarker(a)}\n$1lifecycle: superseded\n$1superseded_by: ${a.into}`
          : `$1# ${gardenMarker(a)}\n$1lifecycle: superseded`,
      );
      text = text.slice(0, start) + updated + text.slice(end);
      changed.add(name);
      located[a.target] = `${basename(learningsDir)}/${name}`;
    }
    if (changed.has(name)) writeFileSync(path, text);
  }
  return { paths: [...changed].sort().map((f) => `${basename(learningsDir)}/${f}`), located };
}

/** The comment a gardener action leaves in the entry it changed. */
export function gardenMarker(a: GardenAction): string {
  return `knowledge gardener: ${a.class} ${a.target}`;
}

export interface KnowledgeScorecard {
  usedShare: number | null;
  totals: Record<string, { count: number; bytes: number; largest: number }>;
  danglingPointers: number;
  duplicatePairs: number;
  retireCandidates: number;
  /** The items carrying the largest share of their kind's bytes — the fold candidates, ranked, not cut off. */
  heaviest: Array<{ id: string; kind: string; bytes: number; shareOfKind: number }>;
  memory?: { danglingIndexLines: number; indexLoad: string };
}

export function heaviestItems(items: KnowledgeItem[], n: number): KnowledgeScorecard["heaviest"] {
  const kindBytes = inventoryTotals(items);
  return items
    .map((i) => ({ id: i.id, kind: i.kind, bytes: i.bytes, shareOfKind: Math.round((i.bytes / Math.max(1, kindBytes[i.kind]!.bytes)) * 100) / 100 }))
    .sort((a, b) => b.shareOfKind - a.shareOfKind || b.bytes - a.bytes)
    .slice(0, n);
}

export function buildScorecard(opts: {
  items: KnowledgeItem[];
  usage: LearningUsage;
  dangling: number;
  plan: GardenPlan;
  memoryDirs?: string[];
}): KnowledgeScorecard {
  const memoryReports = (opts.memoryDirs ?? []).filter((d) => existsSync(d)).map((d) => lintMemoryDir(d));
  return {
    usedShare: usedShare(opts.usage),
    totals: inventoryTotals(opts.items),
    danglingPointers: opts.dangling,
    duplicatePairs: opts.plan.actions.filter((a) => a.class === "merge").length,
    retireCandidates: opts.plan.actions.filter((a) => a.class === "retire").length,
    heaviest: heaviestItems(opts.items, 5),
    ...(memoryReports.length > 0
      ? {
          memory: {
            danglingIndexLines: memoryReports.reduce((s, r) => s + r.dangling.length, 0),
            indexLoad: memoryReports.map((r) => r.index.load).sort().reverse()[0]!,
          },
        }
      : {}),
  };
}

/** What changed since the last pass: the corpus's size and its usage totals. */
export function gardenFingerprint(items: KnowledgeItem[], usage: LearningUsage): string {
  const bytes = items.reduce((s, i) => s + i.bytes, 0);
  const offered = Object.values(usage).reduce((s, c) => s + c.offered, 0);
  return `${items.length}:${bytes}:${offered}`;
}

/** Modification times of the files a pass reads, so an unchanged corpus costs one stat per file. */
export function cheapFingerprint(repoRoot: string, stateDir: string): string {
  const mtime = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  const layout = resolveRepoLayout(repoRoot);
  const learnings = layout.learningsDir;
  const shardTimes = existsSync(learnings) ? readdirSync(learnings).sort().map((f) => mtime(join(learnings, f))) : [];
  return [
    ...shardTimes,
    mtime(join(repoRoot, "DECISIONS.md")),
    mtime(layout.masterPlan),
    mtime(join(repoRoot, "docs", "forensics")),
    mtime(join(repoRoot, "doctrine")),
    mtime(join(stateDir, "learnings-usage.json")),
  ].join(",");
}

export const GARDEN_LOG = "docs/knowledge-garden-log.md";

/** Append this pass's section to the garden log — a changelog of what the knowledge base did to
 *  itself — and return the section's heading, which only this pass's PR can contain. */
export function appendGardenLog(root: string, at: Date, actions: GardenAction[], card: KnowledgeScorecard): string {
  const path = join(root, GARDEN_LOG);
  const heading = `## Pass ${at.toISOString()}`;
  let prior: string;
  try {
    prior = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    prior = "# Knowledge garden log\n\nEach section is one pass of the knowledge gardener (W1-T4095): what it changed and how the knowledge base scored.\n";
  }
  const share = card.usedShare === null ? "not measured yet" : `${Math.round(card.usedShare * 100)}%`;
  const section = [
    "",
    heading,
    "",
    ...actions.map((a) => `- ${a.class}${a.target ? ` ${a.target}` : ""}${a.into ? ` into ${a.into}` : ""}: ${a.reason}`),
    "",
    `Learnings used when offered: ${share}. Dangling Why pointers: ${card.danglingPointers}.`,
    "",
  ].join("\n");
  writeAtomic(path, prior.replace(/\n*$/, "\n") + section);
  return heading;
}

/** A place to make the pass's changes and land them as one PR. */
export interface GardenWorkspace extends GardenCheckout {
  /** Re-run learnings assertions in the workspace (the REFRESH action); returns changed paths. */
  refreshAssertions: () => string[];
}

function prBody(actions: GardenAction[], located: Record<string, string>, heading: string): string {
  const proved = actions.filter((a) => located[a.target]);
  const lines = [
    "The knowledge gardener (W1-T4095) tended the knowledge base. Every change is reversible: nothing is deleted, and a superseded learning keeps its text and stops being injected.",
    "",
    ...actions.map((a) => `- **${a.class}**${a.target ? ` \`${a.target}\`` : ""}${a.into ? ` into \`${a.into}\`` : ""}: ${a.reason}`),
    "",
    "## Acceptance",
    `- claim: this pass is recorded in the garden log`,
    `  proof: grep: ^${heading}$ in ${GARDEN_LOG}`,
    ...proved.flatMap((a) => [`- claim: the gardener's ${a.class} of ${a.target} is marked in its entry`, `  proof: grep: ${gardenMarker(a)}$ in ${located[a.target]}`]),
  ];
  return lines.join("\n");
}

interface KnowledgeInventory {
  items: KnowledgeItem[];
  usage: LearningUsage;
  skillUsage: SkillUsage;
  approvedSkillNames: string[];
  guardZeroStreak: Record<string, number>;
  testPins: Record<string, string>;
}

/** The knowledge base as a gardener spec: its corpus, its evidence and its actions. RULE-MERGE and
 *  REPAIR-REFERENCE land a reviewed PR exactly like MERGE/RETIRE/REFRESH; SKILL-LIFECYCLE and
 *  GUARD-RETIREMENT land no PR at all — they stage a proposal into the SAME ratification inbox
 *  `rmd approve` already reads, so a person still decides, through the channel that already
 *  exists for it, rather than a git diff pretending a proposal is a fact. */
export function knowledgeGardenSpec(deps: GardenerDeps<GardenWorkspace>): GardenSpec<GardenActionClass, KnowledgeInventory, GardenAction, GardenWorkspace> {
  const clock = deps.clock ?? systemClock;
  const approvedSkillsDir = join(deps.repoRoot, ".claude", "skills");
  const inboxPath = join(deps.stateDir, "inbox-proposals.json");
  return {
    name: "knowledge",
    classes: GARDEN_ACTION_CLASSES,
    cheapFingerprint: () => cheapFingerprint(deps.repoRoot, deps.stateDir),
    inventory: () => {
      const items = buildKnowledgeInventory(deps.repoRoot, { memoryDirs: deps.memoryDirs });
      const learningIds = items.filter((i) => i.kind === "learning").map((i) => bare(i.id));
      return {
        items,
        testPins: testPinnedLearnings(deps.repoRoot, learningIds),
        usage: readLearningUsage(`${deps.stateDir}/learnings-usage.json`),
        skillUsage: readSkillUsage(skillUsagePath(deps.stateDir)),
        approvedSkillNames: loadInjectableSkills(approvedSkillsDir).map((s) => s.name),
        guardZeroStreak: readGuardZeroStreak(deps.stateDir),
      };
    },
    fingerprint: (inv) => gardenFingerprint(inv.items, inv.usage),
    // Every class that lands a PR here is judged on the same evidence: whether workers use the
    // learnings they are offered. SKILL-LIFECYCLE/GUARD-RETIREMENT never land a PR (see above), so
    // this metric is never actually read for them — `rmd approve` is their judge, not this loop.
    metric: (inv) => toOutcome(usageTotals(inv.usage)),
    candidates: (inv, rng) => {
      const { actions, kept } = candidateActions({ ...inv, rng, root: deps.repoRoot });
      for (const k of kept) deps.log("knowledge.kept_for_test", { class: k.class, target: k.target, test: inv.testPins[k.target], reason: k.reason });
      return actions;
    },
    scorecard: (inv, plan) => ({ ...buildScorecard({ ...inv, dangling: danglingWhyPointers(deps.repoRoot).length, plan, memoryDirs: deps.memoryDirs }) }),
    apply: (ws, plan, card) => {
      const applied = applyLearningActions(resolveRepoLayout(ws.root).learningsDir, plan.actions);
      const ruleMerged = applyRuleMergeActions(ws.root, plan.actions);
      const repaired = applyRepairReferenceActions(ws.root, plan.actions);
      const refreshed = plan.acting.includes("refresh") ? ws.refreshAssertions() : [];
      // Neither of these touches the workspace: both stage a proposal into the daemon's OWN state
      // dir, outside the checkout this pass would otherwise land as a PR.
      for (const a of plan.actions) {
        if (a.class === "skill-lifecycle") stageSkillLifecycleForAction(deps.stateDir, deps.repoRoot, a);
        if (a.class === "guard-retirement") stageGuardRetirementProposal(inboxPath, a);
      }
      const changed = [...new Set([...applied.paths, ...ruleMerged, ...repaired, ...refreshed])];
      if (changed.length === 0) return undefined;
      const heading = appendGardenLog(ws.root, clock.date(), plan.actions, card as unknown as KnowledgeScorecard);
      const acting = plan.acting[0];
      const nonRefresh = plan.actions.filter((a) => a.class !== "refresh");
      const title =
        acting === "rule-merge"
          ? `chore(knowledge): the gardener merges ${nonRefresh.length} doctrine rule(s)`
          : acting === "repair-reference"
            ? `chore(knowledge): the gardener repairs ${nonRefresh.length} dangling reference(s)`
            : `chore(knowledge): the gardener folds and retires ${nonRefresh.length} learnings`;
      const ruleMergeLocated = Object.fromEntries(plan.actions.filter((a) => a.class === "rule-merge" && a.at).map((a) => [a.target, a.at!]));
      return {
        paths: [...changed, GARDEN_LOG].sort(),
        title,
        body: prBody(plan.actions, { ...applied.located, ...ruleMergeLocated }, heading),
      };
    },
  };
}

/** One knowledge gardener pass. Returns what it did. */
export function runGardenPass(deps: GardenerDeps<GardenWorkspace>): { ran: boolean; plan?: GardenPlan; prUrl?: string; scorecard?: KnowledgeScorecard } {
  const result = runGarden(knowledgeGardenSpec(deps), deps);
  return { ...result, scorecard: result.scorecard as unknown as KnowledgeScorecard | undefined };
}

/** Run knowledge passes on their own timer beside the main loop, never two at once. */
export function startKnowledgeGardener(deps: GardenerDeps<GardenWorkspace>, intervalMs: number): { stop: () => void } {
  return startGarden(knowledgeGardenSpec(deps), deps, intervalMs);
}
