/**
 * REPO-LOCATION PLUMBING — `repoRoot`, its initialiser `resolveRepoRoot`, and
 * `resolveOwnerRepo`, moved out of `src/run-task.ts` (W1-T2260). A MOVE, NOT A REDESIGN: no
 * signature changed, and `run-task.ts` re-imports these three under their original names so
 * its ~280 call sites (165 for `repoRoot`, 57 for `resolveOwnerRepo`) read exactly as before.
 * ONE internal line is NOT byte-identical, deliberately: `resolveRepoRoot`'s install-path
 * fallback derives the checkout root from `import.meta.url`, which is module-relative. This
 * file lives one directory deeper than `src/run-task.ts` did (`src/lib/` vs. `src/`), so its
 * `dirname()` chain gained one more call to keep resolving to the same checkout root —
 * preserving BEHAVIOR is what "a move, not a redesign" means, not preserving unrelated bytes.
 *
 * WHY THESE THREE MOVE TOGETHER. `resolveOwnerRepo` shells `git -C repoRoot ...`, so it cannot
 * relocate without `repoRoot`; `repoRoot` is itself `resolveRepoRoot(process.argv.slice(2),
 * process.cwd())`, so its initialiser has to come along too — a prior plan that moved only two
 * of the three would have discovered the third the same way this task's own measurement did:
 * a `tsc` error inside the file being emptied.
 *
 * WHY A DEDICATED MODULE, NOT A SHARED ONE. `repoRoot`'s initialiser reads `process.argv`/
 * `process.cwd()` AT IMPORT TIME, so any importer of a broader lib file would pay (and trigger)
 * that argv read. Only modules that own argv import this one: `src/run-task.ts` (the CLI
 * entrypoint) and, since W1-T9722, `src/lib/tick-read-worker.ts` (the read-plane worker entry; a
 * worker thread inherits the parent's argv/cwd). test/cli-plumbing-extraction.test.ts names that
 * one exemption and refuses any other.
 *
 * This module imports nothing from `src/run-task.ts` or `src/spike.ts` — the dependency-cruiser
 * `lib-no-spike-or-cli` rule (`severity: "error"`) forbids exactly that edge.
 */
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOwnerRepoAt } from "./owner-repo.js";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFileIfExists } from "./fs-race-safe.js";
import { loadPlan } from "./plan.js";

// W1-T2922: keep the layout API surfaced from repo-location for the review proof, while
// pure library callers import repo-layout.js directly so they do not evaluate repoRoot at import.
// NO RE-EXPORT OF THE LAYOUT HALF, and that is the whole point of the split. A re-export here
// reads as convenience and costs exactly what the split removed: an import runs the file, so a
// library reaching `resolveRepoLayout` THROUGH this module pays the `process.argv` evaluation on
// line ~80 just the same. test/cli-plumbing-extraction.test.ts refuses it by name — this module
// exports the argv cluster and nothing else. Consumers import from ./repo-layout.js directly.

/**
 * Resolve the repo root a `rmd` invocation GATES, in priority order — replacing the
 * old INSTALL-PATH derivation (`dirname(dirname(fileURLToPath(import.meta.url)))`,
 * which named WHERE THE SCRIPT LIVES, never where the operator is standing). The
 * #271 fixture: one checkout's `bin/rmd`, invoked with cwd inside a DIFFERENT work
 * tree, used to silently gate the INSTALL tree's plan — a false green that never
 * opened the file under test.
 *   1. an explicit `--repo-root <path>` escape hatch, read directly off argv (a
 *      GLOBAL flag scanned here rather than through any one command's own flag
 *      allow-list — see `stripRepoRootFlag` (`src/run-task.ts`) for why `main()` strips it
 *      before per-command validation runs).
 *   2. CWD-ASCENT: `git rev-parse --show-toplevel` from `cwd` — the tree the
 *      INVOKING shell is standing in, not the tree the running code happens to live in.
 *   3. Fall back to the INSTALL path ONLY when `cwd` is not inside a git work tree
 *      at all (e.g. a bare/scripted context) — reported on stderr so the fallback
 *      is never silent.
 */
