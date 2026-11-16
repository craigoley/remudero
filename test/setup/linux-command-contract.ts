/**
 * test/setup/linux-command-contract.ts — the Linux command contract for suites that run a Linux host
 * script on a Mac (W1-T13051).
 *
 * INCIDENT, measured 2026-11-16 on the operator Mac: macOS `chmod` reads `--` as a file name
 * (`chmod: --: No such file or directory`), where GNU `chmod` reads it as the end of options.
 * `snapshot_container_config` in deploy/host-update.sh calls `chmod 700 -- <dir>`. The script runs on
 * Linux in production, so hosted CI was green, while 9 of the 36 suites that run it failed on every Mac
 * author preflight that selected them (22 tests). One suite carried a private stub; the rest had none.
 *
 * Fix: rather than a stub per suite, every test process on macOS gets one directory on PATH, ahead of the platform's own, whose
 * `chmod` honours the marker. Suites build a child's PATH from `process.env.PATH`, so present and future
 * suites inherit it. Loaded by test/setup/tmp-hygiene.ts, which every runner invocation already imports.
 *
 * The shim is faithful to what the marker means: it drops the first bare `--`, and an operand after it
 * that begins with `-` is passed as `./<operand>`, so it is still read as a path. Everything else,
 * the real command's exit status and its error text included, passes through.
 *
 * Add a command here only when a difference has been measured; this file is the one place for it.
 */
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reapDeadOwnerDirs, setupDirOwnerTag } from "#test/setup/no-live-remote.js";

/** The contract directory's name prefix. The owning pid follows it, so a later test process can remove
 *  the directory a killed one left (see `reapDeadOwnerDirs`). */
export const LINUX_CONTRACT_DIR_PREFIX = "rmd-test-linux-contract-";

/** Every command the contract directory shadows on macOS, and nothing else may be in it. */
export const LINUX_CONTRACT_COMMANDS: readonly string[] = ["chmod"];

/** The `chmod` shim's text. `realChmod` is the platform's own binary, named by absolute path so the
 *  shim can never find itself on PATH. */
export function chmodShimSource(realChmod = "/bin/chmod"): string {
  return [
    "#!/bin/bash",
    "# W1-T13051: macOS chmod reads `--` as a file name; GNU chmod reads it as the end of options.",
    "args=()",
    "seen=0",
    'for arg in "$@"; do',
    '  if [ "$seen" = 0 ] && [ "$arg" = "--" ]; then seen=1; continue; fi',
    '  if [ "$seen" = 1 ]; then case "$arg" in -*) arg="./$arg" ;; esac; fi',
    '  args+=("$arg")',
    "done",
    `exec ${realChmod} "\${args[@]}"`,
    "",
  ].join("\n");
}

export interface LinuxCommandContract {
  installed: boolean;
  /** The directory put on PATH ahead of the platform's own; absent when nothing was installed. */
  dir?: string;
}

export interface LinuxCommandContractDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Creates the directory. The default is `fs.mkdtempSync` read at call time, so the exit sweep that
   *  test/setup/tmp-hygiene.ts wraps around it removes the directory with every other fixture. */
  mkdtemp?: (prefix: string) => string;
}

/** On macOS, put a directory holding the shims first on `env.PATH`. Anywhere else, do nothing at all. */
export function installLinuxCommandContract(deps: LinuxCommandContractDeps = {}): LinuxCommandContract {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return { installed: false };
  const env = deps.env ?? process.env;
  if (deps.mkdtemp === undefined) reapDeadOwnerDirs(LINUX_CONTRACT_DIR_PREFIX);
  const mkdtemp = deps.mkdtemp ?? ((prefix: string) => fs.mkdtempSync(prefix));
  const dir = mkdtemp(join(tmpdir(), `${LINUX_CONTRACT_DIR_PREFIX}${setupDirOwnerTag()}`));
  fs.writeFileSync(join(dir, "chmod"), chmodShimSource(), { mode: 0o755 });
  env.PATH = `${dir}:${env.PATH ?? ""}`;
  return { installed: true, dir };
}
