import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, parse } from "node:path";

export interface FixtureDuCall {
  argv: string[];
  requested: string | null;
  resolved: string | null;
  allowed: boolean;
  status: number | null;
  signal?: string | null;
  error?: string;
}

/** Test-only namespace boundary, not a fake reading or a security sandbox. The unmodified beat
 * still requests its production paths; only real directories owned by this fixture reach native du.
 * Resolve the native executable before PATH is shadowed, and reject symlink escapes and extra flags
 * (notably -L). Default du does not follow symlinks within the approved directory either. */
export function installFixtureDuGuard(binDir: string, roots: readonly string[]) {
  if (roots.length === 0) throw new Error("fixture du requires an owned namespace");
  const namespaces = roots.map(root => {
    if (!isAbsolute(root)) throw new Error("fixture du namespace must be absolute");
    const resolved = realpathSync(root);
    if (resolved === parse(resolved).root || !statSync(resolved).isDirectory()) {
      throw new Error("fixture du namespace must be a non-root directory");
    }
    return resolved;
  });
  const native = spawnSync("sh", ["-c", "command -p -v du"], { encoding: "utf8" });
  if (native.status !== 0 || !isAbsolute(native.stdout.trim())) {
    throw new Error(`native du is unavailable: ${native.error ?? native.stderr}`);
  }
  const path = join(binDir, "du"), callsPath = join(binDir, "fixture-du-calls.ndjson");
  const config = { namespaces, native: realpathSync(native.stdout.trim()), callsPath };
  writeFileSync(callsPath, "", { flag: "wx", mode: 0o600 });
  writeFileSync(path, String.raw`#!${process.execPath}
"use strict";
const { spawnSync } = require("node:child_process");
const { appendFileSync, realpathSync } = require("node:fs");
const { isAbsolute, relative, sep } = require("node:path");
const config = ${JSON.stringify(config)};
const argv = process.argv.slice(2);
const call = { argv, requested: argv[1] ?? null, resolved: null, allowed: false, status: 1 };
const record = () => appendFileSync(config.callsPath, JSON.stringify(call) + "\n");
const refuse = reason => {
  call.error = reason;
  record();
  process.stderr.write(reason + "\n");
  process.exit(1);
};
if (argv.length !== 2 || argv[0] !== "-sk" || !isAbsolute(argv[1])) {
  refuse("fixture du accepts only -sk and one absolute path");
}
try { call.resolved = realpathSync(argv[1]); }
catch (error) { refuse("cannot resolve fixture measurement: " + error.message); }
call.allowed = config.namespaces.some(root => {
  const child = relative(root, call.resolved);
  return child === "" || (child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child));
});
if (!call.allowed) refuse("outside fixture namespace: " + argv[1]);
const result = spawnSync(config.native, ["-sk", call.resolved], {
  encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
});
call.status = result.status;
call.signal = result.signal;
if (result.error) call.error = result.error.message;
record();
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) process.stderr.write(result.error.message + "\n");
process.exit(result.status ?? 1);
`, { flag: "wx", mode: 0o700 });
  return {
    path, callsPath,
    calls: (): FixtureDuCall[] => readFileSync(callsPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)),
  };
}