export function resolveRepoRoot(
  argv: string[],
  cwd: string,
  showToplevel: (dir: string) => string = (dir) =>
    execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
): string {
  const flagIdx = argv.indexOf("--repo-root");
  if (flagIdx >= 0 && argv[flagIdx + 1] !== undefined) return resolve(argv[flagIdx + 1]);
  try {
    return showToplevel(cwd);
  } catch (e) {
    // Three `dirname()` calls, not run-task.ts's original two: this module lives one directory
    // deeper (`src/lib/repo-location.ts` vs. `src/run-task.ts`), and the install-root fallback
    // must still resolve to the checkout root, not `<checkout>/src`. Behavior-preserving, not a
    // redesign — see the module header.
    const installRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    console.error(
      `### rmd: cwd (${cwd}) is not inside a git work tree (${(e as Error).message}) — ` +
        `falling back to the install root (${installRoot})`,
    );
    return installRoot;
  }
}

export const repoRoot = resolveRepoRoot(process.argv.slice(2), process.cwd());

/** Owner + repo, parsed from THIS repo's origin url — no hardcoded slug in the tree. */
export function resolveOwnerRepo(): { owner: string; repo: string } {
  return resolveOwnerRepoAt(repoRoot);
}

/** W1-T10925: what the daemon wrote at boot about the repository it drains. */
export interface DaemonTargetRecord { owner: string; repo: string; isSelf: boolean; checkoutRoot: string }

export function daemonTargetRecordPath(stateDir: string): string {
  return join(stateDir, "daemon-target.json");
}

/** W1-T10925: written at boot under `<config.root>/state`, so a verb run with `docker exec` in this
 *  instance can find the target's checkout. The daemon's launch argv is not visible to that verb. */
export function writeDaemonTargetRecord(stateDir: string, record: DaemonTargetRecord): { written: true } | { written: false; reason: string } {
  const path = daemonTargetRecordPath(stateDir);
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(record, null, 2) + "\n");
    renameSync(`${path}.${process.pid}.tmp`, path);
    return { written: true };
  } catch (e) {
    return { written: false, reason: `${path}: ${(e as Error).message}` };
  }
}

export type DaemonTargetRecordRead =
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string }
  | { kind: "record"; record: DaemonTargetRecord };

/** An absent or malformed record means "no target", never a guess from the `repos/` listing. */
export function readDaemonTargetRecord(stateDir: string): DaemonTargetRecordRead {
  const path = daemonTargetRecordPath(stateDir);
  let raw: string | undefined;
  try {
    raw = readFileIfExists(path);
  } catch (e) {
    return { kind: "unreadable", reason: `${path}: ${(e as Error).message}` };
  }
  if (raw === undefined) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: "unreadable", reason: `${path}: ${(e as Error).message}` };
  }
  const r = parsed as Partial<DaemonTargetRecord> | null;
  if (r === null || typeof r !== "object" || typeof r.owner !== "string" || typeof r.repo !== "string" ||
    typeof r.isSelf !== "boolean" || typeof r.checkoutRoot !== "string" || r.checkoutRoot === "") {
    return { kind: "unreadable", reason: `${path}: not an {owner, repo, isSelf, checkoutRoot} record` };
  }
  return { kind: "record", record: { owner: r.owner, repo: r.repo, isSelf: r.isSelf, checkoutRoot: r.checkoutRoot } };
}

export interface VerbPlanRootInput {
  /** The verb's argv; an explicit `--repo-root <path>` in it wins outright. */
  argv?: string[];
  /** The cwd toplevel (`repoRoot`). */
  cwdRoot?: string;
  /** `<config.root>/state`, where the daemon's target record lives; read only once (b) misses.
   *  `undefined` means this host has no instance config, so no target. */
  stateDir: () => string | undefined;
  /** Does the plan at this checkout root hold the id? Defaults to the checkout's `plan/tasks.yaml` + shards. */
  holds?: (root: string, taskId: string) => boolean;
}

