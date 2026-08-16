import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `rmd sync` — the sanctioned dedupe-then-pull recipe as one explicit verb (W1-T907,
 * feedback#fb-1784856771241-14ea45).
 *
 * THE PROBLEM. `checkCliFreshness` (src/lib/self-sync.ts) refuses to auto-sync a checkout that
 * is both BEHIND origin/main and DIRTY — correctly, because its contract is "never mutating
 * uncommitted local state" (W1-T79/W1-T445). But the dirt that trips that refusal is very often
 * untracked/modified copies of paths the incoming diff ALREADY carries byte-for-byte: an
 * untracked `plan/feedback/<id>.yaml` the landing bridge already committed on origin/main
 * (W1-T243/#599), or a locally-appended `DECISIONS.md` whose records already landed via
 * `plan/decisions.d` (W1-T191/#966). W1-T446's intersect-only fix to `checkCliFreshness` cannot
 * unstick this class — its own design says the byte-identical discard is a separate decision.
 * THIS is that separate decision: a verb the operator invokes deliberately, once, that discards
 * ONLY provably-lossless dirt, preserves everything else aside with a named report, and
 * fast-forwards. It does not touch `checkCliFreshness` — W1-T446 remains the only task that may
 * change ITS predicate; this module is a new, independent code path.
 *
 * THE THREE-WAY CLASSIFICATION (over every path `git status --porcelain` reports dirty,
 * untracked included):
 *   IDENTICAL   local bytes equal the origin/main blob at that path -> discard it (lossless: the
 *               content is already on origin/main). A locally-appended `DECISIONS.md` gets the
 *               same treatment under a heading-level variant (see {@link classifyDecisions}) —
 *               W1-T191's landing bridge means the raw bytes rarely match even when every
 *               appended RECORD already landed.
 *   DIVERGENT   the path either doesn't exist on origin/main, or exists with different bytes:
 *               NEVER deleted, NEVER overwritten. Copied aside under a timestamped `state/`
 *               directory (gitignored — W1-T256) with a named report BEFORE any discard runs,
 *               and only cleared from the working tree if the fast-forward actually needs that
 *               path (i.e. it is part of `git diff --name-only HEAD..origin/main`) — a divergent
 *               file the ff never touches is left exactly where it was.
 *   BLOCKING    HEAD carries a local commit that is not an ancestor of origin/main — genuine
 *               history divergence. Refuses the WHOLE verb before any classification/mutation:
 *               no file removed, no file moved, no ref moved.
 *
 * The byte-identity test (`git hash-object` on the local file vs `git rev-parse <ref>:<path>`)
 * and the tracked/untracked discard split (`git checkout --` vs `unlink`) deliberately mirror
 * `src/lib/deployer.ts`'s `realDeployDeps().sameAsIncoming`/`discardLocal` closures — REUSING
 * that predicate rather than spelling a third one (design (ii) of the task record). They are
 * reimplemented here, not imported, so this one explicit operator verb does not need to load
 * `deployer.ts`'s fleet-control/ledger dependency graph for a two-git-call comparison; the
 * algorithm — and its "any failure answers false, never a guess" fail-closed default — is
 * unchanged from the original.
 *
 * NOT IN SCOPE (design (vii)): changing `checkCliFreshness`'s own predicate (W1-T446 owns that),
 * auto-invoking this verb from any guard/daemon/launchd unit, or the install-checkout structural
 * fix (fb-1784913390318-1fcb63). The pull is FF-ONLY (`git merge --ff-only origin/main`) —
 * never merge, never rebase, never `reset --hard` on the operator's behalf; an off-`main`
 * checkout refuses exactly as W1-T445 established for `checkCliFreshness`.
 */

export type GitRunner = (args: string[]) => string;

export interface OperatorSyncDeps {
  /** Injectable git runner (repoDir-scoped). Default: real `git -C <repoDir> ...`. */
  git?: GitRunner;
  /** stdout sink. Default: console.log. */
  say?: (msg: string) => void;
  /** stderr sink. Default: console.error. */
  warn?: (msg: string) => void;
  /** Clock for the preserve-aside directory's timestamp. Default: Date.now. */
  now?: () => number;
}

/** One dirty path this run preserved aside, and why it was never discarded. */
export interface PreservedFile {
  path: string;
  reason: string;
}

export type OperatorSyncResult =
  | { status: "up-to-date"; message: string }
  | { status: "degraded"; reason: string; message: string }
  | { status: "refused"; reason: "off-main" | "blocking" | "pull-failed"; message: string }
  | {
      status: "dry-run";
      identical: string[];
      restored: string[];
      preserved: PreservedFile[];
      message: string;
    }
  | {
      status: "synced";
      oldSha: string;
      newSha: string;
      discarded: string[];
      preserved: PreservedFile[];
      reportPath?: string;
      message: string;
    };

const REMEDY_COMMAND = "git pull --ff-only";
const DECISIONS_FILE = "DECISIONS.md";

function defaultGit(repoDir: string): GitRunner {
  return (args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
}

/** Mirrors self-sync.ts's currentBranch: `symbolic-ref -q` prints nothing (and exits 1) on a
 *  detached HEAD, unlike `rev-parse --abbrev-ref HEAD`, which prints the misleading literal
 *  "HEAD". Not imported from self-sync.ts (design (i) keeps that module untouched and unlinked
 *  from this one) — this is the same two-line git call, duplicated on purpose. */
function currentBranch(git: GitRunner): string | undefined {
  try {
    return git(["symbolic-ref", "--short", "-q", "HEAD"]).trim();
  } catch {
    return undefined;
  }
}

function isTracked(git: GitRunner, path: string): boolean {
  try {
    git(["ls-files", "--error-unmatch", "--", path]);
    return true;
  } catch {
    return false;
  }
}

// See this module's header doc: the SAME predicate deployer.ts's realDeployDeps().sameAsIncoming
// already established, reimplemented rather than imported. ANY failure (path absent from the
// ref, unreadable file, git error) answers false — the conservative default, same as the
// original.
function sameAsOrigin(git: GitRunner, path: string, ref: string): boolean {
  try {
    const local = git(["hash-object", "--", path]).trim();
    const incoming = git(["rev-parse", `${ref}:${path}`]).trim();
    return local.length > 0 && local === incoming;
  } catch {
    return false;
  }
}

function existsAtRef(git: GitRunner, path: string, ref: string): boolean {
  try {
    git(["cat-file", "-e", `${ref}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

// Tracked => `checkout --` (restores the path to HEAD's committed bytes — the ff below then
// carries it the rest of the way to origin/main); untracked => remove. Same split as
// deployer.ts's discardLocal, reimplemented for the reason given in this module's header doc.
function discardLocal(git: GitRunner, repoDir: string, path: string): void {
  if (isTracked(git, path)) {
    git(["checkout", "--", path]);
  } else {
    unlinkSync(join(repoDir, path));
  }
}

// NEVER `.trim()` the raw porcelain STRING before this runs: porcelain's status column can
// legitimately start with a space (e.g. " M path" for an unstaged-only modification), and
// trimming the whole blob first eats that leading space off line one, shifting every
// `slice(3)` on that line by one character (silently truncating the path's first letter).
// Trimming is safe and intended PER LINE, after the fixed 3-char status-column slice, only to
// drop a trailing \r.
function parsePorcelain(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/** Every `## ...` heading line — the granularity `decisionRecordContent` (feedback-landing.ts)
 *  writes one per appended record, and the granularity design (iv) names for the absent-records
 *  report: "report the absent records by heading". */
function headingLines(content: string): string[] {
  return content
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.trim());
}

interface DecisionsVerdict {
  kind: "restorable" | "preserve";
  missing: string[];
}

/**
 * W1-T191 case (design (iv)): `DECISIONS.md` is TRACKED and gets appended locally, but records
 * now land on origin/main through the `plan/decisions.d` shard bridge, so its raw bytes rarely
 * match origin/main's copy even when every appended record already landed. Compare by HEADING
 * instead of by byte: every locally-added `## ...` heading present in origin/main's copy ->
 * `restorable` (safe to discard — see the module doc's IDENTICAL treatment); any locally-added
 * heading ABSENT from origin/main -> `preserve`, naming exactly which ones by heading.
 */
function classifyDecisions(git: GitRunner, repoDir: string): DecisionsVerdict {
  let local = "";
  try {
    local = readFileSync(join(repoDir, DECISIONS_FILE), "utf8");
  } catch {
    local = "";
  }
  let origin = "";
  try {
    origin = git(["show", `origin/main:${DECISIONS_FILE}`]);
  } catch {
    origin = "";
  }
  const originHeadings = new Set(headingLines(origin));
  const missing = headingLines(local).filter((h) => !originHeadings.has(h));
  return missing.length === 0 ? { kind: "restorable", missing: [] } : { kind: "preserve", missing };
}

function preserveAside(repoDir: string, stateDir: string, path: string): void {
  const dest = join(stateDir, path);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(repoDir, path), dest);
}

/**
 * Classify every dirty path and, for a real (non-dry-run) invocation, execute the plan: preserve
 * DIVERGENT paths aside FIRST (design (iii) — before any discard/clear runs), discard IDENTICAL
 * (and heading-restorable DECISIONS.md) paths, clear DIVERGENT paths only where the fast-forward
 * actually needs them, then `git merge --ff-only origin/main`.
 */
export function runOperatorSync(
  repoDir: string,
  opts: { dryRun?: boolean } = {},
  deps: OperatorSyncDeps = {},
): OperatorSyncResult {
  const git = deps.git ?? defaultGit(repoDir);
  const say = deps.say ?? ((msg: string) => console.log(msg));
  const warn = deps.warn ?? ((msg: string) => console.error(msg));
  const now = deps.now ?? (() => Date.now());
  const dryRun = opts.dryRun === true;

  try {
    git(["fetch", "--quiet", "origin"]);
  } catch (err) {
    const message = `rmd sync: git fetch origin failed in ${repoDir}: ${String(err)}`;
    warn(message);
    return { status: "degraded", reason: "fetch-failed", message };
  }

  let headSha: string;
  let originSha: string;
  try {
    headSha = git(["rev-parse", "HEAD"]).trim();
    originSha = git(["rev-parse", "origin/main"]).trim();
  } catch (err) {
    const message = `rmd sync: could not resolve HEAD/origin/main in ${repoDir}: ${String(err)}`;
    warn(message);
    return { status: "degraded", reason: "resolve-failed", message };
  }

  if (headSha === originSha) {
    const message = "### rmd sync: already up to date with origin/main — nothing to classify or pull";
    say(message);
    return { status: "up-to-date", message };
  }

  const branch = currentBranch(git);
  if (branch !== "main") {
    const where = branch === undefined ? "a DETACHED HEAD" : `branch \`${branch}\``;
    const message =
      `rmd sync: this checkout is on ${where}, not \`main\` -- refusing (never moving a ref that ` +
      `is not main, same rule W1-T445 established for the CLI entry guard). Run ` +
      `\`${REMEDY_COMMAND}\` yourself if that is really what you want.`;
    warn(message);
    return { status: "refused", reason: "off-main", message };
  }

  let ffPossible = true;
  try {
    git(["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
  } catch {
    ffPossible = false;
  }
  if (!ffPossible) {
    const message =
      `rmd sync: HEAD carries a local commit that is not an ancestor of origin/main -- refusing ` +
      `the WHOLE verb (never merging, rebasing, or discarding real history on your behalf). No ` +
      `file was removed or moved, and HEAD is unchanged. Resolve the divergence yourself, then ` +
      `re-run \`rmd sync\`.`;
    warn(message);
    return { status: "refused", reason: "blocking", message };
  }

  // --untracked-files=all: an entirely-new UNTRACKED DIRECTORY otherwise collapses to one
  // `?? dir/` line instead of enumerating the files inside it — exactly the shape the operator's
  // own untracked exhaust takes (a fresh plan/feedback/<id>.yaml under a directory the checkout
  // has never tracked a file in before), and a collapsed directory line can neither hash nor be
  // discarded as a single path.
  const dirty = parsePorcelain(git(["status", "--porcelain", "--untracked-files=all"]));
  const incoming = new Set(
    git(["diff", "--name-only", `${headSha}..origin/main`])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );

  const identical: string[] = [];
  const restored: string[] = [];
  const preserved: PreservedFile[] = [];
  // DIVERGENT (and decisions-preserve) paths: preserved unconditionally, cleared from the
  // working tree only when `incoming` actually needs that path.
  const clearIfNeeded: string[] = [];

  for (const path of dirty) {
    if (path === DECISIONS_FILE && isTracked(git, path)) {
      const verdict = classifyDecisions(git, repoDir);
      if (verdict.kind === "restorable") {
        restored.push(path);
      } else {
        preserved.push({
          path,
          reason:
            `DECISIONS.md: ${verdict.missing.length} appended record(s) not yet on origin/main: ` +
            verdict.missing.join("; "),
        });
        clearIfNeeded.push(path);
      }
      continue;
    }
    if (sameAsOrigin(git, path, "origin/main")) {
      identical.push(path);
      continue;
    }
    const onOrigin = existsAtRef(git, path, "origin/main");
    preserved.push({
      path,
      reason: onOrigin ? "differs from the origin/main blob at this path" : "no origin/main counterpart",
    });
    clearIfNeeded.push(path);
  }

  if (dryRun) {
    const lines = [
      `### rmd sync --dry-run: ${identical.length} identical (would discard), ${restored.length} ` +
        `DECISIONS.md record set(s) fully landed (would restore), ${preserved.length} genuinely ` +
        `local (would preserve aside, never deleted)`,
      ...identical.map((p) => `  identical -> discard: ${p}`),
      ...restored.map((p) => `  decisions -> restore: ${p}`),
      ...preserved.map((p) => `  preserve  -> ${p.path} (${p.reason})`),
      "Nothing was mutated -- no deletion, no preserve copy, HEAD unchanged. Re-run without " +
        "--dry-run to execute this plan.",
    ];
    const message = lines.join("\n");
    say(message);
    return { status: "dry-run", identical, restored, preserved, message };
  }

  // PRESERVE FIRST — before any discard/clear runs (design (iii)).
  let reportPath: string | undefined;
  if (preserved.length > 0) {
    const stateDir = join(repoDir, "state", `sync-${now()}`);
    mkdirSync(stateDir, { recursive: true });
    for (const f of preserved) preserveAside(repoDir, stateDir, f.path);
    const report = `# rmd sync preserve-aside report\n\n${preserved.map((f) => `- ${f.path}: ${f.reason}`).join("\n")}\n`;
    writeFileSync(join(stateDir, "report.md"), report, "utf8");
    reportPath = stateDir;
    say(`### rmd sync: preserved ${preserved.length} file(s) aside -> ${stateDir}`);
    for (const f of preserved) say(`  preserved: ${f.path} (${f.reason})`);
  }

  // DISCARD byte-identical dirt (and fully-landed DECISIONS.md) — lossless by construction.
  for (const p of identical) discardLocal(git, repoDir, p);
  for (const p of restored) discardLocal(git, repoDir, p);

  // CLEAR preserved-but-in-the-way paths ONLY when the fast-forward actually needs them.
  for (const p of clearIfNeeded) {
    if (incoming.has(p)) discardLocal(git, repoDir, p);
  }

  try {
    git(["merge", "--ff-only", "origin/main"]);
  } catch (err) {
    const message =
      `rmd sync: fast-forward failed after clearing byte-identical dirt: ${String(err)} -- your ` +
      `genuinely-local files are unaffected` + (reportPath ? ` and still safe under ${reportPath}` : "");
    warn(message);
    return { status: "refused", reason: "pull-failed", message };
  }

  const newSha = git(["rev-parse", "HEAD"]).trim();
  const discarded = [...identical, ...restored];
  const message =
    `### rmd sync: ${headSha.slice(0, 7)}..${newSha.slice(0, 7)} -- discarded ${discarded.length} ` +
    `byte-identical file(s), preserved ${preserved.length} genuinely-local file(s)` +
    (reportPath ? ` (report: ${reportPath})` : "");
  say(message);
  return { status: "synced", oldSha: headSha, newSha, discarded, preserved, reportPath, message };
}
