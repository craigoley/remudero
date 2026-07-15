/**
 * THE BILLING BOUNDARY (FIELD FINDING 1, MASTER-PLAN §9).
 *
 * Worker environments are CONSTRUCTED, never inherited. `ANTHROPIC_API_KEY` is
 * exported from this operator's login shell and TAKES PRECEDENCE over the
 * claude.ai OAuth login — any child that inherits it silently bills API rates
 * instead of the Max subscription. By building each child env from an explicit
 * allowlist and asserting no `ANTHROPIC_*` key survives, Claude Code falls back
 * to subscription OAuth. `billing_mode` becomes a decision the harness makes and
 * records, never an accident it inherits.
 *
 * launchd happens to be clean (it never sources `.zshrc`), but a daemon started
 * from a dev shell inherits the key — this function is what makes BOTH paths
 * safe. The API key is injected ONLY when an overflow valve is deliberately
 * engaged (not in this spike).
 */

import { join } from "node:path";

/**
 * Base variables a worker legitimately needs, copied from the parent by name.
 *
 * `USER` is load-bearing on macOS: the subscription OAuth token is stored in the
 * login Keychain (not a file), and the CLI resolves the keychain identity from
 * `USER`. With PATH/HOME/TMPDIR/LANG but no USER, a headless run returns
 * "Not logged in · Please run /login" (verified: SDK 0.3.209 / CLI 2.1.209).
 * `LOGNAME` alone is NOT sufficient. None of these carry secrets.
 */
const ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "USER"] as const;

/** Any key matching this is a billing-boundary violation and must not survive. */
const ANTHROPIC_KEY = /^ANTHROPIC_/i;

/**
 * Build a child environment from an explicit allowlist plus caller-supplied
 * vars. Never inherits `process.env` wholesale. Throws if any `ANTHROPIC_*`
 * key survives (including one a caller passed in), so a leak fails loud at the
 * boundary rather than silently on the invoice.
 *
 * Shell isolation is the SAME contamination class as the ANTHROPIC_* denial,
 * mirrored: where ANTHROPIC_* is DENIED, the two shell vars below are GRANTED,
 * so a worker's shell sources Remudero's own (empty) rc, never the operator's.
 * Workers inherit NOTHING they aren't explicitly given; neither var is copied
 * from the parent (an operator ZDOTDIR/CLAUDE_CODE_SHELL is ignored), only set
 * to the granted value.
 *  - `opts.shell` → **CLAUDE_CODE_SHELL** (default `/bin/bash`). Claude Code's
 *    Bash-tool snapshot sources `os.homedir()/.<shell>rc`; bash's `$HOME/.bashrc`
 *    is absent on a stock macOS, so the snapshot is empty — this is what actually
 *    stops the operator's `~/.zshrc` (and its interactive `compinit` prompt that
 *    stalled W1-T1C) from reaching the worker. See config.workerShell.
 *  - `opts.zdotdir` → **ZDOTDIR** (default derived from HOME). Defense-in-depth
 *    for any direct `zsh` a worker spawns. See config.workerZdotdir.
 */
export function buildWorkerEnv(
  extra: Record<string, string> = {},
  parent: NodeJS.ProcessEnv = process.env,
  opts: { zdotdir?: string; shell?: string } = {},
): Record<string, string> {
  const child: Record<string, string> = {};

  for (const key of ALLOWLIST) {
    const val = parent[key];
    if (typeof val === "string") child[key] = val;
  }

  for (const [key, val] of Object.entries(extra)) {
    child[key] = val;
  }

  // Grant CLAUDE_CODE_SHELL (unless the caller set one via `extra`). This is the
  // var that actually isolates the worker's Bash-tool snapshot from ~/.zshrc.
  if (!("CLAUDE_CODE_SHELL" in child)) {
    const shell = opts.shell ?? "/bin/bash";
    child.CLAUDE_CODE_SHELL = shell;
  }

  // Grant ZDOTDIR (unless the caller set one via `extra`). Prefer the path the
  // caller resolved from config; otherwise derive the default from HOME
  // (`<HOME>/.config/remudero/zdotdir`, i.e. `<root>/../.config/remudero/zdotdir`).
  if (!("ZDOTDIR" in child)) {
    const home = child.HOME ?? parent.HOME;
    const zdotdir = opts.zdotdir ?? (home ? join(home, ".config", "remudero", "zdotdir") : undefined);
    if (zdotdir) child.ZDOTDIR = zdotdir;
  }

  const survivors = Object.keys(child).filter((k) => ANTHROPIC_KEY.test(k));
  if (survivors.length > 0) {
    throw new Error(
      `buildWorkerEnv: billing-boundary violation — ANTHROPIC_* keys survived: ${survivors.join(", ")}`,
    );
  }

  return child;
}

/** True iff `env` carries zero ANTHROPIC_* keys. Proof helper for callers. */
export function isBillingClean(env: Record<string, string | undefined>): boolean {
  return !Object.keys(env).some((k) => ANTHROPIC_KEY.test(k));
}

/** Result of {@link assertCleanBoot} — one ledger-ready boot-time reading. */
export interface BootAssertion {
  /** True iff the DAEMON'S OWN process env (not a worker's — see below) is ANTHROPIC_*-free. */
  env_clean: boolean;
  /** Always `"subscription"` here: this repo never runs a daemon under `api` billing (§9). */
  billing_mode: "subscription";
}

/**
 * The daemon's boot-time billing assertion (W1-T12b). This checks the DAEMON
 * PROCESS'S OWN env — what launchd (or a dev shell) handed it at exec — which
 * is a DIFFERENT env from a worker's: every worker's env is already built fresh
 * from `buildWorkerEnv`'s allowlist above and can never inherit an ANTHROPIC_*
 * key regardless of what the daemon process itself carries. So `env_clean:
 * false` here does not mean a leak reached a worker — it means the daemon was
 * booted from a contaminated shell rather than launchd's clean one (launchd
 * never sources `.zshrc` — see file header), which is a canary worth logging
 * loudly, not a hard gate: {@link isBillingClean} does the read, this just
 * shapes it into the ledger fields `daemon.boot` (wired in lib/daemon.ts)
 * records: `env_clean=true / billing_mode=subscription` on the clean path this
 * repo always expects in production.
 */
export function assertCleanBoot(env: NodeJS.ProcessEnv = process.env): BootAssertion {
  return { env_clean: isBillingClean(env), billing_mode: "subscription" };
}
