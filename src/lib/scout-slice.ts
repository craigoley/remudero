import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { EXPORT_GARDEN_WINDOW_DAYS } from "./export-gardener.js";
import { slug } from "./feedback-docket.js";
import { writeAtomic } from "./fs-race-safe.js";
import { renderMachineShard } from "./machine-filing.js";
import type { PlanInventory } from "./plan-gardener.js";
import { hostWorktreeGit } from "./worktree-git.js";

/**
 * lib/scout-slice.ts (W1-T5455) — the scout's second class reads the repository, not the ledger.
 *
 * The ledger scout (W1-T5454) finds only what already misbehaves at run time. A risky function with no
 * test, a comment that contradicts the code beside it, a doc that names a symbol that no longer exists:
 * the ledger cannot measure these and a model reading the code can. Reading everything every pass is
 * the cost, so each pass reads ONE slice — a directory under src/lib, scripts, docs or test — chosen by
 * {@link pickScoutSlice} from a persisted cursor so every directory is read in turn.
 *
 * A model asked for improvements always produces some, so the class's value is what it is REFUSED:
 * {@link verifySliceFindings} re-checks every finding deterministically (the file exists at HEAD, the
 * cited line holds the text the claim names, no open or recently merged task already covers it) and a
 * finding that fails is discarded with a reason, never repaired by asking the model again. The model
 * seam is INJECTED ({@link SliceModelCall}); nothing here imports a model.
 */

/** The roots a slice is drawn from. A root's own files are one slice and each immediate subdirectory is another. */
export const SCOUT_SLICE_ROOTS: readonly string[] = ["src/lib", "scripts", "docs", "test"];
/** The most source one pass shows the model. */
export const SCOUT_SLICE_BYTE_BUDGET = 60_000;
/** The most findings one pass accepts from the model; the rest of its answer is ignored. */
export const SCOUT_SLICE_MAX_FINDINGS = 3;
/** A finding's claim is one sentence; longer is a paragraph, which cannot be re-verified as one thing. */
export const SCOUT_SLICE_MAX_CLAIM_CHARS = 240;
/** The slice class is judged on the export gardener's revert window, not the ledger class's 7 days. */
export const SCOUT_SLICE_SURVIVAL_WINDOW_MS = EXPORT_GARDEN_WINDOW_DAYS * 24 * 3_600_000;
/** The persisted cursor, beside the gardener's own state file. */
export const SCOUT_SLICE_CURSOR_FILE = "scout-slice-cursor.json";

export const scoutSliceOrigin = (dir: string): string => `scout:slice:${dir}`;
export const isSliceOrigin = (origin: unknown): boolean => typeof origin === "string" && origin.startsWith("scout:slice:");

// ── The slice picker (pure) ──────────────────────────────────────────────────────────────────

export interface SliceFile {
  path: string;
  bytes: number;
  /** When the file last changed on main, ms since epoch; 0 when it never did inside the lookback. */
  changedAtMs: number;
}

export interface SliceCursor {
  /** The directory the last pass read; the next pass reads the one after it. */
  dir?: string;
  /** Directory → when it was last read, ms. A file changed after this is read first. */
  readAt: Record<string, number>;
  /** Directory → the last unchanged file read, so the next read of that directory resumes after it. */
  resume: Record<string, string>;
}

export interface SlicePick {
  dir: string;
  files: SliceFile[];
  bytes: number;
  /** The cursor to persist once this slice has been read. */
  cursor: SliceCursor;
}

/** The slice a repo-relative path belongs to, or undefined when it is outside every root. */
export function sliceDirOf(path: string): string | undefined {
  for (const root of SCOUT_SLICE_ROOTS) {
    if (!path.startsWith(`${root}/`)) continue;
    const rest = path.slice(root.length + 1);
    const slash = rest.indexOf("/");
    return slash < 0 ? root : `${root}/${rest.slice(0, slash)}`;
  }
  return undefined;
}

/**
 * The next slice: the directory after `cursor.dir` (wrapping), its files changed since that directory was
 * last read first, then the rest in path order starting after where the last read of it stopped, until the
 * byte budget is spent. Pure, so a test pins the rotation. A directory with no file small enough to fit
 * still advances the cursor, so one oversized directory never stalls the rotation.
 */
