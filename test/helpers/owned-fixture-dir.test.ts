import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ownedFixtureDir, type FixtureScope } from "./owned-fixture-dir.js";
import { writeLedger } from "./ledger-fixture.js";
import { gitRepo } from "./git-repo.js";
import { fixtureRetentionReason } from "../setup/retained-fixtures.js";

test("owned fixtures release each completed test before the next allocation and keep suite scratch", async (t) => {
  const suite = ownedFixtureDir(t, "fixture-suite");
  let last: string | undefined;
  for (let i = 0; i < 12; i++) {
    if (last) assert.equal(existsSync(last), false);
    await t.test(`fixture ${i}`, (child) => {
      const fixture = ownedFixtureDir(child, "fixture-case");
      last = fixture.dir;
      writeFileSync(join(fixture.dir, "payload"), Buffer.alloc(64 * 1024));
      assert.ok(existsSync(suite.dir));
    });
  }
  assert.equal(existsSync(last!), false);
  assert.ok(existsSync(suite.dir));
});

function capturedScope() {
  let finish: () => unknown;
  const scope = { after: (fn: () => unknown) => { finish = fn; } } as FixtureScope;
  return { scope, finish: () => finish!() };
}

test("owned fixture disposal waits for registered writer closure and preserves rejected evidence", async () => {
  const first = capturedScope();
  const fixture = ownedFixtureDir(first.scope, "fixture-writer");
  let close!: () => void;
  fixture.until(new Promise<void>((resolve) => { close = resolve; }));
  const finishing = first.finish();
  await Promise.resolve();
  assert.ok(existsSync(fixture.dir));
  writeFileSync(join(fixture.dir, "last-write"), "closed");
  close(); await finishing;
  assert.equal(existsSync(fixture.dir), false);
  const second = capturedScope();
  const retained = ownedFixtureDir(second.scope, "fixture-rejected");
  const original = new Error("writer closure unproven");
  retained.until(Promise.reject(original));
  try {
    await assert.rejects(async () => second.finish(), (error) => error === original);
    assert.ok(existsSync(retained.dir));
    assert.match(fixtureRetentionReason(retained.dir)!, /closure/);
  } finally { rmSync(retained.dir, { recursive: true, force: true }); }
});

test("the real process-exit backstop preserves explicitly retained fixture evidence", () => {
  const script = `import {ownedFixtureDir} from './test/helpers/owned-fixture-dir.ts';
    const scope = {after() {}};
    const fixture = ownedFixtureDir(scope, 'fixture-exit-retain');
    fixture.retain('synthetic failure evidence');
    console.log(JSON.stringify({fixture:fixture.dir}));`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts", "--input-type=module", "-e", script],
    { cwd: process.cwd(), encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  const dir = (JSON.parse(output.trim()) as { fixture: string }).fixture;
  try { assert.ok(existsSync(dir), "the actual exit hook must not undo scoped retention"); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fixture retirement keeps retained evidence and refuses a replaced directory", async () => {
  const first = capturedScope(), fixture = ownedFixtureDir(first.scope, "fixture-retain");
  try {
    assert.throws(() => fixture.retain(" "), /reason/);
    fixture.retain("failure evidence"); await first.finish();
    assert.ok(existsSync(fixture.dir));
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
  const second = capturedScope(), changed = ownedFixtureDir(second.scope, "fixture-changed");
  const moved = `${changed.dir}-original`;
  renameSync(changed.dir, moved); mkdirSync(changed.dir);
  try {
    assert.notEqual(lstatSync(changed.dir).ino, lstatSync(moved).ino);
    await assert.rejects(async () => second.finish(), /identity changed/);
    assert.ok(existsSync(changed.dir)); assert.ok(existsSync(moved));
  } finally { rmSync(changed.dir, { recursive: true, force: true }); rmSync(moved, { recursive: true, force: true }); }
});

test("shared Git and ledger fixtures actually use their caller's lifetime", async (t) => {
  let gitDir = "", ledgerDir = "";
  await t.test("consumer", (scope) => {
    gitDir = gitRepo({ scope }).dir;
    ledgerDir = writeLedger([{ step: "fixture" }], { scope }).dir;
    assert.ok(existsSync(gitDir)); assert.ok(existsSync(ledgerDir));
  });
  assert.equal(existsSync(gitDir), false);
  assert.equal(existsSync(ledgerDir), false);
  const outer = ownedFixtureDir(t, "fixture-caller");
  await t.test("borrowed", (scope) => { writeLedger([], { dir: outer.dir, scope }); });
  assert.ok(existsSync(outer.dir), "a supplied shared path is never retired by the borrower");
});
