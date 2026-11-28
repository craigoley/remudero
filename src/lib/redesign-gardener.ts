import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import { backlogEvidence, backlogLandingGuard, judgeBacklog, ownProofsHoldOnMain, satisfiedByMainFromRows, type BacklogDisposition } from "./backlog-gardener.js";
import { fixedClock, systemClock, type Clock } from "./clock.js";
import type { TaskFileInput } from "./feedback-landing.js";
import { writeAtomic } from "./fs-race-safe.js";
import { gardenLedgerBucket, gardenStatePath, readGardenState, type GardenAction, type GardenCheckout, type GardenerDeps, type GardenSpec } from "./gardener.js";
import { readMainHistory } from "./hot-file-gardener.js";
import { readOriginMainSha } from "./inbox.js";
import { readLedgerUnionRecordsSync } from "./ledger-union.js";
import { machineShardFilingRefusal, reparkStaleRuling } from "./machine-filing.js";
import { parseTasksFromYaml, type Task } from "./plan.js";
import { grepProofHeldAt, planCheapFingerprint, planInventory, type PlanGardenOps, type PlanInventory, type PlanOpsCatalog, type PlanOpsRead } from "./plan-gardener.js";
import { escapeGrepLiteral } from "./plan-pr-emitter.js";
import { PR_OPEN_SATISFIED_BY_MAIN_STEP } from "./pr-open.js";
import { ACCEPTANCE_PROOF_GRAMMAR } from "./proof-grammar.js";
import { INSTRUMENT_SURFACE, commentOnlyGrepProofRefusal, isDialectPrefixed } from "./review.js";
import { lintTask, promoteIntroducedPlanOnlyDiagnostics, sharedProofViolations } from "./task-linter.js";

/**
 * The redesign gardener lets the plan Architect amend a held task or propose retirement backed by main.
 *
 * A fix round that stands down ("fix needs design at this exact head", a refused criterion whose refusal-amendment
 * pointer says "an Architect must make the change above") holds its PR until the task's record changes. Nothing made
 * that change but a person, so on 2026-10-29 seven fleet PRs waited hours behind 149 needs-human issues. This garden
 * asks an LLM Architect for the smallest amendment that lets the next round build the SAME claims, and lands it as a
 * plan PR that review and auto-merge judge like any other. Standing rule 16 is enforced in code, never trusted to the
 * model: every claim survives verbatim and in order, `files:` only grows, and an instrument path, a workflow, a deploy
 * file or a plan file is never granted. A merged amendment changes the task's contract revision, which is exactly what
 * releases the sweep's design and stand-down holds. When the Architect answers GRILL, or the code refuses its edit, the
 * PR stays on the SLO ladder (HELD_ESCALATION_SLO_MS in sweep.ts), which judges a rebuild or a digest.
 */

export type RedesignClass = "amend" | "retire";
export const REDESIGN_CLASSES: readonly RedesignClass[] = ["amend", "retire"];
export const REDESIGN_NAME = "redesign";
export const REDESIGN_JUDGED_STEP = "redesign.judged";
const REDESIGN_SCORECARD_STEP = `${REDESIGN_NAME}.scorecard`;
export const REDESIGN_OPS_LANDING_STEP = `${REDESIGN_NAME}.ops_landing_submitted`;
export const REDESIGN_OPS_LANDING_RESULT_STEP = `${REDESIGN_NAME}.ops_landing_result`;
const PLAN_OPS_LANDING_STEPS = new Set(["plan.ops_landing", "plan.ops_landing_failed", "plan.ops_landing_skipped"]);
/** A hold younger than this is left to the fix lane's own next pass; an hour also bounds re-asking on a flapping hold. */
export const REDESIGN_AFTER_MS = 60 * 60_000;
/** BACKSTOP on spend: how many tasks one pass asks about. Each answer is one Architect spawn, and each landing is one
 *  plan PR to review; the signature dedup is the primary control on re-asking. */
export const REDESIGN_MAX_PER_PASS = 2;
/** A held PR the sweep has not disposed for this long is no longer being swept (merged, closed or rebuilt). */
const SWEPT_RECENTLY_MS = 2 * 60 * 60_000;
const EVIDENCE_WINDOW_MS = 7 * 24 * 60 * 60_000;
const HOLD_REASON = /^(?:fix needs design at this exact head|fix stood down at )/;
/** W1-T13657: the sweep's wait on a task contract amendment (W1-T12714) is a hold too; nothing else makes the amendment. */
const AMENDMENT_WAIT = /^fix needs a task contract amendment at this exact head/;
const isHold = (r: Row): r is Row & { reason: string } => typeof r.reason === "string" &&
  ((r.disposition === "refused-escalate" && HOLD_REASON.test(r.reason)) || (r.disposition === "wait" && AMENDMENT_WAIT.test(r.reason)));
const POINTER = /^ {2}# refusal-amendment \(.*(?:\n {2}# {3}.*)*/gm;
/** The stamp refusal-amendment.ts writes into the pointer's head: `(<task>, run <run>, <iso>)`. */
export const POINTER_STAMP_RE = /^ {2}# refusal-amendment \([^,]+, run [^,]+, (\d{4}-\d\d-\d\dT[\d:.]+Z)\)/;
const MARKER = (signature: string) => `  # redesign: signature=${signature}`;
/** One shard line recording the Architect's decision for this evidence signature. */
export const REDESIGN_MARKER_RE = /^ {2}# redesign: signature=([a-f0-9]{16})$/;
const FORBIDDEN_PREFIXES = [".github/", "deploy/", "plan/", "state/", "hooks/"];