export function pickScoutSlice(files: readonly SliceFile[], cursor: SliceCursor, nowMs: number, budgetBytes: number = SCOUT_SLICE_BYTE_BUDGET): SlicePick | undefined {
  const byDir = new Map<string, SliceFile[]>();
  for (const f of files) {
    const dir = sliceDirOf(f.path);
    if (dir === undefined) continue;
    byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
  }
  const dirs = [...byDir.keys()].sort();
  if (dirs.length === 0) return undefined;
  const dir = dirs.find((d) => cursor.dir === undefined || d > cursor.dir) ?? dirs[0]!;
  const inDir = byDir.get(dir)!.sort((a, b) => a.path.localeCompare(b.path));
  const lastRead = cursor.readAt[dir];
  const changed = lastRead === undefined ? [] : inDir.filter((f) => f.changedAtMs > lastRead);
  const changedPaths = new Set(changed.map((f) => f.path));
  const unchanged = inDir.filter((f) => !changedPaths.has(f.path));
  const resumeAfter = cursor.resume[dir];
  const split = resumeAfter === undefined ? 0 : unchanged.findIndex((f) => f.path > resumeAfter);
  const rotated = split <= 0 ? unchanged : [...unchanged.slice(split), ...unchanged.slice(0, split)];
  const picked: SliceFile[] = [];
  let bytes = 0;
  let lastUnchanged: string | undefined;
  for (const f of [...changed, ...rotated]) {
    if (bytes + f.bytes > budgetBytes) continue;
    picked.push(f);
    bytes += f.bytes;
    if (!changedPaths.has(f.path)) lastUnchanged = f.path;
  }
  const resume = { ...cursor.resume };
  if (lastUnchanged !== undefined) resume[dir] = lastUnchanged;
  return { dir, files: picked, bytes, cursor: { dir, readAt: { ...cursor.readAt, [dir]: nowMs }, resume } };
}

export function emptySliceCursor(): SliceCursor {
  return { readAt: {}, resume: {} };
}

/** The persisted cursor; a missing file is a first read, a damaged one is refused rather than reset to the start. */
export function readSliceCursor(path: string): SliceCursor {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySliceCursor();
    throw new Error(`scout slice cursor ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`scout slice cursor ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const p = parsed as Partial<SliceCursor> | null;
  const record = (v: unknown, kind: "number" | "string"): boolean =>
    typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === kind);
  if (typeof p !== "object" || p === null || !record(p.readAt, "number") || !record(p.resume, "string") || (p.dir !== undefined && typeof p.dir !== "string")) {
    throw new Error(`scout slice cursor ${path} is malformed`);
  }
  return { ...(p.dir === undefined ? {} : { dir: p.dir }), readAt: p.readAt!, resume: p.resume! };
}

export function writeSliceCursor(path: string, cursor: SliceCursor): void {
  writeAtomic(path, JSON.stringify(cursor, null, 2) + "\n");
}

// ── Reading the repository at HEAD ───────────────────────────────────────────────────────────

export interface SliceSources {
  /** Tracked files under the slice roots, with their size and when each last changed on main. */
  listFiles: (sinceMs: number | undefined) => readonly SliceFile[];
  /** A file's text at HEAD, or undefined when HEAD has no such file. */
  readAtHead: (path: string) => string | undefined;
}

/** A repo-relative path that stays inside the repository. */
export const isRepoRelative = (path: string): boolean => path !== "" && !isAbsolute(path) && !path.split("/").includes("..");

