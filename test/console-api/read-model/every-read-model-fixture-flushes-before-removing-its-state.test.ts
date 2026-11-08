// W1-T11411: since the read-model transaction publisher became a worker thread (W1-T9501) it writes
// observation files into the state dir asynchronously, so a fixture that removes that dir before the
// publisher settles races it into ENOTEMPTY. flushReadModelTransactions() is the barrier; this census
// refuses any suite that opens the read model and removes a temp dir without the shared helper
// (test/helpers/read-model-fixture-dir.ts) or the flush barrier (an awaited flushReadModelTransactions). It carries no
// allowlist: a suite it names migrates.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { acquireLease, flushReadModelTransactions, openReadModel } from "#src/lib/read-model-db.js";
import { onReadModelClose, readModelFixtureDir } from "#test/helpers/read-model-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const OPENER = /\b(?:createReadModelTicker|createReadModelWorker|openReadModelDb)\b|read-model-db\.js/;
const REMOVAL = /\brmSync\(\s*[^()]*,\s*\{[^}]*recursive:\s*true/;
/** A non-import mention: the call, or the function bound as an injectable default (`settle = flushReadModelTransactions`). */
const FLUSH = /^(?!import\b).*\bflushReadModelTransactions\b/m;
const HELPER = /\breadModelFixtureDir\(/;

/** Names of the suites in `sources` that open the read model, remove a temp dir, and do neither safe thing. */
export function unflushedFixtures(sources: ReadonlyMap<string, string>): string[] {
  const refused: string[] = [];
  for (const [name, text] of sources) {
    if (!OPENER.test(text)) continue;
    if (!REMOVAL.test(text) || HELPER.test(text)) continue;
    if (!FLUSH.test(text)) refused.push(name);
  }
  return refused.sort();
}

function testSuites(dir = join(REPO_ROOT, "test")): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".test.ts") || entry.split("/").includes("node_modules")) continue;
    out.set(`test/${entry}`, readFileSync(join(dir, entry), "utf8"));
  }
  return out;
}

test("W1-T11411 census: every suite that opens the read model flushes the diagnostic publisher before removing its state", () => {
  const suites = testSuites();
  const opening = [...suites].filter(([, text]) => OPENER.test(text) && (REMOVAL.test(text) || HELPER.test(text)));
  const viaHelper = opening.filter(([, text]) => HELPER.test(text));
  // 119 suites open the read model and tear down a dir at the commit that landed this census; 90+ of them use the helper.
  assert.ok(opening.length >= 100, `the census must see the read-model population, saw ${opening.length}`);
  assert.ok(viaHelper.length >= 85, `the shared helper must carry the migrated suites, saw ${viaHelper.length}`);
  assert.deepEqual(unflushedFixtures(suites), [],
    "these suites remove their state dir without awaiting flushReadModelTransactions: use readModelFixtureDir from #test/helpers/read-model-fixture-dir.js");
});

test("W1-T11411 census: a planted fixture that removes its state dir without the barrier is caught, and the two safe shapes are not", () => {
  const rm = "t.after(() => rmSync(dir, { recursive: true, force: true }));";
  const open = 'import { createReadModelTicker } from "#src/lib/read-model-worker.js";';
  const sources = new Map([
    ["planted-violation", `${open}\n${rm}\n`],
    ["planted-flush-before", `${open}\nawait flushReadModelTransactions();\n${rm}\n`],
    ["planted-injected-flush", `${open}\nasync function retire(settle = flushReadModelTransactions) { await settle(); }\n${rm}\n`],
    ["planted-flush-only-imported", `import { flushReadModelTransactions } from "#src/lib/read-model-db.js";\n${open}\n${rm}\n`],
    ["planted-helper", `${open}\nconst { dir } = readModelFixtureDir(t, "k");\n${rm}\n`],
    ["planted-no-opener", `${rm}\n`],
    ["planted-no-removal", `${open}\n`],
  ]);
  assert.deepEqual(unflushedFixtures(sources), ["planted-flush-only-imported", "planted-violation"]);
});

test("the shared read-model fixture removes its state dir only after its closers ran in reverse order and the publisher flushed", async () => {
  const hooks: Array<() => unknown> = [];
  const scope = { after(fn: () => unknown) { hooks.push(fn); } } as Parameters<typeof readModelFixtureDir>[0];
  const { dir, onClose } = readModelFixtureDir(scope, "read-model-fixture-dir-lifecycle");
  const db = openReadModel({ stateDir: dir, instance: "core", schemaVersion: 1 });
  assert.equal(acquireLease(db, { holder: "lifecycle" }).ok, true);
  const order: string[] = [];
  onClose(() => { order.push(`first:${existsSync(dir)}`); });
  onClose(async () => { await turn(); order.push(`second:${existsSync(dir)}`); db.close(); });
  onReadModelClose(scope, () => { order.push(`third:${existsSync(dir)}`); });
  assert.equal(hooks.length, 1, "one teardown hook serves the dir and every closer");
  await hooks[0]!();
  assert.deepEqual(order, ["third:true", "second:true", "first:true"], "closers run last-registered first while the dir still exists");
  assert.equal(existsSync(dir), false);
  await flushReadModelTransactions();
  await turn();
  assert.equal(existsSync(dir), false, "the default publisher cannot recreate the removed state dir");
});

test("a failing closer does not stop the others and keeps the dir for evidence", async () => {
  const hooks: Array<() => unknown> = [];
  const scope = { after(fn: () => unknown) { hooks.push(fn); } } as Parameters<typeof readModelFixtureDir>[0];
  const { dir, onClose } = readModelFixtureDir(scope, "read-model-fixture-dir-failure");
  const original = new Error("closer failed");
  const ran: number[] = [];
  onClose(() => { ran.push(1); });
  onClose(() => { ran.push(2); throw original; });
  try {
    await assert.rejects(async () => hooks[0]!(), (error: unknown) => error instanceof AggregateError && error.errors.includes(original));
    assert.deepEqual(ran, [2, 1]);
    assert.equal(existsSync(dir), true);
  } finally {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  }
});

test("two failing closers surface together", async () => {
  const hooks: Array<() => unknown> = [];
  const scope = { after(fn: () => unknown) { hooks.push(fn); } } as Parameters<typeof readModelFixtureDir>[0];
  const { dir, onClose } = readModelFixtureDir(scope, "read-model-fixture-dir-two-failures");
  onClose(() => { throw new Error("a"); });
  onClose(() => { throw new Error("b"); });
  try {
    await assert.rejects(async () => hooks[0]!(), (error: unknown) => error instanceof AggregateError);
  } finally {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  }
});
