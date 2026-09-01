import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createOrReadExclusive } from "./fs-race-safe.js";

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
   * The daemon's OWN git checkout — the one tree the deploy supervisor is allowed to
   * fast-forward (W1-T924, fb-1784913390318-1fcb63). Optional; defaults to
   * `join(config.root, "daemon-install")` (see {@link resolveInstallRoot},
   * lib/install-root.ts) — derived from `config.root`, NEVER a hardcoded absolute path
   * (public-repo hygiene, same precedent as {@link workerZdotdir}/{@link workerHomeDir}).
   *
   * WHY THIS EXISTS: before this field, the deploy supervisor's `deployRunCommand` passed
   * `installPath: repoRoot` — the toplevel of WHATEVER CHECKOUT invoked the CLI, which on the
   * mini is the operator's own WIP tree. `lib/install-root.ts` owns resolving this field,
   * deciding whether the resulting tree is fit to deploy into, and provisioning it
   * (`rmd install-checkout`); this field is only ever the NOUN it resolves against — it carries
   * no behavior itself.
   */
  installRoot?: string;
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
  /**
   * Strike cap for the blocked_review FIX RUNG (W1-T76, absorbs P21; MASTER-PLAN
   * §3's fixing ladder: round 1 resumes the failing session, round 2 is a fresh
   * worker on the same branch). Optional; defaults to 2 — see {@link fixStrikeCap}.
   */
  fixStrikeCap?: number;
  /**
   * Base URL the operator console (`rmd serve`) is reachable at from wherever the
   * operator reads their message channel (W1-T144 console push) — a tailnet/LAN
   * address, since "localhost" resolves to nothing on the phone reading a pushed
   * iMessage. Optional; defaults to `http://localhost:4317` (serve's own default
   * port — see {@link consoleUrl}), correct only when the digest reader and the
   * console share one machine.
   */
  consoleUrl?: string;
  /**
   * Where the operator console BINDS (W1-T152) — the declared, per-install source for
   * `rmd serve`'s listen address and port, so the launchd unit (`rmd serve-plist`) and a
   * hand-run `rmd serve` resolve the SAME interfaces without the operator retyping flags.
   *
   * `host` is the comma-separated interface list `resolveServeHosts` accepts (e.g.
   * `"127.0.0.1,100.90.47.107"` — loopback for local curls AND the tailnet address for the
   * phone); a wildcard is refused there, as always. It lives HERE, outside the git tree,
   * because a tailnet address is machine-specific and must never be a literal in committed
   * source (the same rule `root`/`claudeBin` follow).
   *
   * PRECEDENCE, both in `rmd serve` and in the generated unit: `--host`/`--port` flag >
   * `RMD_SERVE_HOST` env > this field > loopback/{@link DEFAULT_SERVE_PORT}. Absent, nothing
   * changes: the console binds 127.0.0.1:4317 exactly as before.
   *
   * `identityCapability` (W1-T371) opts the console into ADDITIVE tailnet-identity auth: the
   * Tailscale ACL app-capability name (e.g. `"example.com/cap/console-write"`) an allowlisted
   * node must be granted to authenticate with no bearer token at all — see
   * {@link resolveServeIdentity} (serve.ts) and service.ts's `IdentityAuth` for the two gates
   * enforced. No flag/env override, unlike host/port: it's a per-install constant chosen once
   * against the operator's own Tailscale ACL, not something a single invocation varies. Absent
   * (the default): identity is never consulted and the bearer token authenticates exactly as
   * it always has — a Tailscale failure (or simply never opting in) degrades to the token
   * rather than locking the operator out.
   *
   * `trustedProxy` (W1-T398) is the REQUIRED companion to `identityCapability`: it names which
   * process the operator means to be terminating on the loopback address gate 1
   * (`identityGrantedScopes`, service.ts) checks against, since nothing else in this config
   * states that. Setting `identityCapability` with `trustedProxy` absent is REFUSED at startup
   * — silently inheriting that trust assumption is exactly the hazard this field closes. The
   * only accepted value today is `"tailscale"` ({@link resolveServeIdentity}'s
   * `TRUSTED_PROXY_TAILSCALE`); any other value is a named opt-out that is also refused, with a
   * message naming the header-stripping guarantee it would have to provide. Irrelevant, and
   * never read, when `identityCapability` is absent.
   */
  serve?: { host?: string; port?: number; identityCapability?: string; trustedProxy?: string };
  /**
   * W1-T431 (Tier-2 relay CLIENT — the outbound-only half of D-11's distribution architecture):
   * where `rmd relay` dials OUT to, and the short-lived credential it presents once it gets
   * there. Lives HERE, outside the git tree, for the same reason `serve.host`/`claudeBin` do —
   * both a relay address and an enrollment token are per-install secrets that must never be a
   * literal in committed source or a CLI argument (shell history, `ps`).
   *
   * `url` is the relay's dial-out address (e.g. `"https://relay.example.com:8443"`); `token` is
   * the enrollment credential pasted from the relay's UI, the GitHub self-hosted-runner
   * registration-token shape (design note iv) — rotation is re-enrollment (delete/replace this
   * field), never a runtime rotation call. Both absent (the default): `rmd relay` refuses to
   * start and says so; `rmd serve` is completely unaffected either way, since the two commands
   * are separate processes and this field is read by neither's dispatch but its own.
   */
  relay?: { url?: string; token?: string };
  /**
   * Headroom governor switch (operator ruling fb-1784894405468-a4153e, 2026-07-24,
   * amending P34(c)/W1-T249, extending W1-T252 — its DEFAULT clause reversed by the
   * operator ruling of 2026-07-25, below).
   *
   * When `enabled` is false, ALL headroom-based dispatch gating is OFF: the W1-T197
   * daemon idle curve and the ratified W1-T249 reserve gate never pause dispatch on
   * `percent_used`. Headroom is still READ and LEDGERED every daemon cycle
   * (telemetry without enforcement), so the console shows weekly burn and the
   * operator flips the flag with data in front of him. The per-run turn limit and
   * `budget_usd` tripwire remain the runaway guards (ruling clause 4). When
   * `enabled` is true, the existing time-aware curve enforces unchanged.
   *
   * DEFAULT — **true** (OPERATOR RULING 2026-07-25, superseding a4153e's default
   * clause while keeping its flag architecture intact): "most people would prefer
   * rmd to efficiently manage their tokens rather than eat into extra spend." The
   * shipped default protects the subscription window; SPENDING PAST IT IS THE
   * DELIBERATE ACT — an operator opts into overflow by setting this field false (or
   * `RMD_HEADROOM_ENABLED=0`), never by inheriting a permissive default. This host
   * carries exactly that explicit opt-out in `~/.config/remudero/config.json`
   * (`headroom.enabled: false`, the credits-burst posture a4153e ruled for), so live
   * behaviour here is unchanged — only what an unconfigured install inherits flips.
   *
   * FUTURE HOME: `plan/policy.yaml`'s `headroom.enabled` row once W1-T252 ships —
   * documented there with the same default, **true**; this config field (and the
   * `RMD_HEADROOM_ENABLED` env override — see {@link resolveHeadroomEnabled}) is the
   * interim carrier until then.
   */
  headroom?: { enabled?: boolean };
  /**
   * Explicit override for the shared-knowledge homes (the "org brain") — see
   * {@link learningsHomes}. Optional; when absent (or a given sub-field is
   * absent), each home defaults to its historic `config.root`-derived path
   * unchanged, so a single-instance install's behavior does not change.
   *
   * WHY THIS EXISTS (D-11 cell architecture): `userOverallLearningsHome` and
   * `globalLearningsHome` used to derive ONLY from `config.root`, which was
   * fine while one instance had one `config.root`. Once a cell architecture
   * gives each codebase its own `config.root` (own ledger, governor,
   * worktrees), that same derivation silently SPLITS the org brain: N cells
   * each grow a private, empty `learnings-user/` instead of sharing one. This
   * field lets same-machine cells point at the SAME path explicitly, so N
   * cells read one brain instead of fragmenting it N ways. Cross-machine /
   * cross-user sharing stays W1-T425's redacted hash-pinned transport,
   * unchanged.
   *
   * Cells READ the shared homes freely; this field does not add or change any
   * locking — writes remain whatever single-writer path already exists today.
   */
  learningsHomes?: { userOverall?: string; global?: string };
}

