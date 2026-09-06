// Why: the overflow valve's two-factor design and the launchd-vs-dev-shell split —
// docs/forensics/env.md#module-header (W1-T258).
/**
 * The billing boundary (Field finding 1, MASTER-PLAN §9). Worker environments are constructed
 * here, never inherited — an operator's login shell can export `ANTHROPIC_API_KEY`, which takes
 * precedence over the claude.ai OAuth login and would silently bill API rates instead of the Max
 * subscription. `buildWorkerEnv` builds each child env from an explicit allowlist and asserts no
 * stray `ANTHROPIC_*` key survives, so `billing_mode` is a decision this harness makes, never an
 * accident it inherits — safe by default on a clean launchd boot and a dev shell alike.
 * The overflow valve (opt-in, W1-T258) is two-factor — `config.overflow: "api_key"` (as
 * `opts.allowApiKey`) plus the key's presence — so the key alone in a shell never silently bills
 * the fleet to API; engaged, it travels env-to-env only, never written to a file or logged by value.
 * FALSIFIER: test/env.test.ts, test/gh-token-worker-env.test.ts.
 */

import { join } from "node:path";

// Why: why USER/CLAUDE_CODE_OAUTH_TOKEN/GH_TOKEN are each safe to copy, and the container-parity
// incident behind GH_TOKEN — docs/forensics/env.md#allowlist (W1-T236, W1-T258).
/**
 * Base variables a worker legitimately needs, copied from the parent by name. `USER` is
 * load-bearing on macOS: subscription auth resolves from the login Keychain via `USER`. The
 * OAuth token and `GH_TOKEN` are ambient container identity — the only credentials a
 * container-based worker can hold — on the allowlist rather than threaded per-call, since a
 * missed opt-in call site would silently produce an unauthenticated worker. Neither matches
 * {@link ANTHROPIC_KEY} nor flips {@link billingMode}, so neither weakens the boundary below.
 * FALSIFIER: test/token-authenticated-worker.test.ts, test/gh-token-worker-env.test.ts.
 */
const ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "USER", "CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"] as const;

/** Any key matching this is a billing-boundary violation and must not survive into a child env. */
const ANTHROPIC_KEY = /^ANTHROPIC_/i;

/** The one exception: the sole ANTHROPIC_* key the overflow valve may pass through (see the file
 * header). Opt-in by presence in the parent env; absent means subscription billing. */
const SANCTIONED_KEY = "ANTHROPIC_API_KEY";

/**
 * Build a child environment from an explicit allowlist plus caller-supplied vars — never
 * `process.env` wholesale. Throws if any `ANTHROPIC_*` key other than the sanctioned
 * `ANTHROPIC_API_KEY` overflow valve survives, so a leak fails loud here rather than on the invoice.
 * INVARIANT: shell isolation mirrors that denial — `opts.home`/`shell`/`zdotdir` grant
 * HOME/CLAUDE_CODE_SHELL/ZDOTDIR so a worker's shell sources Remudero's own empty rc, never the
 * operator's `~/.zshrc`; see config.workerHomeDir/workerShell/workerZdotdir.
 * FALSIFIER: test/env.test.ts, test/codex-worker-home-redirection.test.ts.
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

  // Grants the HOME redirection (unless the caller set HOME via `extra`), overriding whatever the
  // allowlist copied from the parent's real HOME — the W1-T18 mechanism that makes isolation hold
  // on any host, not only one whose `~/.bashrc` happens to be absent.
  if (opts.home && !("HOME" in extra)) {
    child.HOME = opts.home;
  }

  // Grants CLAUDE_CODE_SHELL (unless the caller set one via `extra`) — the var that isolates the
  // worker's Bash-tool snapshot from `~/.zshrc`.
  if (!("CLAUDE_CODE_SHELL" in child)) {
    const shell = opts.shell ?? "/bin/bash";
    child.CLAUDE_CODE_SHELL = shell;
  }

  // Grants ZDOTDIR (unless the caller set one via `extra`), preferring the caller's resolved path
  // and otherwise deriving one from HOME (`<HOME>/.config/remudero/zdotdir`).
  if (!("ZDOTDIR" in child)) {
    const home = child.HOME ?? parent.HOME;
    const zdotdir = opts.zdotdir ?? (home ? join(home, ".config", "remudero", "zdotdir") : undefined);
    if (zdotdir) child.ZDOTDIR = zdotdir;
  }

  // Grants DISABLE_AUTOUPDATER=1 (unless the caller set one via `extra`) — the shared `claude`
  // binary a worker execs can be rewritten mid-run by an autoupdate (W1-T236).
  // Why: the observed mid-run binary rewrite and why this is an explicit add, not a copy —
  // docs/forensics/env.md#disable_autoupdater (W1-T236).
  if (!("DISABLE_AUTOUPDATER" in child)) {
    child.DISABLE_AUTOUPDATER = "1";
  }

  // Overflow valve — engaged only when the caller passes `opts.allowApiKey` (the config.overflow
  // conditional-cap guard, §9). Passes the parent's ANTHROPIC_API_KEY through by value; absent the
  // flag or the key, nothing is copied and billing stays subscription.
  if (opts.allowApiKey && !(SANCTIONED_KEY in child)) {
    const apiKey = parent[SANCTIONED_KEY];
    if (typeof apiKey === "string" && apiKey.length > 0) child[SANCTIONED_KEY] = apiKey;
  }

  // Every ANTHROPIC_* key is a hard violation except the sanctioned valve, and only while engaged
  // (one reaching `child` without the flag — e.g. injected via `extra` — is still a leak).
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
 * The billing mode a run bills at, derived from the child env's actual key names (never guessed):
 * `api` iff the sanctioned `ANTHROPIC_API_KEY` valve is engaged, else `subscription`. Takes key
 * names, not values, so it reads straight off `WorkerResult.childEnvKeys`.
 */
