import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Instance configuration for a Remudero install.
 *
 * Machine-specific paths live ONLY here — in `~/.config/remudero/config.json`,
 * outside the git tree. Committed source must never embed absolute machine
 * paths (public-repo hygiene). The control plane resolves the claude binary
 * and workspace root from this file, never from PATH at call time
 * (FIELD FINDING 2/3: `claude` is a shell function; the real binary must be
 * resolved once, out-of-band, and pinned).
 */
export interface Config {
  /** Absolute path to the real claude CLI binary (never the shell function). */
  claudeBin: string;
  /** Workspace root; everything the fleet touches lives under it (§4A). */
  root: string;
  /**
   * Isolated ZDOTDIR handed to every worker shell (see {@link workerZdotdir}).
   * Optional in the config file; defaults to `<root>/../.config/remudero/zdotdir`.
   */
  zdotdir?: string;
  /**
   * Shell Claude Code uses for worker Bash tools (see {@link workerShell}).
   * Optional; defaults to `/bin/bash`.
   */
  workerShell?: string;
  /**
   * Scratch HOME every worker is redirected into (see {@link workerHomeDir}) —
   * the W1-T18 general isolation mechanism. Optional in the config file;
   * defaults to `<root>/worker-home`.
   */
  workerHomeRoot?: string;
  /**
   * SOFT budget threshold (notional $) at which a run ledgers a WARNING and
   * CONTINUES — a visibility tripwire, NOT a kill. Optional; defaults to 25.00.
   * The HARD cap (a run's `budget_usd`, default 100) is the runaway backstop; this
   * soft line just surfaces an anomaly before it reaches the hard cap. On
   * subscription these dollars are NOTIONAL (§9). See {@link softBudgetThreshold}.
   */
  softBudgetThresholdUsd?: number;
  /** Model implement/recon workers ride. Optional; defaults to `sonnet`. */
  workerModel?: string;
  /** Model the retro Architect rides — MUST outrank workerModel (G-17). Default `opus`. */
  architectModel?: string;
  /**
   * iMessage buddy identifier (phone number or Apple ID email) real-time escalation
   * pings are sent to (W1-T8, notify.ts). Optional; defaults to the operator's Apple
   * ID email so the notifier works out of the box on a single-operator instance.
   */
  notifyRecipient?: string;
  /**
   * Overflow valve (operator opt-in, §9): `"none"` (default) never routes off the
   * subscription; `"api_key"` lets priority-queued runs bill via ANTHROPIC_API_KEY
   * at metered rates once subscription windows are exhausted, rather than waiting
   * for reset. See {@link validateConfig} for the invariant this field is paired with.
   */
  overflow?: "none" | "api_key";
  /**
   * Hard daily dollar cap enforced whenever a run bills in `api` mode (§9 conditional
   * cap guard: "no dollar cap" is valid ONLY under subscription billing — any run
   * that overflows to `api_key` billing is ALWAYS capped). `undefined`/`null` means
   * "no cap", which is why `overflow: "api_key"` can never be paired with an unset
   * `dailyCapUsd` — {@link validateConfig} rejects that combination at load.
   */
  dailyCapUsd?: number | null;
}

/**
 * Thrown by {@link validateConfig} when a config violates one of the harness's
 * cross-field invariants. Named (rather than a bare `Error`) so callers/tests can
 * assert on the specific failure mode instead of matching on message text.
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/**
 * Validate a config's cross-field invariants (§9). Currently enforces the
 * **conditional cap guard**: `overflow: "api_key"` routes runs to metered
 * ANTHROPIC_API_KEY billing, and any run in `api` billing mode MUST be hard-capped
 * regardless of operator settings — so `overflow: "api_key"` paired with no
 * `dailyCapUsd` (`daily_cap: none`) is rejected rather than silently letting an
 * uncapped run bill real money. Throws {@link ConfigValidationError}; does not
 * return a boolean, so a caller cannot accidentally ignore an invalid config.
 */
export function validateConfig(config: Config): void {
  const dailyCapIsNone = config.dailyCapUsd === undefined || config.dailyCapUsd === null;
  if (config.overflow === "api_key" && dailyCapIsNone) {
    throw new ConfigValidationError(
      'invalid config: overflow: "api_key" requires a dailyCapUsd (api-mode runs must be ' +
        "hard-capped — §9 conditional cap guard); got daily_cap: none",
    );
  }
}

