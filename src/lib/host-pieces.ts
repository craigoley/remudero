import { dirname, join } from "node:path";

// Why: on 2026-11-10 at about 12:32Z an accidental deletion on the Azure host removed the dependency
// tool, the field-trials script, ~/.gh-token and the read broker's unit and launcher. Nothing named
// what was gone. Each loss surfaced through a different failure over about 90 minutes (W1-T12074).
/**
 * The pieces a fleet host needs installed outside the checkout. Each entry names the path to test,
 * the command that restores it, and the failure seen without it. `rmd doctor`'s host-pieces check
 * reads this list (src/lib/doctor.ts) and tests PATHS ONLY: no entry is ever opened, so the GitHub
 * login entry never reads a credential. SSH keys are left out on purpose. They belong to the
 * person, not the fleet. FALSIFIER: test/doctor-names-each-host-piece-that-is-missing.test.ts.
 */

/** The platforms a piece can apply to: the Linux fleet host and a Mac operator account. */
export type HostPiecePlatform = "linux" | "darwin";

export interface HostPiece {
  /** A stable name, printed by doctor beside the path. */
  id: string;
  /** Where the piece applies. A piece is never reported on any other platform. */
  platforms: readonly HostPiecePlatform[];
  /** The absolute path whose existence is tested. */
  path: string;
  /** The command that restores the piece, run from the checkout. */
  installer: string;
  /** One line on what fails without it. */
  withoutIt: string;
}

/** Where the pieces live on this host. Each field is resolved by the caller, never read here. */
export interface HostPieceContext {
  /** The service account's home directory. */
  home: string;
  /** `$XDG_CONFIG_HOME` when set; otherwise `<home>/.config` is used. */
  configHome?: string;
  /** The fleet state root, the state directory deploy/install-host-units.sh is given. */
  stateRoot: string;
  /** Where deploy/install-host-units.sh writes its scripts; `/usr/local/bin` by default. */
  binDir?: string;
  /** The converged fleet checkout that owns the heartbeat and reclaim cron scripts. */
  fleetInstallDir?: string;
  /** The installed six-hour cleanup script; defaults to `<home>/rmd-host-cleanup.sh`. */
  cleanupPath?: string;
  /** The installed temporary sweep script; defaults beside the cleanup script. */
  tmpSweepPath?: string;
}

