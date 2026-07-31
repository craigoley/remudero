/**
 * launchd unit GENERATION (W1-T12b, split from W1-T12 — DIAGNOSIS.md, Rule 16).
 *
 * This module only builds the .plist TEXT (a pure string transform over
 * explicit, injected inputs) and computes where it WOULD live on disk. It
 * never writes a file, never shells out to `launchctl`, and never touches
 * `~/Library/LaunchAgents` — actually installing + loading the unit on a real
 * user session is W1-T12d (verify:human): a headless worker cannot commission
 * a live launchd service (Rule 18). That boundary is why every function here
 * is a pure function of its arguments, provable with plain string assertions
 * in a unit test — no real launchd involved.
 *
 * Two things this unit gets right on purpose:
 *
 *  1. ABSOLUTE PATHS EVERYWHERE. launchd execs `ProgramArguments[0]` directly
 *     (no shell, no PATH search) and starts the child in `/` unless
 *     `WorkingDirectory` is set — a relative path or an unset working
 *     directory silently fails or resolves against the wrong tree. Every path
 *     `generateLaunchdPlist` embeds (the launcher, the working directory, the
 *     log files) is asserted absolute; a relative path is a thrown error, not
 *     a plist that fails silently at boot.
 *
 *  2. AN EXPLICIT PATH, NO ANTHROPIC_*. launchd's own default PATH
 *     (`/usr/bin:/bin:/usr/sbin:/sbin`) omits `/usr/local/bin` and Homebrew's
 *     `/opt/homebrew/bin`, where `node`/`claude` typically live on macOS — so
 *     `EnvironmentVariables.PATH` is always set explicitly, never left to
 *     launchd's default. `EnvironmentVariables` is otherwise a closed
 *     allowlist (PATH + HOME only) — launchd never sources `~/.zshrc` (see
 *     lib/env.ts header), so this file is the WHOLE env the daemon process
 *     receives at boot, and no key here may ever match `ANTHROPIC_*` (the
 *     billing boundary, MASTER-PLAN §9). `assertNoAnthropicKeys` enforces this
 *     the same way `lib/env.ts`'s `buildWorkerEnv` enforces it for a worker's
 *     env: a survivor throws at generation time rather than shipping a
 *     contaminated unit. The daemon process ALSO re-checks its own live env at
 *     boot (`lib/daemon.ts` `daemonBoot`, over `lib/env.ts` `assertCleanBoot`)
 *     — belt-and-suspenders, since a plist that is clean today says nothing
 *     about how the process actually gets exec'd on a future edit.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { loadDefaultPolicy } from "./policy.js";

/** The launchd label this daemon unit is always generated under. */
export const DAEMON_LABEL = "com.remudero.daemon";

/**
 * launchd's own default PATH omits Homebrew — this is the explicit
 * replacement `generateLaunchdPlist` uses unless a caller overrides it.
 */
