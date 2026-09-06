/**
 * Builds launchd .plist TEXT for the daemon, serve, digest and deploy-supervisor units — a pure
 * string transform over injected inputs, and a pure computation of where the unit WOULD live on
 * disk. It never writes a file and never shells out to `launchctl` (W1-T12b, split from W1-T12
 * per DIAGNOSIS.md Rule 16); installing and loading a unit on a real session is human-only work,
 * W1-T12d, because a headless worker cannot commission a live launchd service (Rule 18).
 *
 * Three invariants every generator here holds:
 *  1. Every embedded path (launcher, working directory, log files) must be absolute — launchd
 *     execs `ProgramArguments[0]` directly, with no shell and no PATH search, and a relative
 *     path fails silently rather than throwing. {@link assertAbsolute} enforces it.
 *  2. `EnvironmentVariables` is a closed allowlist that never carries an `ANTHROPIC_*` key (the
 *     billing boundary, MASTER-PLAN §9) — launchd never sources `~/.zshrc`, so this is the WHOLE
 *     env the process boots with. {@link assertNoAnthropicKeys} enforces it.
 *  3. `ProgramArguments[0]` must resolve inside the caller-supplied `installRoot`, never
 *     whichever checkout happened to invoke the generator (W1-T925) — a mismatch would be a
 *     spawn error launchd retries forever. {@link assertRmdBinWithinInstallRoot} enforces it.
 *
 * Falsifier: test/launchd.test.ts, test/serve-plist.test.ts.
 */
// Why: the ANTHROPIC_* boot-env rationale and the cd-derived-checkout incident behind rule 3 — docs/forensics/launchd.md#module-header.

import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { loadDefaultPolicy } from "./policy.js";

/** The launchd label this daemon unit is always generated under. */
export const DAEMON_LABEL = "com.remudero.daemon";

