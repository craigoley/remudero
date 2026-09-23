import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { systemClock, type Clock } from "./clock.js";
import { writeAtomic } from "./fs-race-safe.js";
import { resolveRepoLayout } from "./repo-layout.js";
import { buildKnowledgeInventory, danglingWhyPointers, inventoryTotals, type KnowledgeItem } from "./knowledge-inventory.js";
import { learningValue, readLearningUsage, sampleBeta, seededRandom, type LearningUsage } from "./knowledge-value.js";
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
 * `state/KNOWLEDGE_OFF-<class>`.
 */

export type GardenActionClass = "merge" | "retire" | "refresh";
export const GARDEN_ACTION_CLASSES: readonly GardenActionClass[] = ["merge", "retire", "refresh"];

export interface GardenAction {
  class: GardenActionClass;
  /** The learning id acted on (without the `learnings#` prefix); empty for refresh. */
  target: string;
  /** For a merge: the learning it is folded into. */
  into?: string;
  reason: string;
}

export interface UsageTotals {
  offered: number;
  used: number;
}

export interface GardenerState {
  classes: Record<GardenActionClass, { alpha: number; beta: number }>;
  lastPass?: { fingerprint: string };
  /** The cheap modification-time fingerprint of the last look, so an idle tick reads nothing more. */
  lastCheap?: string;
  /** The one action class whose PR is awaiting its outcome. While it waits, no new PR is opened. */
  pending?: { prUrl: string; actionClass: GardenActionClass; baseline: UsageTotals; atMerge?: UsageTotals };
}

export type PrState = "open" | "merged" | "closed" | "unknown";

/** A new class starts optimistic (Beta(3, 1)): it acts most passes until its outcomes say otherwise. */
export function initialGardenerState(): GardenerState {
  return { classes: { merge: { alpha: 3, beta: 1 }, retire: { alpha: 3, beta: 1 }, refresh: { alpha: 3, beta: 1 } } };
}

export function gardenerStatePath(stateDir: string): string {
  return `${stateDir}/knowledge-gardener.json`;
}

export function readGardenerState(path: string): GardenerState {
  if (!existsSync(path)) return initialGardenerState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GardenerState;
    return parsed && parsed.classes ? { ...initialGardenerState(), ...parsed } : initialGardenerState();
  } catch {
    // deliberate: an unreadable state restarts every class at its optimistic prior; nothing is lost
    // that the next passes cannot re-learn.
    return initialGardenerState();
  }
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

export function usedShare(usage: LearningUsage): number | null {
  const counts = Object.values(usage);
  const offered = counts.reduce((s, c) => s + c.offered, 0);
  return offered > 0 ? counts.reduce((s, c) => s + c.used, 0) / offered : null;
}

export function usageTotals(usage: LearningUsage): UsageTotals {
  const counts = Object.values(usage);
  return { offered: counts.reduce((s, c) => s + c.offered, 0), used: counts.reduce((s, c) => s + c.used, 0) };
}

export type PendingVerdict = "none" | "waiting" | "credit" | "debit";

/**
 * Judge the pending action class, if any. A closed (unmerged) PR is a debit. After the merge, the
 * used share of learnings offered SINCE the merge is compared with the share before the pass; the
 * class is credited or debited only once the difference exceeds one standard error of that share
 * (so noise never counts either way), and otherwise keeps waiting for more evidence.
 */
export function judgePending(state: GardenerState, now: UsageTotals, prState: PrState): { state: GardenerState; verdict: PendingVerdict } {
  const pending = state.pending;
  if (!pending) return { state, verdict: "none" };
  const settle = (credit: boolean): { state: GardenerState; verdict: PendingVerdict } => {
    const c = state.classes[pending.actionClass];
    const classes = { ...state.classes, [pending.actionClass]: credit ? { ...c, alpha: c.alpha + 1 } : { ...c, beta: c.beta + 1 } };
    return { state: { ...state, classes, pending: undefined }, verdict: credit ? "credit" : "debit" };
  };
  if (prState === "closed") return settle(false);
  if (prState !== "merged") return { state, verdict: "waiting" };
  if (!pending.atMerge) return { state: { ...state, pending: { ...pending, atMerge: now } }, verdict: "waiting" };
  const offered = now.offered - pending.atMerge.offered;
  if (offered <= 0) return { state, verdict: "waiting" };
  const after = (now.used - pending.atMerge.used) / offered;
  const before = pending.baseline.offered > 0 ? pending.baseline.used / pending.baseline.offered : 0.5;
  const se = Math.sqrt(Math.max(before * (1 - before), 1 / (4 * offered)) / offered);
  if (after - before > se) return settle(true);
  if (before - after > se) return settle(false);
  return { state, verdict: "waiting" };
}

export interface GardenPlan {
  actions: GardenAction[];
  /** Which classes this pass's draw let act. */
  acting: GardenActionClass[];
}

export function planGardenPass(opts: {
  items: KnowledgeItem[];
  usage: LearningUsage;
  state: GardenerState;
  rng: () => number;
  switchedOff?: (c: GardenActionClass) => boolean;
}): GardenPlan {
  // Every class draws from its record; of those that drew at least even odds, the ONE with the highest
  // draw and something to do acts this pass, so each outcome is credited to exactly one class.
  const draws = GARDEN_ACTION_CLASSES.map((c) => ({ c, draw: opts.switchedOff?.(c) ? -1 : sampleBeta({ ...opts.state.classes[c], mean: 0 }, opts.rng) }));
  const eligible = draws.filter((d) => d.draw >= 0.5).sort((a, b) => b.draw - a.draw).map((d) => d.c);
  const all = candidateActions(opts);
  const chosen = eligible.find((c) => all.some((a) => a.class === c));
  return { actions: chosen ? all.filter((a) => a.class === chosen) : [], acting: chosen ? [chosen] : [] };
}

