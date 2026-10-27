import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import { systemClock, type Clock } from "./clock.js";
import { buildDecisionSummarySpawnArgs, isOptionIntent, type OptionIntent, type SummarizeInput } from "./feedback.js";
import { readClassificationSnapshot } from "./fleet-lane.js";
import { readFileIfExists, writeAtomic } from "./fs-race-safe.js";
import { classifiedInboxOwner } from "./inbox-owner.js";
import { INBOX_SPEAKER, optionAction, plainInboxMessage, plainStorePath, readPlainStore, type InboxOptionLane, type PlainBackfillDeps, type PlainOptionAction } from "./inbox-plain.js";
import type { Mount } from "./mounts.js";
import { checkOperatorMessage } from "./operator-message.js";
import { spawnWorker } from "./worker.js";
import { benchmarkNonDispatchSpawn } from "./benchmark-run.js";

/**
 * lib/inbox-recommendation.ts (W1-T8950) — each operator inbox item carries the decision the fleet recommends.
 *
 * On 2026-10-13 an operator session cleared the inbox from a page built outside the console: one recommendation
 * per item, saying what to choose, the exact text to post, why, and the evidence on main. This module keeps that
 * recommendation on the item itself. A writer on its own timer asks the summarize lane for one recommendation per
 * item, a checker refuses one whose evidence does not resolve on origin/main, and the operator session's 47
 * recommendations are imported once as a seed. The route is attached at serve time from W1-T8826's mapping and is
 * never stored. A recommendation whose source changed (summary, lane, or the task's record on main) is not served.
 */

export type RecommendationSource = "writer" | "operator-session-seed";

export interface InboxRecommendation {
  action: OptionIntent;
  /** The exact reason, feedback or reply the action posts as its input. */
  text?: string;
  why: string;
  evidence: string[];
  /** True only with evidence of a merged change on main that resolves the subject. */
  obsolete: boolean;
  /** The shared root cause, when several items are one cause. */
  group?: string;
  generatedAt: string;
  source: RecommendationSource;
}

export interface StoredRecommendation extends InboxRecommendation {
  sourceFingerprint: string;
  /** The repository and fixed main commit the writer read this advice against; absent from a legacy entry, which proves neither. */
  repository?: string;
  sourceCommit?: string;
  /** The task record's blob on main the fingerprint was taken over; absent when the item names no task. */
  shardBlob?: string;
}

/** A recommendation as the inbox serves it: the route is attached here, never stored. */
export interface ServedRecommendation extends InboxRecommendation {
  route?: PlainOptionAction;
}

export type RecommendationStore = Record<string, StoredRecommendation>;

const SEED_NAME = "inbox-recommendations-2026-10-13";
/** The committed operator-session seed, repo-relative. */
export const RECOMMENDATION_SEED_PATH = "plan/seeds/inbox-recommendations-2026-10-13.json";

export function recommendationStorePath(stateDir: string): string {
  return `${stateDir}/inbox-recommendations.json`;
}

/** Writer answers refused twice, by proposal id, with the fingerprint they were refused at. */
function refusalsPath(stateDir: string): string {
  return `${stateDir}/inbox-recommendation-refusals.json`;
}

function seedMarkerPath(stateDir: string): string {
  return `${stateDir}/inbox-recommendation-seeds.json`;
}

function readJsonObject<T>(path: string): Record<string, T> {
  const raw = readFileIfExists(path);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, T>) : {};
  } catch {
    // deliberate: an unreadable store reads as empty; the items show no recommendation and the writer refills it.
    return {};
  }
}

export function readRecommendationStore(path: string): RecommendationStore {
  return readJsonObject<StoredRecommendation>(path);
}

/** The task a proposal id names, when it names one. */
export function recommendationTaskId(proposalId: string): string | undefined {
  return /^(?:machine-judge|verify-human):([A-Z][A-Z0-9]*-T[A-Za-z0-9]+)$/.exec(proposalId)?.[1];
}

export function recommendationFingerprint(proposal: { id: string; summary: string }, lane: InboxOptionLane, shardBlob?: string): string {
  const parts: string[] = ["inbox-recommendation-v1", proposal.id, proposal.summary, lane];
  if (recommendationTaskId(proposal.id) !== undefined && shardBlob !== undefined) parts.push(shardBlob);
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((e) => typeof e === "string");
}

