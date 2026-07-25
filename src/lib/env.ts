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
 * safe by DEFAULT (absent key ⇒ subscription, exactly as before).
 *
 * THE OVERFLOW VALVE (opt-in, W1-T258). Engaging it is TWO-FACTOR, so the key
 * merely being present in a shell can never silently bill the fleet to API:
 *   1. INTENT — `config.overflow: "api_key"` (config.ts §9), which `validateConfig`
 *      refuses unless it is paired with a `dailyCapUsd` (no uncapped api run can
 *      even be configured). The caller passes this through as `opts.allowApiKey`.
 *   2. KEY — `ANTHROPIC_API_KEY` present in the parent env.
 * With BOTH, that one key — and only that one — is passed BY VALUE into each
 * worker's env so the run bills to API credits instead of an exhausted
 * subscription window. It travels env→env only: never written to a file, never
 * logged as a value (only its NAME appears in `childEnvKeys`). Absent EITHER
 * factor ⇒ subscription, exactly as before. Every OTHER `ANTHROPIC_*` key
 * (BASE_URL/MODEL/AUTH_TOKEN/…) still fails loud below — those redirect billing
 * or behaviour and are contamination, not a valve. `billing_mode` is then
 * DERIVED from the child's actual key set ({@link billingMode}), never guessed.
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

/** Any key matching this is a billing-boundary violation and must not survive… */
const ANTHROPIC_KEY = /^ANTHROPIC_/i;

/** …EXCEPT this one: the sole ANTHROPIC_* key the overflow valve may pass through
 * (see file header). Opt-in by presence in the parent env; absent ⇒ subscription. */
const SANCTIONED_KEY = "ANTHROPIC_API_KEY";

/**
 * Build a child environment from an explicit allowlist plus caller-supplied
 * vars. Never inherits `process.env` wholesale. Throws if any `ANTHROPIC_*`
 * key OTHER than the sanctioned `ANTHROPIC_API_KEY` overflow valve survives
 * (including one a caller passed in), so a leak fails loud at the boundary
 * rather than silently on the invoice. The valve itself is opt-in: the parent's
 * `ANTHROPIC_API_KEY` is copied through ONLY when present (see file header).
 *
 * Shell isolation is the SAME contamination class as the ANTHROPIC_* denial,
 * mirrored: where ANTHROPIC_* is DENIED, the vars below are GRANTED, so a
 * worker's shell sources Remudero's own (empty) rc, never the operator's.
 * Workers inherit NOTHING they aren't explicitly given; none of these is
 * copied from the parent (an operator HOME/ZDOTDIR/CLAUDE_CODE_SHELL is
 * ignored), only set to the granted value.
 *  - `opts.home` → **HOME** (W1-T18 general isolation mechanism). When set,
 *    OVERRIDES whatever the allowlist copied from the parent's real HOME with
 *    a Remudero-controlled scratch dir (`worker-home.ts`) holding only empty
 *    rc files — this is what makes isolation hold on ANY host, not just one
 *    whose `~/.bashrc` happens to be absent. See config.workerHomeDir.
 *  - `opts.shell` → **CLAUDE_CODE_SHELL** (default `/bin/bash`). Claude Code's
 *    Bash-tool snapshot sources `os.homedir()/.<shell>rc`, resolved off HOME —
 *    combined with `opts.home` above, that path is the redirected scratch
 *    HOME's empty rc, never the operator's `~/.zshrc` (and its interactive
 *    `compinit` prompt that stalled W1-T1C). See config.workerShell.
 *  - `opts.zdotdir` → **ZDOTDIR** (default derived from HOME). Defense-in-depth
 *    for any direct `zsh` a worker spawns. See config.workerZdotdir.
 */