export const DEFAULT_LAUNCHD_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export interface LaunchdPlistOpts {
  /** Absolute path to the `bin/rmd` launcher. Never resolved from PATH — launchd doesn't search it. */
  rmdBin: string;
  /** Workspace root (config.root, §4A) — absolute. WorkingDirectory + log files derive from it. */
  root: string;
  /** launchd label. Default {@link DAEMON_LABEL}. */
  label?: string;
  /** Explicit PATH the daemon process boots with. Default {@link DEFAULT_LAUNCHD_PATH}. */
  path?: string;
  /** HOME the daemon process boots with. Default `os.homedir()`. */
  home?: string;
  /** `rmd daemon --poll-ms <n>`, when set (absent ⇒ the command's own default). */
  pollIntervalMs?: number;
  /**
   * `rmd daemon --repo <name>`, baked in so the launchd unit drains the INTENDED repo (e.g.
   * remudero-sandbox for W1-T12d), never an implicit default. Absent ⇒ no --repo in the unit,
   * so the daemon's self-target guard refuses to start rather than silently draining its own
   * source repo. Explicit is safe.
   */
  repo?: string;
  /**
   * Whether `repo` (or its absence, which `resolveDaemonTarget` defaults to self at runtime)
   * targets the daemon's OWN source repo. Passed in already-resolved by the CLI layer (which
   * has the git origin to compare against) so this module stays a pure string transform — no
   * shell-out here. Default false (never refuses) so existing non-self callers are unaffected.
   */
  isSelfTarget?: boolean;
  /**
   * `rmd daemon-plist --allow-self-target` — explicit operator consent to generate a unit that
   * targets the daemon's own source repo (the W1-T109 commissioning crash-loop near-miss: a
   * self-target unit generated WITHOUT this flag loads fine, but the daemon's OWN runtime guard
   * (`resolveDaemonTarget`) then refuses to start, exits non-zero, and
   * `KeepAlive`/`SuccessfulExit: false` restarts it forever). When {@link isSelfTarget} is true,
   * this flag is REQUIRED — {@link generateLaunchdPlist} throws instead of emitting a unit that
   * would crash-loop at boot (fail at the cheapest layer, generation, not boot). When given, it
   * is baked into `ProgramArguments` so the daemon's own runtime consent gate is satisfied too.
   * Ignored (never required, never baked) for a non-self target.
   */
  allowSelfTarget?: boolean;
  /**
   * Seconds launchd waits between daemon relaunches (R-1: the relaunch-storm rate limit
   * already applied to the SEPARATE serve unit, {@link DEFAULT_SERVE_THROTTLE_S}). NET-NEW
   * for the daemon unit (W1-T253, P37 CONSUMERS) — no prior literal existed to lift, so
   * absent here this reads `plan/policy.yaml`'s `launchd.throttleIntervalS` (net-new,
   * bounded [10, 3600] at load) rather than a source literal.
   */
  throttleIntervalS?: number;
}

/** Thrown by {@link generateLaunchdPlist} when an input violates one of its invariants. */
export class LaunchdPlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchdPlistError";
  }
}

function assertAbsolute(value: string, field: string): void {
  if (!value.startsWith("/")) {
    throw new LaunchdPlistError(`generateLaunchdPlist: ${field} must be an absolute path, got ${JSON.stringify(value)}`);
  }
}

/**
 * Same billing-boundary check as `lib/env.ts`'s `buildWorkerEnv`, applied to a launchd unit's
 * own `EnvironmentVariables` block. EXPORTED (not module-private) so both {@link
 * generateLaunchdPlist} (the daemon unit, W1-T12b) and {@link generateDigestLaunchdPlist} (the
 * digest unit, W1-T112) can be PROVEN to call the identical assertion — one billing boundary
 * implementation, not two that could drift — and so a fixture can inject an ANTHROPIC_* key
 * directly and observe the throw without needing a generator whose options happen to expose a
 * raw-env override. `context` names the caller in the thrown message (defaults to the original
 * daemon-generator name for backward compatibility with existing error-text assertions).
 */
export const ANTHROPIC_KEY = /^ANTHROPIC_/i;
export function assertNoAnthropicKeys(env: Record<string, string>, context: string = "generateLaunchdPlist"): void {
  const survivors = Object.keys(env).filter((k) => ANTHROPIC_KEY.test(k));
  if (survivors.length > 0) {
    throw new LaunchdPlistError(
      `${context}: billing-boundary violation — ANTHROPIC_* key(s) in EnvironmentVariables: ${survivors.join(", ")}`,
    );
  }
}

/** Minimal XML-text escaping — the handful of values this module ever embeds (paths, a label). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stringArray(values: string[]): string {
  return values.map((v) => `    <string>${escapeXml(v)}</string>`).join("\n");
}

/**
 * Generate the launchd .plist TEXT for the Remudero daemon (`rmd daemon`).
 * Pure function of its args — no filesystem write, no `launchctl` call (see
 * file header). Throws {@link LaunchdPlistError} if `rmdBin`/`root` aren't
 * absolute, or if the assembled `EnvironmentVariables` block carries an
 * `ANTHROPIC_*` key.
 */