type Row = Record<string, unknown>;
export type PathKind = "file" | "dir" | "none";

export interface RedesignEdit {
  filesAdd: string[];
  proofs: Array<{ criterion: number; proof: string }>;
  amendment: string;
  reason: string;
}

interface RedesignRetirement {
  retirement: Extract<BacklogDisposition, { kind: "retire" }>["retirement"];
  reason: string;
}

export type RedesignAction = GardenAction<RedesignClass> & {
  shard: string;
  signature: string;
  /** One key per evidence line ({@link RedesignCandidate.keys}), recorded with every verdict and landing. */
  keys: string[];
} & (
  | { class: "amend"; edit: RedesignEdit }
  | { class: "retire"; edit: RedesignRetirement; confirmation: string; original: string }
);

export interface RedesignCandidate {
  id: string;
  shard: string;
  text: string;
  evidence: string[];
  signature: string;
  /** One key per evidence line: the candidate is asked only while one of them has no verdict and no landing. */
  keys: string[];
}

export interface RedesignInventory {
  candidates: number;
  actions: RedesignAction[];
  outcomes: Array<{ task_id: string; outcome: RedesignClass | "grill" | "refused" | "unparseable"; reason: string }>;
}

export interface RedesignSources {
  clock: Clock;
  plan: () => PlanInventory;
  readShard: (rel: string, taskId?: string) => string;
  /** Rows of exactly the named steps since `sinceIso`. */
  ledger: (steps: readonly string[], sinceIso: string) => readonly Row[];
  /** What the repo path is: a directory would grant every file under it, so only a file or a new test is declared. */
  pathKind: (rel: string) => PathKind;
  /** One tool-less Architect spawn. */
  judgeText: (prompt: string) => Promise<string>;
  /** The landing guard's verdict on the edited shard, checked before an amend is accepted, so an amendment the guard
   *  would refuse is a recorded refusal rather than a filing that fails on every pass. */
  landingRefusal: (rel: string, text: string, pinnedBase?: string) => string | undefined;
  /** Signatures a landed PR carried, an open PR carries, or an operator's close declined: none is asked again. */
  settled: () => ReadonlySet<string>;
  /** A repo file's text at the Architect's head, or undefined when it is absent; lets the edit guard read a grep proof's
   *  target. Without it only a pattern that opens with a comment opener is judged. */
  readTarget?: (rel: string) => string | undefined;
}

const signatureOf = (id: string, evidence: readonly string[]): string =>
  createHash("sha256").update(JSON.stringify([id, ...evidence])).digest("hex").slice(0, 16);

/** The verdict and landing keys a ledger row carries: its signature and, since round 8 of #15621, its evidence keys. */
const rowKeys = (r: Row, signatures: unknown): string[] => [
  ...(Array.isArray(signatures) ? signatures.map(String) : typeof signatures === "string" ? [signatures] : []),
  ...(Array.isArray(r.evidence_keys) ? r.evidence_keys.map(String) : []),
];

/** Attach a sealed plan landing's terminal result to the signatures that started it. */
export function redesignOpsLandingResult(step: string, extra: Row, submission: Row | undefined): Row | undefined {
  if (!PLAN_OPS_LANDING_STEPS.has(step) || submission === undefined) return undefined;
  const hasHeldOutcome = (typeof extra.pr_url === "string" && extra.pr_url.length > 0) ||
    Number(extra.landed) > 0 || Number(extra.waiting) > 0 || Number(extra.refused) > 0;
  return {
    ...submission,
    ...extra,
    step: REDESIGN_OPS_LANDING_RESULT_STEP,
    failure: step !== "plan.ops_landing" || !hasHeldOutcome,
  };
}

