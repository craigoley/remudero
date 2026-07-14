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
  return parsed as Config;
}