export function billingMode(envKeys: readonly string[]): BillingMode {
  return envKeys.includes(SANCTIONED_KEY) ? "api" : "subscription";
}

/** True iff `env` carries zero ANTHROPIC_* keys. Proof helper for callers. */
export function isBillingClean(env: Record<string, string | undefined>): boolean {
  return !Object.keys(env).some((k) => ANTHROPIC_KEY.test(k));
}

// Why: why env_clean is a canary rather than a hard gate — docs/forensics/env.md#bootassertion
// (W1-T991).
/** Result of {@link assertCleanBoot} — one ledger-ready boot-time reading. */
export interface BootAssertion {
  /** True iff the daemon's own process env (not a worker's — see below) is ANTHROPIC_*-free. */
  env_clean: boolean;
  /** `api` iff the daemon booted with the sanctioned overflow valve engaged, else `subscription`. */
  billing_mode: BillingMode;
  /** Absolute path of the node runtime executing this process (`process.execPath`, W1-T991). */
  node_path: string;
  /** `process.version` of the running runtime, e.g. `"v22.22.3"`. */
  node_version: string;
  /** Named drift reason — present only when the runtime is outside the daemon's own roots or
   * disagrees with `.nvmrc`. Advisory: never blocks boot. */
  node_drift?: string;
}

// Why: why a contaminated-shell boot is a canary, not a hard gate, and how it differs from a
// worker leak — docs/forensics/env.md#assertcleanboot (W1-T12b).
/**
 * The daemon's boot-time billing assertion (W1-T12b), read from the daemon process's own env —
 * a different env from a worker's, which `buildWorkerEnv` already builds clean regardless. A
 * `false` `env_clean` means the daemon booted from a contaminated shell, not that a leak reached
 * a worker; it is a canary worth logging loudly, not a hard gate. Wired into the ledger's
 * `daemon.boot` field by lib/daemon.ts.
 */