/** launchd's own default PATH omits Homebrew — the explicit replacement {@link generateLaunchdPlist} uses by default. */
export const DEFAULT_LAUNCHD_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export interface LaunchdPlistOpts {
  /** Absolute path to the `bin/rmd` launcher. Never resolved from PATH. Must resolve inside
   *  {@link installRoot}, or {@link generateLaunchdPlist} throws (W1-T925). */
  rmdBin: string;
  /** Absolute path to the daemon's install checkout ({@link resolveInstallRoot}). {@link rmdBin}
   *  must resolve inside it (W1-T925), never whichever checkout invoked the generator. */
  installRoot: string;
  /** Whether {@link installRoot} exists, pre-resolved by the caller (mirrors {@link isSelfTarget}).
   *  `false` throws: a missing launcher path is a spawn error launchd retries forever. */
  installRootExists: boolean;
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
  /** `rmd daemon --repo <name>`, baked in so the unit drains the intended repo. Absent means no
   *  `--repo`, so the self-target guard refuses to start rather than draining its own repo. */
  repo?: string;
  /** Whether `repo` (or its absence, defaulting to self at runtime) targets the daemon's OWN
   *  source repo. Pre-resolved by the CLI layer so this module stays a pure transform. Default false. */
  isSelfTarget?: boolean;
  // Why: the W1-T109 commissioning near-miss this flag prevents — docs/forensics/launchd.md#allowselftarget.
  /** `rmd daemon-plist --allow-self-target` — explicit consent to target the daemon's own repo.
   *  Required whenever {@link isSelfTarget} is true, or {@link generateLaunchdPlist} throws;
   *  baked into `ProgramArguments` when given. Ignored for a non-self target. */
  allowSelfTarget?: boolean;
  // Why: why this field has no source literal to lift — docs/forensics/launchd.md#throttleintervals.
  /** Seconds launchd waits between daemon relaunches (R-1 rate limit; see also
   *  {@link DEFAULT_SERVE_THROTTLE_S}). Absent, reads `plan/policy.yaml`'s `launchd.throttleIntervalS` (bounded [10, 3600] at load). */
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

// Why: why this is a local copy rather than an import — docs/forensics/launchd.md#iswithin.
/** True when `child` is `parent` itself, or nested under it. Both inputs are already asserted
 *  absolute by the caller. Deliberately a local copy, not an import of `lib/install-root.ts`'s
 *  equivalent, so this module stays a leaf with no dependency on it. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The install-checkout gate (W1-T925) shared by all four generators in this file, so the
 *  refusal text and its remedy are written once. */
function assertInstallRootExists(installRootExists: boolean, installRoot: string, context: string): void {
  if (!installRootExists) {
    throw new LaunchdPlistError(
      `${context}: the install checkout does not exist at ${installRoot} — a unit whose ` +
        `ProgramArguments[0] points at a missing binary would spawn-error at boot and launchd's ` +
        `KeepAlive/StartInterval would retry it forever. Run \`rmd install-checkout --write\` to ` +
        `provision the install checkout, then regenerate this unit.`,
    );
  }
}

function assertRmdBinWithinInstallRoot(rmdBin: string, installRoot: string, context: string): void {
  if (!isWithin(installRoot, rmdBin)) {
    throw new LaunchdPlistError(
      `${context}: rmdBin (${rmdBin}) resolves OUTSIDE the install root (${installRoot}) — every ` +
        `generated unit's launcher must come from the dedicated install checkout (W1-T924), never ` +
        `whichever tree the generator happened to be invoked from. Run \`rmd install-checkout ` +
        `--write\` to provision the install checkout, then regenerate this unit with an rmdBin ` +
        `under it.`,
    );
  }
}

// Why: why this check is exported rather than module-private — docs/forensics/launchd.md#assertnoanthropickeys.
/** Same billing-boundary check as `lib/env.ts`'s `buildWorkerEnv`, applied to a launchd unit's
 *  `EnvironmentVariables`. Exported so both {@link generateLaunchdPlist} and {@link
 *  generateDigestLaunchdPlist} call the identical assertion. `context` names the caller in the
 *  thrown message. */
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

/** Generate the launchd .plist TEXT for the Remudero daemon (`rmd daemon`). Pure function of its
 *  args (see file header). Throws {@link LaunchdPlistError} if a required path isn't absolute,
 *  if `installRootExists` is false, if `rmdBin` resolves outside `installRoot` (W1-T925), or if
 *  `EnvironmentVariables` would carry an `ANTHROPIC_*` key. */
export function generateLaunchdPlist(opts: LaunchdPlistOpts): string {
  assertAbsolute(opts.rmdBin, "rmdBin");
  assertAbsolute(opts.installRoot, "installRoot");
  assertAbsolute(opts.root, "root");
  if (opts.home !== undefined) assertAbsolute(opts.home, "home");

  // Install-checkout gates (W1-T925), before the self-target gate: a refusal must generate nothing.
  assertInstallRootExists(opts.installRootExists, opts.installRoot, "generateLaunchdPlist");
  assertRmdBinWithinInstallRoot(opts.rmdBin, opts.installRoot, "generateLaunchdPlist");

  // Self-target consent gate (W1-T109): fail here, the cheapest layer, not at boot as a
  // KeepAlive crash-loop. Mirrors the runtime gate `resolveDaemonTarget` applies to `rmd daemon`.
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
  // W1-T253: net-new, reads plan/policy.yaml's launchd.throttleIntervalS by default (see
  // LaunchdPlistOpts.throttleIntervalS).
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
    // Bakes the same consent resolveDaemonTarget requires, so the unit boots pre-consented.
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

/** Where this unit WOULD live under `~/Library/LaunchAgents` — a pure path computation, never a
 *  write. W1-T12d (the human operator) writes the file and runs `launchctl load`. */
export function launchdPlistPath(label: string = DAEMON_LABEL, home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

// Why: the pre-existing inline duplicate this factoring replaced — docs/forensics/launchd.md#launchctlguitarget.
/** The `launchctl` GUI-domain service target for one label — `gui/<uid>/<label>` — the argument
 *  `bootout`/`print`/`kickstart` take to address an already-bootstrapped job by name. Factored
 *  here so callers build this exactly once rather than re-deriving the format. */
export function launchctlGuiTarget(uid: number, label: string): string {
  return `gui/${uid}/${label}`;
}

// ── The serve LaunchAgent (W1-T152 — the operator console as a background service) ───────────
// Same generator family as generateLaunchdPlist (same absolute-path assertions, same
// ANTHROPIC-clean allowlist), with three differences: unconditional KeepAlive, an explicit
// ThrottleInterval, and bind interfaces carried in RMD_SERVE_HOST. It must run with the daemon
// stopped or absent (W1-T152 note ii) — nothing below references DAEMON_LABEL or any daemon path.
// Why: the incidents behind all three differences — docs/forensics/launchd.md#the-serve-launchagent.

/** The launchd label the serve (operator console) unit is always generated under. */
export const SERVE_LABEL = "com.remudero.serve";

/** Default seconds launchd waits between serve relaunches — the R-1 relaunch-storm rate limit. */
export const DEFAULT_SERVE_THROTTLE_S = 60;

// Why: the coffee-shop-LAN risk and the dual-copy test invariant — docs/forensics/launchd.md#serve_wildcard_hosts.
/** Bind values that mean "every interface", refused by name at generation. Defense-in-depth
 *  duplicate of `lib/serve.ts`'s own `WILDCARD_HOSTS`; test/serve-plist.test.ts asserts the two
 *  sets are identical so they cannot drift apart. */
export const SERVE_WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*", ""]);

/** Where the serve unit's stdout/stderr land — the same `<root>/state/logs/` home every unit in
 *  this family uses. Exported so the CLI can pre-create both files 0600 (R-5) before launchd
 *  creates them at its own umask. */
export function serveLogPaths(root: string): { stdout: string; stderr: string } {
  const logDir = join(root, "state", "logs");
  return { stdout: join(logDir, "serve.out.log"), stderr: join(logDir, "serve.err.log") };
}

export interface ServeLaunchdPlistOpts {
  /** Absolute path to the `bin/rmd` launcher — see {@link LaunchdPlistOpts.rmdBin}; must resolve
   *  inside {@link installRoot} (W1-T925) or {@link generateServeLaunchdPlist} throws. */
  rmdBin: string;
  /** The daemon's install checkout — see {@link LaunchdPlistOpts.installRoot}, identical here. */
  installRoot: string;
  /** Whether {@link installRoot} exists — see {@link LaunchdPlistOpts.installRootExists}, identical here. */
  installRootExists: boolean;
  /** Workspace root (config.root, §4A) — absolute. WorkingDirectory + log files derive from it. */
  root: string;
  /** TCP port baked into `ProgramArguments`. Resolved by the caller from `--port`/config. */
  port: number;
  /** The interfaces the console binds, already resolved by the caller from `--host`/config/env
   *  (`resolveServeHosts`). Emitted as `RMD_SERVE_HOST`. Never defaulted here: a unit that
   *  silently binds loopback-only leaves the operator's remote console dead. */
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

/** Generate the launchd .plist TEXT for the operator console (`rmd serve`). Pure function of its
 *  args (see file header). Throws {@link LaunchdPlistError} on a non-absolute path, a missing
 *  install checkout, an `rmdBin` outside `installRoot` (W1-T925), an invalid `port`, an empty or
 *  wildcard `hosts`, a `throttleSeconds` under 10, or an `ANTHROPIC_*` key. */
export function generateServeLaunchdPlist(opts: ServeLaunchdPlistOpts): string {
  assertAbsolute(opts.rmdBin, "rmdBin");
  assertAbsolute(opts.installRoot, "installRoot");
  assertAbsolute(opts.root, "root");
  if (opts.home !== undefined) assertAbsolute(opts.home, "home");
  assertInstallRootExists(opts.installRootExists, opts.installRoot, "generateServeLaunchdPlist");
  assertRmdBinWithinInstallRoot(opts.rmdBin, opts.installRoot, "generateServeLaunchdPlist");

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

// ── The digest LaunchAgent (W1-T112 — the morning pulse) ──────────────────────────────────────
// Same generator family as generateLaunchdPlist (same absolute-path assertions, same
// ANTHROPIC-clean allowlist, reused verbatim). It differs only in WHEN it runs: a
// StartCalendarInterval firing once a day at `hour`:00, not a RunAtLoad+KeepAlive process.

/** The launchd label the digest unit is always generated under. */
export const DIGEST_LABEL = "com.remudero.digest";

/** Default local hour (24h, 0-23) the digest pulse fires — a MORNING pulse, per the title. */
export const DEFAULT_DIGEST_HOUR = 8;

export interface DigestLaunchdPlistOpts {
  /** Absolute path to the `bin/rmd` launcher — see {@link LaunchdPlistOpts.rmdBin}; must resolve
   *  inside {@link installRoot} (W1-T925) or {@link generateDigestLaunchdPlist} throws. */
  rmdBin: string;
  /** The daemon's install checkout — see {@link LaunchdPlistOpts.installRoot}, identical here. */
  installRoot: string;
  /** Whether {@link installRoot} exists — see {@link LaunchdPlistOpts.installRootExists}, identical here. */
  installRootExists: boolean;
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

/** Generate the launchd .plist TEXT for the daily `rmd digest` pulse. Pure function of its args
 *  (see file header). Throws {@link LaunchdPlistError} on a non-absolute path, a missing install
 *  checkout, an `rmdBin` outside `installRoot` (W1-T925), an `hour` outside `[0, 23]`, or an
 *  `ANTHROPIC_*` key — the same checks {@link generateLaunchdPlist} applies. */
export function generateDigestLaunchdPlist(opts: DigestLaunchdPlistOpts): string {
  assertAbsolute(opts.rmdBin, "rmdBin");
  assertAbsolute(opts.installRoot, "installRoot");
  assertAbsolute(opts.root, "root");
  if (opts.home !== undefined) assertAbsolute(opts.home, "home");
  assertInstallRootExists(opts.installRootExists, opts.installRoot, "generateDigestLaunchdPlist");
  assertRmdBinWithinInstallRoot(opts.rmdBin, opts.installRoot, "generateDigestLaunchdPlist");

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

// ── The deploy supervisor unit (out-of-process daemon self-update, option C) ──────────────────
// A periodic one-shot, not KeepAlive: every StartInterval seconds launchd runs `rmd deploy-run`
// (one {@link runDeployCycle}), which kickstarts the SEPARATE daemon job rather than the daemon
// self-restarting (sidesteps the KeepAlive self-restart trap in daemon.ts). Same ANTHROPIC-clean
// allowlist as the daemon/digest units.

/** Default launchd label for the deploy supervisor. */
export const SUPERVISOR_LABEL = "com.remudero.supervisor";
/** Default supervisor tick pace: one deploy cycle every 2 minutes. */
export const DEFAULT_SUPERVISOR_INTERVAL_S = 120;

export interface SupervisorLaunchdPlistOpts {
  /** Absolute path to `bin/rmd` — see {@link LaunchdPlistOpts.rmdBin}; must resolve inside
   *  {@link installRoot} (W1-T925) or {@link generateSupervisorLaunchdPlist} throws. */
  rmdBin: string;
  /** The daemon's install checkout — see {@link LaunchdPlistOpts.installRoot}, identical here. */
  installRoot: string;
  /** Whether {@link installRoot} exists — see {@link LaunchdPlistOpts.installRootExists}, identical here. */
  installRootExists: boolean;
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

/** Throws {@link LaunchdPlistError} on a non-absolute path, a missing install checkout, an
 *  `rmdBin` outside `installRoot` (W1-T925), an `intervalSeconds` under 30, or an `ANTHROPIC_*`
 *  key — the same checks {@link generateLaunchdPlist} applies. */
export function generateSupervisorLaunchdPlist(opts: SupervisorLaunchdPlistOpts): string {
  assertAbsolute(opts.rmdBin, "rmdBin");
  assertAbsolute(opts.installRoot, "installRoot");
  assertAbsolute(opts.root, "root");
  if (opts.home !== undefined) assertAbsolute(opts.home, "home");
  assertInstallRootExists(opts.installRootExists, opts.installRoot, "generateSupervisorLaunchdPlist");
  assertRmdBinWithinInstallRoot(opts.rmdBin, opts.installRoot, "generateSupervisorLaunchdPlist");

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

/** Pure string parse of a generated (or installed) supervisor plist's `StartInterval` — no file
 *  I/O here (see file header). Used by `rmd status` (W1-T301) so the liveness threshold tracks
 *  whatever interval is actually installed. Returns `undefined` on anything unparseable, never a
 *  fabricated number. */
export function parseSupervisorStartInterval(plistXml: string): number | undefined {
  const m = /<key>\s*StartInterval\s*<\/key>\s*<integer>\s*(-?\d+)\s*<\/integer>/.exec(plistXml);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