function candidateActions(opts: { items: KnowledgeItem[]; usage: LearningUsage; rng: () => number }): GardenAction[] {
  const bare = (id: string) => id.replace(/^learnings#/, "");
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
  return actions;
}

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

/** Where a landed PR stands, read over REST with the given fetcher. */
export function gardenPrState(owner: string, repo: string, prUrl: string, fetch: (args: string[]) => unknown): PrState {
  const n = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  if (!n) return "unknown";
  try {
    const pr = fetch(["api", `repos/${owner}/${repo}/pulls/${n}`]) as { merged?: boolean; state?: string };
    return pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
  } catch {
    // deliberate: an unreadable PR is "unknown", which keeps the pending class waiting, never judged on a guess.
    return "unknown";
  }
}

/** A place to make the pass's changes and land them as one PR. */
export interface GardenWorkspace {
  /** The checkout the changes are made in (a fresh worktree of origin/main). */
  root: string;
  /** Re-run learnings assertions in the workspace (the REFRESH action); returns changed paths. */
  refreshAssertions: () => string[];
  /** Commit the given paths and open the PR; returns its URL, or undefined when nothing landed. */
  land: (opts: { paths: string[]; title: string; body: string }) => string | undefined;
  dispose: () => void;
}

export interface GardenerDeps {
  stateDir: string;
  /** Where to read the current corpus from for planning (the daemon's own checkout). */
  repoRoot: string;
  memoryDirs?: string[];
  openWorkspace: () => GardenWorkspace;
  log: (step: string, extra?: Record<string, unknown>) => void;
  /** Where a landed PR stands, so its action class is judged by the PR's outcome. */
  prState?: (prUrl: string) => PrState;
  seed?: number;
  clock?: Clock;
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

/** One gardener pass. Returns what it did. */
export function runGardenPass(deps: GardenerDeps): { ran: boolean; plan?: GardenPlan; prUrl?: string; scorecard?: KnowledgeScorecard } {
  const statePath = gardenerStatePath(deps.stateDir);
  const cheap = cheapFingerprint(deps.repoRoot, deps.stateDir);
  if (readGardenerState(statePath).lastCheap === cheap) return { ran: false };
  const items = buildKnowledgeInventory(deps.repoRoot, { memoryDirs: deps.memoryDirs });
  const usage = readLearningUsage(`${deps.stateDir}/learnings-usage.json`);
  const fingerprint = gardenFingerprint(items, usage);
  let state = readGardenerState(statePath);
  if (state.lastPass?.fingerprint === fingerprint) {
    writeAtomic(statePath, JSON.stringify({ ...state, lastCheap: cheap }, null, 2) + "\n");
    return { ran: false };
  }
  const totals = usageTotals(usage);
  const judged = judgePending(state, totals, state.pending ? (deps.prState?.(state.pending.prUrl) ?? "unknown") : "unknown");
  state = judged.state;
  if (judged.verdict === "credit" || judged.verdict === "debit") deps.log("knowledge.gardener_judged", { verdict: judged.verdict, classes: state.classes });
  const clock = deps.clock ?? systemClock;
  const rng = seededRandom(deps.seed ?? clock.now());
  const plan = state.pending ? { actions: [], acting: [] } : planGardenPass({
    items,
    usage,
    state,
    rng,
    switchedOff: (c) => existsSync(join(deps.stateDir, `KNOWLEDGE_OFF-${c}`)),
  });
  const scorecard = buildScorecard({ items, usage, dangling: danglingWhyPointers(deps.repoRoot).length, plan, memoryDirs: deps.memoryDirs });
  let prUrl: string | undefined;
  if (plan.actions.length > 0) {
    const ws = deps.openWorkspace();
    try {
      const applied = applyLearningActions(resolveRepoLayout(ws.root).learningsDir, plan.actions);
      const refreshed = plan.acting.includes("refresh") ? ws.refreshAssertions() : [];
      const changed = [...new Set([...applied.paths, ...refreshed])];
      if (changed.length > 0) {
        const heading = appendGardenLog(ws.root, clock.date(), plan.actions, scorecard);
        const paths = [...changed, GARDEN_LOG].sort();
        prUrl = ws.land({
          paths,
          title: `chore(knowledge): the gardener folds and retires ${plan.actions.filter((a) => a.class !== "refresh").length} learnings`,
          body: prBody(plan.actions, applied.located, heading),
        });
      }
    } finally {
      ws.dispose();
    }
  }
  deps.log("knowledge.scorecard", { ...scorecard, acting: plan.acting, actions: plan.actions.length, pr_url: prUrl ?? null, awaiting: state.pending?.prUrl ?? null });
  // Only a class whose changes actually landed as a PR is judged, and only by that PR's outcome.
  const pending = prUrl && plan.acting[0] ? { prUrl, actionClass: plan.acting[0], baseline: totals } : state.pending;
  writeAtomic(statePath, JSON.stringify({ ...state, pending, lastCheap: cheap, lastPass: { fingerprint } }, null, 2) + "\n");
  return { ran: true, plan, prUrl, scorecard };
}

/** Run a pass on its own timer beside the main loop, never two at once. */
export function startKnowledgeGardener(deps: GardenerDeps, intervalMs: number): { stop: () => void } {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      runGardenPass(deps);
    } catch (e) {
      deps.log("knowledge.gardener_failed", { error: String((e as Error)?.message ?? e) });
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