/**
 * Resolve the headroom-governor switch (ruling fb-1784894405468-a4153e; default clause
 * reversed by the operator ruling of 2026-07-25). Precedence:
 * the `RMD_HEADROOM_ENABLED` env var (set/unset by the daemon plist) OVERRIDES the
 * config field in BOTH directions; absent an env value, the config's
 * `headroom.enabled`; absent that, **true** — governor ON, the product default that
 * protects the subscription window. Opting into overflow is the deliberate act: a
 * config `headroom.enabled: false` (this host) or `RMD_HEADROOM_ENABLED=0`.
 * `1/true/on/yes` (case-insensitive) ⇒ enabled; anything else present ⇒ disabled.
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
 * The shell Claude Code runs for a worker's Bash tool, granted via `CLAUDE_CODE_SHELL`. Default
 * `/bin/bash`.
 * WHY NOT ZDOTDIR ALONE (installed-version ground truth, CLI 2.1.209): Claude Code builds a shell
 * SNAPSHOT for its Bash tool by sourcing the rc file at `os.homedir()/.zshrc` — resolved from
 * HOME, NOT `$ZDOTDIR`. Setting ZDOTDIR does not redirect it. But the rc filename follows the
 * shell: bash → `$HOME/.bashrc`. Pointing the snapshot shell at bash used to work only because
 * THIS host's `$HOME/.bashrc` happened to be absent (LEARNINGS.md, PR #8) — an accident, not
 * construction; a stranger's populated `~/.bashrc` would isolate nothing. W1-T18 (see
 * {@link workerHomeDir}, `worker-home.ts`) fixes the accident by redirecting the worker's `HOME`
 * itself to a Remudero-controlled scratch dir holding only empty rc files, so `bash →
 * $HOME/.bashrc` now resolves to a path the OPERATOR never wrote regardless of what their real
 * `~/.bashrc` contains. ZDOTDIR is kept alongside this as defense-in-depth for any direct `zsh` a
 * worker spawns, and never fires the interactive `compinit` prompt that stalled W1-T1C.
 */
