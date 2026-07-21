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

/** Same billing-boundary check as `lib/env.ts`'s `buildWorkerEnv`, applied to the plist's own env block. */
const ANTHROPIC_KEY = /^ANTHROPIC_/i;
function assertNoAnthropicKeys(env: Record<string, string>): void {
  const survivors = Object.keys(env).filter((k) => ANTHROPIC_KEY.test(k));
  if (survivors.length > 0) {
    throw new LaunchdPlistError(
      `generateLaunchdPlist: billing-boundary violation — ANTHROPIC_* key(s) in EnvironmentVariables: ${survivors.join(", ")}`,
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

  const label = opts.label ?? DAEMON_LABEL;
  const path = opts.path ?? DEFAULT_LAUNCHD_PATH;
  const home = opts.home ?? homedir();
  const logDir = join(opts.root, "state", "logs");
  const stdoutPath = join(logDir, "daemon.out.log");
  const stderrPath = join(logDir, "daemon.err.log");

  const environment: Record<string, string> = { PATH: path, HOME: home };
  assertNoAnthropicKeys(environment);

  const programArguments = [opts.rmdBin, "daemon"];
  if (opts.repo !== undefined) {
    programArguments.push("--repo", opts.repo);
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
  assertNoAnthropicKeys(environment);

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
