import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireTestSlot, resolveTestSlotDir, testSlotHasAncestor, testSlotProcessFacts, TEST_SLOT_PARENT_ENV } from "../src/lib/test-slot.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const probe = `
  import { acquireTestSlot } from './src/lib/test-slot.ts';
  const logs=[];
  const lease=acquireTestSlot('real-nested-child',{slots:1,waitBoundMs:0,log:line=>logs.push(JSON.parse(line))});
  lease.refresh(); lease.release();
  console.log(JSON.stringify({outcome:lease.outcome,note:lease.note,concurrency:lease.concurrency,logs}));
`;
function child(environment: NodeJS.ProcessEnv) {
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
    cwd: ROOT, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, ...environment, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: "" },
  }));
}
function owner(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-static-slot-owner-"));
  const lease = acquireTestSlot("actual-owner", { dir, slots: 1 });
  t.after(() => { lease.release(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(lease.outcome, "acquired");
  assert.ok(lease.childEnvironment, "actual kernel process identity is required");
  const claim = JSON.parse(lease.childEnvironment[TEST_SLOT_PARENT_ENV]!);
  const bytes = readFileSync(claim.path, "utf8");
  return { dir, lease, claim, bytes };
}

test("author static admission: real child and grandchild borrow one live owner without releasing it", (t) => {
  const { dir, lease, bytes, claim } = owner(t);
  const result = child(lease.childEnvironment!);
  assert.equal(result.outcome, "acquired");
  assert.match(result.note, /inherited live parent test slot/);
  assert.equal(result.concurrency, lease.concurrency);
  assert.deepEqual(result.logs, []);
  assert.equal(readFileSync(claim.path, "utf8"), bytes);
  const grandchild = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { execFileSync } from 'node:child_process';
    process.stdout.write(execFileSync(process.execPath, ${JSON.stringify(["--import", "tsx", "--input-type=module", "-e", probe])}, {encoding:'utf8'}));
  `], { cwd: ROOT, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, ...lease.childEnvironment, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: "" } });
  assert.match(JSON.parse(grandchild).note, /inherited live parent test slot/);
  assert.deepEqual(readdirSync(dir), ["slot-1.json"]);
  assert.equal(readFileSync(claim.path, "utf8"), bytes);
});

test("author static admission: malformed, wrong-directory and unreadable claims never bypass contention", (t) => {
  const { lease, claim } = owner(t);
  const cases = [
    ["{", "unreadable-parent-claim"],
    ["null", "malformed-claim"],
    [JSON.stringify({ ...claim, path: claim.path + ".wrong" }), "malformed-claim"],
    [JSON.stringify({ ...claim, path: join(tmpdir(), "slot-1.json") }), "different-slot-directory"],
    [JSON.stringify({ ...claim, path: join(dirname(claim.path), "slot-9.json") }), "unreadable-parent-claim"],
    [JSON.stringify({ ...claim, nonce: "wrong" }), "different-holder"],
    [JSON.stringify({ ...claim, start: "wrong" }), "different-holder"],
    [JSON.stringify({ ...claim, concurrency: 0 }), "different-holder"],
  ];
  for (const [raw, reason] of cases) {
    const result = child({ ...lease.childEnvironment, [TEST_SLOT_PARENT_ENV]: raw });
    assert.equal(result.outcome, "wait_bound_exceeded", raw);
    assert.match(result.logs[0].reason, new RegExp(reason!));
    assert.ok(existsSync(claim.path), "a rejected child must preserve the real owner");
  }
});

test("author static admission: changed holder identity, host, nonce and malformed records are rejected", (t) => {
  const { lease, claim, bytes } = owner(t);
  const held = JSON.parse(bytes);
  const cases = [
    JSON.stringify({ ...held, ownerNonce: "replaced" }),
    JSON.stringify({ ...held, host: "foreign-owner" }),
    JSON.stringify({ ...held, concurrency: 0 }),
    JSON.stringify({ ...held, pid: held.pid + 1 }),
    "null", "{}", "{",
  ];
  for (const raw of cases) {
    writeFileSync(claim.path, raw);
    const result = child(lease.childEnvironment!);
    assert.ok(result.logs.some((row: { step: string; reason?: string }) =>
      row.step === "test_slot.parent_rejected" && row.reason === "different-holder"));
    assert.doesNotMatch(result.note, /inherited/);
    writeFileSync(claim.path, bytes);
  }
});