export function workerShell(config: Config): string {
  return config.workerShell ?? "/bin/bash";
}

/** The soft budget WARNING threshold (notional $). Default 25.00; never a kill. */
export function softBudgetThreshold(config: Config): number {
  return config.softBudgetThresholdUsd ?? 25.0;
}

/**
 * The blocked_review FIX RUNG's strike cap (W1-T76, absorbs P21). Default 2 —
 * §3's ladder: strike 1 resumes the failing session, strike 2 is a fresh
 * worker on the same branch; exhausting the cap escalates rather than looping.
 */
export function fixStrikeCap(config: Config): number {
  return config.fixStrikeCap ?? 2;
}

/** Model implement/recon workers ride. Default `sonnet`. */
export function workerModel(config: Config): string {
  return config.workerModel ?? "sonnet";
}

/**
 * Model plan authorship (the Architect, `rmd plan`/`rmd retro`'s orchestration role) rides — must
 * outrank workerModel (G-17). Sourced from the `.remudero/mounts.yaml` `architect:` row, falling
 * back to `config.architectModel`, then `opus`. `mounts` is typed structurally to avoid a
 * config↔mounts import. W1-T2559: retro, triage, and the inbox-draft rung used to ride THIS
 * resolver too; they now each resolve through their OWN `synthesis.<role>` row instead — see
 * {@link synthesisModel}/{@link synthesisEffort} — never this one.
 */
export function architectModel(config: Config, mounts?: { architect: { model: string } }): string {
  return mounts?.architect.model ?? config.architectModel ?? "opus";
}

/** The three synthesis rungs (W1-T2559). Re-declared structurally here to avoid a config↔mounts
 *  import; `src/lib/mounts.ts` exports the canonical `SynthesisRole`. */
export type SynthesisRole = "retro" | "triage" | "inbox_draft";