export function buildWorkerEnv(
  extra: Record<string, string> = {},
  parent: NodeJS.ProcessEnv = process.env,
  opts: { zdotdir?: string; shell?: string; home?: string; allowApiKey?: boolean } = {},
): Record<string, string> {
  const child: Record<string, string> = {};

  for (const key of ALLOWLIST) {
    const val = parent[key];
    if (typeof val === "string") child[key] = val;
  }

  for (const [key, val] of Object.entries(extra)) {
    child[key] = val;
  }

  // Grant the HOME redirection (unless the caller set HOME explicitly via
  // `extra` — test/override escape hatch), OVERRIDING whatever the allowlist
  // above copied from the parent's real HOME. This is the W1-T18 mechanism:
  // isolation no longer depends on the operator's real `~/.bashrc` being
  // absent, because the worker's HOME is never the operator's real HOME.
  if (opts.home && !("HOME" in extra)) {
    child.HOME = opts.home;
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

  // Overflow valve — engaged ONLY when the caller passes `opts.allowApiKey`
  // (config.overflow === "api_key", §9 conditional-cap guard). When engaged and
  // the operator has exported ANTHROPIC_API_KEY into the PARENT env, pass that
  // one key BY VALUE into the child so this run bills to API credits instead of
  // the subscription window. env→env only — the value is never written to a file
  // or logged (childEnvKeys records the NAME, not the value). Absent the flag OR
  // the key ⇒ nothing copied ⇒ subscription, exactly as before.
  if (opts.allowApiKey && !(SANCTIONED_KEY in child)) {
    const apiKey = parent[SANCTIONED_KEY];
    if (typeof apiKey === "string" && apiKey.length > 0) child[SANCTIONED_KEY] = apiKey;
  }

  // Every ANTHROPIC_* key is a hard violation — EXCEPT the sanctioned valve, and
  // only while it is engaged (an ANTHROPIC_API_KEY reaching `child` WITHOUT the
  // flag — e.g. injected via `extra` — is still a leak and still throws).
  const survivors = Object.keys(child).filter(
    (k) => ANTHROPIC_KEY.test(k) && !(opts.allowApiKey === true && k === SANCTIONED_KEY),
  );
  if (survivors.length > 0) {
    throw new Error(
      `buildWorkerEnv: billing-boundary violation — ANTHROPIC_* keys survived: ${survivors.join(", ")}`,
    );
  }

  return child;
}

/** The two billing modes a ledger line can record. */
export type BillingMode = "api" | "subscription";

/**
 * The billing mode a run bills at, DERIVED from the child env's actual key NAMES
 * (never guessed, never a standing constant): `api` iff the sanctioned
 * `ANTHROPIC_API_KEY` valve is engaged, else `subscription`. Takes key names (not
 * values) so it reads straight off `WorkerResult.childEnvKeys` — the same
 * secret-free proof surface the ledger already records.
 */
export function billingMode(envKeys: readonly string[]): BillingMode {
  return envKeys.includes(SANCTIONED_KEY) ? "api" : "subscription";
}

/** True iff `env` carries zero ANTHROPIC_* keys. Proof helper for callers. */
export function isBillingClean(env: Record<string, string | undefined>): boolean {
  return !Object.keys(env).some((k) => ANTHROPIC_KEY.test(k));
}

/** Result of {@link assertCleanBoot} — one ledger-ready boot-time reading. */
export interface BootAssertion {
  /** True iff the DAEMON'S OWN process env (not a worker's — see below) is ANTHROPIC_*-free. */
  env_clean: boolean;
  /** `api` iff the daemon booted with the sanctioned `ANTHROPIC_API_KEY` valve engaged
   * (overnight-on-credits, W1-T258), else `subscription` — the default this repo expects. */
  billing_mode: BillingMode;
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
export function assertCleanBoot(
  env: NodeJS.ProcessEnv = process.env,
  allowApiKey = false,
): BootAssertion {
  // The valve is engaged only under BOTH factors (config intent + the key), so a
  // daemon that merely inherited the key from a shell — with overflow off — still
  // reports subscription, matching what its workers will actually bill.
  const engaged = allowApiKey && typeof env[SANCTIONED_KEY] === "string" && env[SANCTIONED_KEY] !== "";
  return { env_clean: isBillingClean(env), billing_mode: engaged ? "api" : "subscription" };
}