function wellShaped(x: unknown): x is StoredRecommendation {
  if (!x || typeof x !== "object") return false;
  const r = x as Partial<StoredRecommendation>;
  return isOptionIntent(r.action) && typeof r.why === "string" && isStringArray(r.evidence) && typeof r.obsolete === "boolean" &&
    typeof r.generatedAt === "string" && (r.source === "writer" || r.source === "operator-session-seed") &&
    typeof r.sourceFingerprint === "string" && (r.text === undefined || typeof r.text === "string") &&
    (r.group === undefined || typeof r.group === "string");
}

function servedFields(r: InboxRecommendation): InboxRecommendation {
  return {
    action: r.action, ...(r.text === undefined ? {} : { text: r.text }), why: r.why, evidence: [...r.evidence], obsolete: r.obsolete,
    ...(r.group === undefined ? {} : { group: r.group }), generatedAt: r.generatedAt, source: r.source,
  };
}

/** What one captured pass of the selected repository says is current: each shard task's blob, and the tasks that
 *  live in the plan monolith. Read from {@link recommendationSourcePath}, never from the recommendation store. */
export interface RecommendationQualification {
  repository: string;
  commit: string;
  tasks: Record<string, string>;
  monolith: string[];
}

export function recommendationSourcePath(stateDir: string): string {
  return `${stateDir}/inbox-recommendation-source.json`;
}

/** The writer's last captured source, or undefined when none is readable or well shaped. */
export function readRecommendationSource(stateDir: string): RecommendationQualification | undefined {
  const raw = readJsonObject<unknown>(recommendationSourcePath(stateDir));
  const { repository, commit, tasks, monolith } = raw as Partial<Record<keyof RecommendationQualification, unknown>>;
  if (typeof repository !== "string" || repository === "" || typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) return undefined;
  if (!tasks || typeof tasks !== "object" || Array.isArray(tasks) || !Object.values(tasks).every((b) => typeof b === "string")) return undefined;
  if (!isStringArray(monolith)) return undefined;
  return { repository, commit, tasks: tasks as Record<string, string>, monolith };
}

/** The qualification narrowed to the given proposals' tasks, so the persisted stores carry only what they cite. */
export function narrowQualification(source: RecommendationQualification, proposalIds: Iterable<string>): RecommendationQualification {
  const tasks: Record<string, string> = {};
  const monolith = new Set<string>();
  for (const id of proposalIds) {
    const taskId = recommendationTaskId(id);
    if (taskId === undefined) continue;
    if (source.tasks[taskId] !== undefined) tasks[taskId] = source.tasks[taskId]!;
    if (source.monolith.includes(taskId)) monolith.add(taskId);
  }
  return { repository: source.repository, commit: source.commit, tasks, monolith: [...monolith] };
}

/** The item's current recommendation with its route, or undefined: none stored, a changed source, a fleet item, or no
 *  independently captured current repository evidence that the stored advice still matches. */
export function recommendationFor(proposal: { id: string; summary: string }, lane: InboxOptionLane, store: RecommendationStore,
  classification: Parameters<typeof classifiedInboxOwner>[1] = {}, source?: RecommendationQualification): ServedRecommendation | undefined {
  if (classifiedInboxOwner(proposal, classification) !== "operator") return undefined;
  const stored = store[proposal.id];
  if (!wellShaped(stored) || source === undefined) return undefined;
  if (stored.repository !== undefined && stored.repository !== source.repository) return undefined;
  const taskId = recommendationTaskId(proposal.id);
  let currentBlob: string | undefined;
  if (taskId === undefined) {
    // A non-task recommendation is served only when it proves the repository it was written for.
    if (stored.repository !== source.repository) return undefined;
  } else {
    currentBlob = source.tasks[taskId];
    if (currentBlob !== undefined ? stored.shardBlob !== currentBlob : stored.shardBlob !== undefined || !source.monolith.includes(taskId)) return undefined;
  }
  if (stored.sourceFingerprint !== recommendationFingerprint(proposal, lane, currentBlob)) return undefined;
  const route = optionAction(stored.action, lane, proposal.id);
  return { ...servedFields(stored), ...(route ? { route } : {}) };
}

