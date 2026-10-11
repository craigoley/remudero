import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { assertClaimRefPushAllowedAsync } from "./live-write-guard.js";

/**
 * A DURABLE HOME FOR PRESERVED WORK. The live-edit ladder (live-edit-ladder.ts) and the fix-owner
 * recovery arms (W1-T6362, W1-T7719) write immutable `refs/rmd-recovery/*` commits into a host
 * checkout. Kept there only, they die with the host. The daemon already pushes coordination refs
 * (refs/rmd-dispatch, refs/rmd-id, refs/rmd-pause) to origin with the fleet App token, from the same
 * checkouts; this publishes recovery refs the same way, CREATE-ONLY: a ref already on origin is never
 * moved, and a name origin holds at another sha is a conflict, never overwritten.
 *
 * RETENTION IS TIERED BY EVIDENCE, NEVER BY COUNT OR AGE:
 *   unpublished -- only on this host: kept, and published.
 *   held        -- on origin, but its record was never escalated or never restored (or it has no
 *                  record at all, as every fix-owner ref): kept everywhere, forever.
 *   resolved    -- escalated AND restored, its content not on origin/main: the host copy is dropped,
 *                  origin keeps the durable one.
 *   landed      -- escalated AND restored, and every path it changed already reads the same on
 *                  origin/main: nothing is left to recover, so the origin copy and the host files go.
 */
export const RECOVERY_REF_NAMESPACE = "refs/rmd-recovery";

export type RecoveryGitAnswer = { status: number; stdout: string; stderr: string };
/** Runs `git <args>` in one checkout and resolves on every outcome (dispatch-claim's gitClaimRunnerAsync). */
export type RecoveryGitRunner = (args: string[]) => Promise<RecoveryGitAnswer>;
export type RecoveryLog = (step: string, extra: Record<string, unknown>) => void;

export const RECOVERY_REF_STEPS = {
  published: "recovery_refs.published",
  conflict: "recovery_refs.conflict",
  publishFailed: "recovery_refs.publish_failed",
  pruned: "recovery_refs.pruned",
} as const;

const LIST_BOUND = 20;
/** Refspecs per push: an argv size, not a policy. Every missing ref is pushed, in as many pushes as it takes. */
const PUSH_CHUNK = 64;

function refMap(text: string, sep: RegExp): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const [sha, ref] = line.trim().split(sep);
    if (sha && ref?.startsWith(`${RECOVERY_REF_NAMESPACE}/`)) out.set(ref, sha);
  }
  return out;
}

export async function localRecoveryRefs(run: RecoveryGitRunner): Promise<Map<string, string>> {
  const res = await run(["for-each-ref", "--format=%(objectname) %(refname)", `${RECOVERY_REF_NAMESPACE}/`]);
  if (res.status !== 0) throw new Error(`for-each-ref failed: ${res.stderr.trim()}`);
  return refMap(res.stdout, / /);
}

/** origin's recovery refs, or undefined when origin could not be read (never an empty map). */
export async function originRecoveryRefs(run: RecoveryGitRunner): Promise<Map<string, string> | undefined> {
  const res = await run(["ls-remote", "origin", `${RECOVERY_REF_NAMESPACE}/*`]);
  return res.status === 0 ? refMap(res.stdout, /\s+/) : undefined;
}

export interface RecoveryPublishResult {
  local: number;
  published: string[];
  durable: number;
  conflicts: string[];
  failed: string[];
  /** Set when origin could not be read: nothing was pushed and nothing counts as durable. */
  unreachable?: string;
  /** origin's recovery refs after the pass, when it was read. */
  origin?: Map<string, string>;
}