/**
 * Model a synthesis rung (retro / triage / inbox-draft) rides — its OWN `.remudero/mounts.yaml`
 * `synthesis.<role>` row, never {@link architectModel}'s `architect:` row (W1-T2559). These three
 * ship no code and supervise no worker, so G-17's Tier Invariant does not bind them to plan
 * authorship's tier. UNLIKE `architectModel`, this never defaults: `mounts.synthesis` is REQUIRED
 * and load-time validated (`src/lib/mounts.ts`'s `validateMounts`) — a missing/malformed role
 * REFUSES at load rather than silently falling back to the Architect's.
 */
export function synthesisModel(mounts: { synthesis: Record<SynthesisRole, { model: string }> }, role: SynthesisRole): string {
  return mounts.synthesis[role].model;
}

/**
 * Reasoning effort a synthesis rung rides — same source and no-default contract as
 * {@link synthesisModel}. Wired to the spawn (`src/run-task.ts`) so effort is an actually-tuned
 * lever for these rungs (pre-W1-T2559, the bundled `architect.effort` was never passed to any of
 * the three rungs' spawn calls).
 */
export function synthesisEffort(mounts: { synthesis: Record<SynthesisRole, { effort: string }> }, role: SynthesisRole): string {
  return mounts.synthesis[role].effort;
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
 * Base URL for the operator console's deep links (W1-T144 console push — digest.ts's
 * `consoleCardUrl`). Default `http://localhost:4317` (serve's own default port, see
 * `rmd serve`'s help text); override via `consoleUrl` in config.json with a
 * tailnet/LAN address so a pushed link actually resolves from wherever the message
 * channel is read, not just from the machine running the console.
 */
export function consoleUrl(config: Config): string {
  return config.consoleUrl ?? "http://localhost:4317";
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
 * The Remudero-controlled scratch directory every worker's `HOME` is redirected to (W1-T18 general
 * shell-isolation mechanism, `worker-home.ts`). It holds ONLY empty rc files Remudero itself
 * wrote, plus explicit symlinks back to the real HOME for the few paths a worker legitimately
 * needs (`.claude`, `.config/gh`, `.gitconfig`) — so a worker's shell-snapshot rc (`$HOME/.bashrc`,
 * resolved off `HOME` — see {@link workerShell}) is isolated from the OPERATOR's real dotfiles
 * regardless of what they contain, not just on hosts where `~/.bashrc` happens to be absent.
 *
 * Derived from `config.root`, never a hardcoded absolute path (public-repo hygiene): default
 * `<root>/worker-home`. An instance may pin it explicitly via `workerHomeRoot` in
 * `~/.config/remudero/config.json`.
 */
export function workerHomeDir(config: Config): string {
  return config.workerHomeRoot ?? join(config.root, "worker-home");
}

/** Path to the instance config file. Derived, never a committed literal. */
export function configPath(): string {
  return join(homedir(), ".config", "remudero", "config.json");
}

