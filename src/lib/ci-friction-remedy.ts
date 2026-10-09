/**
 * lib/ci-friction-remedy.ts — what happens AFTER the ci-friction gardener (W1-T4435) finds a cause.
 *
 * MEASURED 2026-10-02, before this module: eight filings, six built, and every build PR only appended
 * a paragraph to docs/ci-friction-remedies.md — the shard declared that file alone and its proof
 * grepped it, and nothing in the repo reads it. A landed filing then marked its cause decided for
 * good, and the overseer's effect reading compared half-life-decayed minutes, which fall with time
 * and fleet volume whatever was built: causes that never got a remedy fell as far as those that did.
 * The gardener found the right causes and nothing happened with them.
 *
 * THREE DECISIONS LIVE HERE, each from evidence the fleet already writes:
 *
 * 1. WHAT A REMEDY IS. A drafted task names the code that OWNS its cause ({@link locateCiFrictionOwner}:
 *    the source that raises a refusal's reason, the script behind a CI check, the file a main merge
 *    conflicts on), a new regression test, and an evidence pack of real rounds. A docs-only record is
 *    rung 0 and never counts as a remedy.
 * 2. WHETHER IT WORKED ({@link ciFrictionRemedyEffect}). The cause's SHARE of all priced fix rounds,
 *    in equal windows before and after the remedy's BUILD merged (its `Remudero-Task:` trailer, never
 *    the filing PR's merge). A share is volume-invariant, so a quiet fleet is not a fixed cause. Credit
 *    needs a one-sided significant fall; debit needs the after-window to hold at least the evidence the
 *    before-window held with no such fall. Neither is a tuned constant: the bar scales with the cause.
 * 3. WHAT HAPPENS NEXT ({@link ciFrictionCauseState}). A remedy that did not move the share reopens its
 *    cause one rung up (`ci-friction:<cause>#r<N>`), carrying what the last rung tried and measured; the
 *    third failed rung goes to a person instead of a fourth task.
 */
import { fixedClock } from "./clock.js";

/** The fields of one priced round this module reads. */
export interface RemedyRound {
  pr: number;
  causeKey: string;
  at?: string;
  detail?: string;
}

/** The legacy remedies file: a record declaring only it (or no files) is rung 0 — not a remedy. */
export const CI_FRICTION_REMEDIES_DOC = "docs/ci-friction-remedies.md";

/** The rung at which a cause stops being re-drafted and goes to a person. */
export const CI_FRICTION_ESCALATE_RUNG = 3;

/** One plan task whose `origin:` names a ci-friction cause. */
export interface CiFrictionRemedyTask {
  /** Exact changed owning-file blob from a credited source build, never a status flip. */
  preventionSource?: import("./prevention-source-evidence.js").PreventionSourceRegistration | { state: "unavailable"; reason: string };
  id: string;
  origin: string;
  status: string;
  /** A `retirement:` field is present (retired, withdrawn, superseded). */
  retired: boolean;
  files: string[];
  /** When the task's BUILD merged to main (its `Remudero-Task:` trailer), when it has. */
  mergedAt?: string;
  /** The shard file it was read from. */
  path?: string;
}

