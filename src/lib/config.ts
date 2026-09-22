import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalWorkerProviderId, validateConfigShape, WORKER_PROVIDER_IDS, type Config, type WorkerProviderId } from "./config-schema.js";
import { createOrReadExclusive } from "./fs-race-safe.js";
export { canonicalWorkerProviderId, WORKER_PROVIDER_IDS } from "./config-schema.js";
export type { Config, WorkerProviderId } from "./config-schema.js";

/**
 * Instance configuration for a Remudero install. Machine-specific paths live ONLY in
 * `~/.config/remudero/config.json`, outside the git tree — committed source never embeds an
 * absolute machine path. The control plane resolves the claude binary and workspace root from
 * this file, never from PATH (the shell `claude` function isn't the real binary).
 */
// The field shape lives in src/lib/config-schema.ts; this module keeps the semantic resolvers and
// cross-field validation that operate on a typed Config.

/**
 * Resolve the headroom-governor switch. Precedence: `RMD_HEADROOM_ENABLED` env (overrides
 * both directions) > `config.headroom.enabled` > default **true**. `1/true/on/yes`
 * (case-insensitive) enables; anything else present disables.
 */
export function resolveHeadroomEnabled(
  config: Pick<Config, "headroom">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.RMD_HEADROOM_ENABLED;
  if (typeof raw === "string" && raw.trim() !== "") {
    return /^(1|true|on|yes)$/i.test(raw.trim());
  }
  return config.headroom?.enabled ?? true;
}

/**
 * The closed set of worker-provider ids.  Keep runtime validation and the exported union derived
 * from this one value: a new provider must not be accepted by mounts/policy in one path while a
 * second, hand-written literal silently rejects it elsewhere.
 */