/** Push every local recovery ref origin lacks, create-only (`--force-with-lease=<ref>:`, empty: must not exist). */
export async function publishRecoveryRefs(run: RecoveryGitRunner, log: RecoveryLog): Promise<RecoveryPublishResult> {
  const local = await localRecoveryRefs(run);
  const result: RecoveryPublishResult = { local: local.size, published: [], durable: 0, conflicts: [], failed: [] };
  if (local.size === 0) return result;
  const origin = await originRecoveryRefs(run);
  if (!origin) {
    result.unreachable = "ls-remote origin failed";
    log(RECOVERY_REF_STEPS.publishFailed, { reason: result.unreachable, local: local.size });
    return result;
  }
  const missing: Array<[string, string]> = [];
  for (const [ref, sha] of local) {
    const there = origin.get(ref);
    if (there === sha) result.durable++;
    else if (there !== undefined) result.conflicts.push(ref);
    else missing.push([ref, sha]);
  }
  for (let i = 0; i < missing.length; i += PUSH_CHUNK) {
    const chunk = missing.slice(i, i + PUSH_CHUNK);
    for (const [ref] of chunk) await assertClaimRefPushAllowedAsync(run, ref);
    const res = await run(["push", "--porcelain", "origin", ...chunk.map(([ref]) => `--force-with-lease=${ref}:`), ...chunk.map(([ref, sha]) => `${sha}:${ref}`)]);
    const lines = new Map<string, { flag: string; summary: string }>();
    for (const line of res.stdout.split("\n")) {
      const m = /^(.)\t[0-9a-f]+:(\S+)\t(.*)$/.exec(line);
      if (m) lines.set(m[2]!, { flag: m[1]!, summary: m[3]! });
    }
    for (const [ref, sha] of chunk) {
      const line = lines.get(ref);
      if (line?.flag === "*" || line?.flag === "=") {
        result.published.push(ref);
        origin.set(ref, sha);
      } else if (line?.flag === "!" && /stale info|already exists|fetch first|non-fast-forward/.test(line.summary)) result.conflicts.push(ref);
      else result.failed.push(ref);
    }
    if (res.status !== 0 && lines.size === 0) log(RECOVERY_REF_STEPS.publishFailed, { reason: res.stderr.trim().slice(0, 512), refs: chunk.length });
  }
  result.durable += result.published.length;
  result.origin = origin;
  if (result.published.length > 0) {
    log(RECOVERY_REF_STEPS.published, { count: result.published.length, refs: result.published.slice(0, LIST_BOUND) });
  }
  if (result.conflicts.length > 0) {
    log(RECOVERY_REF_STEPS.conflict, { count: result.conflicts.length, refs: result.conflicts.slice(0, LIST_BOUND) });
  }
  return result;
}

/** One preserved record: its refs and host files, and what happened to it. Written by the live-edit ladder. */
export interface RecoveryRecord {
  refs: string[];
  /** Host files (patches, this record), relative to the state root. */
  files: string[];
  escalatedUrl?: string;
  restoredAtMs?: number;
}

export type RecoveryTier = "unpublished" | "held" | "resolved" | "landed";

export function recoveryTier(r: { published: boolean; escalated: boolean; restored: boolean; landed: boolean }): RecoveryTier {
  if (!r.published) return "unpublished";
  if (!r.escalated || !r.restored) return "held";
  return r.landed ? "landed" : "resolved";
}

/** The records under `<stateDir>/recovery/live-edits/<tree>/*.json`, with their paths. Unreadable ones are skipped:
 *  a ref with no readable record is held. */
export function readRecoveryRecords(stateDir: string, tree: string): Array<{ path: string; record: RecoveryRecord }> {
  const dir = join(stateDir, "recovery", "live-edits", tree);
  if (!existsSync(dir)) return [];
  const out: Array<{ path: string; record: RecoveryRecord }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as RecoveryRecord;
      if (Array.isArray(record.refs) && Array.isArray(record.files)) out.push({ path: join(dir, name), record });
    } catch {
      continue; // torn or foreign: its refs stay held
    }
  }
  return out;
}

/** Whether every path `sha` changed against its parent reads the same at origin/main. Unknown is false. */
async function landedOnMain(run: RecoveryGitRunner, sha: string): Promise<boolean> {
  const names = await run(["diff", "--name-only", "-z", "--no-renames", `${sha}^`, sha]);
  if (names.status !== 0) return false;
  const paths = names.stdout.split("\0").filter(Boolean);
  if (paths.length === 0) return true;
  const same = await run(["diff", "--quiet", "--no-renames", sha, "origin/main", "--", ...paths.map((p) => `:(literal)${p}`)]);
  return same.status === 0;
}

export interface RecoveryRetentionResult {
  tiers: Record<RecoveryTier, number>;
  prunedLocal: string[];
  prunedOrigin: string[];
}