// ── Evidence on main ───────────────────────────────────────────────────────────────────────────

export type EvidenceKind = "pr" | "sha" | "task" | "path";

/** What the writer and the checker read from origin/main. */
export interface RecommendationEvidence {
  /** Every task record in the plan's shard directory on main, by task id: its path and blob. */
  shards(): Promise<Map<string, { path: string; blob: string }>>;
  shardText(path: string): Promise<string | undefined>;
  /** Commits on main that name the task, newest first, as "sha subject" lines. */
  taskHistory(taskId: string): Promise<string[]>;
  /** The kind an evidence entry resolves as on main, or undefined when it resolves as nothing. */
  resolve(entry: string): Promise<EvidenceKind | undefined>;
  /** Fix one verified commit of the selected repository and read everything from it; refuses a foreign or unreadable
   *  repository. Absent from a fake, which then reads as one unpinned pass. */
  pin?(): Promise<PinnedRecommendationEvidence>;
}

export interface PinnedRecommendationEvidence extends RecommendationEvidence {
  repository: string;
  commit: string;
  /** Every shard task's blob and the plan-monolith task ids, at the pinned commit. */
  qualification(): Promise<RecommendationQualification>;
  /** Throws when the selected repository's main moved off the pinned commit. */
  assertUnchanged(): Promise<void>;
}

export type GitRunner = (args: string[]) => Promise<string>;

async function succeeds(run: Promise<unknown>): Promise<boolean> {
  try {
    await run;
    return true;
  } catch {
    // deliberate: git exits non-zero for "not found", which is the answer here.
    return false;
  }
}

/** {@link RecommendationEvidence} over git against origin/main; `plan` names the plan monolith and its directory,
 *  repo-relative, as the repo layout resolves them. */
export function gitRecommendationEvidence(git: GitRunner, plan: { planDir: string; planMonolith: string },
  selected?: { repository: string; checkoutRoot: string }): RecommendationEvidence {
  const evidence = evidenceAt(git, plan, "origin/main");
  if (!selected) return evidence;
  return {
    ...evidence,
    pin: async () => {
      const top = (await git(["rev-parse", "--show-toplevel"])).trim();
      if (top === "" || realpathSync(top) !== realpathSync(selected.checkoutRoot)) {
        throw new Error(`recommendation source ${top} is not the selected checkout ${selected.checkoutRoot}`);
      }
      const commit = (await git(["rev-parse", "--verify", "origin/main^{commit}"])).trim();
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("recommendation source commit is unreadable");
      const at = evidenceAt(git, plan, commit);
      return {
        ...at, repository: selected.repository, commit,
        qualification: async () => {
          const tasks: Record<string, string> = {};
          for (const [id, shard] of await at.shards()) tasks[id] = shard.blob;
          const present = await succeeds(git(["cat-file", "-e", `${commit}:${plan.planMonolith}`]));
          const text = present ? await git(["show", `${commit}:${plan.planMonolith}`]) : "";
          const monolith = [...text.matchAll(/^- id: ([A-Z][A-Z0-9]*-T[A-Za-z0-9]+)[ \t]*$/gm)].map((m) => m[1]!).filter((id) => tasks[id] === undefined);
          return { repository: selected.repository, commit, tasks, monolith };
        },
        assertUnchanged: async () => {
          const now = (await git(["rev-parse", "--verify", "origin/main^{commit}"])).trim();
          if (now !== commit) throw new Error(`recommendation source moved from ${commit} to ${now} during the pass`);
        },
      };
    },
  };
}

