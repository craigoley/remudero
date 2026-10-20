/**
 * W1-T9962 — A CEILING IS JUDGED ON THE TREE THAT WILL LAND, AGAINST THE MAIN IT LANDS ON.
 *
 * Each PR's ratchet gates ran on its own base. On 2026-10-16 #12428, #12388 and #12437 each passed
 * comment-load that way, and together took src/run-task.ts to 18,253 comment lines over a recorded
 * 18,250. #12388 had lowered the row on a stale base, so main's own row was lowered under it.
 *
 * {@link judgeMergedRatchets} is pure over two readers: the merge-tree of (main tip, PR head) and
 * main's tip. It counts with each gate's own counter (scripts/comment-load-ratchet.mjs,
 * scripts/clock-signature-ratchet.mjs), never a copy, and names every gate it does not count.
 * {@link readMergedRatchetInputsSteps} is the I/O: merge-tree and blob reads in the managed clone,
 * no worktree, no npm and no CI run.
 */
import { step, type Steps } from "./git-push.js";
import { singlePrRestArgs } from "./open-prs-rest.js";
import type { PlanSafetyGit, PlanSafetyGitResult } from "./plan-pr-merge-safety.js";
// @ts-expect-error a plain .mjs script with no declaration file, as src/lib/plan-index.ts imports its sibling.
import { CEILING_BUCKET_COMMENTS, DEFAULT_BASELINE_RELATIVE_PATH as COMMENT_BASELINE, MEASURED_ROOTS, ceilingForComments, countCommentLines, readBaseline as readCommentBaseline } from "../../scripts/comment-load-ratchet.mjs";
// @ts-expect-error a plain .mjs script with no declaration file, as src/lib/plan-index.ts imports its sibling.
import { DEFAULT_BASELINE_RELATIVE_PATH as CLOCK_BASELINE, readBaseline as readClockBaseline, scanClockSignaturesFromText } from "../../scripts/clock-signature-ratchet.mjs";

export type MergedRatchetVerdictName = "clean" | "crossing" | "stale-lowering" | "unread";

/** One count over its ceiling on the merged tree. `prCeiling` is the row as the merge lands it. */
export interface MergedRatchetRow {
  gate: "comment-load" | "clock-signature";
  path: string;
  field?: string;
  verdict: "crossing" | "stale-lowering";
  merged: number;
  mainCeiling: number;
  prCeiling: number;
  /** stale-lowering: the merged count (what the shrink-record writes there); crossing: the gate's printed record value. */
  rederived: number;
}

/** A gate this judge does not count, and why: never read as clean. */
export interface UncountedRatchetGate {
  gate: string;
  class: "run-derived" | "delta-only" | "population";
}

export const COUNTED_RATCHET_GATES = ["comment-load", "clock-signature"] as const;

export const UNCOUNTED_RATCHET_GATES: readonly UncountedRatchetGate[] = [
  { gate: "coverage", class: "run-derived" },
  { gate: "mutation", class: "run-derived" },
  { gate: "source-size", class: "delta-only" },
  // Whole-population counts: each needs every file's text on both trees, not only the changed paths.
  { gate: "fixture-copy", class: "population" },
  { gate: "house-layout", class: "population" },
  { gate: "deps-interface", class: "population" },
  { gate: "affected-reach", class: "population" },
  { gate: "learnings-budget", class: "population" },
  { gate: "claude-md-budget", class: "population" },
];

export interface MergedRatchetJudgement {
  verdict: MergedRatchetVerdictName;
  rows: MergedRatchetRow[];
  counted: string[];
  uncounted: UncountedRatchetGate[];
  mainSha?: string;
  headSha?: string;
  /** Why the verdict is unread, or why nothing was counted (`behind_by 0`). */
  reason?: string;
  elapsedMs?: number;
}

/** How many rows a `sweep.ratchet_judge.decided` row lists; `rows_count` carries the rest. */
export const RATCHET_JUDGE_ROWS_SHOWN = 10;

/** The `sweep.ratchet_judge.decided` fields one judgement contributes, beside the caller's PR identity and remedy. */
export function ratchetJudgeLedgerFields(j: MergedRatchetJudgement): Record<string, unknown> {
  return {
    verdict: j.verdict,
    ...(j.mainSha !== undefined ? { main_sha: j.mainSha } : {}),
    ...(j.headSha !== undefined ? { head_sha: j.headSha } : {}),
    counted_gates: j.counted,
    uncounted_gates: j.uncounted.map((u) => `${u.gate}:${u.class}`),
    rows: j.rows.slice(0, RATCHET_JUDGE_ROWS_SHOWN),
    rows_count: j.rows.length,
    ...(j.reason !== undefined ? { reason: j.reason } : {}),
    ...(j.elapsedMs !== undefined ? { elapsed_ms: j.elapsedMs } : {}),
  };
}

