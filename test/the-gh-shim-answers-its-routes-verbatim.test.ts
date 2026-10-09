import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
});