function evidenceAt(git: GitRunner, plan: { planDir: string; planMonolith: string }, ref: string): RecommendationEvidence {
  const shardDir = `${plan.planDir}/tasks.d/`;
  return {
    shards: async () => {
      const out = await git(["ls-tree", ref, shardDir]);
      const shards = new Map<string, { path: string; blob: string }>();
      for (const line of out.split("\n")) {
        const [meta, path] = line.split("\t");
        const blob = /^\d+ blob ([0-9a-f]+)$/.exec(meta ?? "")?.[1];
        const id = path?.startsWith(shardDir) ? /^([A-Z][A-Z0-9]*-T[A-Za-z0-9]+)-[^/]*\.ya?ml$/.exec(path.slice(shardDir.length))?.[1] : undefined;
        if (blob && id) shards.set(id, { path: path!, blob });
      }
      return shards;
    },
    shardText: async (path) => {
      try {
        return await git(["show", `${ref}:${path}`]);
      } catch {
        // deliberate: a record that left main between the listing and this read is context the writer goes without.
        return undefined;
      }
    },
    taskHistory: async (taskId) => {
      const out = await git(["log", ref, "-n", "20", "--format=%h %s", "--fixed-strings", `--grep=${taskId}`]);
      return out.split("\n").filter((l) => l.trim() !== "");
    },
    resolve: async (entry) => {
      const value = entry.trim();
      const pr = /^#(\d+)$/.exec(value)?.[1];
      if (pr !== undefined) {
        try {
          const hit = await git(["log", ref, "-n", "1", "--format=%H", "--fixed-strings", `--grep=(#${pr})`]);
          return hit.trim() !== "" ? "pr" : undefined;
        } catch {
          // deliberate: a log that cannot be read proves nothing, so the entry does not resolve.
          return undefined;
        }
      }
      if (/^[0-9a-f]{7,40}$/.test(value)) return (await succeeds(git(["merge-base", "--is-ancestor", value, ref]))) ? "sha" : undefined;
      if (/^[A-Z][A-Z0-9]*-T[A-Za-z0-9]+$/.test(value)) {
        return (await succeeds(git(["grep", "-q", "-e", `^- id: ${value}[[:space:]]*$`, ref, "--", plan.planMonolith, shardDir]))) ? "task" : undefined;
      }
      const path = value.replace(/:\d+(?:-\d+)?$/, "");
      if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(path) || path.split("/").includes("..")) return undefined;
      return (await succeeds(git(["cat-file", "-e", `${ref}:${path}`]))) ? "path" : undefined;
    },
  };
}

// ── The checker (writer output only) ───────────────────────────────────────────────────────────

export interface RecommendationCheck {
  ok: boolean;
  problems: string[];
}

/** Refuse an answer whose action the lane cannot route, whose input is missing, whose why is empty, whose evidence
 *  does not resolve on main, or that claims obsolete without a merged PR or a sha on main. */
export async function checkRecommendation(
  answer: unknown,
  item: { id: string; lane: InboxOptionLane; ifNothingHappens?: string },
  evidence: Pick<RecommendationEvidence, "resolve">,
): Promise<RecommendationCheck> {
  const problems: string[] = [];
  const a = (answer && typeof answer === "object" ? answer : {}) as Record<string, unknown>;
  if (!isOptionIntent(a.action)) {
    problems.push("action must be one of approve, decline, reframe, reply, keep");
    return { ok: false, problems };
  }
  const route = optionAction(a.action, item.lane, item.id);
  if (a.action !== "keep" && route === undefined) problems.push(`this item cannot be routed to ${a.action} from where it sits`);
  if (route?.input !== undefined && (typeof a.text !== "string" || a.text.trim() === "")) problems.push(`${a.action} posts a ${route.input}; give its exact text`);
  const why = typeof a.why === "string" ? a.why : undefined;
  const parts = checkOperatorMessage({ speaker: INBOX_SPEAKER, whatHappened: why, whatIsAsked: a.action, consequenceOfInaction: item.ifNothingHappens ?? null });
  for (const part of parts.missing) problems.push(`the why is missing its ${part}`);
  if (typeof a.obsolete !== "boolean") problems.push("obsolete must be true or false");
  if (a.group !== undefined && typeof a.group !== "string") problems.push("group must be text");
  const entries = isStringArray(a.evidence) ? a.evidence : undefined;
  if (entries === undefined) problems.push("evidence must be a list of PR numbers, shas, task ids or file paths");
  const kinds: EvidenceKind[] = [];
  for (const entry of entries ?? []) {
    const kind = await evidence.resolve(entry);
    if (kind === undefined) problems.push(`evidence "${entry}" does not resolve on main`);
    else kinds.push(kind);
  }
  if (a.obsolete === true && !kinds.some((k) => k === "pr" || k === "sha")) {
    problems.push("obsolete needs a merged PR or a commit on main as evidence");
  }
  return { ok: problems.length === 0, problems };
}

// ── The writer ─────────────────────────────────────────────────────────────────────────────────

