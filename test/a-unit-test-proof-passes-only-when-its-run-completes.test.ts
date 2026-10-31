// A `unit test:` proof passes only when every file it ran reached its own per-file summary.
//
// MEASURED 2026-10-12 on node 24.21: an isolated `node --test` run reports a file whose child exits 0
// part-way (a test calling the real `process.exit(0)`) as `ok N - <file>` with every test it would
// have run lost, prints the trailing `# duration_ms` summary, and exits 0. A file that registers no
// tests reads the same. execWhitelistedProof returned "pass" on both, so a proof whose third test
// would throw — or that tests nothing — was credited `executed_pass`. #10894/#10918 judged every CI
// and preflight runner by its per-file summaries; the review's proof runner now reuses that judge.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  execWhitelistedProof,
  execWhitelistedProofAsync,
  type AsyncProofSpawner,
  type ProofSpawner,
  type WhitelistedProof,
} from "#src/lib/review.js";

const dir = mkdtempSync(join(tmpdir(), "rmd-proof-judge-"));
after(() => rmSync(dir, { recursive: true, force: true }));
mkdirSync(join(dir, "test"));
const write = (name: string, body: string) => writeFileSync(join(dir, "test", name), `import test from "node:test";\n${body}`);
write(
  "exits-part-way.test.mjs",
  'test("judged proof first", () => {});\ntest("judged proof second", () => { process.exit(0); });\ntest("judged proof third", () => { throw new Error("never runs"); });\n',
);
write("exits-on-its-match.test.mjs", 'test("judged proof first", () => { process.exit(0); });\n');
write("registers-nothing.test.mjs", "");
write("complete.test.mjs", 'test("judged proof first", () => {});\ntest("judged proof other", () => {});\n');

// The real node runner, unsandboxed: the judge reads what node itself writes, so a canned stdout would prove nothing.
// NODE_TEST_CONTEXT is dropped as the production spawner's declared env drops it: inherited, it makes the nested
// `node --test` report to this runner instead of stdout.
const env = { ...process.env, NODE_TEST_CONTEXT: undefined };
const seenArgs: string[][] = [];
const realSpawn: ProofSpawner = (_command, args, cwd, timeoutMs) => {
  seenArgs.push([...args]);
  return execFileSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] });
};
const realSpawnAsync: AsyncProofSpawner = (_command, args, cwd, timeoutMs) =>
  new Promise((resolve, reject) =>
    execFile(process.execPath, args as string[], { cwd, env, encoding: "utf8", timeout: timeoutMs }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { status: typeof error.code === "number" ? error.code : null, stdout, stderr })) : resolve(stdout),
    ),
  );

const purePath = (file: string): WhitelistedProof => ({
  kind: "test",
  command: "node",
  args: ["--test", "--test-reporter=tap", file],
  label: file,
});
const nameFiltered = (name: string, files: string[]): WhitelistedProof => ({
  kind: "test",
  command: "node",
  args: ["--test", "--test-reporter=tap", "--test-name-pattern", name, ...files],
  label: name,
  nameFiltered: true,
});
const run = (proof: WhitelistedProof) => execWhitelistedProof(proof, dir, 60_000, realSpawn, { preparedArgs: proof.args });

test("a pure-path proof whose file exits 0 part-way is not a pass, and its failure names the unreported file", () => {
  const proof = purePath("test/exits-part-way.test.mjs");
  assert.equal(run(proof), "fail");
  assert.match(proof.failureOutput ?? "", /never reported \(first: test\/exits-part-way\.test\.mjs\)/);
});

test("a pure-path proof whose file registers no tests is not a pass", () => {
  assert.equal(run(purePath("test/registers-nothing.test.mjs")), "fail");
});

test("a name-filtered proof is not a pass when one of its candidate files exits 0 before its matches report", () => {
  const proof = nameFiltered("judged proof first", ["test/complete.test.mjs", "test/exits-on-its-match.test.mjs"]);
  assert.equal(run(proof), "fail");
  assert.match(proof.failureOutput ?? "", /exits-on-its-match\.test\.mjs/);
});

test("the asynchronous executor judges the same run the same way", async () => {
  const proof = purePath("test/exits-part-way.test.mjs");
  assert.equal(await execWhitelistedProofAsync(proof, dir, 60_000, realSpawnAsync, { preparedArgs: proof.args }), "fail");
});

test("a complete run still passes, pure-path and name-filtered, and the judge's reporter rode the argv", () => {
  seenArgs.length = 0;
  assert.equal(run(purePath("test/complete.test.mjs")), "pass");
  assert.equal(run(nameFiltered("judged proof first", ["test/complete.test.mjs"])), "pass");
  assert.equal(seenArgs.length, 2);
  for (const args of seenArgs) assert.ok(args.some((arg) => arg.startsWith("--test-reporter=data:")), args.join(" "));
});