export function gitSliceSources(repoRoot: string): SliceSources {
  const git = (args: string[]): string => hostWorktreeGit(repoRoot, args, { maxBuffer: 64 * 1024 * 1024 });
  return {
    listFiles: (sinceMs) => {
      const tracked = git(["ls-files", "--", ...SCOUT_SLICE_ROOTS]).split("\n").filter((p) => p !== "");
      const changedAt = new Map<string, number>();
      if (sinceMs !== undefined) {
        const log = git(["log", `--since=${new Date(sinceMs).toISOString()}`, "--format=%x01%ct", "--name-only", "--", ...SCOUT_SLICE_ROOTS]);
        for (const chunk of log.split("\u0001")) {
          const [stamp, ...names] = chunk.split("\n");
          const at = Number(stamp) * 1000;
          if (!Number.isFinite(at)) continue;
          for (const n of names) if (n !== "" && (changedAt.get(n) ?? 0) < at) changedAt.set(n, at);
        }
      }
      return tracked.flatMap((path) => {
        try {
          return [{ path, bytes: statSync(join(repoRoot, path)).size, changedAtMs: changedAt.get(path) ?? 0 }];
        } catch (error) {
          // A path tracked but absent from the checkout (a pending deletion) is not a file to read.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      });
    },
    readAtHead: (path) => {
      if (!isRepoRelative(path)) return undefined;
      try {
        return git(["show", `HEAD:${path}`]);
      } catch (error) {
        // `git show` exits non-zero for a path HEAD does not hold; anything else is not that answer.
        if (/exists on disk, but not in|does not exist in|bad revision|unknown revision/.test(String((error as { stderr?: unknown }).stderr ?? error))) return undefined;
        throw error;
      }
    },
  };
}

// ── The model seam ───────────────────────────────────────────────────────────────────────────

/** The injected model call: a prompt in, the model's text out. A test supplies the answer. */
export type SliceModelCall = (prompt: string) => Promise<string>;

/** What the model claims to have seen. `file` and `line` are checked, not trusted. */
export interface SliceFinding {
  file: string;
  line: number;
  /** One sentence. It must quote, in backticks, the symbol or text it names on the cited line. */
  claim: string;
  /** The one concrete check that would show the claim true. */
  check: string;
}

export function buildSlicePrompt(dir: string, files: readonly { path: string; text: string }[], openTitles: readonly string[]): string {
  return [
    `You are reading one slice of a repository: the directory \`${dir}\`. Report at most ${SCOUT_SLICE_MAX_FINDINGS} weak spots you can SEE in the text below: a dead branch of logic, a risky function with no test beside it, a comment that contradicts the code next to it, a doc that names a symbol that no longer exists, a needless duplicate.`,
    "",
    "Rules:",
    "- Report only what the text below shows. Do not guess at code you were not shown.",
    "- Every finding cites a `file` and a 1-based `line`, and its one-sentence `claim` QUOTES, in backticks, the symbol or text it names as it appears ON THAT LINE.",
    "- Every finding carries the one concrete `check` (a command or a test) that would show the claim true.",
    "- Do not report anything an open task below already covers.",
    "- Answer with ONLY a JSON array, `[]` if you see nothing: [{\"file\":\"...\",\"line\":1,\"claim\":\"...\",\"check\":\"...\"}]",
    "",
    "Open task titles:",
    ...openTitles.map((t) => `- ${t}`),
    "",
    ...files.flatMap((f) => [`=== ${f.path} ===`, ...f.text.split("\n").map((l, i) => `${i + 1}: ${l}`), ""]),
  ].join("\n");
}

/** The findings in a model answer; a malformed entry is dropped with its reason, never repaired. */
export function parseSliceFindings(text: string): { findings: SliceFinding[]; dropped: string[] } {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) return { findings: [], dropped: ["the answer holds no JSON array"] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    return { findings: [], dropped: [`the answer's array is not JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!Array.isArray(parsed)) return { findings: [], dropped: ["the answer is not an array"] };
  const findings: SliceFinding[] = [];
  const dropped: string[] = [];
  for (const [i, e] of parsed.entries()) {
    const f = e as Partial<SliceFinding> | null;
    if (typeof f !== "object" || f === null || typeof f.file !== "string" || !Number.isInteger(f.line) || typeof f.claim !== "string" || typeof f.check !== "string" || f.claim.trim() === "" || f.check.trim() === "") {
      dropped.push(`finding ${i + 1} lacks a file, an integer line, a claim and a check`);
    } else if (findings.length >= SCOUT_SLICE_MAX_FINDINGS) {
      dropped.push(`finding ${i + 1} is past the ${SCOUT_SLICE_MAX_FINDINGS}-finding cap`);
    } else {
      findings.push({ file: f.file, line: f.line as number, claim: f.claim.trim(), check: f.check.trim() });
    }
  }
  return { findings, dropped };
}

// ── The premise check (deterministic) ────────────────────────────────────────────────────────

export interface DroppedFinding {
  finding: SliceFinding;
  reason: string;
}

/** The spans a claim quotes in backticks: the text the cited line must hold. */
export function claimQuotes(claim: string): string[] {
  return [...claim.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!.trim()).filter((q) => q !== "");
}

/** The file paths a task declares, plus its title, are the surface a finding must not repeat. */
function taskCovers(task: { title: string; files?: readonly string[] }, finding: SliceFinding, quotes: readonly string[]): boolean {
  if ((task.files ?? []).includes(finding.file)) return true;
  const title = task.title.toLowerCase();
  return title.includes(finding.file.toLowerCase()) || quotes.some((q) => q.length >= 4 && title.includes(q.toLowerCase()));
}

export interface PremiseContext {
  readAtHead: (path: string) => string | undefined;
  plan: PlanInventory;
  /** Task id → merge instant, for merges inside the coverage window. */
  merged: ReadonlyMap<string, number>;
  nowMs: number;
  /** How far back a merged task still covers a surface. */
  coverageMs: number;
}

/**
 * Every finding that survives all three checks, and every one that does not with its reason. NEVER
 * re-asks the model: a finding is true as the model cited it or it is gone.
 */
export function verifySliceFindings(findings: readonly SliceFinding[], ctx: PremiseContext): { kept: SliceFinding[]; dropped: DroppedFinding[] } {
  const kept: SliceFinding[] = [];
  const dropped: DroppedFinding[] = [];
  const openIds = new Set(ctx.plan.open.map((t) => t.id));
  const covering = ctx.plan.all.filter((t) => {
    if (openIds.has(t.id)) return true;
    const at = ctx.merged.get(t.id);
    return at !== undefined && at >= ctx.nowMs - ctx.coverageMs;
  });
  for (const finding of findings) {
    const reject = (reason: string): void => void dropped.push({ finding, reason });
    if (!isRepoRelative(finding.file)) { reject(`${finding.file} is not a repo-relative path`); continue; }
    const text = ctx.readAtHead(finding.file);
    if (text === undefined) { reject(`${finding.file} does not exist at HEAD`); continue; }
    const lines = text.split("\n");
    if (finding.line < 1 || finding.line > lines.length) { reject(`${finding.file} has ${lines.length} lines; line ${finding.line} is outside it`); continue; }
    const quotes = claimQuotes(finding.claim);
    if (quotes.length === 0) { reject("the claim quotes no symbol or text in backticks, so nothing can be checked on the cited line"); continue; }
    const cited = lines[finding.line - 1]!;
    if (!quotes.some((q) => cited.includes(q))) { reject(`line ${finding.line} of ${finding.file} does not hold ${quotes.map((q) => `\`${q}\``).join(" or ")}`); continue; }
    const twin = covering.find((t) => taskCovers(t, finding, quotes));
    if (twin !== undefined) { reject(`${twin.id} (${openIds.has(twin.id) ? "open" : "recently merged"}) already covers ${finding.file}`); continue; }
    if (kept.some((k) => k.file === finding.file && k.line === finding.line)) { reject("another finding in this pass already cites the same line"); continue; }
    kept.push(finding);
  }
  return { kept, dropped };
}

// ── Filing ───────────────────────────────────────────────────────────────────────────────────

const sliceTestPath = (finding: SliceFinding): string => `test/scout-slice-${slug(`${finding.file}-${finding.line}`, 50).replace(/-+$/, "")}.test.ts`;

/** Render ONE verified finding as a single-record shard through the shared machine-filing renderer. */
export function sliceShard(finding: SliceFinding, taskId: string, dir: string, population: readonly number[] = []): { text: string; refused?: string } {
  const testPath = sliceTestPath(finding);
  const claim = finding.claim.length > SCOUT_SLICE_MAX_CLAIM_CHARS ? `${finding.claim.slice(0, SCOUT_SLICE_MAX_CLAIM_CHARS - 1)}…` : finding.claim;
  return renderMachineShard({
    taskId,
    title: `THE SCOUT'S SLICE FINDING IN ${finding.file} — ${claim}`,
    origin: scoutSliceOrigin(dir),
    files: [finding.file, testPath],
    costPopulation: population,
    acceptance: [{
      claim: `the weak spot at ${finding.file}:${finding.line} is fixed: ${claim}`,
      proof: `grep: test("${taskId}: ${slug(finding.file, 40)} no longer has the weak spot at line ${finding.line}" in ${testPath}`,
    }],
    note: `Filed by the scout gardener's slice class (W1-T5455). The cited line was re-checked at HEAD before this was filed. MACHINE-AUTHORED — the machine-filing judge releases it or escalates it to a person.`,
    rationale: [
      `The scout read \`${dir}\` and reported, at ${finding.file}:${finding.line}: ${claim}`,
      `The check that shows it true: ${finding.check}`,
      "Re-verify the premise first: if the cited line no longer holds what the claim names, close this task without a change.",
    ],
  });
}

// ── Survival ─────────────────────────────────────────────────────────────────────────────────

export interface SliceSurvivalProbes {
  /** Whether a revert of the task's change reached main. */
  reverted: (taskId: string) => boolean;
  /** Whether the task's PR was closed unmerged. */
  closed: (taskId: string) => boolean;
  /** Whether the finding's own acceptance check still passes at HEAD. */
  checkPasses: (taskId: string) => boolean;
}

export interface SliceSurvivalRow {
  task: string;
  dir: string;
  verdict: "credit" | "debit" | "pending";
  reason?: string;
}

/**
 * A scout slice task credits the class only if its change is still in main a full window after it merged
 * AND its own check still passes. A revert, a closed PR or a failing check debits. Ledger-origin scout
 * tasks are not read here: they are judged by whether their symptom stopped.
 */
export function sliceSurvival(
  plan: PlanInventory, merged: ReadonlyMap<string, number>, probes: SliceSurvivalProbes, nowMs: number,
): { outcome: { trials: number; successes: number }; tracked: SliceSurvivalRow[] } {
  const tracked: SliceSurvivalRow[] = [];
  let trials = 0;
  let successes = 0;
  for (const task of plan.all) {
    if (task.origin === undefined || !isSliceOrigin(task.origin)) continue;
    const dir = task.origin.slice("scout:slice:".length);
    const at = merged.get(task.id);
    const debit = (reason: string): void => { trials += 1; tracked.push({ task: task.id, dir, verdict: "debit", reason }); };
    if (at === undefined) {
      if (probes.closed(task.id)) debit("its PR was closed unmerged");
      continue;
    }
    if (probes.reverted(task.id)) { debit("its change was reverted"); continue; }
    if (nowMs - at < SCOUT_SLICE_SURVIVAL_WINDOW_MS) { tracked.push({ task: task.id, dir, verdict: "pending" }); continue; }
    if (!probes.checkPasses(task.id)) { debit("its own check no longer passes"); continue; }
    trials += 1;
    successes += 1;
    tracked.push({ task: task.id, dir, verdict: "credit" });
  }
  return { outcome: { trials, successes }, tracked };
}

/** The `grep: PATTERN in FILE` acceptance proofs of a task, evaluated at HEAD; a task with none cannot pass. */
export function grepProofsHold(proofs: readonly string[], readAtHead: (path: string) => string | undefined): boolean {
  const greps = proofs.flatMap((p) => {
    const m = /^grep:\s*(.+?)\s+in\s+(\S+)$/.exec(p.trim());
    return m ? [{ needle: m[1]!.replace(/^(['"])(.*)\1$/, "$2"), file: m[2]! }] : [];
  });
  return greps.length > 0 && greps.every((g) => readAtHead(g.file)?.includes(g.needle) === true);
}

/** Task ids whose change a revert commit undid, inside `sinceIso..`: a revert names the commit it undoes. */
export function readRevertedTasks(repoRoot: string, sinceIso: string): Set<string> {
  const git = (args: string[]): string => hostWorktreeGit(repoRoot, args, { maxBuffer: 64 * 1024 * 1024 });
  const out = new Set<string>();
  const log = git(["log", "HEAD", `--since=${sinceIso}`, "-i", "--grep=^revert", "--format=%x01%B"]);
  for (const chunk of log.split("\u0001")) {
    for (const m of chunk.matchAll(/^Remudero-Task:\s*(\S+)\s*$/gm)) out.add(m[1]!);
    for (const m of chunk.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)) {
      let body: string;
      try {
        body = git(["show", "-s", "--format=%B", m[1]!]);
      } catch (error) {
        // A reverted commit this clone cannot show is unknown, not proof of anything: it credits nothing.
        void error;
        continue;
      }
      for (const t of body.matchAll(/^Remudero-Task:\s*(\S+)\s*$/gm)) out.add(t[1]!);
    }
  }
  return out;
}