export type VerbPlanRoot =
  | { ok: true; root: string; via: "repo-root" | "cwd" | "target"; target?: DaemonTargetRecord }
  | { ok: false; searched: string[]; error: string };

function planHoldsTask(root: string, taskId: string): boolean {
  return loadPlan(join(root, "plan", "tasks.yaml")).byId.has(taskId);
}

/**
 * W1-T10925 — THE PLAN ROOT A PER-TASK OPERATOR VERB ACTS ON. Precedence:
 *   (a) an explicit `--repo-root` wins, as before (the only plan searched);
 *   (b) the cwd toplevel, when its plan holds the id;
 *   (c) the instance's TARGET checkout from the daemon's boot record, when (b) misses and the record
 *       names a non-self target.
 * A self-targeting record, or none at all, resolves exactly as before. A miss names every plan
 * searched, plus the `--repo-root` the target record names.
 */
export function resolveVerbPlanRoot(taskId: string | undefined, input: VerbPlanRootInput): VerbPlanRoot {
  const argv = input.argv ?? process.argv.slice(2);
  const holds = input.holds ?? planHoldsTask;
  const searched: string[] = [];
  const tryRoot = (root: string): boolean => {
    const label = join(root, "plan", "tasks.yaml");
    try {
      if (taskId !== undefined && holds(root, taskId)) return true;
      searched.push(label);
    } catch (e) {
      searched.push(`${label} (unreadable: ${(e as Error).message})`);
    }
    return false;
  };
  let read: DaemonTargetRecordRead | undefined;
  const targetRecord = (): DaemonTargetRecordRead => {
    if (read !== undefined) return read;
    let stateDir: string | undefined;
    try {
      stateDir = input.stateDir();
    } catch (e) {
      return (read = { kind: "unreadable", reason: `instance config: ${(e as Error).message}` });
    }
    return (read = stateDir === undefined ? { kind: "absent" } : readDaemonTargetRecord(stateDir));
  };
  const nonSelf = (r: DaemonTargetRecordRead) => r.kind === "record" && !r.record.isSelf ? r.record : undefined;
  const flagIdx = argv.indexOf("--repo-root");
  const explicit = flagIdx >= 0 && argv[flagIdx + 1] !== undefined ? resolve(argv[flagIdx + 1]!) : undefined;
  // Proposal and inbox verbs have no task id. They still act on the instance's target plan.
  if (taskId === undefined) {
    if (explicit !== undefined) return { ok: true, root: explicit, via: "repo-root" };
    const target = nonSelf(targetRecord());
    return target === undefined
      ? { ok: true, root: input.cwdRoot ?? repoRoot, via: "cwd" }
      : { ok: true, root: target.checkoutRoot, via: "target", target };
  }
  if (explicit !== undefined) {
    if (tryRoot(explicit)) return { ok: true, root: explicit, via: "repo-root" };
  } else {
    const cwdRoot = input.cwdRoot ?? repoRoot;
    if (tryRoot(cwdRoot)) return { ok: true, root: cwdRoot, via: "cwd" };
    const target = nonSelf(targetRecord());
    if (target !== undefined && resolve(target.checkoutRoot) !== resolve(cwdRoot) && tryRoot(target.checkoutRoot)) {
      return { ok: true, root: target.checkoutRoot, via: "target", target };
    }
  }
  const record = targetRecord();
  const target = nonSelf(record);
  const hint = target !== undefined
    ? `; this instance targets ${target.owner}/${target.repo} — read its plan with --repo-root ${target.checkoutRoot}`
    : record.kind === "unreadable" ? `; no instance target (record unreadable: ${record.reason})` : "";
  return { ok: false, searched, error: `not found in ${searched.join(", ")}${hint}` };
}