/** The tasks a person was asked to redesign and has not: a refusal-amendment pointer, or a PR the sweep holds. */
export function redesignCandidates(sources: RedesignSources): RedesignCandidate[] {
  const now = sources.clock.now();
  const plan = sources.plan();
  const open = new Map(plan.open.map((t) => [t.id, t]));
  const evidence = new Map<string, string[]>();
  const add = (id: string, line: string) => {
    if (!open.has(id) || !plan.shards.has(id)) return;
    const list = evidence.get(id) ?? [];
    if (!list.includes(line)) list.push(line);
    evidence.set(id, list);
  };
  const rows = sources.ledger(["sweep.disposed"], fixedClock(now - EVIDENCE_WINDOW_MS).iso());
  const newest = new Map<number, Row>();
  for (const row of rows) {
    if (row.step !== "sweep.disposed" || typeof row.pr_number !== "number") continue;
    const prior = newest.get(row.pr_number);
    if (prior === undefined || String(row.ts) >= String(prior.ts)) newest.set(row.pr_number, row);
  }
  // A PR the sweep still disposes is its task's to judge: the task's pointer waits until EVERY such PR's hold qualifies,
  // so a qualifying older PR never speaks for a younger one. A pointer holds its task from dispatch until the record
  // changes (readWorkerRefusalHold), so once no live PR owns the task, nothing but an amendment moves it, and the
  // pointer is the Architect's whatever became of an earlier PR. The sweep writes no row when a PR closes, so "live" is
  // read as disposed within SWEPT_RECENTLY_MS; a closed PR's task waits at most that long.
  const waiting = new Set<string>();
  for (const row of newest.values()) {
    const at = Date.parse(String(row.ts));
    if (typeof row.task_id !== "string" || !Number.isFinite(at) || now - at > SWEPT_RECENTLY_MS) continue;
    // Every live PR waits its task's pointer until its own hold qualifies below.
    waiting.add(`${row.task_id}#${row.pr_number}`);
    if (!isHold(row)) continue;
    // The hold is aged from the start of its unbroken run: walking back from the newest row, any other disposition, an
    // unrelated refusal or another head ends it, so an interrupted hold restarts its hour.
    const history = rows.filter((r) => r.step === "sweep.disposed" && r.pr_number === row.pr_number)
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    let heldSince = at;
    for (const r of history) {
      const ts = Date.parse(String(r.ts));
      if (!isHold(r) || r.head_sha !== row.head_sha || !Number.isFinite(ts)) break;
      heldSince = Math.min(heldSince, ts);
    }
    if (now - heldSince < REDESIGN_AFTER_MS) continue;
    waiting.delete(`${row.task_id}#${row.pr_number}`);
    add(row.task_id, `PR #${row.pr_number} at head ${String(row.head_sha).slice(0, 7)} is held: ${row.reason.slice(0, 1500)}`);
  }
  for (const [id] of open) {
    const rel = plan.shards.get(id);
    if (rel === undefined || [...waiting].some((key) => key.startsWith(`${id}#`))) continue;
    // refusal-amendment.ts appends each run's pointer above `status:`, so a shard can hold several: every one is
    // evidence, and the NEWEST stamp is when the lane last stood down. A pointer set younger than the fix lane's hour,
    // or one with no stamp to age, is not yet the Architect's.
    const pointers = [...sources.readShard(rel, id).matchAll(POINTER)].map((m) => m[0]);
    const stamps = pointers.map((p) => Date.parse(POINTER_STAMP_RE.exec(p)?.[1] ?? ""));
    if (pointers.length > 0 && stamps.every(Number.isFinite) && now - Math.max(...stamps) >= REDESIGN_AFTER_MS) {
      add(id, `refusal-amendment pointer in the shard:\n${pointers.map((p) => p.trim()).join("\n")}`);
    }
  }
  // A verdict is never windowed: an unchanged pointer is the same evidence a week later, and is not asked again. It is
  // kept per evidence line, because the set of lines is windowed: a hold row leaving the seven days changes the set,
  // and a set that only lost lines, or reordered them, holds no line a verdict has not already seen.
  const judged = new Set(sources.ledger([REDESIGN_JUDGED_STEP], fixedClock(0).iso())
    .filter((r) => r.retryable !== true).flatMap((r) => rowKeys(r, r.signature)));
  // An accepted decision is recorded by its landing: the open PR holds it, a merge marks the shard, a close
  // declines it, and a filing that failed leaves it free to be asked again.
  const settled = sources.settled();
  const out: RedesignCandidate[] = [];
  for (const [id, unordered] of evidence) {
    const shard = plan.shards.get(id)!;
    const text = sources.readShard(shard, id);
    const lines = [...unordered].sort();
    const signature = signatureOf(id, lines);
    const keys = lines.map((line) => signatureOf(id, [line]));
    const marked = text.split("\n").some((line) => REDESIGN_MARKER_RE.exec(line)?.[1] === signature);
    const known = (key: string) => judged.has(key) || settled.has(key);
    if (!marked && !known(signature) && !keys.every(known)) out.push({ id, shard, text, evidence: lines, signature, keys });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

export function redesignPrompt(candidate: RedesignCandidate): string {
  return [
    "You are the plan Architect (MASTER-PLAN §5B). A fix worker could not build this task and stood down, so its PR waits on",
    "a person. Propose the SMALLEST amendment to the task record that lets the next build satisfy the SAME claims.",
    "",
    "Standing rule 16: the Architect may correct a mis-specified task through a plan PR, and NO criterion is dropped or",
    "weakened. You may: add paths to `files:` (never remove one), restate a criterion's proof so it tests that SAME claim",
    "more directly, and write an `amendment:` that tells the next builder what changed and how to approach the work.",
    "An amendment must preserve every claim in order and leave status, priority, verify and depends_on untouched.",
    "Never add a path under .github/, deploy/, plan/, state/ or hooks/, nor a CI instrument (a ratchet, baseline or gate",
    "script, src/lib/review.ts): those grants are the operator's alone. If the fix needs one of them, a credential, a policy",
    "or security decision, answer GRILL.",
    "The amended record must pass the plan linter as it lands: every added path stays inside the task's one concern",
    "(Rule 19 sizing at its risk), and a record with `author_class: machine` may declare only paths that already exist.",
    "Answer RETIRE if the work is already done or overtaken on main. Use closed for completed work and withdrawn for a",
    "superseded task. Code must confirm the retirement through the task's proofs, a build satisfied by main, or a merged",
    "replacement that covers the declared files and satisfies the proofs. Give a one-sentence reason. Otherwise GRILL",
    "when the claims cannot be preserved by an amendment.",
    "",
    ...ACCEPTANCE_PROOF_GRAMMAR,
    "",
    "Answer with exactly one line starting `REDESIGN:` followed by a JSON object:",
    '{"verdict":"amend"|"grill","reason":"one sentence","files_add":["path"],"proofs":[{"criterion":1,"proof":"unit test: ..."}],"amendment":"plain text"}',
    '{"verdict":"retire","retirement":"closed"|"withdrawn","reason":"one sentence"}',
    "",
    `TASK ${candidate.id} (shard ${candidate.shard}):`,
    candidate.text.trimEnd(),
    "",
    "WHY IT IS HELD:",
    ...candidate.evidence.map((e) => `- ${e}`),
  ].join("\n");
}

type Parsed =
  | { verdict: "amend"; edit: RedesignEdit }
  | { verdict: "retire"; edit: RedesignRetirement }
  | { verdict: "grill" | "unparseable"; reason: string };

export function parseRedesignAnswer(text: string): Parsed {
  const line = text.split("\n").find((l) => l.trim().startsWith("REDESIGN:"));
  if (line === undefined) return { verdict: "unparseable", reason: "no REDESIGN: line" };
  let decoded: unknown;
  try { decoded = JSON.parse(line.trim().slice("REDESIGN:".length)); }
  catch (error) { return { verdict: "unparseable", reason: `REDESIGN: is not JSON (${String(error)})` }; }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    return { verdict: "unparseable", reason: "REDESIGN: needs a JSON object" };
  }
  const value = decoded as Row;
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (value.verdict === "grill") return { verdict: "grill", reason: reason || "no reason given" };
  if (value.verdict === "retire") {
    const { retirement } = value;
    return (retirement === "closed" || retirement === "withdrawn") && reason
      ? { verdict: "retire", edit: { retirement, reason: reason.replace(/\s+/g, " ") } }
      : { verdict: "unparseable", reason: "retire needs a closed or withdrawn retirement and a reason" };
  }
  if (value.verdict !== "amend") return { verdict: "unparseable", reason: `verdict ${JSON.stringify(value.verdict)}` };
  const filesAdd = Array.isArray(value.files_add) ? value.files_add : [];
  const proofs = Array.isArray(value.proofs) ? value.proofs : [];
  const amendment = typeof value.amendment === "string" ? value.amendment.trim() : "";
  if (!filesAdd.every((p) => typeof p === "string") ||
      !proofs.every((p) => typeof p === "object" && p !== null && Number.isSafeInteger((p as Row).criterion) && typeof (p as Row).proof === "string") ||
      !amendment || !reason) return { verdict: "unparseable", reason: "amend needs reason, amendment, string files_add and {criterion, proof} proofs" };
  return { verdict: "amend", edit: { filesAdd: filesAdd as string[], proofs: proofs as RedesignEdit["proofs"], amendment, reason } };
}

/** Rule 16 and the operator's grants, checked in code: the reason an edit is refused, or undefined. */
export function redesignEditRefusal(task: Task, edit: RedesignEdit, pathKind: (rel: string) => PathKind, readTarget?: (rel: string) => string | undefined): string | undefined {
  const instruments = INSTRUMENT_SURFACE.map((re) => new RegExp(re));
  for (const path of edit.filesAdd) {
    // Only the canonical spelling is compared against the grant lists: ./deploy/x or src//lib/x would slip a prefix match.
    if (path.startsWith("/") || posix.normalize(path) !== path || path.startsWith("./") || path.endsWith("/") ||
        path.split("/").includes("..") || path.includes("*") || !/^[\w./-]+$/.test(path)) return `files_add ${path} is not a plain repo path`;
    if (FORBIDDEN_PREFIXES.some((p) => path.startsWith(p)) || instruments.some((re) => re.test(path))) return `files_add ${path} is an operator-only grant`;
    const kind = pathKind(path);
    if (kind !== "file" && !(kind === "none" && path.startsWith("test/"))) return `files_add ${path} is not an existing file and is not a new test`;
  }
  const criteria = task.acceptance ?? [];
  for (const { criterion, proof } of edit.proofs) {
    if (criterion < 1 || criterion > criteria.length) return `proof for criterion ${criterion}, which the task does not have`;
    if (!isDialectPrefixed(proof) || proof.includes("\n")) return `criterion ${criterion}'s proof has no dialect prefix or spans lines`;
    // W1-T11376: lint-plan's comment-only rule, applied before the edit is written, so a proof review can only grade executed_stale is a recorded refusal.
    const commentOnly = commentOnlyGrepProofRefusal(proof, readTarget);
    if (commentOnly !== undefined) return `criterion ${criterion}'s proof is refused: ${commentOnly}`;
  }
  if (edit.filesAdd.length === 0 && edit.proofs.length === 0 && task.amendment?.includes(edit.amendment)) return "the edit changes nothing";
  return undefined;
}

/** The edited shard text, or why the edit cannot be applied to this shard's text safely. */
export function applyRedesignEdit(text: string, rel: string, edit: RedesignEdit, signature: string, date: string): { text: string } | { refused: string } {
  const before = parseTasksFromYaml(text, rel);
  if (before.length !== 1) return { refused: `the shard holds ${before.length} records` };
  let next = text;
  const files = /^ {2}files:[ \t]*\n((?: {4}- .*\n)+)/m.exec(next);
  const fresh = [...new Set(edit.filesAdd)].filter((p) => !(before[0]!.files ?? []).includes(p));
  if (fresh.length > 0) {
    if (files === null) return { refused: "the shard has no block-list files:" };
    const at = files.index + files[0].length;
    next = next.slice(0, at) + fresh.map((p) => `    - ${p}\n`).join("") + next.slice(at);
  }
  const proofLines = [...next.matchAll(/^ {6}proof:.*$/gm)];
  if (proofLines.length !== (before[0]!.acceptance ?? []).length && edit.proofs.length > 0) return { refused: "a proof is not on one line" };
  for (const { criterion, proof } of [...edit.proofs].sort((a, b) => b.criterion - a.criterion)) {
    const line = proofLines[criterion - 1]!;
    next = next.slice(0, line.index) + `      proof: ${JSON.stringify(proof)}` + next.slice(line.index + line[0].length);
  }
  // The reason is one line of the scalar: a newline in it would end the block and start a new key.
  const paragraph = [`${date}, by the redesign Architect (machine, rule 16): ${edit.reason.replace(/\s+/g, " ").trim()}`, ...edit.amendment.split("\n")]
    .map((l) => (l.trim() ? `    ${l.trimEnd()}` : "")).join("\n");
  const amendment = /^ {2}amendment: \|[-+]?[ \t]*\n((?: {4}.*\n| *\n)*)/m.exec(next);
  if (amendment !== null) {
    const at = amendment.index + amendment[0].length;
    next = `${next.slice(0, at)}\n${paragraph}\n${next.slice(at)}`;
  } else {
    next = `${next.trimEnd()}\n  amendment: |\n${paragraph}\n`;
  }
  const status = /^ {2}status:/m.exec(next);
  if (status === null) return { refused: "the shard has no status: line" };
  next = `${next.slice(0, status.index)}${MARKER(signature)}\n${next.slice(status.index)}`;
  let after: Task[];
  try { after = parseTasksFromYaml(next, rel); } catch (error) { return { refused: `the edited shard does not parse: ${String(error)}` }; }
  const [a, b] = [before[0]!, after[0]];
  if (after.length !== 1 || b === undefined || b.id !== a.id) return { refused: "the edited shard is not the same one record" };
  const claims = (t: Task) => JSON.stringify((t.acceptance ?? []).map((c) => c.claim));
  if (claims(a) !== claims(b)) return { refused: "a claim changed" };
  if (!(a.files ?? []).every((p) => (b.files ?? []).includes(p))) return { refused: "a declared file was removed" };
  if (a.status !== b.status || a.priority !== b.priority || a.verify !== b.verify ||
      JSON.stringify(a.depends_on ?? []) !== JSON.stringify(b.depends_on ?? [])) return { refused: "status, priority, verify or depends_on changed" };
  // Every other field is the record's own: only files, proofs and the amendment may differ.
  const rest = (t: Task) => JSON.stringify(Object.entries({ ...t, files: undefined, amendment: undefined, acceptance: undefined })
    .filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y)));
  if (rest(a) !== rest(b)) return { refused: "a field other than files, a proof or the amendment changed" };
  // A machine record edited after it was judged goes back to its judge (reparkStaleRuling): the stale ruling is
  // dropped and the record parks at verify: human, as every machine filing arrives, so the landing never carries a pin
  // machine-author-verify refuses.
  return { text: reparkStaleRuling(next, rel) };
}

