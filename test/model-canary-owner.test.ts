import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { CanarySlotOwner } from "../src/lib/model-canary-owner.js";
import { buildCanarySchedule, type CanarySlot, type CanarySchedulePorts } from "../src/lib/model-canary-schedule.js";
import { commonCanarySuite, canarySuiteDigest } from "../src/lib/model-canary-suite.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

type Outcome = Parameters<CanarySchedulePorts["terminal"]>[1];
function slots() {
  const cases = commonCanarySuite().slice(0, 2);
  return buildCanarySchedule("2026-10-11", "shared-owner", cases,
    [{ model: "test-model", route: "test-route", effort: "medium", suiteHash: canarySuiteDigest(cases), billing: "subscription" }]).slots;
}
function outcome(slot: CanarySlot): Outcome {
  return { state: "unavailable", reason: "transport-error", trace: [], grade: null,
    error: new Error("must-not-retain-arbitrary-error"), run: {
      id: "test-run", caseId: slot.caseId, suiteHash: slot.pin.suiteHash, model: slot.pin.model,
      route: slot.pin.route, effort: slot.pin.effort, family: "structured", verified: null,
      totalDurationMs: 1, attempts: [], outcomeReason: "transport-error" } };
}
function fixture(action: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-owner-`));
  try { action(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("canary durable owner serializes different slots and retains terminal identity without arbitrary transport errors", () => fixture(dir => {
  const [a, b] = slots(), first = new CanarySlotOwner(dir), second = new CanarySlotOwner(dir);
  try {
    assert.equal(first.claim(a), "claimed");
    assert.equal(second.claim(a), "already-owned-or-terminal");
    assert.throws(() => second.claim(b), /busy-or-capacity/);
    assert.throws(() => second.terminal(a, outcome(a)), /terminal-not-owned/);
    first.terminal(a, outcome(a));
    assert.equal(second.claim(a), "already-owned-or-terminal");
    assert.equal(second.claim(b), "claimed"); second.terminal(b, outcome(b));
    assert.throws(() => first.terminal(a, outcome(a)), /terminal-not-owned/);
    const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT phase,receipt FROM canary_slots_v1").all();
      assert.equal(rows.length, 2); assert.ok(rows.every(r => r.phase === "terminal"));
      assert.ok(rows.every(r => !String(r.receipt).includes("must-not-retain-arbitrary-error")));
      assert.equal(JSON.parse(String(rows[0].receipt)).state, "unavailable");
    } finally { db.close(); }
    assert.equal(statSync(join(dir, "model-canary-slots.sqlite")).mode & 0o777, 0o600);
  } finally { first.close(); second.close(); }
}));

test("canary durable owner refuses changed slot pins and mismatched or oversized terminal records while retaining the claim", () => fixture(dir => {
  const [a, b] = slots(), owner = new CanarySlotOwner(dir);
  try {
    assert.throws(() => owner.claim({ ...a, id: "../escape" }), /slot-invalid/);
    assert.equal(owner.claim(a), "claimed");
    assert.throws(() => owner.claim({ ...a, pin: { ...a.pin, model: "changed" } }), /identity-conflict/);
    const wrong = outcome(a); wrong.run.model = "other";
    assert.throws(() => owner.terminal(a, wrong), /terminal-identity-invalid/);
    const huge = outcome(a); huge.reason = "x".repeat(128 * 1024);
    assert.throws(() => owner.terminal(a, huge), /receipt-bound/);
    assert.throws(() => owner.claim(b), /busy-or-capacity/);
    owner.terminal(a, outcome(a));
  } finally { owner.close(); }
}));

test("canary durable owner keeps a crashed real child claim held across a new process and a new instance", () => fixture(dir => {
  const [a, b] = slots();
  const script = `import {CanarySlotOwner} from './src/lib/model-canary-owner.ts';
    const owner=new CanarySlotOwner(process.argv[1]); console.log(owner.claim(JSON.parse(process.argv[2]))); process.exit(7);`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, dir, JSON.stringify(a)],
    { encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 7, child.stderr); assert.equal(child.stdout.trim(), "claimed");
  const restarted = new CanarySlotOwner(dir);
  try {
    assert.equal(restarted.claim(a), "already-owned-or-terminal");
    assert.throws(() => restarted.claim(b), /busy-or-capacity/);
    assert.throws(() => restarted.terminal(a, outcome(a)), /terminal-not-owned/);
  } finally { restarted.close(); }
}));

test("canary durable owner admits exactly one of concurrent real native children", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}canary-owner-race-`)), [a] = slots();
  try {
    // Initialize schema first; each competing child still opens its own real SQLite connection.
    new CanarySlotOwner(dir).close();
    const script = `import {CanarySlotOwner} from './src/lib/model-canary-owner.ts';
      const owner=new CanarySlotOwner(process.argv[1]); console.log(owner.claim(JSON.parse(process.argv[2]))); owner.close();`;
    const results = await Promise.all(Array.from({ length: 3 }, () => new Promise<string>((done, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, dir, JSON.stringify(a)], { timeout: 15_000 });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
      child.on("error", reject); child.on("close", code => code === 0 ? done(stdout.trim()) : reject(new Error(stderr)));
    })));
    assert.equal(results.filter(r => r === "claimed").length, 1);
    assert.equal(results.filter(r => r === "already-owned-or-terminal").length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("canary durable owner refuses public git symlinked and nonprivate directories", () => fixture(dir => {
  const shared = join(dir, "shared"), linked = join(dir, "linked"), repo = join(dir, "repo");
  mkdirSync(shared, { mode: 0o700 }); symlinkSync(shared, linked);
  assert.throws(() => new CanarySlotOwner(linked), /private-directory-required/);
  chmodSync(shared, 0o755); assert.throws(() => new CanarySlotOwner(shared), /private-directory-required/);
  mkdirSync(repo, { mode: 0o700 }); mkdirSync(join(repo, ".git"));
  assert.throws(() => new CanarySlotOwner(repo), /directory-inside-git/);
  assert.throws(() => new CanarySlotOwner(join(dir, "missing")), /ENOENT/);
}));

test("canary durable owner canonicalizes an ancestor alias while retaining private leaf ownership", () => fixture(dir => {
  const root = join(dir, "real"), alias = join(dir, "alias"), leaf = join(root, "private");
  mkdirSync(root, { mode: 0o700 }); mkdirSync(leaf, { mode: 0o700 }); symlinkSync(root, alias);
  const owner = new CanarySlotOwner(join(alias, "private"));
  try { assert.equal(owner.claim(slots()[0]), "claimed"); }
  finally { owner.close(); }
  assert.equal(statSync(join(leaf, "model-canary-slots.sqlite")).mode & 0o777, 0o600);
}));

test("canary durable owner preserves an actual invalid-schema initialization failure and closes its database", () => fixture(dir => {
  const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"));
  db.exec("CREATE TABLE canary_slots_v1(id TEXT PRIMARY KEY)"); db.close();
  assert.throws(() => new CanarySlotOwner(dir), /no such column/);
  const reopened = new DatabaseSync(join(dir, "model-canary-slots.sqlite"));
  try { assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM canary_slots_v1").get()?.n, 0); }
  finally { reopened.close(); }
}));

test("canary durable owner refuses a full real store without pretending the next slot already ran", () => fixture(dir => {
  new CanarySlotOwner(dir).close();
  const db = new DatabaseSync(join(dir, "model-canary-slots.sqlite"));
  db.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000)
    INSERT INTO canary_slots_v1(id,binding,owner,phase) SELECT CAST(i AS TEXT),'test','test','terminal' FROM n`);
  db.close();
  const owner = new CanarySlotOwner(dir);
  try { assert.throws(() => owner.claim(slots()[0]), /busy-or-capacity/); }
  finally { owner.close(); }
}));
