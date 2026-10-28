/**
 * deploy/mac/cache-reclaim.py — an lsof warning about an unrelated mount is not activity.
 *
 * 2026-10-28: another account's CoreDevice DeviceFS made lsof warn on every call, and the
 * artifact cleaner read any stderr as "cwd-query-unavailable", so idle node_modules stayed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "mac", "cache-reclaim.py");

function unexplained(stderr: string, path: string): boolean {
  const r = spawnSync("python3", ["-c",
    "import runpy,sys; ns=runpy.run_path(sys.argv[1]); print(ns['lsof_stderr_unexplained'](sys.argv[2], ns['Path'](sys.argv[3])))",
    SCRIPT, stderr, path], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() === "True";
}

const warning = (mount: string) => [
  `lsof: WARNING: can't stat() devicefs file system ${mount}`,
  "      Output information may be incomplete.",
  '      assuming "dev=30000004" from mount table',
].join("\n");

test("a can't-stat warning for a mount elsewhere leaves the workspace verifiable", () => {
  assert.equal(unexplained(warning("/Users/other/Library/Developer/CoreDevice/DeviceFS"), "/Users/me/work/ws"), false);
  assert.equal(unexplained("", "/Users/me/work/ws"), false);
});

test("a mount inside or above the workspace, or any other message, still holds it", () => {
  assert.equal(unexplained(warning("/Users/me/work/ws/v"), "/Users/me/work/ws"), true);
  assert.equal(unexplained(warning("/Users/me"), "/Users/me/work/ws"), true);
  assert.equal(unexplained("lsof: WARNING: something else", "/Users/me/work/ws"), true);
  assert.equal(unexplained(warning("/elsewhere") + "\nlsof: status error on /x", "/Users/me/work/ws"), true);
});