export interface RecommendationContext {
  proposal: { id: string; summary: string };
  lane: InboxOptionLane;
  plain?: { headline: string; whatHappened: string; whatWeNeed: string; ifNothingHappens: string };
  shardText?: string;
  history: string[];
}

export function buildRecommendationPrompt(ctx: RecommendationContext, retryProblems: string[] = []): string {
  const routable = (["approve", "decline", "reframe", "reply"] as const).filter((a) => optionAction(a, ctx.lane, ctx.proposal.id) !== undefined);
  return [
    "You recommend ONE decision on an inbox item for the operator of an autonomous software fleet.",
    "Respond with ONLY a JSON object, no prose and no markdown fence, shaped EXACTLY:",
    '{"action": string, "text": string (when the action posts text), "why": string (one plain sentence),',
    ' "evidence": [string, ...], "obsolete": boolean, "group": string (optional)}',
    `"action" is one of: ${[...routable, "keep"].join(", ")}. keep leaves the item as it is and posts nothing.`,
    'decline posts a reason, reframe posts feedback, reply posts a question: put that exact text in "text".',
    'Every "evidence" entry is a merged PR number ("#11199"), a commit sha on main, a task id ("W1-T8918"), or a file path ("src/lib/inbox.ts:1655").',
    '"obsolete" is true only when a merged PR or a commit on main already resolves the item; then cite it in "evidence".',
    'Give "group" when this item shares one root cause with other items, naming that cause in a few words.',
    ...(retryProblems.length > 0 ? [`Your last answer was refused for: ${retryProblems.join("; ")}. Answer again without those.`] : []),
    "",
    `Item: ${ctx.proposal.id} (sits in ${ctx.lane})`,
    `Summary: ${ctx.proposal.summary}`,
    ...(ctx.plain ? [`Plain message: ${ctx.plain.headline}. ${ctx.plain.whatHappened} ${ctx.plain.whatWeNeed} If nothing happens: ${ctx.plain.ifNothingHappens}`] : []),
    ...(ctx.shardText !== undefined ? ["", "The task record on main:", ctx.shardText] : []),
    ...(ctx.history.length > 0 ? ["", "Commits on main that name the task, newest first:", ...ctx.history] : []),
  ].join("\n");
}

/** The production writer: the summarize lane's mount, with this module's prompt. Untested by unit, like every real spawn. */
export function realRecommendationWriter(opts: { mount: Mount; cwd: string; settingsFile: string; spawn?: typeof spawnWorker }): (input: SummarizeInput) => Promise<unknown> {
  const spawn = opts.spawn ?? benchmarkNonDispatchSpawn("feedback-summary");
  return async ({ context: prompt }) => {
    const args = buildDecisionSummarySpawnArgs({ input: { context: "" }, mount: opts.mount, cwd: opts.cwd, settingsFile: opts.settingsFile });
    const result = await spawn({ ...args, prompt });
    const match = /\{[\s\S]*\}/.exec(result.text);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      // deliberate: an unparseable answer is a refused answer; the checker names it.
      return null;
    }
  };
}

/** What the writer reads beyond the plain backfill's seam, whose `summarize` it takes as the writer: each prompt
 *  arrives as `context`, whole. Absent `summarize`, only the seed is imported. */
export interface RecommendationSources {
  evidence: RecommendationEvidence;
  /** The committed seed's text; absent or unreadable, nothing is seeded. */
  readSeed?: () => string | undefined;
  /** Each proposal's lane, from serve's classification snapshot by default. */
  readLanes?: () => Record<string, InboxOptionLane>;
  clock?: Clock;
}

export type RecommendationBackfill = PlainBackfillDeps & RecommendationSources;

const LANE_OF_STATE: Readonly<Record<string, InboxOptionLane>> = {
  ready: "ready", drafting: "drafting", not_ready: "notReady", deferred_with_trigger: "notReady", declined: "declined",
};

function snapshotLanes(snapshot: ReturnType<typeof readClassificationSnapshot>): Record<string, InboxOptionLane> {
  const lanes: Record<string, InboxOptionLane> = {};
  for (const [id, state] of Object.entries(snapshot?.states ?? {})) {
    const lane = LANE_OF_STATE[state];
    if (lane) lanes[id] = lane;
  }
  return lanes;
}

