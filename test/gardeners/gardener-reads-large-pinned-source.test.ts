import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readFixLaneEvidence } from "#src/lib/fix-lane-gardener.js";
import { ghShim } from "#test/helpers/gh-shim.js";

test("the fix-lane gardener reads large source at its recorded blob and refuses unavailable evidence", async t => {
  const source = "// retained source\n".repeat(60_000);
  const sha = createHash("sha1").update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest("hex");
  const head = "c".repeat(40);
  const rows = [{ step: "fix.dispatch", head_sha: head, pr_number: 1,
    ci_failures: [{ check: "coverage-ratchet", signature: "diff-coverage: BLOCKED", logTail:
      "diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests\n  - src/run-task.ts:6" }] }];
  const shim = ghShim([
    { when: `contents/src/run-task.ts?ref=${head}`, stdout: JSON.stringify({ encoding: "none", content: "", sha, size: Buffer.byteLength(source) }) },
    { when: `git/blobs/${sha}`, stdout: JSON.stringify({ sha, encoding: "base64", content: Buffer.from(source).toString("base64") }) },
  ]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const saved = new Map(["PATH", "RMD_GH_CACHE_HOME", "RMD_GH_SHARED_READ_GAP_MS"].map(key => [key, process.env[key]]));
  process.env.PATH = `${shim.dir}:${process.env.PATH}`;
  process.env.RMD_GH_CACHE_HOME = join(shim.dir, "cache");
  process.env.RMD_GH_SHARED_READ_GAP_MS = "0";
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const read = () => readFixLaneEvidence({ owner: "acme", repo: "remudero" }, rows);
  const evidence = await read();
  assert.equal(evidence.readHeadSource!(head, "src/run-task.ts"), source);
  assert.equal(evidence.readHeadSource!("d".repeat(40), "src/run-task.ts"), undefined);
  assert.deepEqual(shim.calls(), [
    `api repos/acme/remudero/contents/src/run-task.ts?ref=${head}`,
    `api repos/acme/remudero/git/blobs/${sha}`,
  ]);
  for (const body of [
    { sha: "b".repeat(40), encoding: "base64", content: Buffer.from(source).toString("base64") },
    { sha, encoding: "none", content: "" },
    { sha, encoding: "base64" },
  ]) {
    shim.addRoute({ when: `git/blobs/${sha}`, stdout: JSON.stringify(body) });
    await assert.rejects(read, /fix-lane source (blob identity mismatch|unreadable)/);
  }
  shim.addRoute({ when: `git/blobs/${sha}`, stderr: "fixture blob denied", exit: 1 });
  await assert.rejects(read, /fixture blob denied/);
  for (const body of [{ encoding: "none", sha: "invalid" }, { encoding: "none" }, {}]) {
    shim.addRoute({ when: "contents/", stdout: JSON.stringify(body) });
    await assert.rejects(read, /fix-lane source unreadable/);
  }
});