/** `ci-friction:<key>` is rung 1; `ci-friction:<key>#r<N>` is rung N. */
export function parseCiFrictionOrigin(origin: string): { key: string; rung: number } | undefined {
  const m = /^ci-friction:(.+?)(?:#r(\d+))?$/.exec(origin);
  return m ? { key: m[1]!, rung: m[2] === undefined ? 1 : Number(m[2]) } : undefined;
}

/** The origin a draft at `rung` carries — rung 1 keeps the original, unsuffixed spelling. */
export function ciFrictionRungOrigin(key: string, rung: number): string {
  return rung <= 1 ? `ci-friction:${key}` : `ci-friction:${key}#r${rung}`;
}

/** A record that can only ever change prose: it declares nothing, or only the remedies doc. */
export function isDocOnlyRemedy(task: Pick<CiFrictionRemedyTask, "files">): boolean {
  return task.files.length === 0 || task.files.every((f) => f === CI_FRICTION_REMEDIES_DOC);
}

/** The rung a task holds: a docs-only record is rung 0 whatever its origin says. */
export function remedyRung(task: CiFrictionRemedyTask): number {
  return isDocOnlyRemedy(task) ? 0 : parseCiFrictionOrigin(task.origin)?.rung ?? 1;
}

// ── Effect ─────────────────────────────────────────────────────────────────────────────────

export interface ShareWindow {
  /** Rounds of the cause in the window. */
  k: number;
  /** Every priced round in the window. */
  n: number;
}

export type RemedyVerdict = "credit" | "debit" | "pending" | "unmeasurable";

export interface RemedyEffect {
  verdict: RemedyVerdict;
  before: ShareWindow;
  after: ShareWindow;
  /** The window each side spans, in days. */
  windowDays: number;
  /** The one-sided z score of the fall (negative = the share fell). */
  z: number;
  /** Why, in one line, for a ledger row and a task's evidence pack. */
  reason: string;
}

/** A significant one-sided fall: the 5% tail of a normal z. A statistics convention, not a tuned bar. */
const ONE_SIDED_Z = -1.6449;

/** The longest window either side spans, so an old remedy is judged on recent behaviour. PRIMARY CONTROL:
 *  it sets the measurement, it never fires on a failure. */
export const CI_FRICTION_EFFECT_MAX_WINDOW_MS = 14 * 24 * 3_600_000;

const share = (w: ShareWindow): number => (w.n > 0 ? w.k / w.n : 0);

/**
 * Did the cause's share of fix rounds fall after the remedy merged? Windows are equal: `after` runs from
 * the merge to now, `before` spans the same length ending at the merge (each capped at
 * {@link CI_FRICTION_EFFECT_MAX_WINDOW_MS}).
 */
export function ciFrictionRemedyEffect(rounds: readonly RemedyRound[], causeKey: string, mergedAtMs: number, nowMs: number): RemedyEffect {
  const span = Math.min(Math.max(0, nowMs - mergedAtMs), CI_FRICTION_EFFECT_MAX_WINDOW_MS);
  const before: ShareWindow = { k: 0, n: 0 };
  const after: ShareWindow = { k: 0, n: 0 };
  for (const r of rounds) {
    const t = r.at === undefined ? NaN : Date.parse(r.at);
    if (!Number.isFinite(t)) continue;
    const side = t >= mergedAtMs && t <= mergedAtMs + span ? after : t < mergedAtMs && t >= mergedAtMs - span ? before : undefined;
    if (!side) continue;
    side.n += 1;
    if (r.causeKey === causeKey) side.k += 1;
  }
  const windowDays = Math.round((span / 86_400_000) * 10) / 10;
  if (before.k === 0 || before.n === 0) {
    return { verdict: "unmeasurable", before, after, windowDays, z: 0, reason: `no ${causeKey} round in the ${windowDays}-day window before the merge, so no fall can be measured` };
  }
  const pooled = (before.k + after.k) / (before.n + after.n);
  const se = after.n > 0 ? Math.sqrt(pooled * (1 - pooled) * (1 / before.n + 1 / after.n)) : 0;
  const z = se > 0 ? (share(after) - share(before)) / se : 0;
  const pct = (w: ShareWindow) => `${(share(w) * 100).toFixed(1)}% (${w.k}/${w.n})`;
  const line = `share of fix rounds ${pct(before)} before, ${pct(after)} after, over ${windowDays} day(s) each side`;
  if (after.n > 0 && z <= ONE_SIDED_Z) return { verdict: "credit", before, after, windowDays, z, reason: `fell: ${line}` };
  // Equal evidence: the after window has seen as many rounds as the before window needed to show
  // the cause `before.k` times. A remedy is never debited on less evidence than it was filed on.
  const expectedAfter = share(before) * after.n;
  if (expectedAfter >= before.k) return { verdict: "debit", before, after, windowDays, z, reason: `did not fall: ${line}` };
  return { verdict: "pending", before, after, windowDays, z, reason: `measuring: ${line}` };
}

// ── The reopen ladder ──────────────────────────────────────────────────────────────────────

export type CiFrictionCauseState =
  /** No task carries this cause at an open rung: draft it at `rung`. `prior` is what the last rung tried. */
  | { state: "draft"; key: string; rung: number; prior?: { task: CiFrictionRemedyTask; effect?: RemedyEffect } }
  /** A task is queued, blocked by the judge, or building. */
  | { state: "in_progress"; key: string; task: CiFrictionRemedyTask }
  /** The remedy merged and its effect is still being measured. */
  | { state: "measuring"; key: string; task: CiFrictionRemedyTask; effect: RemedyEffect }
  /** The remedy merged and the cause's share fell. */
  | { state: "resolved"; key: string; task: CiFrictionRemedyTask; effect: RemedyEffect }
  /** A person or the judge retired the last record; a retirement is a decision, never re-drafted. */
  | { state: "retired"; key: string; task: CiFrictionRemedyTask }
  /** The ladder ran out: a person decides. */
  | { state: "escalate"; key: string; rung: number; prior: { task: CiFrictionRemedyTask; effect?: RemedyEffect } };

const isOpen = (t: CiFrictionRemedyTask): boolean => !t.retired && t.status !== "merged" && t.mergedAt === undefined;

/**
 * Where one cause stands, from every plan task naming it and the rounds the gardener priced. Only the
 * HIGHEST rung decides: a lower rung's outcome is history the higher rung already carries.
 */
export function ciFrictionCauseState(
  key: string,
  tasks: readonly CiFrictionRemedyTask[],
  rounds: readonly RemedyRound[],
  nowMs: number,
  receipts: ReadonlySet<string> = new Set(),
): CiFrictionCauseState {
  const mine = tasks.filter((t) => parseCiFrictionOrigin(t.origin)?.key === key);
  if (mine.length === 0) {
    // A filing PR that landed (a receipt) but whose shard is not on main yet still holds rung 1.
    return receipts.has(ciFrictionRungOrigin(key, 1))
      ? { state: "in_progress", key, task: { id: "(filing PR open)", origin: ciFrictionRungOrigin(key, 1), status: "filing", retired: false, files: [] } }
      : { state: "draft", key, rung: 1 };
  }
  const open = mine.find(isOpen);
  if (open) return { state: "in_progress", key, task: open };
  const top = [...mine].sort((a, b) => remedyRung(b) - remedyRung(a) || (Date.parse(b.mergedAt ?? "") || 0) - (Date.parse(a.mergedAt ?? "") || 0))[0]!;
  const rung = remedyRung(top);
  // Every rung that already has a record is spoken for; a reopened draft takes the next free one.
  const nextFree = (from: number): number => {
    let r = Math.max(1, from);
    // A receipt holds a rung only until its record reaches main; from then the record decides, and a
    // docs-only record holds no rung (2026-10-02: every reopened cause skipped to rung 2 on its receipt).
    const held = (origin: string) => receipts.has(origin) && !mine.some((t) => t.origin === origin);
    while (held(ciFrictionRungOrigin(key, r)) || mine.some((t) => parseCiFrictionOrigin(t.origin)?.rung === r && !isDocOnlyRemedy(t))) r += 1;
    return r;
  };
  if (top.retired && top.mergedAt === undefined) {
    // A docs-only record that a person retired was retiring the doc, not the cause.
    return rung === 0 ? { state: "draft", key, rung: nextFree(1), prior: { task: top } } : { state: "retired", key, task: top };
  }
  if (rung === 0) return { state: "draft", key, rung: nextFree(1), prior: { task: top } };
  const mergedAtMs = Date.parse(top.mergedAt ?? "");
  if (!Number.isFinite(mergedAtMs)) {
    // Status says merged but no trailer names the build: measure nothing, wait for the trailer.
    return { state: "in_progress", key, task: top };
  }
  const effect = ciFrictionRemedyEffect(rounds, key, mergedAtMs, nowMs);
  if (effect.verdict === "credit") return { state: "resolved", key, task: top, effect };
  if (effect.verdict === "debit") {
    const next = nextFree(rung + 1);
    return next >= CI_FRICTION_ESCALATE_RUNG
      ? { state: "escalate", key, rung: next, prior: { task: top, effect } }
      : { state: "draft", key, rung: next, prior: { task: top, effect } };
  }
  // "unmeasurable" (the cause had stopped before the merge) is a resolved cause by another road.
  if (effect.verdict === "unmeasurable") return { state: "resolved", key, task: top, effect };
  return { state: "measuring", key, task: top, effect };
}

// ── Locating the owner of a cause ──────────────────────────────────────────────────────────

export interface OwnerSearch {
  /** Files under `src/` or `scripts/` (never tests, docs or plan) containing `term` literally as a whole token, each
   *  with its hit count. */
  filesContaining: (term: string) => Array<{ file: string; hits: number }>;
  fileExists: (file: string) => boolean;
  pin?: () => OwnerSearch;
  workflowOwner?: (family: string) => CiFrictionOwner | undefined;
  /** The checks `workflowOwner` resolved to no owner because a workflow could not be read or told apart, and why. */
  workflowGaps?: () => Array<{ family: string; reason: string }>;
  evidence?: (key: string, details: readonly string[], owner?: CiFrictionOwner) => CiFrictionOwnershipEvidence;
}

export interface CiFrictionOwnershipEvidence {
  fingerprint: string;
  revision: string;
}

export interface CiFrictionOwner {
  /** The code a remedy must change, most-implicated first (at most two). */
  files: string[];
  /** One line per file: the literal that tied it to the cause. */
  why: string[];
  /** A failing test the cause's rounds name, when they name one — evidence, not a file to edit. */
  failingTest?: string;
}

const OWNER_LIMIT = 2;

/** The search terms a cause's own rounds supply: the stable head of a refusal's reason, a check's name. */
export function ownerSearchTerms(key: string, details: readonly string[]): string[] {
  const [kind, ...rest] = key.split(":");
  const name = rest.join(":");
  const terms: string[] = [];
  if (kind === "fix_refusal") {
    for (const d of details) {
      const head = d.split(/ — |: /)[0]!.replace(/\b[0-9a-f]{7,40}\b/g, "").trim();
      if (head.length >= 12) terms.push(head);
    }
  } else if (kind === "check") {
    const [first, family] = name.split(":");
    const check = first === "ci-log" && family ? family : first!;
    if (first === "ci-log") {
      for (const detail of details) {
        for (const part of detail.split(/ — |; /)) {
          const signature = /^(.+?): (.+)$/.exec(part);
          if (!signature) continue;
          const namedFamily = signature[1]!.replace(/\s*\(\d+\/\d+\)$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          if (namedFamily === check) terms.push(signature[2]!);
        }
      }
    }
    terms.push(check);
  } else if (kind === "main_merge") {
    terms.push(name);
  }
  return [...new Set(terms)];
}

/**
 * The code that owns a cause. A refusal is owned by whatever raises its reason; a CI check by the
 * scripts and source that name it; a main-merge cause by the file it conflicts on. `undefined` when
 * nothing can be located — the cause then goes to a person, never to a docs-only record.
 */
export function locateCiFrictionOwner(key: string, details: readonly string[], search: OwnerSearch): CiFrictionOwner | undefined {
  if (key.startsWith("hand_fix:")) {
    const file = key.slice("hand_fix:".length);
    return /^(src|scripts)\/[\w./-]+$/.test(file) && !file.split("/").includes("..") && search.fileExists(file)
      ? { files: [file], why: [`${file}: repaired by hand in multiple distinct merged PRs`] } : undefined;
  }
  const testPath = key.startsWith("check:ci-log:")
    ? details.map((d) => /(test\/[\w./-]+\.test\.[mc]?[jt]s)/.exec(d)?.[1]).find((p): p is string => p !== undefined)
    : undefined;
  if (key.startsWith("main_merge:")) {
    const file = key.slice("main_merge:".length);
    return search.fileExists(file) ? { files: [file], why: [`${file}: main merged into the PR over a change to it`] } : undefined;
  }
  const terms = ownerSearchTerms(key, details);
  const family = key.startsWith("check:") ? terms.at(-1) : undefined;
  const distinctive = family && key.startsWith("check:ci-log:") ? terms.slice(0, -1) : [];
  const generic = (term: string) => /^(ci|test|tests|coverage|build|check|checks)$/i.test(term.replace(/\s*\(\d+\/\d+\)\s*$/, "").trim());
  const signatures = distinctive.filter(term => !generic(term)).map(term => ({ term, files: search.filesContaining(term) })).filter(m => m.files.length > 0);
  const workflow = signatures.length === 0 && family ? search.workflowOwner?.(family) : undefined;
  if (workflow) return { ...workflow, ...(testPath ? { failingTest: testPath } : {}) };
  const matches = signatures.length > 0 ? signatures : terms.filter(term => !generic(term)).map((term) => ({ term, files: search.filesContaining(term) })).filter((m) => m.files.length > 0);
  // Specificity is relative to this cause's own search, measured in distinct files, not hit volume.
  const breadth = (m: typeof matches[number]) => new Set(m.files.map((f) => f.file)).size;
  const narrowest = Math.min(...matches.map(breadth));
  let specific = matches.filter((m) => breadth(m) === narrowest);
  // A located signature wins a tie with the check family; an unmatched signature adds no evidence.
  if (key.startsWith("check:ci-log:") && specific.some((m) => m.term !== terms.at(-1))) {
    specific = specific.filter((m) => m.term !== terms.at(-1));
  }
  const scores = new Map<string, { hits: number; term: string }>();
  for (const { term, files } of specific) {
    for (const { file, hits } of files) {
      const prior = scores.get(file);
      if (!prior || hits > prior.hits) scores.set(file, { hits, term });
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1].hits - a[1].hits || a[0].localeCompare(b[0])).slice(0, OWNER_LIMIT);
  if (ranked.length === 0) return undefined;
  return {
    files: ranked.map(([file]) => file),
    why: ranked.map(([file, s]) => `${file}: names "${s.term}" (${s.hits} line(s))`),
    ...(testPath ? { failingTest: testPath } : {}),
  };
}

// ── The evidence pack ──────────────────────────────────────────────────────────────────────

export interface EvidenceRound {
  pr: number;
  at: string;
  detail: string;
}

/** The latest `limit` rounds of one cause, newest first, one per pull request. */
export function ciFrictionEvidence(rounds: readonly RemedyRound[], causeKey: string, limit = 5): EvidenceRound[] {
  const seen = new Set<number>();
  return rounds
    .filter((r) => r.causeKey === causeKey && r.at !== undefined)
    .sort((a, b) => b.at!.localeCompare(a.at!))
    .filter((r) => (seen.has(r.pr) ? false : (seen.add(r.pr), true)))
    .slice(0, limit)
    .map((r) => ({ pr: r.pr, at: r.at!, detail: (r.detail ?? "").slice(0, 200) }));
}

/** The rationale a drafted remedy carries: the cause, its evidence, its owner and its history. */
export function ciFrictionRemedyRationale(input: {
  key: string;
  minutes: number;
  rounds: number;
  prs: number;
  owner: CiFrictionOwner;
  evidence: readonly EvidenceRound[];
  prior?: { task: CiFrictionRemedyTask; effect?: RemedyEffect };
}): string[] {
  const { key, owner, prior } = input;
  return [
    `MEASURED by the ci-friction gardener: ${key} cost ${input.minutes} PR minute(s) (seven-day half-life) across ${input.rounds} fix round(s) on ${input.prs} pull request(s).`,
    "",
    "WHERE IT COMES FROM:",
    ...owner.why.map((w) => `- ${w}`),
    ...(owner.failingTest ? [`- the rounds name a failing test: ${owner.failingTest}`] : []),
    "",
    "RECENT ROUNDS (newest first):",
    ...(input.evidence.length > 0 ? input.evidence.map((e) => `- PR #${e.pr} at ${e.at}: ${e.detail || "(no detail recorded)"}`) : ["- (none recorded)"]),
    ...(prior
      ? [
          "",
          `WHAT THE LAST RUNG TRIED: ${prior.task.id} (${isDocOnlyRemedy(prior.task) ? `a docs-only record, which changed no code path; its advice is under ${prior.task.origin} in ${CI_FRICTION_REMEDIES_DOC}` : `files ${prior.task.files.join(", ")}`})` +
            (prior.effect ? ` — ${prior.effect.reason}.` : "."),
          "Do something structurally different from it.",
        ]
      : []),
    "",
    "WHAT COUNTS AS A REMEDY: a change to the code path above so that this round is never dispatched, or is self-healed",
    "without spending a fix round. A paragraph in docs is not a remedy. After merge the gardener measures this cause's",
    "share of all fix rounds in equal windows before and after; if it does not fall, the cause reopens one rung up.",
  ];
}

// ── Replay ─────────────────────────────────────────────────────────────────────────────────

export interface ReplayStep {
  at: string;
  /** The costliest causes and where each stood at this instant. */
  causes: Array<{ key: string; minutes: number; state: CiFrictionCauseState["state"]; rung?: number; verdict?: RemedyVerdict }>;
  /** What the gardener would do: the costliest cause in `draft` or `escalate`. */
  next?: { key: string; state: "draft" | "escalate"; rung: number };
}

/**
 * Replay the ladder over a past window: at each step only the rounds and the plan as they stood then
 * are visible (a task exists from `filedAt`, a build counts from its `mergedAt`).
 */
export function replayCiFrictionLadder(input: {
  fromMs: number;
  toMs: number;
  stepMs: number;
  /** Rounds priced from the whole ledger, each with its time. */
  rounds: readonly RemedyRound[];
  /** Ranks causes from the rounds visible at a step (the gardener's own pricing, injected). */
  price: (visible: readonly RemedyRound[], nowMs: number) => Array<{ key: string; minutes: number }>;
  /** Every ci-friction task with the time its shard reached main. */
  tasks: ReadonlyArray<CiFrictionRemedyTask & { filedAt: string; retiredAt?: string }>;
  top?: number;
  /** Count each step's own action as filed (a queued record holding its cause), so the next step moves
   *  on to the next cause the way a live gardener would. Default true. */
  simulateFilings?: boolean;
}): ReplayStep[] {
  const steps: ReplayStep[] = [];
  const own: Array<CiFrictionRemedyTask & { filedAt: string; retiredAt?: string }> = [];
  for (let t = input.fromMs; t <= input.toMs; t += input.stepMs) {
    const visible = input.rounds.filter((r) => r.at !== undefined && Date.parse(r.at) <= t);
    const asOf = [...input.tasks, ...own]
      .filter((task) => Date.parse(task.filedAt) <= t)
      .map((task) => {
        const merged = task.mergedAt !== undefined && Date.parse(task.mergedAt) <= t;
        const retired = task.retired && (task.retiredAt === undefined || Date.parse(task.retiredAt) <= t);
        return { ...task, status: merged ? "merged" : "queued", retired, ...(merged ? {} : { mergedAt: undefined }) };
      });
    const priced = input.price(visible, t).slice(0, input.top ?? 8);
    const causes = priced.map(({ key, minutes }) => {
      const s = ciFrictionCauseState(key, asOf, visible, t);
      return {
        key,
        minutes,
        state: s.state,
        ...(s.state === "draft" || s.state === "escalate" ? { rung: s.rung } : {}),
        ...("effect" in s && s.effect ? { verdict: s.effect.verdict } : s.state === "draft" && s.prior?.effect ? { verdict: s.prior.effect.verdict } : {}),
      };
    });
    const pick = priced
      .map(({ key }) => ciFrictionCauseState(key, asOf, visible, t))
      .find((s): s is Extract<CiFrictionCauseState, { state: "draft" | "escalate" }> => s.state === "draft" || s.state === "escalate");
    steps.push({ at: fixedClock(t).iso(), causes, ...(pick ? { next: { key: pick.key, state: pick.state, rung: pick.rung } } : {}) });
    if (pick && input.simulateFilings !== false) {
      own.push({ id: `replay-${own.length + 1}`, origin: ciFrictionRungOrigin(pick.key, pick.rung), status: "queued", retired: false, files: ["(replayed filing)"], filedAt: fixedClock(t).iso() });
    }
  }
  return steps;
}