export function assertCleanBoot(
  env: NodeJS.ProcessEnv = process.env,
  allowApiKey = false,
  /** The runtime reading (W1-T991); defaults to this process's own so a real boot needs no
   * caller change. A test overrides to prove drift without a real foreign install. */
  runtime: { execPath: string; version: string } = { execPath: process.execPath, version: process.version },
  /** The repo's declared node pin (`.nvmrc`, trimmed), read by the caller. Omitted means no
   * version-pin comparison; the own-roots check below still runs. */
  declaredNodeVersion?: string,
): BootAssertion {
  // The valve is engaged only under BOTH factors (config intent + the key), so a
  // daemon that merely inherited the key from a shell — with overflow off — still
  // reports subscription, matching what its workers will actually bill.
  const engaged = allowApiKey && typeof env[SANCTIONED_KEY] === "string" && env[SANCTIONED_KEY] !== "";
  const provenance = checkNodeRuntimeProvenance(runtime.execPath, runtime.version, env.HOME, declaredNodeVersion);
  return {
    env_clean: isBillingClean(env),
    billing_mode: engaged ? "api" : "subscription",
    node_path: runtime.execPath,
    node_version: runtime.version,
    ...(provenance.reason ? { node_drift: provenance.reason } : {}),
  };
}

// Why: the incident this reading exists to catch — a foreign account's node running
// undetected — docs/forensics/env.md#node-runtime-provenance-section (W1-T991).
// ── Node runtime provenance (W1-T991) — the sibling reading to env_clean above: this catches a
// daemon executing a foreign runtime, same canary posture, over execPath/version instead of keys.

// Why: why these roots and not one hardcoded host path — docs/forensics/env.md#system_node_roots.
/** System/package-manager roots node commonly installs under, combined below with the daemon's
 * own homedir to decide whether a resolved runtime is inside this account's own roots. */
const SYSTEM_NODE_ROOTS = ["/usr/local", "/opt/homebrew", "/usr", "/bin", "/opt"] as const;

function isUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * Read the running node runtime's provenance against the daemon's own roots and its declared
 * version pin. Pure, so it is unit-testable with a fake execPath/home/pin.
 * Returns `{drift: false}` when the runtime sits under the daemon's own home or a system prefix
 * AND (no declared pin, or the version matches it); otherwise a named reason, out-of-roots first.
 */
export function checkNodeRuntimeProvenance(
  execPath: string,
  version: string,
  ownHome: string | undefined,
  declaredNodeVersion?: string,
): { drift: boolean; reason?: string } {
  const ownRoots = [...(ownHome ? [ownHome] : []), ...SYSTEM_NODE_ROOTS];
  const inOwnRoots = ownRoots.some((root) => isUnderRoot(execPath, root));
  if (!inOwnRoots) {
    return {
      drift: true,
      reason:
        `node runtime ${execPath} is outside the daemon account's own roots ` +
        `(${ownHome ? `home ${ownHome}, ` : ""}system prefixes ${SYSTEM_NODE_ROOTS.join(", ")}) — ` +
        `likely inherited from a different account's install (W1-T991)`,
    };
  }
  if (declaredNodeVersion) {
    const bare = (v: string) => v.replace(/^v/, "");
    if (bare(version) !== bare(declaredNodeVersion)) {
      return {
        drift: true,
        reason:
          `node runtime is ${version} but the repo's .nvmrc pins ${declaredNodeVersion} — ` +
          `this host is running an undeclared node version (W1-T991)`,
      };
    }
  }
  return { drift: false };
}

// Why: why this is the smaller of two content-pin designs and what the deferred stronger one is —
// docs/forensics/env.md#binary-content-pin-section (W1-T236).
// ── Binary content pin (W1-T236) — DISABLE_AUTOUPDATER stops a worker racing an update in flight;
// this instead compares the version recorded at config time against the one observed at preflight,
// since a recorded path is not recorded content.

/** One version-pin reading — returned, never thrown (see {@link checkBinaryPin}). */
export interface BinaryPinCheck {
  /** True iff `actualVersion` differs from `recordedVersion`. */
  drift: boolean;
  /** The version recorded at config time. */
  recordedVersion: string;
  /** The version observed at this preflight. */
  actualVersion: string;
  /** Machine-greppable drift reason — present only when `drift` is true. */
  reason?: string;
}

// Why: why a mismatch is ledgered and continued rather than hard-failed —
// docs/forensics/env.md#checkbinarypin (W1-T236).
/**
 * Compare the `claude` binary version recorded at config time against the one observed at
 * preflight (W1-T236). A match returns `{drift: false}`, no `reason` — the common case passes
 * silently. A mismatch returns `{drift: true, reason}` naming both versions, so a caller can
 * ledger the drift and continue rather than hard-fail — a deliberate operator update stays visible.
 */