export function isWorkerProviderId(value: unknown): value is WorkerProviderId {
  return typeof value === "string" && (WORKER_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Provider list with the backwards-compatible Claude-only default. Normalises every entry through
 *  {@link canonicalWorkerProviderId} (W1-T3607) — THE read boundary for a persisted config's provider
 *  spelling, so every downstream caller sees only the canonical id even when a config.json on disk
 *  still says "openweight". */
export function enabledWorkerProviders(config: Pick<Config, "workerProviders">): WorkerProviderId[] {
  const raw = config.workerProviders?.enabled ?? ["claude"];
  return raw.map((id) => canonicalWorkerProviderId(id) as WorkerProviderId);
}

/**
 * W1-T3705: why a blocked auction may (or may not) RETRY this spawn on Claude billed to API credits.
 *
 * THE VALVE EXISTS FOR THIS MOMENT AND COULD NOT REACH IT. `config.overflow: "api_key"` is there to
 * keep working when the subscription is exhausted, but the auction refuses ON an exhausted
 * subscription and had no knowledge the valve was armed — measured on origin/main, `overflow`
 * appeared nowhere in worker-provider.ts or provider-routing-policy.ts. Armed and unreachable at the
 * one moment it exists for, on any host with more than one provider enabled.
 *
 * A SECOND FALLBACK ARM, NOT WIDER AUCTION ELIGIBILITY. The auction allocates SUBSCRIPTION headroom
 * and an API-billed spawn is not competing for it; loosening its filter would quietly turn a
 * capacity bound into a spend decision. A sibling arm beside the cash fallback keeps the auction's
 * meaning intact and puts the spend behind the same shape of switch.
 *
 * Returns the REASON, like {@link cashFallbackRefusal}: a bare `false` reads, in the logs, exactly
 * like the stall it is meant to explain.
 */
export function overflowFallbackRefusal(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (config.overflow !== "api_key") return 'operator has not set config.overflow to "api_key"';
  // BOTH FACTORS, the two-factor rule `buildWorkerEnv` already enforces: the config switch alone
  // must not bill the fleet to API, and a key sitting in a shell must not either.
  if (!env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY is absent from the daemon environment";
  if (config.dailyCapUsd === undefined || config.dailyCapUsd === null) {
    return "dailyCapUsd is unset, so API-billed spend would be unbounded";
  }
  // The retry rides the claude mount-affinity path, which throws on a provider the committed host
  // config does not enable. Naming it here reports the cause instead of throwing out of the retry.
  if (!enabledWorkerProviders(config).includes("claude")) return "claude is not an enabled worker provider";
  return undefined;
}

/**
 * True when ROUTING, not the daemon's headroom governor, decides what happens at low headroom.
 *
 * THE OLD PREMISE WENT STALE AND THE TWO GATES BECAME A TRAP. This read `enabled.includes("codex")`
 * alone, noting that cash "is selected only by mount affinity" — true when written, false since
 * W1-T3692 made cash a blocked-auction FALLBACK and W1-T3705 added the API-credit arm. The
 * consequence was a pair of gates that could not both be escaped: with codex enabled the AUCTION
 * refuses on an exhausted subscription; dropping codex to skip the auction ARMED this governor
 * instead, which pauses dispatch over the ceiling. Only `enabled: ["claude"]` together with
 * `headroom.enabled: false` reached the overflow valve, and nothing said so.
 *
 * SO A DIVERT PATH COUNTS AS ROUTING OWNING THE DECISION. The governor holds back the last slice of
 * SUBSCRIPTION headroom; if the work will be billed somewhere else entirely, pausing preserves
 * nothing and only stalls the fleet. Standing down is also STRICTLY FINER-GRAINED — the governor
 * pauses every lane at once, while the auction and its fallbacks decide per spawn, so a lane with no
 * divert is still refused on its own merits.
 *
 * Both arms are checked at FULL STRENGTH — {@link overflowFallbackRefusal} for the API arm, cash
 * needing both its switch and its provider. An armed switch whose key or cap is missing diverts
 * nothing, so it must not stand the governor down. */
export function providerRoutingOwnsHeadroom(
  config: Pick<Config, "workerProviders" | "overflow" | "dailyCapUsd">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const enabled = enabledWorkerProviders(config);
  // A second SUBSCRIPTION window to allocate against — the original reason, unchanged.
  if (enabled.includes("codex")) return true;
  // The API-credit arm, read through the one predicate rather than a second copy of its rule.
  if (overflowFallbackRefusal(config as Config, env) === undefined) return true;
  // The cash arm needs its switch AND the provider enabled; either alone diverts nothing.
  if (config.workerProviders?.cashFallbackWhenBlocked === true && enabled.includes("cash")) return true;
  return false;
}

/** Thrown by {@link validateConfig} when a config violates a cross-field invariant. Named
 *  (not a bare `Error`) so callers/tests can assert on the failure mode. */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/**
 * Validate a config's cross-field invariants (§9). The conditional cap guard: `overflow:
 * "api_key"` bills metered `ANTHROPIC_API_KEY`, and any `api`-mode run must be hard-capped —
 * so that pairing with no `dailyCapUsd` is rejected. Throws {@link ConfigValidationError}.
 */
export function validateConfig(config: Config): void {
  validateConfigShape(config, "validateConfig input");
  const dailyCapIsNone = config.dailyCapUsd === undefined || config.dailyCapUsd === null;
  if (config.overflow === "api_key" && dailyCapIsNone) {
    throw new ConfigValidationError(
      'invalid config: overflow: "api_key" requires a dailyCapUsd (api-mode runs must be ' +
        "hard-capped — §9 conditional cap guard); got daily_cap: none",
    );
  }
  // `providers` is already normalised (enabledWorkerProviders), so this fires identically whether the
  // config on disk spells the id "cash" (canonical) or the deprecated "openweight" alias (W1-T3607).
  const providers = enabledWorkerProviders(config);
  if (providers.includes("cash") && dailyCapIsNone) {
    throw new ConfigValidationError(
      'invalid config: workerProviders.enabled includes "cash" (or its deprecated "openweight" spelling) and requires a dailyCapUsd (cash-billed runs must be hard-capped)',
    );
  }
  if (providers.length === 0) {
    throw new ConfigValidationError("invalid config: workerProviders.enabled must contain at least one provider");
  }
  if (new Set(providers).size !== providers.length) {
    throw new ConfigValidationError("invalid config: workerProviders.enabled contains a duplicate provider");
  }
  if (providers.some((provider) => !isWorkerProviderId(provider))) {
    throw new ConfigValidationError(
      `invalid config: workerProviders.enabled accepts only ${WORKER_PROVIDER_IDS.map((provider) => JSON.stringify(provider)).join(", ")}`,
    );
  }
  const reserve = config.workerProviders?.reservePercent ?? 5;
  if (!Number.isFinite(reserve) || reserve < 0 || reserve >= 100) {
    throw new ConfigValidationError("invalid config: workerProviders.reservePercent must be >= 0 and < 100");
  }
  const cacheMs = config.workerProviders?.capacityCacheMs ?? 60_000;
  if (!Number.isFinite(cacheMs) || cacheMs <= 0) {
    throw new ConfigValidationError("invalid config: workerProviders.capacityCacheMs must be > 0");
  }
  for (const tier of ["economy", "balanced", "frontier"] as const) {
    const models = config.workerProviders?.codexModels?.[tier];
    if (models !== undefined && (models.length === 0 || models.some((model) => typeof model !== "string" || model.trim() === ""))) {
      throw new ConfigValidationError(`invalid config: workerProviders.codexModels.${tier} must contain non-empty model ids`);
    }
    if (models && new Set(models).size !== models.length) {
      throw new ConfigValidationError(`invalid config: workerProviders.codexModels.${tier} contains a duplicate model`);
    }
  }
}

// Why: the ZDOTDIR-vs-HOME finding and the W1-T1C compinit stall — docs/forensics/config.md#workershell.
/** The shell Claude Code runs for a worker's Bash tool, granted via `CLAUDE_CODE_SHELL`. Default
 *  `/bin/bash`. Claude Code's Bash snapshot sources `os.homedir()/.<shell>rc`, resolved off `HOME`
 *  rather than `$ZDOTDIR` — so `HOME` (see {@link workerHomeDir}) must also be redirected. */
export function workerShell(config: Config): string {
  return config.workerShell ?? "/bin/bash";
}

/** The soft budget WARNING threshold (notional $). Default 25.00; never a kill. */
export function softBudgetThreshold(config: Config): number {
  return config.softBudgetThresholdUsd ?? 25.0;
}

/** The blocked_review fix rung's strike cap (W1-T76). Default 2 — strike 1 resumes the
 *  failing session, strike 2 is a fresh worker on the same branch. */
export function fixStrikeCap(config: Config): number {
  return config.fixStrikeCap ?? 2;
}

/** Model implement/recon workers ride. Default `sonnet`. */
export function workerModel(config: Config): string {
  return config.workerModel ?? "sonnet";
}

/**
 * Model plan authorship (the Architect) rides — must outrank {@link workerModel} (G-17).
 * Sourced from `.remudero/mounts.yaml`'s `architect:` row, then `config.architectModel`, then
 * `opus`. Retro/triage/inbox-draft each resolve through their own `synthesis.<role>` row
 * instead — see {@link synthesisModel}.
 */
export function architectModel(
  config: Config,
  mounts?: { architect: { model: string } },
): string {
  return mounts?.architect.model ?? config.architectModel ?? "opus";
}

// W1-T3711: THE SQUEEZE-SEAT RESOLVERS ARE GONE, `judgeModel` INCLUDED — deleted rather than wired
// because they were REDUNDANT, not merely unreachable. `selectOpenWeightModel` already maps a
// requested Claude model onto a cash capability: MEASURED, `claude-opus-5` and `opus` both resolve
// `frontier`, whose candidates are `[gpt-5.6-luna, gpt-5.6-terra]` at every effort — the same choice
// a squeeze seat would make, decided once for every seat instead of per row. `judgeModel` had no
// seat at all: `resolveRiskJudgeMount` reads `mounts.routes`, never `mounts.judge` (the Tier
// Invariant's ceiling). The paths that DO carry work when the subscription is gone are
// `cashFallbackWhenBlocked` (W1-T3692) and `config.overflow: "api_key"` (W1-T3705); `parseMount`
// refuses a `squeeze_model` row by name so an old config fails loudly instead of silently.

/** The three synthesis rungs (W1-T2559). Re-declared structurally here to avoid a config↔mounts
 *  import; `src/lib/mounts.ts` exports the canonical `SynthesisRole`. */
export type SynthesisRole = "retro" | "triage" | "inbox_draft";

/**
 * Model a synthesis rung (retro/triage/inbox-draft) rides — its own `synthesis.<role>` row,
 * never {@link architectModel}'s. Unlike `architectModel`, this never defaults:
 * `mounts.synthesis` is required and load-time validated (`mounts.ts`'s `validateMounts`).
 */
export function synthesisModel(mounts: { synthesis: Record<SynthesisRole, { model: string }> }, role: SynthesisRole): string {
  return mounts.synthesis[role].model;
}

/** Reasoning effort a synthesis rung rides — same source and no-default contract as
 *  {@link synthesisModel}. Wired to the spawn in `run-task.ts`. */
export function synthesisEffort(mounts: { synthesis: Record<SynthesisRole, { effort: string }> }, role: SynthesisRole): string {
  return mounts.synthesis[role].effort;
}

/** The iMessage buddy identifier real-time pings go to. Defaults to the operator's Apple ID
 *  email; override via `notifyRecipient` in config.json. */
export function notifyRecipient(config: Config): string {
  return config.notifyRecipient ?? "craigoley@gmail.com";
}

/** Base URL for the operator console's deep links (W1-T144). Default `http://localhost:4317`;
 *  override via `consoleUrl` with a tailnet/LAN address so a pushed link resolves from
 *  wherever the message channel is read. */
export function consoleUrl(config: Config): string {
  return config.consoleUrl ?? "http://localhost:4317";
}

/**
 * The isolated ZDOTDIR every worker shell is pointed at, holding empty `.zshrc`/`.zshenv` so no
 * operator rc leaks in and no interactive `compinit` prompt fires (W1-T1C). Derived from
 * `config.root`; default `<root>/../.config/remudero/zdotdir`, overridable via `zdotdir`.
 */
export function workerZdotdir(config: Config): string {
  return config.zdotdir ?? join(config.root, "..", ".config", "remudero", "zdotdir");
}

/**
 * The scratch directory every worker's `HOME` is redirected to (W1-T18, `worker-home.ts`) —
 * only empty rc files plus symlinks back to the few paths a worker legitimately needs, isolating
 * a worker's shell-snapshot rc (see {@link workerShell}) regardless of host. Derived from
 * `config.root`; default `<root>/worker-home`, overridable via `workerHomeRoot`.
 */
export function workerHomeDir(config: Config): string {
  return config.workerHomeRoot ?? join(config.root, "worker-home");
}

/**
 * Cache root shared by every worker and daemon process on the host. A per-run HOME is deliberate
 * for shell isolation, but using it as XDG_CACHE_HOME created one GitHub cadence stamp per worker.
 * Prefer the explicit host override, then the daemon's XDG/HOME roots; retain the instance path
 * only for hermetic launches that provide neither variable.
 */
export function workerCacheDir(
  config: Pick<Config, "root">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.RMD_GH_CACHE_HOME ?? env.XDG_CACHE_HOME ?? (env.HOME ? join(env.HOME, ".cache") : join(config.root, "state", "cache"));
}

/** Path to the instance config file. Derived, never a committed literal. */
export function configPath(): string {
  return join(homedir(), ".config", "remudero", "config.json");
}

// Why: the W1-T2414 incident this census exists to catch — docs/forensics/config.md#fixture_config_path_segments.
/** The one correct fixture config path (`.config/remudero/config.json`, matching
 *  {@link configPath}'s own construction) — census target for `findFixtureConfigPathViolations`. */
export const FIXTURE_CONFIG_PATH_SEGMENTS = [".config", "remudero", "config.json"] as const;

/** One fixture whose seeded config path does not match {@link configPath}'s own construction. */
export interface FixtureConfigPathViolation {
  /** The file the offending fixture lives in (repo-relative, as handed in). */
  file: string;
  /** `.config/remudero/config.json` — what {@link configPath} itself resolves to. */
  expected: string;
  /** The literal path segments this fixture actually wrote, joined the same way. */
  found: string;
}

/** `join(...)` call ARGUMENTS, paren-matched (not a full parser — same trade-off
 *  test/catch-erasure-ratchet.test.ts's brace matching already makes on this codebase's diffs). */
function matchingParenArgs(source: string, openParenIndex: number): { args: string; end: number } {
  let depth = 1;
  let i = openParenIndex + 1;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") depth--;
  }
  return { args: source.slice(openParenIndex + 1, i - 1), end: i };
}

/** Top-level comma-separated arguments of a call, respecting quotes and nested parens — so
 *  `join(a, b(","), "c")` splits into three, not four. */
function splitTopLevelArgs(argsSource: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < argsSource.length; i++) {
    const ch = argsSource[i];
    if (quote) {
      current += ch;
      if (ch === quote && argsSource[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
    } else if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * The literal string segments a `join(...)` call resolves to, resolving one level of variable
 * indirection (`const dir = join(home, "x")` then `join(dir, "y")`). A non-literal argument
 * (`home`, `homedir()`, `tmpdir()`) contributes nothing — the opaque root, never part of the tail.
 */
function literalJoinTail(argsSource: string, varTails: Map<string, string[]>): string[] {
  const segments: string[] = [];
  for (const arg of splitTopLevelArgs(argsSource)) {
    const literal = /^["'`]([^"'`]*)["'`]$/.exec(arg);
    if (literal) {
      segments.push(literal[1] ?? "");
      continue;
    }
    const ident = /^[A-Za-z_$][\w$]*$/.exec(arg);
    if (ident && varTails.has(arg)) segments.push(...(varTails.get(arg) ?? []));
    // else: an opaque root expression (a bare identifier with no known tail, or a call like
    // `homedir()`/`tmpdir()`) — deliberately contributes no segments.
  }
  return segments;
}

/**
 * Every `const <name> = join(...)` (or `let`/`var`) assignment in `source`, resolved to its
 * literal tail — the one level of indirection real fixtures in this repo actually use.
 */
function collectJoinVarTails(source: string): Map<string, string[]> {
  const tails = new Map<string, string[]>();
  const assignRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*join\(/g;
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(source))) {
    const name = m[1];
    if (!name) continue;
    const openParen = assignRe.lastIndex - 1;
    const { args } = matchingParenArgs(source, openParen);
    tails.set(name, literalJoinTail(args, tails));
  }
  return tails;
}

/** Blank out comments while preserving every other character's offset (same trade-off
 *  test/catch-erasure-ratchet.test.ts's `stripCommentsPreserveOffsets` already makes on this
 *  codebase's own diffs) — so a doc comment DESCRIBING `configPath()`'s construction, split
 *  across a line-wrapped `//` block, is never misparsed as a real `join(...)` call site. */
function stripComments(source: string): string {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}

/**
 * Census over `files` for the W1-T2414 trap (see {@link FIXTURE_CONFIG_PATH_SEGMENTS}). Pure
 * and injected, so it runs against synthetic fixtures and this repo's own `test/` tree. In
 * scope only when a fixture redirects `process.env.HOME` and references `loadConfig`/
 * `configPath`; only a `join(...)` tail ending in `"config.json"` counts as seeding a config.
 */
export function findFixtureConfigPathViolations(
  files: { path: string; content: string }[],
): FixtureConfigPathViolation[] {
  const expected = FIXTURE_CONFIG_PATH_SEGMENTS.join("/");
  const violations: FixtureConfigPathViolation[] = [];
  for (const { path, content: raw } of files) {
    const content = stripComments(raw);
    const redirectsHome = /process\.env\.HOME\s*=/.test(content);
    const reachesConfig = /\bloadConfig\s*\(|\bconfigPath\s*\(/.test(content);
    if (!redirectsHome || !reachesConfig) continue;

    const varTails = collectJoinVarTails(content);
    const joinCallRe = /\bjoin\(/g;
    let m: RegExpExecArray | null;
    const seenFound = new Set<string>();
    while ((m = joinCallRe.exec(content))) {
      const openParen = joinCallRe.lastIndex - 1;
      const { args } = matchingParenArgs(content, openParen);
      const tail = literalJoinTail(args, varTails);
      if (tail.length === 0 || tail[tail.length - 1] !== "config.json") continue;
      const found = tail.join("/");
      if (found === expected || seenFound.has(found)) continue;
      seenFound.add(found);
      violations.push({ file: path, expected, found });
    }
  }
  return violations;
}

/** Render a {@link FixtureConfigPathViolation} into the human-readable line a reviewer sees —
 *  naming both the offending file and the path `configPath()` actually expected (W1-T2414). */
export function renderFixtureConfigPathViolation(v: FixtureConfigPathViolation): string {
  return (
    `${v.file}: seeds its config at "${v.found}", but loadConfig()/configPath() resolves it at ` +
    `"${v.expected}" — this fixture will pass on every developer host and fail only on a runner ` +
    `with no \`claude\` binary, where the absent file sends loadConfig into resolveClaudeBin() ` +
    `(W1-T2414: "Command failed: which claude" names nothing about the config path that caused it)`
  );
}

/** The two shared-knowledge homes {@link learningsHomes} resolves. */
export interface LearningsHomes {
  /** See {@link userOverallLearningsHome}. */
  userOverall: string;
  /** See {@link globalLearningsHome}. */
  global: string;
}

// Why: the D-11 org-brain splitting incident this seam closes — docs/forensics/config.md#learningshomes-resolver.
/**
 * Resolve the two shared-knowledge homes (the "org brain", P32/W1-T145) — the one place both
 * are computed; {@link userOverallLearningsHome}/{@link globalLearningsHome} are thin wrappers
 * so an override reaches every call site. Each defaults to its historic `config.root`-derived
 * path when unconfigured.
 */
export function learningsHomes(config: Config): LearningsHomes {
  return {
    userOverall: config.learningsHomes?.userOverall ?? join(config.root, "learnings-user"),
    global: config.learningsHomes?.global ?? join(config.root, "learnings-global"),
  };
}

/** The user-overall learnings home (P32/W1-T145): a fleet-readable directory outside any repo
 *  checkout, shared by every project's fleet on this instance. Resolved via
 *  {@link learningsHomes}; default `<config.root>/learnings-user`, overridable so multiple
 *  `config.root`s (D-11 cells) share identity. */
export function userOverallLearningsHome(config: Config): string {
  return learningsHomes(config).userOverall;
}

/** The rmd-global learnings home (P32/W1-T145): where the versioned, hash-pinned, cross-user
 *  artifact lives once pulled (see `learnings.ts`'s `loadGlobalArtifact`). Resolved via
 *  {@link learningsHomes}; default `<config.root>/learnings-global`, overridable so
 *  same-machine cells (D-11) share it. */
export function globalLearningsHome(config: Config): string {
  return learningsHomes(config).global;
}

/** Canonical filename of the pulled RMD-GLOBAL artifact inside {@link globalLearningsHome}. */
const GLOBAL_ARTIFACT_FILENAME = "artifact.yaml";

/** Full path to the rmd-global artifact this instance reads (P32/W1-T145) —
 *  `<globalLearningsHome>/artifact.yaml`. A missing file resolves to zero entries via
 *  `learnings.ts`'s `loadGlobalArtifact`, never a crash. */
export function globalArtifactPath(config: Config): string {
  return join(globalLearningsHome(config), GLOBAL_ARTIFACT_FILENAME);
}

// Why: the W1-T2414 diagnosis this rethrow enables — docs/forensics/config.md#resolveclaudebin.
/**
 * Resolve the real `claude` binary in a non-shell context: `execFileSync("which", ...)` runs
 * the binary directly, never the interactive zsh `claude` function. On failure, rethrows naming
 * the config path ({@link configPath}) and which {@link loadConfig} branch reached it.
 */
function resolveClaudeBin(reason: string): string {
  let out: string;
  try {
    out = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`could not resolve the \`claude\` binary for config at ${configPath()} (${reason}): ${cause}`);
  }
  if (!out) {
    throw new Error(`\`which claude\` returned nothing for config at ${configPath()} (${reason})`);
  }
  return out;
}

// Why: the CodeQL js/file-system-race TOCTOU rounds this shape closes — docs/forensics/config.md#loadconfig.
/**
 * Load the instance config, creating it on first run with resolved defaults (`root` defaults to
 * `~/Remudero`). `createOrReadExclusive` (`fs-race-safe.ts`) folds the exists-check and the
 * create into one atomic `open(p, "wx")`, and reads through the file descriptor rather than the
 * path on the `EEXIST` fallback. `resolveClaudeBin()` runs only after an exclusive create wins,
 * or when an existing config is missing the field.
 */
export function loadConfig(): Config {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const result = createOrReadExclusive(p, 0o600);
  if (result.created) {
    try {
      const created = validateConfigShape(
        {
          claudeBin: resolveClaudeBin("config creation was entered"),
          root: join(homedir(), "Remudero"),
        },
        `${p} (created defaults)`,
      );
      validateConfig(created);
      writeSync(result.fd, JSON.stringify(created, null, 2) + "\n");
      return created;
    } finally {
      closeSync(result.fd);
    }
  }
  const parsed = JSON.parse(result.raw) as unknown;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const config = parsed as Record<string, unknown>;
    if (config.claudeBin === undefined || config.claudeBin === null || config.claudeBin === "") {
      config.claudeBin = resolveClaudeBin("existing config is missing claudeBin");
    }
    if (config.root === undefined || config.root === null || config.root === "") {
      config.root = join(homedir(), "Remudero");
    }
  }
  const shaped = validateConfigShape(parsed, p);
  validateConfig(shaped);
  return shaped;
}