function applyRedesignRetirement(text: string, rel: string, edit: RedesignRetirement, signature: string): { text: string; task: Task } | { refused: string } {
  const [task, ...others] = parseTasksFromYaml(text, rel);
  const queued = /^( {2}status:[ \t]+)(queued|'queued'|"queued")([ \t]*(?:#[^\r\n]*)?)(\r?)$/m;
  if (others.length > 0 || task?.status !== "queued" || task.retirement || !queued.test(text)) {
    return { refused: "retirement needs one queued task with a status line and no retirement" };
  }
  const next = text.replace(queued, (_, key, status, comment, cr) =>
    [`${key}${status.replace("queued", "blocked")}${comment}`, `  retirement: ${edit.retirement}`, MARKER(signature), `  # redesign Architect: ${edit.reason}`].join(`${cr}\n`) + cr);
  return { text: reparkStaleRuling(next, rel), task };
}

function retirementConfirmation(task: Task, shard: string, sources: RedesignSources, repoRoot: string): string | undefined {
  const satisfied = satisfiedByMainFromRows(sources.ledger([PR_OPEN_SATISFIED_BY_MAIN_STEP], fixedClock(0).iso())).get(task.id);
  if (satisfied) return `Build ${satisfied.branch} (${satisfied.headSha.slice(0, 12)}) was recorded satisfied by main.`;
  const main = readOriginMainSha(repoRoot);
  const acceptance = task.acceptance;
  if (main === undefined || acceptance === undefined || !ownProofsHoldOnMain(repoRoot, task, shard) ||
      !acceptance.every(({ proof }) => grepProofHeldAt(repoRoot, main, proof) === true)) return undefined;
  const history = readMainHistory(repoRoot, fixedClock(sources.clock.now() - EVIDENCE_WINDOW_MS).iso());
  const evidence = backlogEvidence(task, repoRoot, new Map(), [], history, sources.clock.date(), () => false, false, undefined, () => true);
  return evidence.overtaken ? judgeBacklog(evidence).reason : `Every acceptance proof holds on origin/main (${main.slice(0, 12)}).`;
}

export async function redesignInventory(sources: RedesignSources, deps: GardenerDeps): Promise<RedesignInventory> {
  const candidates = redesignCandidates(sources);
  const plan = sources.plan();
  const actions: RedesignAction[] = [];
  const outcomes: RedesignInventory["outcomes"] = [];
  for (const candidate of candidates.slice(0, REDESIGN_MAX_PER_PASS)) {
    const parsed = parseRedesignAnswer(await sources.judgeText(redesignPrompt(candidate)));
    const action = { target: candidate.id, shard: candidate.shard, signature: candidate.signature, keys: candidate.keys };
    const pinnedBase = plan.ops?.shards.has(candidate.id) ? candidate.text : undefined;
    let outcome: RedesignInventory["outcomes"][number];
    if (parsed.verdict === "amend") {
      const task = plan.open.find((t) => t.id === candidate.id)!;
      const dryRun = applyRedesignEdit(candidate.text, candidate.shard, parsed.edit, candidate.signature, "0000-00-00");
      const refused = redesignEditRefusal(task, parsed.edit, sources.pathKind, sources.readTarget) ??
        ("refused" in dryRun ? dryRun.refused : sources.landingRefusal(candidate.shard, dryRun.text, pinnedBase));
      outcome = refused === undefined
        ? { task_id: candidate.id, outcome: "amend", reason: parsed.edit.reason }
        : { task_id: candidate.id, outcome: "refused", reason: refused };
      if (refused === undefined) actions.push({ ...action, class: "amend", reason: parsed.edit.reason, edit: parsed.edit });
    } else if (parsed.verdict === "retire") {
      const draft = applyRedesignRetirement(candidate.text, candidate.shard, parsed.edit, candidate.signature);
      const confirmation = "refused" in draft ? undefined : retirementConfirmation(draft.task, candidate.shard, sources, deps.repoRoot);
      const refused = "refused" in draft ? draft.refused : confirmation === undefined
        ? "origin/main does not confirm the task is done or overtaken" : sources.landingRefusal(candidate.shard, draft.text, pinnedBase);
      if (refused === undefined && confirmation !== undefined) {
        actions.push({ ...action, class: "retire", reason: parsed.edit.reason, edit: parsed.edit, confirmation, original: candidate.text });
      }
      outcome = refused === undefined
        ? { task_id: candidate.id, outcome: "retire", reason: parsed.edit.reason }
        : { task_id: candidate.id, outcome: "refused", reason: refused };
    } else {
      outcome = { task_id: candidate.id, outcome: parsed.verdict, reason: parsed.reason };
    }
    outcomes.push(outcome);
    // A judged signature is never asked again: new evidence (a new hold, a new pointer) is a new signature.
    if (outcome.outcome !== "amend" && outcome.outcome !== "retire") deps.log(REDESIGN_JUDGED_STEP, { ...outcome, signature: candidate.signature, evidence_keys: candidate.keys });
  }
  return { candidates: candidates.length, actions, outcomes };
}

export function buildRedesignSources(deps: GardenerDeps, overrides: Partial<RedesignSources> = {}, opsRead?: PlanOpsRead): RedesignSources {
  const ops = opsRead?.outcome === "ok" ? opsRead : undefined;
  const readPublicShard = overrides.readShard ?? ((rel) => readFileSync(join(deps.repoRoot, rel), "utf8"));
  const sources: Omit<RedesignSources, "settled"> = {
    clock: deps.clock ?? systemClock,
    plan: () => {
      const inv = planInventory(deps.repoRoot, deps.stateDir, ops);
      if (inv.ops) inv.shards = new Map([...inv.shards, ...inv.ops.shards]);
      return inv;
    },
    ledger: (steps, sinceIso) => {
      const read = readLedgerUnionRecordsSync(deps.stateDir, { step: [...steps], refuseIncomplete: true, sinceTs: sinceIso });
      if (!read.ok) throw new Error(`redesign: incomplete ledger union: ${read.unread.join(", ")}`);
      return read.rows;
    },
    pathKind: (rel) => {
      const stat = statSync(join(deps.repoRoot, rel), { throwIfNoEntry: false });
      return stat === undefined ? "none" : stat.isFile() ? "file" : "dir";
    },
    readTarget: (rel) => {
      // Read directly and take the absence from the read itself: no stat-then-read window.
      try {
        return readFileSync(join(deps.repoRoot, rel), "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return undefined;
        throw error;
      }
    },
    judgeText: () => Promise.reject(new Error("the redesign Architect's spawn is not wired")),
    // backlogLandingGuard's two arms over the drafted text: a machine record is linted whole with admission, any
    // other record only for block violations its base did not already have.
    landingRefusal: (rel, text, pinnedBase) => {
      const exists = (p: string) => existsSync(join(deps.repoRoot, p));
      const head = parseTasksFromYaml(text, rel);
      const base = parseTasksFromYaml(pinnedBase ?? readFileSync(join(deps.repoRoot, rel), "utf8"), rel);
      const sharedProofs = head.flatMap((task) => {
        const prior = base.find((b) => b.id === task.id);
        return promoteIntroducedPlanOnlyDiagnostics(
          sharedProofViolations(task), prior && sharedProofViolations(prior), prior === undefined,
        ).filter((v) => v.severity === "block").map((v) => `${task.id}: ${v.check}: ${v.message}`);
      });
      if (sharedProofs.length > 0) return sharedProofs.join("; ");
      if (head.some((t) => t.author_class === "machine")) return machineShardFilingRefusal(text, rel, { pathExists: exists, pathExistsAtBase: exists });
      const blocks = (t: Task | undefined) => new Map((t === undefined ? [] : lintTask(t, { moduleExists: exists }).violations)
        .filter((v) => v.severity === "block").map((v) => [v.check, v.message]));
      const reasons = head.flatMap((t) => {
        const had = blocks(base.find((b) => b.id === t.id));
        return [...blocks(t)].filter(([check]) => !had.has(check)).map(([check, message]) => `${t.id}: ${check}: ${message}`);
      });
      return reasons.length > 0 ? reasons.join("; ") : undefined;
    },
    ...overrides,
    readShard: (rel, id) => id !== undefined && ops?.shards.get(id) === rel ? ops.sources.get(rel)! : readPublicShard(rel, id),
  };
  return {
    ...sources,
    settled: overrides.settled ?? (() => {
      const state = readGardenState(gardenStatePath(deps.stateDir, REDESIGN_NAME), REDESIGN_CLASSES);
      // The framework releases a decision pending after 24 h while its PR is still open, so a landing's own scorecard
      // row, which only a filed PR carries a url on, is what keeps that PR's signatures from a second PR.
      const landed = sources.ledger([REDESIGN_SCORECARD_STEP], fixedClock(0).iso())
        .filter((r) => typeof r.pr_url === "string" && Array.isArray(r.signatures)).flatMap((r) => rowKeys(r, r.signatures));
      // Ops landings have their own PR lifecycle and are deliberately absent from the public scorecard. Once submitted,
      // keep their signatures and evidence keys out of the Architect queue while that ops landing is in flight or has
      // been declined; the public PR must never settle them on the ops catalog's behalf.
      const opsRows = sources.ledger([REDESIGN_OPS_LANDING_STEP, REDESIGN_OPS_LANDING_RESULT_STEP], fixedClock(0).iso());
      const submissions = opsRows.filter((r) => r.step === REDESIGN_OPS_LANDING_STEP);
      const results = opsRows.filter((r) => r.step === REDESIGN_OPS_LANDING_RESULT_STEP);
      const failedAttempts = new Set(results.filter((r) => r.failure === true && typeof r.attempt_id === "string")
        .map((r) => String(r.attempt_id)));
      // Until the sealed landing reports back, the submission is in flight. A returned PR, queued path, or explicit
      // refusal remains settled; a completed attempt with none of those outcomes is a failure and can be retried.
      const ops = submissions.filter((r) => typeof r.attempt_id !== "string" || !failedAttempts.has(String(r.attempt_id)))
        .flatMap((r) => rowKeys(r, r.signatures));
      return new Set([...(state.pending?.targets ?? []), ...(state.declinedTargets ?? [])].map((t) => t.target).concat(landed, ops));
    }),
  };
}

function redesignLandingClaim(action: RedesignAction): string {
  return `${action.target} carries the Architect's ${action.class === "retire" ? "retirement" : "amendment"}`;
}

function opsRedesignLandingProof(action: RedesignAction, original: string, edited: string): string | undefined {
  // The sealed landing checks the body proof against the pin and the edited shard. The signature is a YAML comment.
  const prior = new Set(original.split("\n").map((line) => line.trimEnd()));
  const line = action.class === "retire" ? `  retirement: ${action.edit.retirement}` :
    edited.split("\n").map((raw) => raw.trimEnd()).find((text) => text !== "" && !text.trimStart().startsWith("#") && !prior.has(text));
  return line === undefined ? undefined : `grep: ^${escapeGrepLiteral(line)}[[:space:]]*$ in ${action.shard}`;
}

export function redesignGardenSpec(
  deps: GardenerDeps, overrides: Partial<RedesignSources> = {}, opsSeam?: Pick<PlanGardenOps, "read" | "land">,
): GardenSpec<RedesignClass, RedesignInventory, RedesignAction, GardenCheckout> {
  const sources = buildRedesignSources(deps, overrides);
  let readOps: PlanOpsCatalog | undefined;
  let opsLandingSequence = 0;
  const isPublic = (action: RedesignAction) => readOps === undefined || !readOps.shards.has(action.target);
  return {
    name: REDESIGN_NAME,
    classes: REDESIGN_CLASSES,
    review: {
      amend: "a task amendment is the Architect's judgement call; close this PR to decline it.",
      retire: "a task retirement is the Architect's judgement call backed by main; close this PR to decline it.",
    },
    landingRefusal: backlogLandingGuard(deps),
    cheapFingerprint: () => `${planCheapFingerprint(deps.repoRoot, deps.stateDir)}:${gardenLedgerBucket(sources.clock)}`,
    inventory: () => { throw new Error("the redesign Architect answers asynchronously: drive it with runGardenAsync"); },
    inventoryAsync: async () => {
      const snapshot = await opsSeam?.read();
      readOps = snapshot?.outcome === "ok" ? snapshot : undefined;
      return redesignInventory(readOps ? buildRedesignSources(deps, overrides, snapshot) : sources, deps);
    },
    fingerprint: (i) => i.actions.map((a) => a.signature).join(",") || "none",
    unfinished: (i) => i.actions.length > 0,
    candidates: (i, _rng, declined = []) => {
      const no = new Set(declined.map((d) => d.target));
      return i.actions.filter((a) => !no.has(a.signature) && !a.keys.every((k) => no.has(k)));
    },
    pendingTargets: (plan) => plan.actions.filter(isPublic).flatMap((a) => [a.signature, ...a.keys].map((target) => ({ class: a.class, target }))),
    scorecard: (i, plan) => {
      // The framework attaches the public PR's URL to this card. Its decision covers only those signatures.
      const publicActions = plan.actions.filter(isPublic);
      const card = { candidates: i.candidates, outcomes: i.outcomes, acting: plan.acting, signatures: publicActions.map((a) => a.signature),
        evidence_keys: publicActions.flatMap((a) => a.keys) };
      deps.log(REDESIGN_SCORECARD_STEP, card);
      return card;
    },
    apply: (ws, plan) => {
      const date = sources.clock.date().toISOString().slice(0, 10);
      const landed: RedesignAction[] = [];
      const opsInputs: TaskFileInput[] = [];
      for (const action of plan.actions) {
        const opsPath = readOps?.shards.get(action.target);
        const abs = join(ws.root, action.shard);
        const original = opsPath === undefined ? readFileSync(abs, "utf8") : readOps!.sources.get(opsPath)!;
        if (action.class === "retire" && original !== action.original) {
          deps.log(REDESIGN_JUDGED_STEP, { task_id: action.target, outcome: "refused", reason: "the shard changed after retirement was confirmed",
            signature: action.signature, evidence_keys: action.keys, retryable: true });
          continue;
        }
        const edited = action.class === "retire"
          ? applyRedesignRetirement(original, action.shard, action.edit, action.signature)
          : applyRedesignEdit(original, action.shard, action.edit, action.signature, date);
        if ("refused" in edited) { deps.log(REDESIGN_JUDGED_STEP, { task_id: action.target, outcome: "refused", reason: edited.refused, signature: action.signature, evidence_keys: action.keys }); continue; }
        if (opsPath === undefined) {
          writeAtomic(abs, edited.text);
          landed.push(action);
        } else {
          const proof = opsRedesignLandingProof(action, original, edited.text);
          if (proof === undefined) {
            deps.log(REDESIGN_JUDGED_STEP, { task_id: action.target, outcome: "refused", reason: "the ops edit adds no data line for its landing proof",
              signature: action.signature, evidence_keys: action.keys });
            continue;
          }
          opsInputs.push({ relPath: opsPath, content: edited.text, claim: redesignLandingClaim(action), proof });
        }
      }
      if (opsSeam && readOps && opsInputs.length > 0) {
        const opsActions = plan.actions.filter((action) => readOps!.shards.has(action.target));
        const attemptId = `${readOps.pin}:${++opsLandingSequence}`;
        const opsSignatures = opsActions.map((action) => action.signature);
        const opsEvidenceKeys = opsActions.flatMap((action) => action.keys);
        deps.log(REDESIGN_OPS_LANDING_STEP, {
          attempt_id: attemptId,
          pin: readOps.pin,
          paths: opsInputs.map((input) => input.relPath),
          signatures: opsSignatures,
          evidence_keys: opsEvidenceKeys,
        });
        try {
          opsSeam.land(opsInputs, readOps.pin);
        } catch (error) {
          deps.log(REDESIGN_OPS_LANDING_RESULT_STEP, {
            attempt_id: attemptId, signatures: opsSignatures, evidence_keys: opsEvidenceKeys, failure: true,
            error: String((error as Error)?.message ?? error),
          });
        }
      }
      if (landed.length === 0) return undefined;
      const retiring = landed[0]!.class === "retire";
      return {
        paths: landed.map((a) => a.shard),
        title: `docs(plan): the Architect ${retiring ? "retires" : "amends"} ${landed.map((a) => a.target).join(", ")} after its fix lane stood down`,
        body: [
          ...(retiring ? [
            "The redesign Architect proposes retiring held tasks after checking main. Each record keeps its acceptance criteria",
            "and records the retirement and the Architect's reason. Close this PR to decline a retirement.",
          ] : [
            "The redesign gardener's Architect amends tasks whose fix lane stood down and held a PR on a person. Every claim",
            "is unchanged (standing rule 16, checked in code); `files:` only grows; no workflow, deploy, plan or CI-instrument",
            "path is granted. A merged amendment changes the task's contract revision, which releases the held PR's next fix round.",
            "Close this PR to decline an amendment.",
          ]), "",
          ...landed.map((a) => [
            `- **${a.target}** (\`${a.shard}\`): ${a.reason}`,
            ...(a.class === "retire" ? [`  - ${a.edit.retirement}: ${a.confirmation}`] : [
              ...(a.edit.filesAdd.length ? [`  - files added: ${a.edit.filesAdd.map((p) => `\`${p}\``).join(", ")}`] : []),
              ...a.edit.proofs.map((p) => `  - criterion ${p.criterion}'s proof is now \`${p.proof}\``),
            ]),
          ].join("\n")),
          "", "## Acceptance",
          ...landed.map((a) => `- claim: ${redesignLandingClaim(a)}\n  proof: "grep: # redesign: signature=${a.signature} in ${a.shard}"`),
        ].join("\n"),
      };
    },
  };
}