export function generateLaunchdPlist(opts: LaunchdPlistOpts): string {
  assertAbsolute(opts.rmdBin, "rmdBin");
  assertAbsolute(opts.root, "root");
  if (opts.home !== undefined) assertAbsolute(opts.home, "home");

  // Self-target consent gate — FIRST, before any plist text is built, so a refusal generates
  // nothing (W1-T109: fail at generation, the cheapest layer, not at boot as a KeepAlive
  // crash-loop). Mirrors the runtime gate `resolveDaemonTarget` applies to `rmd daemon` itself.
  if (opts.isSelfTarget && !opts.allowSelfTarget) {
    throw new LaunchdPlistError(
      `generateLaunchdPlist: refusing to generate a unit that targets the daemon's OWN source ` +
        `repo${opts.repo ? ` '${opts.repo}'` : " (no --repo given, which defaults to self at runtime)"} ` +
        `without --allow-self-target. Loaded as-is, the daemon's own runtime guard would refuse to ` +
        `start it and launchd's KeepAlive would restart it forever. Pass --allow-self-target to bake ` +
        `explicit consent into the unit, or target a different repo with --repo.`,
    );
  }

  const label = opts.label ?? DAEMON_LABEL;
  const path = opts.path ?? DEFAULT_LAUNCHD_PATH;
  const home = opts.home ?? homedir();
  // W1-T253: net-new — reads plan/policy.yaml's launchd.throttleIntervalS (no prior literal
  // existed to lift, see LaunchdPlistOpts.throttleIntervalS's doc) when the caller doesn't
  // override it.
  const throttleIntervalS = opts.throttleIntervalS ?? loadDefaultPolicy().values.launchd.throttleIntervalS;
  const logDir = join(opts.root, "state", "logs");
  const stdoutPath = join(logDir, "daemon.out.log");
  const stderrPath = join(logDir, "daemon.err.log");

  const environment: Record<string, string> = { PATH: path, HOME: home };
  assertNoAnthropicKeys(environment);

  const programArguments = [opts.rmdBin, "daemon"];
  if (opts.repo !== undefined) {
    programArguments.push("--repo", opts.repo);
  }
  if (opts.isSelfTarget && opts.allowSelfTarget) {
    // Bake the SAME consent the runtime guard (resolveDaemonTarget) requires, so the unit
    // boots already-consented rather than crash-looping on the daemon's own refusal.
    programArguments.push("--allow-self-target");
  }
  if (opts.pollIntervalMs !== undefined) {
    programArguments.push("--poll-ms", String(opts.pollIntervalMs));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <!-- ANTHROPIC-clean-env boot assertion (W1-T12b, billing boundary, MASTER-PLAN §9):
       EnvironmentVariables below is a CLOSED allowlist (PATH + HOME only) — launchd
       never sources ~/.zshrc, so this dict is the WHOLE env the daemon process
       receives at boot. generateLaunchdPlist() throws if any ANTHROPIC_* key ever
       lands in it. The daemon process itself re-asserts this at runtime over its
       OWN live env (lib/daemon.ts daemonBoot, lib/env.ts assertCleanBoot) and logs
       env_clean=true / billing_mode=subscription — belt-and-suspenders against a
       future edit to this generator. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
${stringArray(programArguments)}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <!-- ThrottleInterval (W1-T253, P37 CONSUMERS): the R-1 relaunch-storm rate limit,
       net-new here — plan/policy.yaml's launchd.throttleIntervalS, unless overridden. -->
  <key>ThrottleInterval</key>
  <integer>${throttleIntervalS}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

/**
 * Where this unit WOULD live under `~/Library/LaunchAgents` — a pure path
 * computation, never a write. W1-T12d (the human operator) is who actually
 * writes the file there and runs `launchctl load`.
 */
export function launchdPlistPath(label: string = DAEMON_LABEL, home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

/**
 * The `launchctl` GUI-domain SERVICE target for one label — `gui/<uid>/<label>` — the
 * argument `launchctl bootout|print|kickstart` all take to address an already-bootstrapped
 * job by name (as opposed to `bootstrap`, which addresses the DOMAIN `gui/<uid>` plus a
 * plist PATH). Pure string composition, factored here so W1-T169's `rmd down`/`rmd up`
 * (run-task.ts) build this exactly once rather than re-deriving the format at each of
 * their several call sites — deployer.ts's `realDeployDeps` kickstart call built the same
 * shape inline (`gui/${uid}/${label}`) before this existed; this is the same string, not a
 * second format.
 */
export function launchctlGuiTarget(uid: number, label: string): string {
  return `gui/${uid}/${label}`;
}

// ── The SERVE LaunchAgent (W1-T152 — the operator console as a background SERVICE) ────────
//
// SAME generator family as generateLaunchdPlist above (W1-T12b): the same absolute-path
// assertions and the same closed-allowlist, ANTHROPIC-clean EnvironmentVariables. Three
// deliberate differences, each earned by an incident:
//
//  1. `KeepAlive` is UNCONDITIONAL (`<true/>`), not the daemon's `SuccessfulExit: false`.
//     `rmd serve` blocks until SIGINT/SIGTERM and returns 0 on a clean shutdown — under
//     `SuccessfulExit: false` that clean exit is "successful", so launchd would leave the
//     console DOWN exactly when someone ctrl+C'd or SIGTERM'd it, which is the fixture this
//     task exists for (the operator reclaimed his shell twice in one morning and the board
//     went dark). A console the operator reattaches to from a phone must come back from
//     EVERY exit; deliberately stopping it is `launchctl bootout`, not an exit code.
//  2. `ThrottleInterval` is EXPLICIT (default {@link DEFAULT_SERVE_THROTTLE_S}). R-1: 438
//     daemon boots in two days, one per minute at its worst, because KeepAlive relaunches
//     on exit and nothing rate-limited it. Unconditional KeepAlive inherits exactly that
//     shape unless the throttle is stated, so it is stated.
//  3. The bind interfaces ride in `RMD_SERVE_HOST` (the env slot `resolveServeHosts` in
//     lib/serve.ts documents for remote access), resolved by the CALLER from config/env and
//     passed in — never a literal address in committed source (public-repo hygiene, the same
//     rule config.ts's `root` follows). This is the one key beyond PATH+HOME the allowlist
//     carries, and it is still ANTHROPIC-clean (`assertNoAnthropicKeys` runs over the whole
//     assembled dict, not a subset of it).
//
// DAEMON-INDEPENDENCE IS A REQUIREMENT (W1-T152 note ii), not a detail: on 2026-07-21 the
// daemon was deliberately stopped for containment while the operator still needed the board.
// Nothing below references {@link DAEMON_LABEL} or any daemon path — this unit installs,
// loads and runs with the daemon absent, so stopping the fleet never blinds the operator.

/** The launchd label the serve (operator console) unit is always generated under. */
export const SERVE_LABEL = "com.remudero.serve";

/** Default seconds launchd waits between serve relaunches — the R-1 relaunch-storm rate limit. */
export const DEFAULT_SERVE_THROTTLE_S = 60;

/**
 * Bind values that mean "EVERY interface", refused by name at generation time. This is the
 * defense-in-depth DUPLICATE of `lib/serve.ts`'s own `WILDCARD_HOSTS` (the primary gate — the
 * CLI resolves hosts through `resolveServeHosts` before ever reaching this generator). Two
 * copies exist because this module is a leaf (node:os + node:path only) and must not import the
 * live HTTP console to validate a string; test/serve-plist.test.ts asserts the two sets are
 * IDENTICAL, so they cannot drift apart. A unit that binds the wildcard would put fleet-control
 * write actions on every coffee-shop LAN the laptop joins, permanently and across reboots —
 * strictly worse than the foreground `rmd serve` it replaces.
 */
export const SERVE_WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*", ""]);

/** Where the serve unit's stdout/stderr land — the SAME `<root>/state/logs/` home every other
 *  unit in this family uses. Exported so the CLI can pre-create both files 0600 (R-5: a bearer
 *  token in a world-readable log had to be rotated) instead of letting launchd create them at
 *  its own umask, and so the path is computed ONCE for both the unit and the chmod. */
export function serveLogPaths(root: string): { stdout: string; stderr: string } {
  const logDir = join(root, "state", "logs");
  return { stdout: join(logDir, "serve.out.log"), stderr: join(logDir, "serve.err.log") };
}

export interface ServeLaunchdPlistOpts {
  /** Absolute path to the `bin/rmd` launcher. Never resolved from PATH — launchd doesn't search it. */
  rmdBin: string;
  /** Workspace root (config.root, §4A) — absolute. WorkingDirectory + log files derive from it. */
  root: string;
  /** TCP port baked into `ProgramArguments`. Resolved by the caller from `--port`/config. */
  port: number;
  /**
   * The interfaces the console binds, ALREADY resolved by the caller from `--host`/config/env
   * (lib/serve.ts `resolveServeHosts`) — e.g. `["127.0.0.1", "100.90.47.107"]` for "reachable
   * locally AND from the phone over the tailnet". Emitted as `RMD_SERVE_HOST`. Never defaulted
   * here: a unit that silently binds loopback-only would leave the operator's remote console
   * dead with a green `launchctl print`.
   */
  hosts: string[];
  /** launchd label. Default {@link SERVE_LABEL}. */
  label?: string;
  /** Explicit PATH the serve process boots with. Default {@link DEFAULT_LAUNCHD_PATH}. */
  path?: string;
  /** HOME the serve process boots with. Default `os.homedir()`. */
  home?: string;
  /** Seconds between relaunches. Default {@link DEFAULT_SERVE_THROTTLE_S}; min 10. */
  throttleSeconds?: number;
}

/**
 * Generate the launchd .plist TEXT for the operator console (`rmd serve`). Pure function of its
 * args — no filesystem write, no `launchctl` call (see this module's header). Throws
 * {@link LaunchdPlistError} if `rmdBin`/`root`/`home` aren't absolute, if `port` isn't an
 * integer in [1, 65535], if `hosts` is empty or names a wildcard, if `throttleSeconds` is under
 * 10, or if the assembled `EnvironmentVariables` block carries an `ANTHROPIC_*` key.
 */
export function generateServeLaunchdPlist(opts: ServeLaunchdPlistOpts): string {
  assertAbsolute(opts.rmdBin, "rmdBin");
  assertAbsolute(opts.root, "root");
  if (opts.home !== undefined) assertAbsolute(opts.home, "home");

  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new LaunchdPlistError(
      `generateServeLaunchdPlist: port must be an integer in [1, 65535], got ${JSON.stringify(opts.port)}`,
    );
  }
  if (opts.hosts.length === 0) {
    throw new LaunchdPlistError(
      `generateServeLaunchdPlist: hosts must name at least one interface — a unit that binds nothing ` +
        `reads as a working console that answers no one.`,
    );
  }
  for (const h of opts.hosts) {
    if (SERVE_WILDCARD_HOSTS.has(h)) {
      throw new LaunchdPlistError(
        `generateServeLaunchdPlist: host ${JSON.stringify(h)} binds EVERY interface. Name the ` +
          `interface(s) you mean (e.g. "127.0.0.1,<tailnet-ip>") — a launchd unit makes the ` +
          `exposure permanent and reboot-surviving.`,
      );
    }
  }

  const label = opts.label ?? SERVE_LABEL;
  const path = opts.path ?? DEFAULT_LAUNCHD_PATH;
  const home = opts.home ?? homedir();
  const throttle = opts.throttleSeconds ?? DEFAULT_SERVE_THROTTLE_S;
  if (!Number.isInteger(throttle) || throttle < 10) {
    throw new LaunchdPlistError(
      `generateServeLaunchdPlist: throttleSeconds must be an integer >= 10, got ${JSON.stringify(opts.throttleSeconds)}`,
    );
  }
  const logs = serveLogPaths(opts.root);
  const hostList = opts.hosts.join(",");

  const environment: Record<string, string> = { PATH: path, HOME: home, RMD_SERVE_HOST: hostList };
  assertNoAnthropicKeys(environment, "generateServeLaunchdPlist");

  const programArguments = [opts.rmdBin, "serve", "--port", String(opts.port)];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <!-- ANTHROPIC-clean-env boot assertion (billing boundary, MASTER-PLAN §9 — the SAME
       assertion generateLaunchdPlist() applies to the daemon unit, W1-T12b):
       EnvironmentVariables below is a CLOSED allowlist (PATH + HOME + the resolved
       RMD_SERVE_HOST bind list) — launchd never sources ~/.zshrc, so this dict is the
       WHOLE env the console process receives at boot. It carries NO secret: the bearer
       tokens are read at boot from <root>/state/service-tokens.json (0600, created on
       first run) exactly as they are today, and are never embedded in this unit. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
    <key>RMD_SERVE_HOST</key>
    <string>${escapeXml(hostList)}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
${stringArray(programArguments)}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <!-- UNCONDITIONAL KeepAlive (not the daemon's SuccessfulExit:false): rmd serve exits 0
       on a clean SIGINT/SIGTERM, and the console must come back from THAT too — see this
       section's header. ThrottleInterval is the R-1 relaunch-storm rate limit.
       NOTE (no backticks anywhere inside this template literal — one would terminate it). -->
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${throttle}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(logs.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logs.stderr)}</string>
</dict>
</plist>
`;
}

// ── The digest LaunchAgent (W1-T112 — the morning pulse) ──────────────────────────────────
//
// SAME generator family as generateLaunchdPlist above (W1-T12b) — the SAME absolute-path
// assertions and the SAME closed-allowlist, ANTHROPIC-clean EnvironmentVariables reused
// verbatim (one billing boundary, not two generators that could drift apart on it). The one
// real difference is WHEN it runs: the daemon is a long-lived RunAtLoad+KeepAlive process;
// `rmd digest` runs once, sends the pulse, and exits, so this unit is a StartCalendarInterval
// firing once a day at `hour`:00 local time instead.

/** The launchd label the digest unit is always generated under. */
export const DIGEST_LABEL = "com.remudero.digest";

/** Default local hour (24h, 0-23) the digest pulse fires — a MORNING pulse, per the title. */
export const DEFAULT_DIGEST_HOUR = 8;

export interface DigestLaunchdPlistOpts {
  /** Absolute path to the `bin/rmd` launcher. Never resolved from PATH — launchd doesn't search it. */
  rmdBin: string;
  /** Workspace root (config.root, §4A) — absolute. WorkingDirectory + log files derive from it. */
  root: string;
  /** launchd label. Default {@link DIGEST_LABEL}. */
  label?: string;
  /** Explicit PATH the digest process boots with. Default {@link DEFAULT_LAUNCHD_PATH}. */
  path?: string;
  /** HOME the digest process boots with. Default `os.homedir()`. */
  home?: string;
  /** Local hour (0-23) the digest fires each day. Default {@link DEFAULT_DIGEST_HOUR}. */
  hour?: number;
}

/**
 * Generate the launchd .plist TEXT for the daily `rmd digest` pulse. Pure function of its
 * args — no filesystem write, no `launchctl` call (see this module's header). Throws
 * {@link LaunchdPlistError} if `rmdBin`/`root` (or a given `home`) aren't absolute, if
 * `hour` is out of `[0, 23]`, or if the assembled `EnvironmentVariables` block carries an
 * `ANTHROPIC_*` key — the SAME checks {@link generateLaunchdPlist} applies to the daemon unit.
 */
export function generateDigestLaunchdPlist(opts: DigestLaunchdPlistOpts): string {
  assertAbsolute(opts.rmdBin, "rmdBin");
  assertAbsolute(opts.root, "root");
  if (opts.home !== undefined) assertAbsolute(opts.home, "home");

  const label = opts.label ?? DIGEST_LABEL;
  const path = opts.path ?? DEFAULT_LAUNCHD_PATH;
  const home = opts.home ?? homedir();
  const hour = opts.hour ?? DEFAULT_DIGEST_HOUR;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new LaunchdPlistError(`generateDigestLaunchdPlist: hour must be an integer in [0, 23], got ${JSON.stringify(opts.hour)}`);
  }
  const logDir = join(opts.root, "state", "logs");
  const stdoutPath = join(logDir, "digest.out.log");
  const stderrPath = join(logDir, "digest.err.log");

  const environment: Record<string, string> = { PATH: path, HOME: home };
  assertNoAnthropicKeys(environment, "generateDigestLaunchdPlist");

  const programArguments = [opts.rmdBin, "digest"];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <!-- ANTHROPIC-clean-env boot assertion (billing boundary, MASTER-PLAN §9 — the SAME
       assertion generateLaunchdPlist() applies to the daemon unit, W1-T12b):
       EnvironmentVariables below is a CLOSED allowlist (PATH + HOME only) — launchd
       never sources ~/.zshrc, so this dict is the WHOLE env the digest process
       receives at boot. generateDigestLaunchdPlist() throws if any ANTHROPIC_* key
       ever lands in it. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
${stringArray(programArguments)}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.root)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

// ── The deploy SUPERVISOR unit (out-of-process daemon self-update, option C) ────
//
// A periodic one-shot (NOT KeepAlive): every StartInterval seconds launchd runs
// `rmd deploy-run`, which is ONE {@link runDeployCycle} — a no-op unless a deploy is
// triggered AND the daemon is idle. The supervisor kickstarts the SEPARATE daemon
// job; the daemon is never modified and never self-restarts (the KeepAlive
// self-restart trap, daemon.ts:90-91, is sidestepped entirely by an external
// kickstart). Same ANTHROPIC-clean closed-env allowlist as the daemon/digest units.

/** Default launchd label for the deploy supervisor. */
export const SUPERVISOR_LABEL = "com.remudero.supervisor";
/** Default supervisor tick pace: one deploy cycle every 2 minutes. */
export const DEFAULT_SUPERVISOR_INTERVAL_S = 120;

export interface SupervisorLaunchdPlistOpts {
  /** Absolute path to `bin/rmd`. Never resolved from PATH. */
  rmdBin: string;
  /** Workspace root (config.root) — absolute. WorkingDirectory + logs derive from it. */
  root: string;
  /** launchd label. Default {@link SUPERVISOR_LABEL}. */
  label?: string;
  /** Explicit PATH. Default {@link DEFAULT_LAUNCHD_PATH}. */
  path?: string;
  /** HOME. Default `os.homedir()`. */
  home?: string;
  /** Seconds between ticks (each tick = one `rmd deploy-run`). Default 120; min 30. */
  intervalSeconds?: number;
}

export function generateSupervisorLaunchdPlist(opts: SupervisorLaunchdPlistOpts): string {
  assertAbsolute(opts.rmdBin, "rmdBin");
  assertAbsolute(opts.root, "root");
  if (opts.home !== undefined) assertAbsolute(opts.home, "home");

  const label = opts.label ?? SUPERVISOR_LABEL;
  const path = opts.path ?? DEFAULT_LAUNCHD_PATH;
  const home = opts.home ?? homedir();
  const interval = opts.intervalSeconds ?? DEFAULT_SUPERVISOR_INTERVAL_S;
  if (!Number.isInteger(interval) || interval < 30) {
    throw new LaunchdPlistError(
      `generateSupervisorLaunchdPlist: intervalSeconds must be an integer >= 30, got ${JSON.stringify(opts.intervalSeconds)}`,
    );
  }
  const logDir = join(opts.root, "state", "logs");
  const stdoutPath = join(logDir, "supervisor.out.log");
  const stderrPath = join(logDir, "supervisor.err.log");

  const environment: Record<string, string> = { PATH: path, HOME: home };
  assertNoAnthropicKeys(environment, "generateSupervisorLaunchdPlist");

  const programArguments = [opts.rmdBin, "deploy-run"];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
${stringArray(programArguments)}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.root)}</string>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}