/** Apply the tiers to one tree's records. Needs a publish pass's origin map: without one, nothing is durable. */
export async function applyRecoveryRetention(
  run: RecoveryGitRunner,
  stateDir: string,
  tree: string,
  origin: Map<string, string> | undefined,
  log: RecoveryLog,
): Promise<RecoveryRetentionResult> {
  const result: RecoveryRetentionResult = { tiers: { unpublished: 0, held: 0, resolved: 0, landed: 0 }, prunedLocal: [], prunedOrigin: [] };
  const local = await localRecoveryRefs(run);
  for (const { record } of readRecoveryRecords(stateDir, tree)) {
    const shas = record.refs.map((ref) => local.get(ref) ?? origin?.get(ref));
    const published = origin !== undefined && record.refs.every((ref, i) => shas[i] !== undefined && origin.get(ref) === shas[i]);
    const escalated = Boolean(record.escalatedUrl);
    const restored = typeof record.restoredAtMs === "number";
    let landed = false;
    if (published && escalated && restored) {
      landed = true;
      for (const sha of shas) if (!(await landedOnMain(run, sha!))) landed = false;
    }
    const tier = recoveryTier({ published, escalated, restored, landed });
    result.tiers[tier]++;
    if (tier !== "resolved" && tier !== "landed") continue;
    for (const [i, ref] of record.refs.entries()) {
      if (local.has(ref) && (await run(["update-ref", "-d", ref, shas[i]!])).status === 0) result.prunedLocal.push(ref);
    }
    if (tier !== "landed") continue;
    const refs = record.refs.filter((ref) => origin!.has(ref));
    for (const ref of refs) await assertClaimRefPushAllowedAsync(run, ref);
    const res = await run(["push", "--porcelain", "origin", ...refs.map((ref) => `--force-with-lease=${ref}:${origin!.get(ref)}`), ...refs.map((ref) => `:${ref}`)]);
    if (res.status !== 0) continue; // the origin copy stays, and so do the host files; the next pass retries
    result.prunedOrigin.push(...refs);
    const own = resolve(stateDir, "recovery") + sep;
    for (const file of record.files) if (resolve(stateDir, file).startsWith(own)) rmSync(resolve(stateDir, file), { force: true });
  }
  if (result.prunedLocal.length > 0 || result.prunedOrigin.length > 0) {
    log(RECOVERY_REF_STEPS.pruned, { tree, local: result.prunedLocal.slice(0, LIST_BOUND), origin: result.prunedOrigin.slice(0, LIST_BOUND), tiers: result.tiers });
  }
  return result;
}

/** The daemon's pass over one checkout: publish what origin lacks, then apply the tiers to `tree`'s records.
 *  origin is read again only when this checkout's recovery refs changed since the last settled pass, or a
 *  record became escalated and restored; a steady state costs one local for-each-ref. Never throws. */
export function recoveryRefMaintainer(gitFor: (repoDir: string) => RecoveryGitRunner, stateDir: string, log: RecoveryLog): (repoDir: string, tree: string) => Promise<void> {
  const settled = new Map<string, { fingerprint: string; origin: Map<string, string> }>();
  /** Per checkout and tree: the inputs of the last retention pass. Unchanged inputs give the same tiers, so no origin read. */
  const judged = new Map<string, string>();
  return async (repoDir, tree) => {
    try {
      const run = gitFor(repoDir);
      const fingerprint = [...(await localRecoveryRefs(run))].map(([ref, sha]) => `${sha} ${ref}`).sort().join("\n");
      let origin = settled.get(repoDir)?.fingerprint === fingerprint ? settled.get(repoDir)!.origin : undefined;
      if (!origin) {
        const published = await publishRecoveryRefs(run, log);
        origin = published.origin;
        if (origin && published.failed.length === 0) settled.set(repoDir, { fingerprint, origin });
      }
      const due = readRecoveryRecords(stateDir, tree).filter(({ record }) => record.escalatedUrl && typeof record.restoredAtMs === "number");
      const main = (await run(["rev-parse", "--verify", "--quiet", "origin/main"])).stdout.trim();
      const inputs = `${fingerprint}|${main}|${due.map(({ path }) => path).sort().join(",")}`;
      if (due.length > 0 && judged.get(`${repoDir}\0${tree}`) !== inputs) {
        // A resolved record's host ref may already be gone, so publishing (which reads only what the host holds) never asked origin.
        const kept = await applyRecoveryRetention(run, stateDir, tree, origin ?? (await originRecoveryRefs(run)), log);
        if (kept.prunedLocal.length > 0 || kept.prunedOrigin.length > 0) settled.delete(repoDir);
        else judged.set(`${repoDir}\0${tree}`, inputs);
      }
    } catch (e) {
      log(RECOVERY_REF_STEPS.publishFailed, { tree, reason: String((e as Error)?.message ?? e).slice(0, 512) });
    }
  };
}