/**
 * The shell Claude Code runs for a worker's Bash tool, granted via
 * `CLAUDE_CODE_SHELL`. Default `/bin/bash`.
 *
 * WHY NOT ZDOTDIR ALONE (installed-version ground truth, CLI 2.1.209): Claude
 * Code builds a shell SNAPSHOT for its Bash tool by sourcing the rc file at
 * `os.homedir()/.zshrc` — resolved from HOME, NOT `$ZDOTDIR`. Setting ZDOTDIR
 * does not redirect it. But the rc filename follows the shell: bash →
 * `$HOME/.bashrc`. Pointing the snapshot shell at bash used to work only
 * because THIS host's `$HOME/.bashrc` happened to be absent (LEARNINGS.md,
 * PR #8) — an accident, not construction; a stranger's populated `~/.bashrc`
 * would isolate nothing. W1-T18 (see {@link workerHomeDir}, `worker-home.ts`)
 * fixes the accident by redirecting the worker's `HOME` itself to a
 * Remudero-controlled scratch dir holding only empty rc files, so `bash →
 * $HOME/.bashrc` now resolves to a path the OPERATOR never wrote regardless
 * of what their real `~/.bashrc` contains. ZDOTDIR is kept alongside this as
 * defense-in-depth for any direct `zsh` a worker spawns, and never fires the
 * interactive `compinit` prompt that stalled W1-T1C.
 */
export function workerShell(config: Config): string {
  return config.workerShell ?? "/bin/bash";
}

/** The soft budget WARNING threshold (notional $). Default 25.00; never a kill. */
export function softBudgetThreshold(config: Config): number {
  return config.softBudgetThresholdUsd ?? 25.0;
}

/** Model implement/recon workers ride. Default `sonnet`. */
export function workerModel(config: Config): string {
  return config.workerModel ?? "sonnet";
}

/** Model the retro Architect rides (must outrank workerModel — G-17). Default `opus`. */
export function architectModel(config: Config): string {
  return config.architectModel ?? "opus";
}

/**
 * The iMessage buddy identifier real-time pings go to. Default is the operator's
 * Apple ID email (single-operator instance) — overridable per-instance via
 * `notifyRecipient` in config.json for a phone number or a different Apple ID.
 */
export function notifyRecipient(config: Config): string {
  return config.notifyRecipient ?? "craigoley@gmail.com";
}

/**
 * The isolated ZDOTDIR every worker shell is pointed at. It holds empty
 * `.zshrc`/`.zshenv`, so a worker's zsh sources NO operator rc file — no aliases
 * or functions leak in, and (the reason this exists) no interactive `compinit`
 * prompt fires with no tty to answer it, which is how W1-T1C's run stalled.
 *
 * Derived from `config.root`, NEVER a hardcoded absolute path (public-repo
 * hygiene): default `<root>/../.config/remudero/zdotdir`. An instance may pin it
 * explicitly via the `zdotdir` field in `~/.config/remudero/config.json`.
 */
export function workerZdotdir(config: Config): string {
  return config.zdotdir ?? join(config.root, "..", ".config", "remudero", "zdotdir");
}

/**
 * The Remudero-controlled scratch directory every worker's `HOME` is
 * redirected to (W1-T18 general shell-isolation mechanism, `worker-home.ts`).
 * It holds ONLY empty rc files Remudero itself wrote, plus explicit symlinks
 * back to the real HOME for the few paths a worker legitimately needs
 * (`.claude`, `.config/gh`, `.gitconfig`) — so a worker's shell-snapshot rc
 * (`$HOME/.bashrc`, resolved off `HOME` — see {@link workerShell}) is isolated
 * from the OPERATOR's real dotfiles regardless of what they contain, not just
 * on hosts where `~/.bashrc` happens to be absent.
 *
 * Derived from `config.root`, never a hardcoded absolute path (public-repo
 * hygiene): default `<root>/worker-home`. An instance may pin it explicitly
 * via `workerHomeRoot` in `~/.config/remudero/config.json`.
 */
export function workerHomeDir(config: Config): string {
  return config.workerHomeRoot ?? join(config.root, "worker-home");
}

/** Path to the instance config file. Derived, never a committed literal. */
export function configPath(): string {
  return join(homedir(), ".config", "remudero", "config.json");
}

/**
 * Resolve the real `claude` binary in a NON-shell context.
 *
 * `execFileSync('which', ...)` runs the `which` binary directly, so it never
 * sees the interactive zsh `claude` function (FIELD FINDING 3) — it returns the
 * on-disk executable that a spawned Node process would actually exec.
 */
function resolveClaudeBin(): string {
  const out = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  if (!out) throw new Error("could not resolve `claude` binary via `which`");
  return out;
}

/**
 * Load the instance config, creating it on first run with resolved defaults.
 * `root` defaults to `~/Remudero`. Returns fully-resolved absolute paths.
 */
export function loadConfig(): Config {
  const p = configPath();
  if (!existsSync(p)) {
    const created: Config = {
      claudeBin: resolveClaudeBin(),
      root: join(homedir(), "Remudero"),
    };
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(created, null, 2) + "\n", { mode: 0o600 });
    return created;
  }
  const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<Config>;
  if (!parsed.claudeBin) parsed.claudeBin = resolveClaudeBin();
  if (!parsed.root) parsed.root = join(homedir(), "Remudero");
  validateConfig(parsed as Config);
  return parsed as Config;
}
