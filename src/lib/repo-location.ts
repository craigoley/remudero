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
 * `process.cwd()` AT IMPORT TIME — that evaluation is deliberately scoped to modules that
 * legitimately own argv. Folding it into a broader lib file would mean any importer pulling in
 * an unrelated symbol from that file also pays (and triggers) the argv read. Keeping this
 * cluster in its own module means the only thing that imports it is something that actually
 * wants repo-location plumbing.
 *
 * This module imports nothing from `src/run-task.ts` or `src/spike.ts` — see
 * `.dependency-cruiser.cjs`'s `lib-no-spike-or-cli` rule (`severity: "error"`), which forbids
 * exactly that edge.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  const url = execFileSync("git", ["-C", repoRoot, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  }).trim();
  const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`could not parse owner/repo from origin url`);
  return { owner: m[1], repo: m[2] };
}

/**
 * ONE resolved layout per target (W1-T2922). The harness's own directory shape — where the plan
 * lives, where the learnings corpus lives, where the alert policy lives — was assumed by 20+
 * non-test src files repeating the same literal joins against `repoRoot`, which is fine for THIS
 * checkout (the "house") but throws the moment a target repo the harness is asked to manage has a
 * differently-shaped tree (no shard directory, no learnings corpus at all, a relocated plan). This
 * type is the ONE place that shape is named; every field is an ABSOLUTE path, so a caller never
 * re-derives one relative to a root it might have wrong.
 * INVARIANT: {@link resolveRepoLayout}'s house defaults (no override present) reproduce today's
 * literals exactly — the house is the default, a foreign shape is one override file away.
 */
export interface RepoLayout {
  /** The target's own root — every field below is house-defaulted off this unless the target's
   *  own layout override (see {@link resolveRepoLayout}) names a different value. */
  root: string;
  /** The directory the plan monolith lives in, and shard files (`tasks.d/`) are sought under. */
  planDir: string;
  /** The monolith path the plan loader reads (`plan.ts`'s `loadPlan`/`loadPlanForLayout`). */
  planMonolith: string;
  /** The plan's narrative counterpart — the repo's top-level plan-authoring doc. */
  masterPlan: string;
  /** The learnings corpus directory (`learnings.ts`'s `projectLearningsHome`). */
  learningsDir: string;
  /** The per-repo tuned-profile file (a FILE, not a directory: this codebase keeps one file per
   *  `.remudero`-scoped concern, e.g. `project-init.ts`'s onboarding output). */
  principlesFile: string;
  /** The alert policy path (`alert-lane.ts`'s `loadAlertPolicy`). */
  alertPolicy: string;
  /** This harness's own per-target state directory (managed-repos list, mounts, skills, layout
   *  override itself). Never itself overridable — a layout override necessarily lives inside it,
   *  so a target cannot relocate the very directory its override would be read from. */
  stateDir: string;
}

export class RepoLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoLayoutError";
  }
}

/** The subset of {@link RepoLayout} a target's own layout override may declare — every key
 *  optional (an omitted key keeps the house default), a relative value resolved against the
 *  target's `root`, an absolute value kept as-is. */
type RepoLayoutOverrides = Partial<Omit<RepoLayout, "root" | "stateDir">>;

const OVERRIDABLE_LAYOUT_KEYS: readonly (keyof RepoLayoutOverrides)[] = [
  "planDir",
  "planMonolith",
  "masterPlan",
  "learningsDir",
  "principlesFile",
  "alertPolicy",
];

/** House defaults (THIS repo's own shape) for a given target root — the fallback {@link
 *  resolveRepoLayout} uses for every field the target's own override omits. */
function houseLayoutDefaults(root: string): Omit<RepoLayout, "root" | "stateDir"> {
  return {
    planDir: join(root, "plan"),
    planMonolith: join(root, "plan", "tasks.yaml"),
    masterPlan: join(root, "MASTER-PLAN.md"),
    learningsDir: join(root, "learnings"),
    principlesFile: join(root, ".remudero", "principles.yaml"),
    alertPolicy: join(root, "plan", "alert-policy.yaml"),
  };
}

/** Where a target's own layout override lives — always here, inside its own state directory,
 *  regardless of what the override itself declares (it describes the layout; it cannot relocate
 *  the file it is read from). */
function layoutOverridePath(root: string): string {
  return join(root, ".remudero", "layout.json");
}

/** Parse and field-validate an already-read layout override document. FAILS LOUD on malformed
 *  JSON, a non-object shape, an unrecognized key, or a non-string value — same discipline
 *  `managed-repos.ts` applies to its own `.remudero`-scoped file: validate before any read
 *  consumer trusts it. */
function parseLayoutOverrides(text: string, path: string): RepoLayoutOverrides {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RepoLayoutError(`${path} is not valid JSON: ${String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RepoLayoutError(`${path} must be a JSON object of layout overrides`);
  }
  const out: RepoLayoutOverrides = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(OVERRIDABLE_LAYOUT_KEYS as readonly string[]).includes(key)) {
      throw new RepoLayoutError(
        `${path}: unknown layout key '${key}' (must be one of ${OVERRIDABLE_LAYOUT_KEYS.join(", ")})`,
      );
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new RepoLayoutError(`${path}: '${key}' must be a non-empty string, got ${JSON.stringify(value)}`);
    }
    (out as Record<string, string>)[key] = value;
  }
  return out;
}

/**
 * Resolve ONE {@link RepoLayout} for `target` (W1-T2922): house defaults, overridden field-by-
 * field by a layout override this target's own state directory may carry. Running this against
 * THIS checkout's own root returns exactly today's literals, so every existing caller that keeps
 * its own inline join stays byte-identical — the house IS the default. A target with no plan
 * shard directory and no learnings corpus is not a special case here: {@link "./plan.js".loadPlan}
 * and {@link "./learnings.js".loadLearningsCorpus} already treat a missing directory as "nothing
 * here yet", never a throw (see test/repo-layout.test.ts).
 * A present-but-malformed override fails loud ({@link parseLayoutOverrides}); a MISSING one is not
 * an error — the house defaults apply, unchanged.
 */
export function resolveRepoLayout(
  root: string,
  readOverrideFile: (path: string) => string | undefined = (path) =>
    existsSync(path) ? readFileSync(path, "utf8") : undefined,
): RepoLayout {
  const defaults = houseLayoutDefaults(root);
  const overridePath = layoutOverridePath(root);
  const raw = readOverrideFile(overridePath);
  const overrides = raw === undefined ? {} : parseLayoutOverrides(raw, overridePath);
  const resolveField = (rel: string | undefined, fallback: string): string =>
    rel === undefined ? fallback : isAbsolute(rel) ? rel : join(root, rel);
  return {
    root,
    planDir: resolveField(overrides.planDir, defaults.planDir),
    planMonolith: resolveField(overrides.planMonolith, defaults.planMonolith),
    masterPlan: resolveField(overrides.masterPlan, defaults.masterPlan),
    learningsDir: resolveField(overrides.learningsDir, defaults.learningsDir),
    principlesFile: resolveField(overrides.principlesFile, defaults.principlesFile),
    alertPolicy: resolveField(overrides.alertPolicy, defaults.alertPolicy),
    stateDir: join(root, ".remudero"),
  };
}