interface CurrentItem {
  proposal: { id: string; summary: string };
  lane: InboxOptionLane;
  shard?: { path: string; blob: string };
  fingerprint: string;
}

function parseSeed(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as { recommendations?: unknown };
    const recs = parsed?.recommendations;
    return recs && typeof recs === "object" && !Array.isArray(recs) ? (recs as Record<string, unknown>) : {};
  } catch {
    // deliberate: an unreadable seed seeds nothing; the writer still writes every item.
    return {};
  }
}

/** Import the operator-session seed once: each entry whose item is still a current operator item with no stored
 *  recommendation, at the item's current fingerprint. The checker is not applied. Returns how many it imported. */
function importSeedOnce(deps: RecommendationBackfill, items: Map<string, CurrentItem>, store: RecommendationStore,
  stamp: { repository?: string; sourceCommit?: string }): number {
  if (!deps.readSeed) return 0;
  const markers = readJsonObject<{ importedAt: string; ids: string[] }>(seedMarkerPath(deps.stateDir));
  if (markers[SEED_NAME] !== undefined) return 0;
  const imported: string[] = [];
  for (const [id, entry] of Object.entries(parseSeed(deps.readSeed()))) {
    const item = items.get(id);
    if (!item || store[id] !== undefined) continue;
    const r = entry as Partial<InboxRecommendation>;
    if (!isOptionIntent(r.action) || typeof r.why !== "string" || !isStringArray(r.evidence) || typeof r.obsolete !== "boolean") continue;
    store[id] = {
      action: r.action, ...(typeof r.text === "string" ? { text: r.text } : {}), why: r.why, evidence: r.evidence, obsolete: r.obsolete,
      ...(typeof r.group === "string" ? { group: r.group } : {}),
      generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : (deps.clock ?? systemClock).iso(),
      source: "operator-session-seed", ...stamp, sourceFingerprint: item.fingerprint, ...(item.shard ? { shardBlob: item.shard.blob } : {}),
    };
    imported.push(id);
  }
  markers[SEED_NAME] = { importedAt: (deps.clock ?? systemClock).iso(), ids: imported };
  writeAtomic(seedMarkerPath(deps.stateDir), JSON.stringify(markers, null, 2) + "\n");
  return imported.length;
}

export interface RecommendationTick {
  seeded: number;
  written: number;
  refused: number;
  dropped: number;
}

/** One tick: drop recommendations whose task record changed on main, import the seed once, then write at most `max`
 *  items with no current recommendation, oldest registry order first. */
