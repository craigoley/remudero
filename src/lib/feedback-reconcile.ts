/**
 * lib/feedback-reconcile.ts — the cross-root feedback reconciliation manifest and repair
 * (W1-T3562). W1-T3560/W1-T3561 stop the NEXT landing clobber; nothing repairs a record one
 * ALREADY regressed (PR #5383, feedback#fb-1789304804534-e29e68) or captured on a root whose
 * sweep wasn't running (feedback#fb-1789311638612-56d5bd) — `sweepFeedbackLanding` (W1-T530)
 * reads only ONE root's own disk. This is that missing cross-root read, plus the repair.
 *
 * Design, one line each (plan/tasks.d/W1-T3562-*.yaml has the full rationale):
 * (i) dry-run default — {@link reconcileFeedbackLanding} only builds the manifest unless
 *     `apply: true`; classifications are present-everywhere / missing-upstream / regressed
 *     (origin/main sits at an earlier §7B position) / differs (a non-rank byte gap).
 * (ii) ordering is never re-derived — every rank question is a call to
 *      {@link mergeFeedbackRecord} (W1-T3561), never a second copy of the six-status table.
 * (iii) apply re-lands via {@link landFeedbackStatusContent} — the ordinary gated bridge (same
 *       compare-and-swap push, opened-or-reused PR, `automergeHoldFromLedger` consult); it never
 *       pushes to main or merges, and its own fresh-read refusal is defense in depth beyond this
 *       scan's classification.
 * (iv) bounded — each source caps at {@link MAX_RECORDS_PER_SOURCE}, else `truncated: true`.
 * (v) explicit enrolment only — {@link validateRoots} refuses the WHOLE call, before any read, on
 *     a malformed root; roots are never discovered by globbing.
 * (vi) one entry point — `run-task.ts`'s verb only parses argv and calls
 *      {@link reconcileFeedbackLanding}; every decision lives here.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { FEEDBACK_RECORD_STATUSES, mergeFeedbackRecord } from "./feedback-record-merge.js";
import {
  LANDING_BRANCH,
  landFeedbackStatusContent,
  type FeedbackRefusal,
  type LandFeedbackOpts,
  type LandFeedbackResult,
} from "./feedback-landing.js";

const FEEDBACK_REL_DIR = "plan/feedback";

/** A scan is bounded (design iii) — a misconfigured root's runaway directory must not hang an
 *  interactive verb. Past this many top-level entries, a source stops reading and the manifest
 *  says so via `truncated` rather than silently reporting a partial answer as a complete one. */
export const MAX_RECORDS_PER_SOURCE = 2000;

type GitExec = (args: string[]) => string;
type GhExec = (args: string[]) => string;

/** One explicit, operator-named state root (design iv) — never discovered. `name` also labels the
 *  root in the manifest's `foundIn`, so it must be a stable slug, not a path. */
export interface FeedbackReconcileRoot {
  name: string;
  path: string;
}

export type FeedbackReconcileClassification = "present-everywhere" | "missing-upstream" | "regressed" | "differs";

export interface FeedbackReconcileEntry {
  id: string;
  classification: FeedbackReconcileClassification;
  /** Every source (an enrolled root's `name`, or `"feedback-landing"` for the shared branch tip)
   *  holding a copy of this id. */
  foundIn: string[];
  /** origin/main's own `status:` field, when origin/main holds this id and it parses. */
  originStatus?: string;
  /** The best candidate's own `status:` field (may equal `originStatus`). */
  bestStatus?: string;
  /** Populated for `regressed`/`differs` — the deciding {@link mergeFeedbackRecord} call's own
   *  reason text, never a second explanation invented here. */
  reason?: string;
}

export interface FeedbackReconcileManifest {
  /** Every source actually scanned, in the order given, plus the shared landing branch. */
  scannedRoots: string[];
  recordCount: number;
  /** Sum of every scanned source file's byte length — the size the PR body states (design iii). */
  byteCount: number;
  truncated: boolean;
  entries: FeedbackReconcileEntry[];
}

const EMPTY_MANIFEST: FeedbackReconcileManifest = {
  scannedRoots: [],
  recordCount: 0,
  byteCount: 0,
  truncated: false,
  entries: [],
};