export function checkBinaryPin(recordedVersion: string, actualVersion: string): BinaryPinCheck {
  if (recordedVersion === actualVersion) {
    return { drift: false, recordedVersion, actualVersion };
  }
  return {
    drift: true,
    recordedVersion,
    actualVersion,
    reason: `claude binary content changed since it was pinned: recorded ${recordedVersion}, observed ${actualVersion} at preflight`,
  };
}

// Why: why the Dockerfile ARG is the source of truth and why "unknown" is a required third state
// — docs/forensics/env.md#declared_cli_pin_arg-section.
// ── The declared pin: deploy/Dockerfile's `ARG CLAUDE_CODE_VERSION` is the one declaration both
// this reading and deploy/verify-image.sh read. A read failure degrades to `unknown`, never `match`.

/** The Dockerfile ARG that declares which CLI this repo intends its workers to run. */
export const DECLARED_CLI_PIN_ARG = "CLAUDE_CODE_VERSION";

/**
 * The declared CLI pin, parsed out of deploy/Dockerfile text. Returns `undefined` when the ARG is
 * absent — never a guess. Tolerates the optional-default form (`ARG X=1.2.3`) that the Dockerfile
 * actually uses, and quoting, because a future edit may add either.
 */
export function parseDeclaredClaudeVersion(dockerfileText: string): string | undefined {
  const m = new RegExp(`^\\s*ARG\\s+${DECLARED_CLI_PIN_ARG}\\s*=\\s*["\']?([^"\'\\s#]+)`, "m").exec(dockerfileText);
  return m ? m[1] : undefined;
}

/**
 * The bare version from `claude --version` output — MEASURED shape `2.1.227 (Claude Code)`, so the
 * trailing product name is dropped and only the version token compared. Returns `undefined` for
 * output that carries no leading version at all, which is what a broken or wrapped binary emits.
 */
export function parseClaudeVersionOutput(raw: string): string | undefined {
  const m = /^\s*(\d+\.\d+\.\d+\S*)/.exec(raw);
  return m ? m[1] : undefined;
}

/** A three-state binary-pin reading. `unknown` means a read failed, never "no drift". */
export interface BinaryPinReading {
  status: "match" | "drift" | "unknown";
  declaredVersion?: string;
  observedVersion?: string;
  /** Always present, always says which of the three happened and why. */
  reason: string;
}

/**
 * Read the declared pin and the installed binary and compare them through {@link checkBinaryPin}.
 *
 * Both reads are injected and both may throw — a missing Dockerfile, a binary that will not run.
 * Each failure yields `status: "unknown"` with the cause named, so a caller can ledger "we could
 * not tell" as its own outcome rather than reporting a match it never observed.
 */
export function readBinaryPin(deps: {
  readDockerfile: () => string;
  runClaudeVersion: () => string;
}): BinaryPinReading {
  let declaredVersion: string | undefined;
  try {
    declaredVersion = parseDeclaredClaudeVersion(deps.readDockerfile());
  } catch (e) {
    return { status: "unknown", reason: `could not read the declared pin: ${String(e)}` };
  }
  if (!declaredVersion) {
    return { status: "unknown", reason: `deploy/Dockerfile declares no ${DECLARED_CLI_PIN_ARG}` };
  }

  let observedVersion: string | undefined;
  try {
    observedVersion = parseClaudeVersionOutput(deps.runClaudeVersion());
  } catch (e) {
    return { status: "unknown", declaredVersion, reason: `claude --version did not run: ${String(e)}` };
  }
  if (!observedVersion) {
    return { status: "unknown", declaredVersion, reason: "claude --version emitted no recognisable version" };
  }

  const pin = checkBinaryPin(declaredVersion, observedVersion);
  return pin.drift
    ? {
        status: "drift",
        declaredVersion,
        observedVersion,
        reason:
          `this host runs claude ${observedVersion} but deploy/Dockerfile declares ${declaredVersion} — ` +
          `the SDK in package-lock.json is paired with the declared one, so this combination is untested`,
      }
    : { status: "match", declaredVersion, observedVersion, reason: `claude ${observedVersion} matches the declared pin` };
}
