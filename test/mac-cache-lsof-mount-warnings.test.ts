/**
 * deploy/mac/cache-reclaim.py — an lsof warning about an unrelated mount is not activity.
 *
 * 2026-10-28: another account's CoreDevice DeviceFS made lsof warn on every call, and the
 * artifact cleaner read any stderr as "cwd-query-unavailable", so idle node_modules stayed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "deploy", "mac", "cache-reclaim.py");

function unexplained(stderr: string, path: string): boolean {
  const r = spawnSync("python3", ["-c",
    "import runpy,sys; ns=runpy.run_path(sys.argv[1]); print(ns['lsof_stderr_unexplained'](sys.argv[2], ns['Path'](sys.argv[3])))",
    SCRIPT, stderr, path], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() === "True";
}

function inactivity(stderr: string, query: "cwd" | "open"): string {
  const program = String.raw`import runpy,sys,os,types
ns=runpy.run_path(sys.argv[1]);workspace=ns['Path']('/Users/me/work/ws')
def command(argv):
 if argv[0]=='ps':
  return types.SimpleNamespace(returncode=0,stdout=f'{os.getpid()} python\n',stderr='')
 if 'cwd' in argv:
  return types.SimpleNamespace(returncode=0,stdout=f'p{os.getpid()}\nn{ns["Path"].cwd()}\n',stderr=sys.argv[2] if sys.argv[3]=='cwd' else '')
 if '+D' in argv:
  return types.SimpleNamespace(returncode=1,stdout='',stderr=sys.argv[2] if sys.argv[3]=='open' else '')
 return types.SimpleNamespace(returncode=0,stdout='n'+sys.argv[1]+'\n',stderr='')
ns['inactive'].__globals__['command']=command
try:
 ns['inactive'](workspace,ns['Path'](sys.argv[1]))
except ns['Hold'] as error:
 print(str(error))
else:
 print('inactive')
`;
  const result = spawnSync("python3", ["-c", program, SCRIPT, stderr, query], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const details = [
  "      Output information may be incomplete.",
  '      assuming "dev=30000004" from mount table',
];

const warning = (mount: string) => [
  `lsof: WARNING: can't stat() devicefs file system ${mount}`,
  ...details,
].join("\n");

test("a can't-stat warning for a mount elsewhere leaves the workspace verifiable", () => {
  assert.equal(unexplained(warning("/Users/other/Library/Developer/CoreDevice/DeviceFS"), "/Users/me/work/ws"), false);
  assert.equal(unexplained("", "/Users/me/work/ws"), false);
  for (const query of ["cwd", "open"] as const) {
    assert.equal(inactivity(warning("/elsewhere"), query), "inactive");
  }
});

test("a mount inside or above the workspace, or any other message, still holds it", () => {
  assert.equal(unexplained(warning("/Users/me/work/ws/v"), "/Users/me/work/ws"), true);
  assert.equal(unexplained(warning("/Users/me"), "/Users/me/work/ws"), true);
  assert.equal(unexplained("lsof: WARNING: something else", "/Users/me/work/ws"), true);
  assert.equal(unexplained(warning("/elsewhere") + "\nlsof: status error on /x", "/Users/me/work/ws"), true);
  for (const diagnostic of [...details, details.join("\n")]) {
    assert.equal(unexplained(diagnostic, "/Users/me/work/ws"), true, diagnostic);
    assert.equal(unexplained(diagnostic + "\n" + warning("/elsewhere"), "/Users/me/work/ws"), true);
    assert.equal(unexplained(warning("/elsewhere") + "\n\n" + diagnostic, "/Users/me/work/ws"), true);
  }
});

test("standalone lsof continuation diagnostics hold both inactivity guards", () => {
  for (const query of ["cwd", "open"] as const) {
    const expected = query === "cwd" ? "cwd-query-unavailable" : "active-or-unknown-open-file";
    for (const diagnostic of [...details, details.join("\n")]) {
      assert.equal(inactivity(diagnostic, query), expected, `${query}: ${diagnostic}`);
    }
  }
});
