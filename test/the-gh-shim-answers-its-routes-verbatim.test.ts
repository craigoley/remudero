import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ghShim } from "./helpers/gh-shim.js";

function run(shim: { dir: string }, ...args: string[]) {
  return spawnSync("gh", args, {
    encoding: "utf8",
    env: { ...process.env, PATH: `${shim.dir}:${process.env.PATH}`, NAME: "expanded" },
  });
}

test("unit test: test/the-gh-shim-answers-its-routes-verbatim.test.ts", () => {
  const value = { body: "line one\nline two $NAME `echo hi` $(echo hi) back\\slash \"q\"" };
  const shim = ghShim([
    { when: "json", stdout: JSON.stringify(value), stderr: JSON.stringify({ err: value.body }), exit: 3 },
    { when: "plain", stdout: "hello" },
  ]);
  const r = run(shim, "json");
  assert.equal(r.status, 3);
  assert.deepEqual(JSON.parse(r.stdout), value);
  assert.deepEqual(JSON.parse(r.stderr), { err: value.body });
  assert.equal(r.stdout, `${JSON.stringify(value)}\n`);

  const p = run(shim, "plain");
  assert.equal(p.stdout, "hello\n");
  assert.equal(p.stderr, "");

  shim.addRoute({ when: "plain", stdout: "$NAME\\n" });
  assert.equal(run(shim, "plain").stdout, "$NAME\\n\n");
  assert.equal(run(shim, "json").stdout, `${JSON.stringify(value)}\n`);

  const envShim = ghShim([{ when: "env", stdoutEnv: "NAME" }]);
  assert.equal(run(envShim, "env").stdout, "expanded\n");
  assert.throws(() => envShim.addRoute({ when: "bad", stdoutEnv: "X; rm -rf /" }), /environment variable name/);
});

test("W1-T6107: a writes route leaves its file byte for byte, in a directory it creates, only when it matches", () => {
  const out = mkdtempSync(join(tmpdir(), "rmd-gh-shim-writes-"));
  try {
    const content = '{"format":"x","body":"$NAME `echo hi` back\\\\slash"}\n';
    const target = join(out, "nested", "map.json");
    const shim = ghShim([{ when: "run download", writes: { path: target, content } }]);
    assert.equal(run(shim, "run", "list").status, 0);
    assert.equal(existsSync(target), false, "an unmatched invocation writes nothing");
    const r = run(shim, "run", "download", "7", "-n", "artifact");
    assert.equal(r.status, 0);
    assert.equal(readFileSync(target, "utf8"), content);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