export interface ReconcileFeedbackLandingOpts {
  /** The explicit, validated enrolment (design iv). Refused as a whole, before any read, when any
   *  entry is malformed — see {@link validateRoots}. */
  roots: readonly FeedbackReconcileRoot[];
  /** The checkout `origin/main` and `origin/<LANDING_BRANCH>` are read from, and — when `apply` is
   *  set — pushed through via the ordinary bridge. */
  checkoutRoot: string;
  /** Dry-run by default (design i); set `true` to re-land the union (design ii). */
  apply?: boolean;
  /** Injectable `git` exec — real callers omit it. */
  git?: GitExec;
  /** Injectable `gh` exec — real callers omit it. */
  gh?: GhExec;
  /** The same hold reader every landing writer consults (`automergeHoldFromLedger`). */
  ledgerLines?: () => Array<Record<string, unknown>>;
  /** Test seam standing in for {@link landFeedbackStatusContent} — real callers omit it. */
  land?: (root: string, relPath: string, content: string, opts: LandFeedbackOpts) => LandFeedbackResult;
}

export interface ReconcileFeedbackLandingResult {
  manifest: FeedbackReconcileManifest;
  /** True only once `apply` was requested AND at least one record was actually staged this call. */
  applied: boolean;
  /** Repo-relative paths this call actually landed (empty for a dry run, or a no-op apply). */
  landed: string[];
  /** Per-record refusals surfaced by the ordinary bridge — never forced through (design ii). */
  refused: FeedbackRefusal[];
  prUrl?: string;
  /** Set on a whole-call refusal (malformed root, design iv) or a hard read/write failure. */
  error?: string;
}

const ROOT_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Refuses the WHOLE batch, before any `plan/feedback/**` read, on the first malformed root
 *  (design iv) — a partial validation pass could still read an unvalidated sibling entry. */
function validateRoots(roots: readonly FeedbackReconcileRoot[]): string | undefined {
  if (!Array.isArray(roots) || roots.length === 0) {
    return "no roots given — an explicit enrolment is required (never discovered by globbing)";
  }
  const seen = new Set<string>();
  for (const root of roots) {
    const name = (root as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !ROOT_NAME_RE.test(name)) {
      return `malformed root name ${JSON.stringify(name)} — must match ${ROOT_NAME_RE} (a slug, never a path)`;
    }
    if (seen.has(name)) return `duplicate root name "${name}"`;
    seen.add(name);
    const path = (root as { path?: unknown }).path;
    if (typeof path !== "string" || !isAbsolute(path)) {
      return `root "${name}": path must be an absolute string, got ${JSON.stringify(path)}`;
    }
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return `root "${name}": ${path} does not exist or is not a directory — refusing to touch an unknown root`;
    }
  }
  return undefined;
}

function defaultGit(root: string): GitExec {
  return (args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Every top-level `plan/feedback/<id>.yaml` entry under `root` — never a nested attachment,
 *  bounded by {@link MAX_RECORDS_PER_SOURCE}. */
function listFeedbackFiles(root: string): { files: string[]; truncated: boolean } {
  const dir = join(root, FEEDBACK_REL_DIR);
  if (!existsSync(dir)) return { files: [], truncated: false };
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".yaml") && statSync(join(dir, name)).isFile())
    .sort();
  return { files: names.slice(0, MAX_RECORDS_PER_SOURCE), truncated: names.length > MAX_RECORDS_PER_SOURCE };
}

function readOriginMainBytes(git: GitExec, relPath: string): string | undefined {
  try {
    return git(["show", `origin/main:${relPath}`]);
  } catch {
    return undefined; // not on origin/main at all yet
  }
}

/** Every top-level feedback entry on the shared landing branch's remote tip, bounded like a root's
 *  own scan. Best-effort: a branch that has never been pushed, or an unreadable ref, reads as
 *  empty — the same "no pending content" posture {@link import("./feedback-landing.js")} takes. */
function listBranchFeedbackIds(git: GitExec): { ids: Map<string, string>; byteCount: number; truncated: boolean } {
  const ids = new Map<string, string>();
  let byteCount = 0;
  let relPaths: string[];
  try {
    relPaths = git(["ls-tree", "-r", "--name-only", `origin/${LANDING_BRANCH}`])
      .split("\n")
      .map((s) => s.trim())
      .filter((f) => f.startsWith(`${FEEDBACK_REL_DIR}/`) && f.endsWith(".yaml"))
      .filter((f) => !f.slice(FEEDBACK_REL_DIR.length + 1).includes("/"))
      .sort();
  } catch {
    // The branch has never been pushed, or the ref is otherwise unreadable — reads as empty,
    // never fatal (the same "no pending content" posture a first-ever landing call takes).
    return { ids, byteCount, truncated: false };
  }
  const truncated = relPaths.length > MAX_RECORDS_PER_SOURCE;
  for (const relPath of relPaths.slice(0, MAX_RECORDS_PER_SOURCE)) {
    let bytes: string;
    try {
      bytes = git(["show", `origin/${LANDING_BRANCH}:${relPath}`]);
    } catch {
      continue; // the ref moved between ls-tree and this read — dropped, never fatal
    }
    byteCount += Buffer.byteLength(bytes, "utf8");
    ids.set(relPath.slice(FEEDBACK_REL_DIR.length + 1, -".yaml".length), bytes);
  }
  return { ids, byteCount, truncated };
}