export async function backfillRecommendations(deps: RecommendationBackfill, max: number): Promise<RecommendationTick> {
  const tick: RecommendationTick = { seeded: 0, written: 0, refused: 0, dropped: 0 };
  const snapshot = readClassificationSnapshot(deps.stateDir);
  const lanes = deps.readLanes ? deps.readLanes() : snapshotLanes(snapshot);
  // One verified commit of the selected repository is read for the whole pass; a pass that cannot pin it stores nothing.
  const pinned = deps.evidence.pin ? await deps.evidence.pin() : undefined;
  const evidence: RecommendationEvidence = pinned ?? deps.evidence;
  const stamp = pinned ? { repository: pinned.repository, sourceCommit: pinned.commit } : {};
  const shards = await evidence.shards();
  if (pinned) {
    // The independently captured current source the reader qualifies stored advice against.
    const captured = await pinned.qualification();
    await pinned.assertUnchanged();
    writeAtomic(recommendationSourcePath(deps.stateDir), JSON.stringify(captured, null, 2) + "\n");
  }
  const items = new Map<string, CurrentItem>();
  for (const proposal of deps.readProposals()) {
    const lane = lanes[proposal.id];
    const ownership = { displayOwner: snapshot?.displayOwners?.[proposal.id],
      ...(snapshot?.restoredForReview?.includes(proposal.id) ? { requiresReview: true } : {}) };
    if (lane === undefined || classifiedInboxOwner(proposal, ownership) !== "operator") continue;
    const taskId = recommendationTaskId(proposal.id);
    const shard = taskId === undefined ? undefined : shards.get(taskId);
    items.set(proposal.id, { proposal, lane, ...(shard ? { shard } : {}), fingerprint: recommendationFingerprint(proposal, lane, shard?.blob) });
  }
  const path = recommendationStorePath(deps.stateDir);
  const store = readRecommendationStore(path);
  let changed = false;
  for (const [id, stored] of Object.entries(store)) {
    const item = items.get(id);
    if (item && recommendationTaskId(id) !== undefined && stored?.shardBlob !== item.shard?.blob) {
      delete store[id];
      tick.dropped += 1;
      changed = true;
    }
  }
  tick.seeded = importSeedOnce(deps, items, store, stamp);
  if (changed || tick.seeded > 0) writeAtomic(path, JSON.stringify(store, null, 2) + "\n");
  const ask = deps.summarize;
  if (!ask) return tick;
  const refusals = readJsonObject<string>(refusalsPath(deps.stateDir));
  const pending = [...items.values()]
    .filter((item) => store[item.proposal.id]?.sourceFingerprint !== item.fingerprint && refusals[item.proposal.id] !== item.fingerprint)
    .slice(0, max);
  const plainStore = readPlainStore(plainStorePath(deps.stateDir));
  for (const item of pending) {
    const taskId = recommendationTaskId(item.proposal.id);
    const plain = plainInboxMessage(item.proposal, plainStore);
    const ctx: RecommendationContext = {
      proposal: item.proposal, lane: item.lane, plain,
      ...(item.shard ? { shardText: await evidence.shardText(item.shard.path) } : {}),
      history: taskId === undefined ? [] : await evidence.taskHistory(taskId),
    };
    let problems: string[] = [];
    let accepted: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 2 && accepted === undefined; attempt += 1) {
      const answer = await ask({ context: buildRecommendationPrompt(ctx, problems) });
      const check = await checkRecommendation(answer, { id: item.proposal.id, lane: item.lane, ifNothingHappens: plain.ifNothingHappens }, evidence);
      if (check.ok) accepted = answer as Record<string, unknown>;
      else problems = check.problems;
    }
    const latest = readRecommendationStore(path);
    if (accepted === undefined) {
      const fresh = readJsonObject<string>(refusalsPath(deps.stateDir));
      fresh[item.proposal.id] = item.fingerprint;
      writeAtomic(refusalsPath(deps.stateDir), JSON.stringify(fresh, null, 2) + "\n");
      tick.refused += 1;
      continue;
    }
    const a = accepted as unknown as InboxRecommendation;
    // A source that moved or changed during the answer is refused rather than stored as current.
    await pinned?.assertUnchanged();
    latest[item.proposal.id] = {
      action: a.action, ...(typeof a.text === "string" && a.text.trim() !== "" ? { text: a.text } : {}), why: a.why, evidence: a.evidence, obsolete: a.obsolete,
      ...(typeof a.group === "string" && a.group.trim() !== "" ? { group: a.group } : {}),
      generatedAt: (deps.clock ?? systemClock).iso(), source: "writer", ...stamp,
      sourceFingerprint: item.fingerprint, ...(item.shard ? { shardBlob: item.shard.blob } : {}),
    };
    writeAtomic(path, JSON.stringify(latest, null, 2) + "\n");
    tick.written += 1;
  }
  return tick;
}

/** Run {@link backfillRecommendations} on its own timer, one item per tick, never two at once, beside the plain
 *  backfill (the W1-T4077 pump pattern), so a busy daemon main loop never delays it. */
export function startRecommendationBackfill(
  deps: RecommendationBackfill,
  intervalMs: number,
  log: (step: string, extra?: Record<string, unknown>) => void,
): { stop: () => void; settled: () => Promise<void>; isBusy: () => boolean } {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running) return;
    running = backfillRecommendations(deps, 1)
      .then((t) => {
        if (t.seeded > 0) log("inbox.recommendation_seeded", { count: t.seeded });
        if (t.written > 0) log("inbox.recommendation_written", { count: t.written });
        if (t.refused > 0) log("inbox.recommendation_refused", { count: t.refused });
        if (t.dropped > 0) log("inbox.recommendation_dropped", { count: t.dropped });
      })
      .catch((e) => log("inbox.recommendation_failed", { error: String((e as Error)?.message ?? e) }))
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    isBusy: () => running !== undefined,
    settled: async () => {
      await running;
    },
  };
}