test("author static admission: an old start identity cannot borrow a reused owner PID", (t) => {
  const { lease, claim, bytes } = owner(t);
  writeFileSync(claim.path, JSON.stringify({ ...JSON.parse(bytes), processStart: "old-process-start" }));
  const result = child({ ...lease.childEnvironment, [TEST_SLOT_PARENT_ENV]: JSON.stringify({ ...claim, start: "old-process-start" }) });
  assert.equal(result.outcome, "wait_bound_exceeded");
  assert.equal(result.logs[0].reason, "dead-or-reused-owner");
  writeFileSync(claim.path, bytes);
});

test("author static admission: a real sibling is not an ancestor and cannot borrow another owner's slot", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-static-slot-sibling-"));
  const script = `
    import { acquireTestSlot } from './src/lib/test-slot.ts';
    const lease=acquireTestSlot('sibling-owner',{slots:1});
    console.log(JSON.stringify(lease.childEnvironment));
    process.stdin.resume(); process.stdin.on('end',()=>{lease.release();process.exit(0)});
  `;
  const peer = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: ROOT, env: { ...process.env, RMD_TEST_SLOT_DIR: dir, NODE_TEST_CONTEXT: undefined,
      [TEST_SLOT_PARENT_ENV]: undefined, NODE_V8_COVERAGE: "" }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { peer.stdin.end(); if (peer.exitCode === null) peer.kill(); rmSync(dir, { recursive: true, force: true }); });
  const environment = await new Promise<NodeJS.ProcessEnv>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("real sibling failed to acquire private slot")), 10_000);
    peer.once("error", reject); peer.stdout.on("data", (data) => {
      output += String(data); if (output.includes("\n")) { clearTimeout(timeout); resolve(JSON.parse(output.split("\n")[0]!)); }
    });
  });
  const result = child(environment);
  assert.equal(result.outcome, "wait_bound_exceeded");
  assert.equal(result.logs[0].reason, "owner-is-not-an-ancestor");
  assert.ok(existsSync(join(dir, "slot-1.json")));
});

test("author static admission: release never removes a replacement nonce and suite fixtures remain private", (t) => {
  const { lease, claim, bytes, dir } = owner(t);
  writeFileSync(claim.path, JSON.stringify({ ...JSON.parse(bytes), ownerNonce: "replacement" }));
  lease.release();
  assert.ok(existsSync(claim.path));
  const isolated = resolveTestSlotDir({ ...lease.childEnvironment, NODE_TEST_CONTEXT: "child" });
  assert.equal(isolated.scope, "test-process");
  assert.notEqual(isolated.dir, dir);
});

test("author static admission: kernel identity has real defaults and unknown facts never certify an owner", () => {
  assert.ok(testSlotProcessFacts(process.pid)?.start);
  assert.equal(testSlotProcessFacts(-1), undefined);
  assert.equal(testSlotProcessFacts(2_000_000_000), undefined);
  const tail = ["S", "1", ...Array(17).fill("0"), "123"];
  assert.deepEqual(testSlotProcessFacts(5, () => `5 (contains ) spaces) ${tail.join(" ")}`, () => { throw Error("not ps"); }),
    { start: "proc:123", parent: 1 });
  assert.deepEqual(testSlotProcessFacts(5, () => "bad proc", () => " 1 Mon Oct 5 00:00:00 2026\n"),
    { start: "ps:Mon Oct 5 00:00:00 2026", parent: 1 });
  assert.equal(testSlotProcessFacts(5, () => { throw Error("no proc"); }, () => "bad ps"), undefined);
  assert.equal(testSlotHasAncestor(1, 2_000_000_000), false, 'an unknown real process never certifies ancestry');
  assert.equal(testSlotHasAncestor(7, 3, () => ({ parent: 3, start: 'loop' })), false);
  assert.equal(testSlotHasAncestor(7, 1000, (pid) => ({ parent: pid + 1, start: 'unbounded' })), false);
});