function readStatus(bytes: string | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  try {
    const parsed: unknown = parseYaml(bytes);
    const status =
      parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>).status : undefined;
    return typeof status === "string" && (FEEDBACK_RECORD_STATUSES as readonly string[]).includes(status)
      ? status
      : undefined;
  } catch {
    // Unparseable YAML or an unrecognised status both read as "no status to report" here —
    // classify() itself calls mergeFeedbackRecord for the authoritative refuse/take decision;
    // this is display-only, so it never needs to distinguish the two failure shapes.
    return undefined;
  }
}

/** Fold several local copies of the SAME id down to the one furthest along §7B — reusing
 *  {@link mergeFeedbackRecord} pairwise (design's "reuse the predicate, never a second copy of the
 *  ordering rule") rather than comparing ranks directly. */
function pickBest(candidates: readonly { source: string; bytes: string }[]): { source: string; bytes: string } {
  let best = candidates[0];
  for (const cur of candidates.slice(1)) {
    if (mergeFeedbackRecord(best.bytes, cur.bytes).kind === "take-local") best = cur;
  }
  return best;
}

/**
 * Classify `best` (the furthest-along local copy) against origin/main's own bytes, using only
 * {@link mergeFeedbackRecord} calls — never a direct rank comparison. Two calls at most: the
 * FORWARD call (origin as upstream) decides whether origin needs updating at all; when it does, a
 * REVERSE call (best as upstream) asks whether origin's own rank is strictly earlier — the "sits
 * earlier ... refusing to move the record backward" wording {@link mergeFeedbackRecord} only
 * emits for a genuine rank gap — to tell a real regression apart from a same-rank metadata gap.
 */
function classify(
  originBytes: string | undefined,
  best: { source: string; bytes: string },
): { classification: FeedbackReconcileClassification; reason?: string } {
  if (originBytes === undefined) return { classification: "missing-upstream" };
  if (originBytes === best.bytes) return { classification: "present-everywhere" };

  const forward = mergeFeedbackRecord(originBytes, best.bytes);
  if (forward.kind === "keep-upstream") return { classification: "present-everywhere" };
  if (forward.kind === "refuse") {
    // `best` itself sits at or behind origin (or one side is unparseable) — nothing for origin to
    // gain from `best`. A genuine rank gap here means origin is AHEAD, not behind, so it is never
    // a regression; anything else (unparseable YAML) is surfaced as an unresolved difference.
    return /earlier/i.test(forward.reason) ? { classification: "present-everywhere" } : { classification: "differs", reason: forward.reason };
  }

  // forward.kind === "take-local": origin needs `best`'s content. Determine whether the gap is a
  // strict §7B rank regression or a same-rank metadata gap.
  const reverse = mergeFeedbackRecord(best.bytes, originBytes);
  if (reverse.kind === "refuse" && /earlier/i.test(reverse.reason)) {
    return { classification: "regressed", reason: reverse.reason };
  }
  return { classification: "differs", reason: reverse.kind === "refuse" ? reverse.reason : undefined };
}

interface ScanResult {
  manifest: FeedbackReconcileManifest;
  /** Internal only — the raw bytes {@link reconcileFeedbackLanding} needs to actually stage a
   *  repair. Never surfaced on the public manifest (kept small/serializable). */
  bestById: Map<string, string>;
}