/** One line naming each held row, for the `say` beside a refresh. */
export function describeRatchetRows(j: MergedRatchetJudgement): string {
  return j.rows.map((r) => `${r.gate} ${r.path}${r.field ? `#${r.field}` : ""} ${r.merged} > ${r.prCeiling} (main ${r.mainCeiling}, rederived ${r.rederived})`).join("; ");
}

/** What the merge-tree read hands the judge: the two trees as readers, or why it could not. */
export type MergedRatchetInputs =
  | {
      mainSha: string;
      headSha: string;
      changed: string[];
      measuredFiles: string[];
      readMerged: (path: string) => string | null;
      readMain: (path: string) => string | null;
    }
  | { upToDate: true; mainSha: string; headSha: string }
  | { error: string; mainSha?: string; headSha?: string };

/** The clock-signature census's own scope: a src TypeScript file. */
export const CLOCK_SCOPE_RE = /^src\/.+\.ts$/;
const CLOCK_FIELDS = ["legacy", "dateNow", "newDate"] as const;

/** One count's verdict. Over the merged row but within main's: the PR's row was lowered on a stale
 *  base. Over main's too: a crossing, unless main already carried it and this merge grew nothing. */
function judgeCount(merged: number, prCeiling: number, mainCount: number, mainCeiling: number): MergedRatchetRow["verdict"] | undefined {
  if (merged <= prCeiling) return undefined;
  if (merged <= mainCeiling) return "stale-lowering";
  if (mainCount > mainCeiling && merged <= mainCount) return undefined;
  return "crossing";
}

function baselineOf<T>(text: string | null, parse: (t: string, p: string) => T, path: string): T | Record<string, never> {
  return text === null ? {} : parse(text, path);
}

function commentLoadRows(input: Extract<MergedRatchetInputs, { changed: string[] }>): MergedRatchetRow[] {
  const merged = baselineOf(input.readMerged(COMMENT_BASELINE), readCommentBaseline, COMMENT_BASELINE) as Record<string, number>;
  const main = baselineOf(input.readMain(COMMENT_BASELINE), readCommentBaseline, COMMENT_BASELINE) as Record<string, number>;
  const measured = new Set(input.measuredFiles);
  const paths = new Set(input.changed.filter((p) => measured.has(p)));
  if (input.changed.includes(COMMENT_BASELINE)) for (const key of Object.keys(merged)) if (measured.has(key)) paths.add(key);
  const count = (text: string | null, path: string): number => (text === null ? 0 : countCommentLines(text, path).comments);
  const rows: MergedRatchetRow[] = [];
  for (const path of [...paths].sort()) {
    const text = input.readMerged(path);
    if (text === null) continue;
    const n = count(text, path);
    const prCeiling = merged[path] ?? CEILING_BUCKET_COMMENTS;
    const mainCeiling = main[path] ?? CEILING_BUCKET_COMMENTS;
    const verdict = judgeCount(n, prCeiling, count(input.readMain(path), path), mainCeiling);
    if (verdict) rows.push({ gate: "comment-load", path, verdict, merged: n, mainCeiling, prCeiling, rederived: verdict === "stale-lowering" ? n : ceilingForComments(n) });
  }
  return rows;
}

function clockRows(input: Extract<MergedRatchetInputs, { changed: string[] }>): MergedRatchetRow[] {
  type ClockRow = Partial<Record<(typeof CLOCK_FIELDS)[number], number>>;
  const merged = baselineOf(input.readMerged(CLOCK_BASELINE), readClockBaseline, CLOCK_BASELINE) as Record<string, ClockRow>;
  const main = baselineOf(input.readMain(CLOCK_BASELINE), readClockBaseline, CLOCK_BASELINE) as Record<string, ClockRow>;
  const paths = new Set(input.changed.filter((p) => CLOCK_SCOPE_RE.test(p)));
  if (input.changed.includes(CLOCK_BASELINE)) for (const key of Object.keys(merged)) if (key !== "_comment") paths.add(key);
  const scan = (text: string | null): Record<string, number> => (text === null ? { legacy: 0, dateNow: 0, newDate: 0 } : scanClockSignaturesFromText(text));
  const rows: MergedRatchetRow[] = [];
  for (const path of [...paths].sort()) {
    const text = input.readMerged(path);
    if (text === null) continue;
    const counts = scan(text);
    const mainCounts = scan(input.readMain(path));
    for (const field of CLOCK_FIELDS) {
      const prCeiling = merged[path]?.[field] ?? 0;
      const mainCeiling = main[path]?.[field] ?? 0;
      const verdict = judgeCount(counts[field]!, prCeiling, mainCounts[field]!, mainCeiling);
      if (verdict) rows.push({ gate: "clock-signature", path, field, verdict, merged: counts[field]!, mainCeiling, prCeiling, rederived: counts[field]! });
    }
  }
  return rows;
}

/** The ONE verdict the arm, the direct merge and the armed re-judge consult. A read or counter that
 *  fails is `unread`, never `clean`: the caller proceeds as before with the reason on its row. */
export function judgeMergedRatchets(input: MergedRatchetInputs): MergedRatchetJudgement {
  const shas = { ...(input.mainSha !== undefined ? { mainSha: input.mainSha } : {}), ...(input.headSha !== undefined ? { headSha: input.headSha } : {}) };
  const base = { counted: [] as string[], uncounted: [...UNCOUNTED_RATCHET_GATES], ...shas };
  if ("error" in input) return { verdict: "unread", rows: [], ...base, reason: input.error };
  if ("upToDate" in input) return { verdict: "clean", rows: [], ...base, reason: "behind_by 0: the merged tree is the head its CI counted" };
  let rows: MergedRatchetRow[];
  try {
    rows = [...commentLoadRows(input), ...clockRows(input)];
  } catch (e) {
    return { verdict: "unread", rows: [], ...base, reason: `a ratchet counter threw: ${String((e as Error)?.message ?? e)}` };
  }
  const verdict = rows.some((r) => r.verdict === "crossing") ? "crossing" : rows.length > 0 ? "stale-lowering" : "clean";
  return { verdict, rows, ...base, counted: [...COUNTED_RATCHET_GATES] };
}

/** Whether a verdict holds the arm or the merge and asks for a refresh. */
export function ratchetVerdictHolds(judgement: Pick<MergedRatchetJudgement, "verdict"> | undefined): boolean {
  return judgement?.verdict === "crossing" || judgement?.verdict === "stale-lowering";
}

/** The paths the judge will read on either tree, so the I/O reads them in one batch per tree. */
export function mergedRatchetReadSet(changed: readonly string[], baselines: ReadonlyArray<string | null>): string[] {
  const paths = new Set([...changed, COMMENT_BASELINE, CLOCK_BASELINE]);
  const baselineChanged = changed.includes(COMMENT_BASELINE) || changed.includes(CLOCK_BASELINE);
  if (baselineChanged) {
    // A baseline that does not parse throws here, and the read that called this rules it unread.
    for (const text of baselines) if (text !== null) for (const key of Object.keys(JSON.parse(text) as object)) if (key !== "_comment") paths.add(key);
  }
  return [...paths].sort();
}

/** `git cat-file --batch` framing, where `<input> missing` is a path absent from that tree. */
export function parseBlobBatchAllowingMissing(raw: string, paths: readonly string[]): Map<string, string | null> {
  const buf = Buffer.from(raw, "utf8");
  const out = new Map<string, string | null>();
  let off = 0;
  for (const path of paths) {
    const nl = buf.indexOf(0x0a, off);
    if (nl < 0) throw new Error(`git cat-file --batch output ended before ${path}`);
    const fields = buf.toString("utf8", off, nl).split(" ");
    off = nl + 1;
    if (fields[fields.length - 1] === "missing") { out.set(path, null); continue; }
    const size = Number(fields[2]);
    if (fields[1] !== "blob" || !Number.isInteger(size) || off + size > buf.length) throw new Error(`git cat-file --batch could not read ${path}`);
    out.set(path, buf.toString("utf8", off, off + size));
    off += size + 1;
  }
  return out;
}

function* git(run: PlanSafetyGit, args: readonly string[], stdin?: string): Steps<PlanSafetyGitResult> {
  return yield* step(() => run(args, stdin));
}

function failed(verb: string, res: PlanSafetyGitResult): string {
  return `${verb} exited ${res.status === null ? `null${res.signal ? ` (${res.signal})` : ""}` : res.status}${res.stderr ? `: ${res.stderr}` : ""}`;
}

/** The judge's inputs for one PR: fetch main and refs/pull/N/head into the clone (FETCH_HEAD, never a
 *  local branch), merge-tree them, and read the measured paths either side changed since the merge base. */
export function* readMergedRatchetInputsSteps(
  target: { owner: string; repo: string; prNumber: number },
  rest: (args: string[]) => unknown,
  run: PlanSafetyGit,
): Steps<MergedRatchetInputs> {
  try {
    // No managed clone, nothing to merge in: named before any REST read is spent on this PR.
    const clone = yield* git(run, ["rev-parse", "--git-dir"]);
    if (clone.status !== 0) return { error: failed("no managed clone: git rev-parse --git-dir", clone) };
    const pr = (yield* step(() => rest(singlePrRestArgs(target.owner, target.repo, target.prNumber)))) as { base?: { ref?: unknown } } | undefined;
    const baseRef = pr?.base?.ref;
    if (typeof baseRef !== "string") return { error: "the pull read named no base ref" };
    const fetched: string[] = [];
    for (const ref of [baseRef, `refs/pull/${target.prNumber}/head`]) {
      const fetch = yield* git(run, ["fetch", "--no-tags", "--quiet", "origin", ref]);
      if (fetch.status !== 0) return { error: failed(`git fetch ${ref}`, fetch) };
      const sha = (yield* git(run, ["rev-parse", "FETCH_HEAD"])).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/.test(sha)) return { error: `FETCH_HEAD after fetching ${ref} named no commit` };
      fetched.push(sha);
    }
    const [mainSha, headSha] = fetched as [string, string];
    const mergeBase = yield* git(run, ["merge-base", mainSha, headSha]);
    if (mergeBase.status !== 0) return { error: failed("git merge-base", mergeBase), mainSha, headSha };
    const mb = mergeBase.stdout.trim();
    if (mb === mainSha) return { upToDate: true, mainSha, headSha };
    const merged = yield* git(run, ["merge-tree", "--write-tree", "--no-messages", mainSha, headSha]);
    // A conflict is GitHub's mergeability to refuse (a dirty PR is never armed), not a count to read.
    if (merged.status === 1) return { error: "git merge-tree reported a conflict: left to GitHub's mergeability", mainSha, headSha };
    const tree = merged.stdout.split("\n")[0]?.trim() ?? "";
    if (merged.status !== 0 || !/^[0-9a-f]{40,64}$/.test(tree)) return { error: failed("git merge-tree", merged), mainSha, headSha };
    const changed = new Set<string>();
    for (const [from, to] of [[mainSha, tree], [mb, mainSha]] as const) {
      const diff = yield* git(run, ["diff", "--name-only", "--no-renames", from, to]);
      if (diff.status !== 0) return { error: failed("git diff --name-only", diff), mainSha, headSha };
      for (const p of diff.stdout.split("\n")) if (p.trim()) changed.add(p.trim());
    }
    const listing = yield* git(run, ["ls-tree", "-r", "--name-only", tree, "--", ...MEASURED_ROOTS]);
    if (listing.status !== 0) return { error: failed("git ls-tree", listing), mainSha, headSha };
    const measuredFiles = listing.stdout.split("\n").filter(Boolean);
    const readBatch = function* (rev: string, paths: readonly string[]): Steps<Map<string, string | null>> {
      const res = yield* git(run, ["cat-file", "--batch"], paths.map((p) => `${rev}:${p}`).join("\n") + "\n");
      if (res.status !== 0) throw new Error(failed("git cat-file --batch", res));
      return parseBlobBatchAllowingMissing(res.stdout, paths);
    };
    const baselinePaths = [COMMENT_BASELINE, CLOCK_BASELINE];
    const baselines = [...(yield* readBatch(tree, baselinePaths)).values(), ...(yield* readBatch(mainSha, baselinePaths)).values()];
    const paths = mergedRatchetReadSet([...changed], baselines);
    const mergedBlobs = yield* readBatch(tree, paths);
    const mainBlobs = yield* readBatch(mainSha, paths);
    const reader = (blobs: Map<string, string | null>) => (path: string): string | null => {
      if (!blobs.has(path)) throw new Error(`${path} was not in the read set`);
      return blobs.get(path)!;
    };
    return { mainSha, headSha, changed: [...changed].sort(), measuredFiles, readMerged: reader(mergedBlobs), readMain: reader(mainBlobs) };
  } catch (e) {
    // the failure is the reading: the judge rules it unread, and the arm proceeds as before with it named.
    return { error: String((e as Error)?.message ?? e) };
  }
}