const HOST_UNITS_INSTALLER = "sudo deploy/install-host-units.sh --install";
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Every piece on every platform, before the platform filter. */
export function allHostPieces(ctx: HostPieceContext): HostPiece[] {
  const config = ctx.configHome ?? join(ctx.home, ".config");
  const bin = ctx.binDir ?? "/usr/local/bin";
  const fleetInstall = ctx.fleetInstallDir ?? join(ctx.stateRoot, "daemon-install");
  const cleanupPath = ctx.cleanupPath ?? join(ctx.home, "rmd-host-cleanup.sh");
  const tmpSweepPath = ctx.tmpSweepPath ?? join(dirname(cleanupPath), "rmd-tmp-sweep.sh");
  return [
    {
      id: "dependency-tool",
      platforms: ["linux", "darwin"],
      path: join(ctx.home, ".local", "bin", "remudero-dependencies"),
      installer: "bash deploy/install-dependency-seeds.sh",
      withoutIt: "a new worktree gets no linked dependencies and the janitor's seed sweep reports command not found",
    },
    {
      id: "gh-broker-unit",
      platforms: ["linux"],
      path: join(config, "systemd", "user", "remudero-gh-read-broker.service"),
      installer: "deploy/install-gh-read-broker.sh --install",
      withoutIt: "the GitHub read broker does not start, so every session falls back to the 180 s read floor",
    },
    {
      id: "gh-broker-launcher",
      platforms: ["linux"],
      path: join(config, "remudero", "gh-broker-start.sh"),
      installer: "deploy/install-gh-read-broker.sh --install",
      withoutIt: "the broker unit's ExecStart is missing, so the broker restarts in a loop",
    },
    {
      id: "gh-broker-agent",
      platforms: ["darwin"],
      path: join(ctx.home, "Library", "LaunchAgents", "com.remudero.gh-read-broker.plist"),
      installer: "deploy/mac/install-gh-read-broker.sh",
      withoutIt: "launchd does not keep this account's GitHub read broker running",
    },
    {
      id: "field-trials-script",
      platforms: ["linux"],
      path: join(ctx.home, ".local", "bin", "rmd-field-trials-refresh"),
      installer: "deploy/install-field-trials-refresh.sh --install",
      withoutIt: "the daily Field Trials refresh cron reports command not found",
    },
    {
      id: "daemon-launcher",
      platforms: ["linux"],
      path: join(ctx.home, "rmd-relaunch.sh"),
      installer: HOST_UNITS_INSTALLER,
      withoutIt: "rmd-fleet.service and the watchdog timer cannot start the daemon after a reboot or a crash",
    },
    {
      id: "heartbeat-script",
      platforms: ["linux"],
      path: join(fleetInstall, "scripts", "fleet-heartbeat.sh"),
      installer: `git -C ${shellQuote(fleetInstall)} restore -- scripts/fleet-heartbeat.sh`,
      withoutIt: "the five-minute heartbeat cron pushes no beat, so the host looks dead to fleet-heartbeat-watch",
    },
    {
      id: "reclaim-script",
      platforms: ["linux"],
      path: join(fleetInstall, "deploy", "host-update.sh"),
      installer: `git -C ${shellQuote(fleetInstall)} restore -- deploy/host-update.sh`,
      withoutIt: "the daily reclaim cron takes no off-host state snapshot",
    },
    {
      id: "host-cleanup-script",
      platforms: ["linux"],
      path: cleanupPath,
      installer: HOST_UNITS_INSTALLER,
      withoutIt: "the six-hour janitor cron cannot reclaim disk space",
    },
    {
      id: "tmp-sweep-script",
      platforms: ["linux"],
      path: tmpSweepPath,
      installer: HOST_UNITS_INSTALLER,
      withoutIt: "the hourly temp sweep cannot reclaim stale temporary files",
    },
    {
      id: "reap-stray-script",
      platforms: ["linux"],
      path: join(bin, "rmd-reap-stray-containers"),
      installer: HOST_UNITS_INSTALLER,
      withoutIt: "rmd-reap-stray.timer fails, and a leaked container can hold the host's CPU",
    },
    {
      id: "session-reaper-script",
      platforms: ["linux"],
      path: join(bin, "rmd-session-reaper"),
      installer: HOST_UNITS_INSTALLER,
      withoutIt: "rmd-session-reaper.timer fails, and closed sessions leak processes toward SessionsMax",
    },
    {
      id: "acr-login-script",
      platforms: ["linux"],
      path: join(bin, "acr-login.sh"),
      installer: HOST_UNITS_INSTALLER,
      withoutIt: "rmd-acr-login.timer fails, so the registry login expires and image pulls are refused",
    },
    {
      id: "github-login",
      platforms: ["linux"],
      path: join(ctx.home, ".gh-token"),
      installer: "gh auth login, then: umask 077; gh auth token > ~/.gh-token",
      withoutIt: "the heartbeat cron and host cleanup have no GitHub token, so their GitHub calls are refused",
    },
    {
      id: "github-login",
      platforms: ["darwin"],
      path: join(config, "gh", "hosts.yml"),
      installer: "gh auth login",
      withoutIt: "gh has no stored login, so this account's GitHub reads are refused",
    },
  ];
}

/** The pieces that apply on `platform`. Any other platform, such as win32, gets an empty list. */
export function hostPieces(platform: string, ctx: HostPieceContext): HostPiece[] {
  return allHostPieces(ctx).filter((p) => (p.platforms as readonly string[]).includes(platform));
}