/**
 * A test fixture that redirects HOME, reaches `loadConfig`/`configPath`, but hand-rolls its own
 * seeded `config.json` at some OTHER literal path is the trap W1-T2414 is filed against: the
 * absent file sends `loadConfig` down its `created` branch, which shells `resolveClaudeBin()` —
 * present on every developer host, absent on a runner with no `claude` binary, so the fixture
 * passes everywhere it is written and fails only where it is judged. `configPath()`'s own
 * construction (`.config/remudero/config.json`) is the ONE correct shape; this is its census.
 */
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
 * The literal string segments a `join(...)` call's arguments resolve to, in order, resolving ONE
 * level of variable indirection (`const configDir = join(home, ".config", "remudero")` followed
 * by `join(configDir, "config.json")` — the exact shape `test/feedback-landing.test.ts` and
 * `test/install-checkout-command.test.ts` already use). A non-literal, unresolvable argument
 * (`home`, `homedir()`, `tmpdir()`) contributes nothing — it is the opaque root, never part of
 * the tail this check compares.
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
 * Census over `files` for the trap this task is filed against — see the module-level doc comment
 * above. Pure and injected (no fs of its own), so it drives against BOTH synthetic fixtures
 * (proving it fires, and proving it stays quiet on the innocent cases) and the repo's own `test/`
 * tree (proving nothing live is at risk today, W1-T2414's falsifier). A fixture is IN SCOPE only
 * if it both redirects `process.env.HOME` and references `loadConfig`/`configPath` — anything else
 * cannot reach `resolveClaudeBin` through this seam by construction, so it is silently skipped
 * rather than reported (false-positive containment: a `.remudero`-writing fixture that seeds a
 * wholly different artifact, e.g. `mounts.yaml`, and never calls `loadConfig` is not this defect).
 * Within scope, only a `join(...)` call whose literal tail actually ENDS in `"config.json"` counts
 * as "seeding a config file" — a fixture that never writes one is never reported (same containment).
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

/**
 * Resolve the two shared-knowledge homes (the "org brain") — P32/W1-T145's layered knowledge,
 * D-11's cell-sharing seam. This is the ONE place both homes are computed; {@link userOverallLearningsHome}
 * and {@link globalLearningsHome} are thin wrappers over it, and every consumer elsewhere
 * (run-task.ts, learnings.ts) reads through those wrappers rather than re-deriving a path, so an
 * explicit `config.learningsHomes` override actually reaches every call site instead of shipping
 * green and inert.
 * Each home independently defaults to its historic `config.root`-derived path when
 * `config.learningsHomes` (or the specific sub-field) is absent — BYTE-FOR-BYTE the same path an
 * unconfigured install always resolved, so existing single-instance installs see no behavior
 * change. An operator (or a cell orchestrator) sets `config.learningsHomes.userOverall` / `.global`
 * to an identical path across multiple `config.root`s to make N same-machine cells read one
 * shared corpus instead of N private ones.
 */
export function learningsHomes(config: Config): LearningsHomes {
  return {
    userOverall: config.learningsHomes?.userOverall ?? join(config.root, "learnings-user"),
    global: config.learningsHomes?.global ?? join(config.root, "learnings-global"),
  };
}

/**
 * The USER-OVERALL learnings home (P32/W1-T145, layered knowledge): a fleet-readable directory
 * OUTSIDE any single repo checkout, so every project's fleet on this instance reads the SAME
 * cross-project corpus.
 * Resolved via {@link learningsHomes}; default `<config.root>/learnings-user` when unconfigured.
 * Because the default depends ONLY on `config.root` — never on a repo path, cwd, or which checkout
 * is asking — two different repo checkouts under the same instance always resolve to the identical
 * path by default (same pattern as {@link workerZdotdir}/{@link workerHomeDir} deriving off
 * `config.root` rather than a per-repo path). `config.learningsHomes.userOverall` lets an operator
 * make that identity hold ACROSS `config.root`s too (D-11 cells), not just within one.
 */
export function userOverallLearningsHome(config: Config): string {
  return learningsHomes(config).userOverall;
}

/**
 * The RMD-GLOBAL learnings home (P32/W1-T145, layered knowledge): where the versioned,
 * hash-pinned, cross-user artifact lives once pulled onto this machine (see `learnings.ts`'s
 * `GlobalArtifact`/`loadGlobalArtifact` for the artifact shape and its integrity check). The PULL
 * itself — opt-in POST up / hash-pinned artifact down, no persistent connection — is §6/Tier 3
 * (DECISIONS.md distribution-architecture) and is DEFERRED; this only names where a pulled
 * artifact is read from.
 *
 * Resolved via {@link learningsHomes}; default `<config.root>/learnings-global` when unconfigured,
 * overridable via `config.learningsHomes.global` so same-machine cells (D-11) share it.
 */
export function globalLearningsHome(config: Config): string {
  return learningsHomes(config).global;
}

/** Canonical filename of the pulled RMD-GLOBAL artifact inside {@link globalLearningsHome}. */
const GLOBAL_ARTIFACT_FILENAME = "artifact.yaml";

/**
 * Full path to the RMD-GLOBAL artifact file this instance reads (P32/W1-T145)
 * — `<globalLearningsHome>/artifact.yaml`. A missing file (nothing pulled
 * yet, e.g. before §6 transport exists) is handled by
 * `learnings.ts`'s `loadGlobalArtifact` the same as any other refusal: zero
 * entries, never a crash.
 */
export function globalArtifactPath(config: Config): string {
  return join(globalLearningsHome(config), GLOBAL_ARTIFACT_FILENAME);
}

/**
 * Resolve the real `claude` binary in a NON-shell context. `execFileSync('which', ...)` runs the
 * `which` binary directly, so it never sees the interactive zsh `claude` function (FIELD FINDING
 * 3) — it returns the on-disk executable that a spawned Node process would actually exec.
 *
 * W1-T2414: `which` fails with a bare `Command failed: which claude` — nothing about a config
 * path, a HOME redirect or a fixture — so a test whose fixture seeds the config somewhere
 * `configPath()` doesn't resolve reads, on CI, as a missing binary rather than the wrong seam that
 * reached for it. This rethrows naming the config path this call was reached from (from
 * `configPath()` itself, not a passed-in argument) and WHICH branch of {@link loadConfig} entered
 * it, via `reason`. Control flow, return type and the eager call itself are unchanged.
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

/**
 * Load the instance config, creating it on first run with resolved defaults. `root` defaults to
 * `~/Remudero`. Returns fully-resolved absolute paths.
 *
 * EXCLUSIVE-CREATE DISCIPLINE (CodeQL js/file-system-race): the old shape here was
 * `existsSync(p) ? read : write` — a classic TOCTOU. Between the `existsSync` check and the
 * `writeFileSync`, a second process (two workers racing their first `loadConfig()` call) could
 * create the file first; this process's unconditional write would then silently clobber it.
 * `openSync(p, "wx")` folds the check and the create into one atomic syscall: it succeeds only if
 * THIS call created the file, and fails with `EEXIST` if anything else already had — no window
 * for a second writer to win a race that this branch doesn't already know about.
 * `resolveClaudeBin()` (shells `which claude`) is deliberately called only *after* the exclusive
 * create wins, and not at all on the `EEXIST` fallback path unless the existing config is missing
 * the field — same laziness as before (LEARNINGS.md lazy-config-in-ci: it must stay absent from
 * CI runs where the config file already exists and the binary doesn't).
 *
 * CodeQL js/file-system-race, round 2 (alert #24): the first round fixed the WRITE side (the `wx`
 * create above) but left the `EEXIST` fallback reading via `readFileSync(p, ...)` — a path-string
 * operation CodeQL's dataflow still correlates back to the `wx` attempt as "checked, then used by
 * name." Same remediation the query itself recommends for the write side applies here too: read
 * through the DESCRIPTOR, not the path. `openSync(p, "r")` plus `readFileSync(fd, ...)` never
 * hands a file-name string to the read sink, so there is nothing left for the query to flag.
 *
 * CodeQL js/file-system-race, round 4 (alert #60): CodeQL still correlates the `wx` attempt's `p`
 * with the fallback read's `p`, even through the descriptor indirection (a false positive — see
 * fs-race-safe.ts's header comment). Rather than open-code a fourth copy of this exact
 * create-or-read shape, both the `wx` attempt and the descriptor read now live in the shared
 * `createOrReadExclusive` helper (also used by serve.ts's `resolveServiceTokens`), so a fifth
 * round reuses tested code instead of a new copy.
 */
export function loadConfig(): Config {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const result = createOrReadExclusive(p, 0o600);
  if (result.created) {
    try {
      const created: Config = {
        claudeBin: resolveClaudeBin("config creation was entered"),
        root: join(homedir(), "Remudero"),
      };
      writeSync(result.fd, JSON.stringify(created, null, 2) + "\n");
      return created;
    } finally {
      closeSync(result.fd);
    }
  }
  const parsed = JSON.parse(result.raw) as Partial<Config>;
  if (!parsed.claudeBin) parsed.claudeBin = resolveClaudeBin("existing config is missing claudeBin");
  if (!parsed.root) parsed.root = join(homedir(), "Remudero");
  validateConfig(parsed as Config);
  return parsed as Config;
}