function scan(opts: Pick<ReconcileFeedbackLandingOpts, "roots" | "checkoutRoot" | "git">): { ok: true; scan: ScanResult } | { ok: false; error: string } {
  const rootsError = validateRoots(opts.roots);
  if (rootsError) return { ok: false, error: `refusing: ${rootsError}` };

  const git = opts.git ?? defaultGit(opts.checkoutRoot);
  try {
    git(["fetch", "origin", "--quiet"]);
  } catch (e) {
    return { ok: false, error: `cannot fetch origin: ${String((e as Error)?.message ?? e)}` };
  }

  let byteCount = 0;
  let truncated = false;
  const bySource = new Map<string, Map<string, string>>();

  for (const root of opts.roots) {
    const { files, truncated: rootTruncated } = listFeedbackFiles(root.path);
    truncated = truncated || rootTruncated;
    const ids = new Map<string, string>();
    for (const file of files) {
      const bytes = readFileSync(join(root.path, FEEDBACK_REL_DIR, file), "utf8");
      byteCount += Buffer.byteLength(bytes, "utf8");
      ids.set(file.slice(0, -".yaml".length), bytes);
    }
    bySource.set(root.name, ids);
  }

  const branch = listBranchFeedbackIds(git);
  truncated = truncated || branch.truncated;
  byteCount += branch.byteCount;
  bySource.set("feedback-landing", branch.ids);

  const candidateIds = new Set<string>();
  for (const ids of bySource.values()) for (const id of ids.keys()) candidateIds.add(id);

  const entries: FeedbackReconcileEntry[] = [];
  const bestById = new Map<string, string>();
  for (const id of [...candidateIds].sort()) {
    const foundIn: string[] = [];
    const candidates: { source: string; bytes: string }[] = [];
    for (const [source, ids] of bySource) {
      const bytes = ids.get(id);
      if (bytes !== undefined) {
        foundIn.push(source);
        candidates.push({ source, bytes });
      }
    }
    if (candidates.length === 0) continue;
    const best = pickBest(candidates);
    bestById.set(id, best.bytes);
    const originBytes = readOriginMainBytes(git, `${FEEDBACK_REL_DIR}/${id}.yaml`);
    const { classification, reason } = classify(originBytes, best);
    entries.push({
      id,
      classification,
      foundIn,
      ...(readStatus(originBytes) !== undefined ? { originStatus: readStatus(originBytes) } : {}),
      ...(readStatus(best.bytes) !== undefined ? { bestStatus: readStatus(best.bytes) } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  return {
    ok: true,
    scan: {
      manifest: {
        scannedRoots: [...opts.roots.map((r) => r.name), "feedback-landing"],
        recordCount: entries.length,
        byteCount,
        truncated,
        entries,
      },
      bestById,
    },
  };
}

/** Manifest-only projection — never stages or pushes anything. `src/run-task.ts`'s dry-run path
 *  (the default) calls this shape via {@link reconcileFeedbackLanding} directly; exported
 *  separately only so a caller that never wants `apply` available at all has no flag to pass. */
export function buildFeedbackReconcileManifest(
  opts: Pick<ReconcileFeedbackLandingOpts, "roots" | "checkoutRoot" | "git">,
): { ok: true; manifest: FeedbackReconcileManifest } | { ok: false; error: string } {
  const result = scan(opts);
  return result.ok ? { ok: true, manifest: result.scan.manifest } : result;
}

const RECONCILE_NEEDS_REPAIR: ReadonlySet<FeedbackReconcileClassification> = new Set([
  "missing-upstream",
  "regressed",
  "differs",
]);

/**
 * The one entry point (design vi). Dry-run by default: builds and returns the manifest, touching
 * nothing. With `apply: true`, every classified-as-needing-repair record is re-landed one at a
 * time through {@link landFeedbackStatusContent} — the ordinary gated bridge, which re-validates
 * each record against a FRESH `origin/main` read at push time and refuses (never forces) one that
 * would move a record backward, surfacing that refusal on the result rather than retrying around
 * it.
 */
export function reconcileFeedbackLanding(opts: ReconcileFeedbackLandingOpts): ReconcileFeedbackLandingResult {
  const scanned = scan(opts);
  if (!scanned.ok) {
    return { manifest: EMPTY_MANIFEST, applied: false, landed: [], refused: [], error: scanned.error };
  }
  const { manifest, bestById } = scanned.scan;
  if (!opts.apply) {
    return { manifest, applied: false, landed: [], refused: [] };
  }

  const land = opts.land ?? landFeedbackStatusContent;
  const landOpts: LandFeedbackOpts = { git: opts.git, gh: opts.gh, ledgerLines: opts.ledgerLines };
  const landed: string[] = [];
  const refused: FeedbackRefusal[] = [];
  let prUrl: string | undefined;
  let error: string | undefined;

  for (const entry of manifest.entries) {
    if (!RECONCILE_NEEDS_REPAIR.has(entry.classification)) continue;
    const bytes = bestById.get(entry.id);
    if (bytes === undefined) continue; // unreachable in practice — every entry came from bestById
    const relPath = `${FEEDBACK_REL_DIR}/${entry.id}.yaml`;
    const result = land(opts.checkoutRoot, relPath, bytes, landOpts);
    if (result.refused && result.refused.length > 0) {
      refused.push(...result.refused);
      continue;
    }
    if (result.landed) {
      landed.push(relPath);
      if (result.prUrl) prUrl = result.prUrl;
      if (result.error) error = error ? `${error}; ${result.error}` : result.error;
    } else if (result.error) {
      error = error ? `${error}; ${result.error}` : result.error;
    }
  }

  return {
    manifest,
    applied: landed.length > 0,
    landed,
    refused,
    ...(prUrl ? { prUrl } : {}),
    ...(error ? { error } : {}),
  };
}
