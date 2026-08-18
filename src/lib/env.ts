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
// `CLAUDE_CODE_OAUTH_TOKEN` (impl-ED) is AMBIENT CONTAINER IDENTITY, the same class as the five
// above, and it is the ONLY credential a container can hold: `claude setup-token` writes nothing to
// disk — it prints a year-long string to the terminal and the vendor documentation says to set it as
// this variable wherever you want to authenticate. Before this line the codebase had no awareness of
// it at all and a token-authenticated worker was impossible.
//
// WHY THE ALLOWLIST AND NOT AN OPT-IN, since `ANTHROPIC_API_KEY` sets the opposite precedent. That
// key is opt-in (`opts.allowApiKey`) because it FLIPS BILLING MODE: {@link billingMode} returns
// `"api"` when and only when it survives. This token does not — it authenticates the same
// subscription the `/login` credential does, so `billingMode` still reads `"subscription"` and the
// reason the valve is gated does not apply here. It also does not match {@link ANTHROPIC_KEY}
// (verified, not assumed), so the leak assertion below is unweakened.
//
// AND THE FAILURE DIRECTIONS ARE NOT SYMMETRIC. Threading it through `extra` would need every one of
// the three spawn paths to opt in; a missed one yields a silently UNAUTHENTICATED worker, which is
// the failure this fleet is worst at seeing. On the allowlist it cannot be missed.
// `GH_TOKEN` is PARITY RESTORATION, not a widening — and that distinction is the whole
// justification, so it is worth stating precisely.
//
// THE WORKER IS DESIGNED TO PUSH AND OPEN ITS OWN PR. Three independent places say so: the
// implement prompt instructs it to `git push origin HEAD` and `gh pr create --fill --base main`;
// `settings/worker.json` carries `excludedCommands: ["gh *"]`, an exclusion that exists ONLY so a
// worker's `gh` runs outside Seatbelt (it fails TLS verification under it); and the orchestrator's
// own push is commented as "the ONE orchestrator-initiated push in this file (the worker itself
// normally pushes from inside its own sandbox)" — a FALLBACK, not the route.
//
// AND THE WORKER ALREADY HOLDS THIS CREDENTIAL ON MACOS. `WORKER_HOME_SYMLINKS` (worker-home.ts)
// grants `.config/gh` into every per-run worker HOME, with the reason recorded verbatim as "gh CLI
// auth token, so a worker can open/merge PRs". A container simply stores the same secret in a
// VARIABLE instead of a FILE — and the isolation boundary treats those two forms oppositely: the
// file is symlinked in, the variable is stripped out. Measured with a fake token, `GH_TOKEN`
// reaches the child env as `false`. So the container worker is the ONLY configuration in which the
// fleet's own stated intent does not hold.
//
// WHY THE ALLOWLIST AND NOT THREADING, the same argument `CLAUDE_CODE_OAUTH_TOKEN` records
// directly above: threading needs all three spawn paths to opt in, and a missed one yields a
// silently UNAUTHENTICATED worker — the failure this fleet is worst at seeing. Here that failure
// is not hypothetical, it is the observed one: the container's workers fail their push, the
// orchestrator's fallback quietly recovers it, and the only trace is a `fallback:` line.
//
// IT DOES NOT WEAKEN THE BILLING BOUNDARY. `GH_TOKEN` does not match {@link ANTHROPIC_KEY}
// (VERIFIED by running the pattern, not by reading it), so the leak assertion below is unchanged,
// and {@link billingMode} keys off `SANCTIONED_KEY` alone so a GitHub token cannot flip a run to
// `api`. `GITHUB_TOKEN` is deliberately NOT added: `gh` prefers `GH_TOKEN`, and the container's git
// credential helper expands `$GH_TOKEN` specifically, so a second name would be scope creep on a
// credential surface for no reachable caller.
const ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "USER", "CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"] as const;

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

  // Grant DISABLE_AUTOUPDATER=1 (unless the caller set one via `extra`) — W1-T236:
  // the shared `claude` binary a worker execs is a symlink into an
  // auto-updating install (npm-global or the native installer), and its
  // content can be rewritten mid-run out from under the resolved path — a
  // same-day 2.1.216→2.1.217 bump was observed rewriting it 2026-07-21
  // mid-incident. Unlike every OTHER grant above, this is not copied from the
  // parent (autoupdates are not something a worker's env legitimately carries
  // in) — it is an explicit ADD, the same discipline the ALLOWLIST enforces
  // for copies: nothing reaches `child` that is not named. This makes it
  // impossible for a running worker to trigger or race an update of the
  // binary it and every sibling worker are executing; the operator can still
  // update the CLI deliberately outside a run.
  if (!("DISABLE_AUTOUPDATER" in child)) {
    child.DISABLE_AUTOUPDATER = "1";
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
  /** Absolute path of the node runtime executing THIS process (`process.execPath`) —
   * W1-T991: the reading that answers "which node does the fleet execute" without
   * reading a live process listing. Always present (unlike `node_drift` below), so the
   * ledger records the running interpreter on every boot, drifting or not. */
  node_path: string;
  /** `process.version` of the running runtime, e.g. `"v22.22.3"`. */
  node_version: string;
  /** Named drift reason — present ONLY when `node_path` falls outside the daemon
   * account's own roots (its HOME plus the system/homebrew prefixes), or `node_version`
   * disagrees with the repo's declared `.nvmrc` pin. Advisory: its presence never blocks
   * boot (W1-T991 design part 2 — same ruling as {@link checkBinaryPin}'s drift). */
  node_drift?: string;
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
  /**
   * The runtime reading (W1-T991) — defaults to THIS process's own execPath/version so a
   * real boot needs no caller change; a test overrides to prove drift without a real
   * foreign-account install. See {@link checkNodeRuntimeProvenance} for the drift logic.
   */
  runtime: { execPath: string; version: string } = { execPath: process.execPath, version: process.version },
  /**
   * The repo's declared node pin (`.nvmrc` content, trimmed) — read by the CALLER before
   * calling this (this module never touches the filesystem, see file header). Omitted ⇒
   * no version-pin comparison; the own-roots check below still runs.
   */
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

// ── Node runtime provenance (W1-T991) ───────────────────────────────────────
//
// THE SIBLING READING assertCleanBoot's own doc names above: env_clean catches a daemon
// booted from a contaminated SHELL; this catches a daemon EXECUTING a foreign RUNTIME —
// same canary, same advisory posture, over process.execPath/version instead of
// ANTHROPIC_* keys. bin/rmd's last line execs node_modules/.bin/tsx, a shebang script, so
// the daemon's own node is whatever PATH resolved at exec time, never a path anyone
// chose; nothing before this read it, pinned it, or recorded it (see the task's rationale
// — a live worker was observed running a DIFFERENT account's nvm-installed node, invisible
// until that install is eventually pruned or upgraded out from under every spawn at once).

/**
 * System/package-manager roots node commonly installs under, independent of any ONE
 * user's home — combined with the daemon's OWN homedir (`env.HOME`) below to decide
 * whether a resolved runtime is inside "this account's own roots". Never a single
 * hardcoded host path: the container lane runs as a different user under a different
 * prefix entirely (`deploy/`), so a check keyed to one literal `/Users/...` path would
 * fire on every non-macOS boot and get muted, then ignored (design part 3).
 */
const SYSTEM_NODE_ROOTS = ["/usr/local", "/opt/homebrew", "/usr", "/bin", "/opt"] as const;

function isUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * Read the running node runtime's provenance against the daemon's own roots and the
 * repo's declared version pin. Pure — takes every reading as an argument rather than
 * touching `process`/the filesystem itself (same discipline as {@link checkBinaryPin}),
 * so it is unit-testable with a fake execPath/home/pin and no real foreign install.
 *
 * Returns `{drift: false}` (no `reason`) when the runtime sits under the daemon's own
 * home or a system prefix AND (no declared pin, or the version matches it) — the common
 * case, which passes silently. Otherwise returns a NAMED reason: an out-of-roots path is
 * reported before a version mismatch (design part 2) — it is the stronger claim, and a
 * foreign-account runtime is rarely also coincidentally version-pinned right.
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

// ── Binary content pin (W1-T236) ────────────────────────────────────────
//
// DISABLE_AUTOUPDATER above stops a WORKER from triggering or racing an
// update while it runs. It does not, by itself, make a swap the OPERATOR
// caused between runs visible: `config.claudeBin` (config.ts's
// `resolveClaudeBin`) records a path once, and a path is not content — the
// same path can resolve to a rewritten binary after a deliberate `npm i -g`
// or an autoupdate that landed between runs. `checkBinaryPin` is the smaller
// of the two content-pin designs (MASTER-PLAN's harness-owned-copy is the
// stronger, deferred guarantee): compare the version recorded at config time
// against the version observed at THIS preflight (`claude --version`, e.g.
// via `resolveClaudeExecutable`'s caller). A caller wires this at the actual
// preflight call site; this module only supplies the pure comparison so it is
// unit-testable without a real binary.

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

/**
 * Compare the `claude` binary version recorded at config time against the
 * version observed at preflight (W1-T236). A MATCH returns `{drift: false}`
 * with no `reason` — the common case passes silently, exactly as before this
 * pin existed (acceptance: "a matching binary passes preflight silently").
 * A MISMATCH — the shared binary's content changed underneath the recorded
 * path (a deliberate operator update, or an autoupdate race) — returns
 * `{drift: true, reason}` naming both versions, so a caller can LEDGER the
 * drift and CONTINUE rather than hard-fail: the operator still updates the
 * CLI deliberately, so this makes a swap VISIBLE and INTENTIONAL, never
 * impossible (acceptance: "ledgered with a named drift reason").
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

// ── The DECLARED pin, and the reading that finally consumes checkBinaryPin ──
//
// WHY THIS EXISTS: {@link checkBinaryPin} shipped with NO PRODUCTION CALLER (src/lib/reachability.ts
// lists it by name among the zero-consumer organs), and the reason is not that someone forgot the
// call — it is that its `recordedVersion` argument HAD NO PRODUCER ANYWHERE IN THE TREE. `Config`
// carries `claudeBin`, a PATH, and no version; `resolveClaudeExecutable` runs `--version` with
// `stdio: "ignore"` and discards the output. Wiring it therefore required deciding what "recorded"
// means, which is the whole of the design below.
//
// THE SOURCE OF TRUTH IS THE ONE DECLARATION THIS REPO ALREADY MAKES: `ARG CLAUDE_CODE_VERSION` in
// deploy/Dockerfile. Two reasons, and the second is why nothing else was chosen:
//   1. It is the version this repo SAYS its workers run — the Dockerfile argues it at length (the
//      `stable` dist-tag, and lockstep with the `@anthropic-ai/claude-agent-sdk` version in
//      package-lock.json). A host that disagrees with it is exactly the condition worth reporting.
//   2. deploy/verify-image.sh reads THE SAME LINE. One declaration, two consumers, no second copy
//      to drift — and no inference. Deriving the expected CLI from the SDK version instead would
//      have meant trusting the 2.1.N-alongside-0.3.N convention, which upstream documents but does
//      not guarantee; that would put an unenforced assumption inside a gate.
//
// THREE STATES, NEVER TWO. `unknown` is not padding: this fleet's standing law is that a READ
// FAILURE DEGRADES TO UNKNOWN, NEVER TO A NUMBER — and the recon that produced this task found that
// law broken three times in one function elsewhere (deployer.ts's `probeIdle`). An unreadable
// Dockerfile or a `claude --version` that will not run must not be able to render as `match`.

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

/** A three-state binary-pin reading. `unknown` means A READ FAILED, never "no drift". */
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
 * BOTH READS ARE INJECTED and BOTH may throw — a missing Dockerfile, a binary that will not run.
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
