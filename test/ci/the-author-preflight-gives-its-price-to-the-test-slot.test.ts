import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

// @ts-expect-error This JavaScript CLI module has no declaration file; this test covers its runtime path.
import { main, priceSelection } from "#scripts/preflight-author.mjs";
import { parseTestSlotTicket, takeTestSlotTicket, testSlotQueueDir, type TestSlotTicket } from "#src/lib/test-slot-queue.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SUITES = ["test/leaf.test.ts"];
const selection = () => ({ fullRun: false, suites: SUITES, narrow: [], reasons: ["W1-T12061 fixture"] });

function fixture(t: TestContext) {
  const repo = gitRepo({ kind: "w1-t12061-author", seedCommit: false });
  t.after(() => repo.cleanup());
  const root = repo.dir;
  for (const path of ["test/setup", "src", "scripts", "coverage"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), `${process.versions.node}\n`);
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  const tsxTool = realpathSync(join(REPO_ROOT, "node_modules/.bin/tsx"));
  const dependencyDonor = dirname(dirname(dirname(tsxTool)));
  symlinkSync(dependencyDonor, join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json")));
  writeFileSync(join(root, "scripts/census-precheck.mjs"), "console.log('fixture census precheck passed');\n");
  writeFileSync(join(root, "scripts/lint-plan-offline.mjs"), "console.log('fixture plan lint passed');\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/run-task.ts"), "console.log('baseline');\n");
  writeFileSync(join(root, "test/leaf.test.ts"), "import { test } from 'node:test'; test('leaf', () => {});\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "test: baseline");
  repo.addRemote("origin", root);
  repo.git("checkout", "-b", "run-unfiled-w1-t12061-fixture");
  writeFileSync(join(root, "src/run-task.ts"), "console.log('changed');\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "fix: exercise author price handoff");
  return { root, receipt: () => JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8")) };
}

function slotDirectory(t: TestContext): string {
  const parent = mkdtempSync(join(tmpdir(), "rmd-w1-t12061-"));
  const dir = join(parent, "slots");
  mkdirSync(dir);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return dir;
}

test("W1-T11915 criterion 4: the production preflight prices its waiting ticket after it takes it", t => {
  const f = fixture(t), dir = slotDirectory(t);
  const expectedCostMs = priceSelection(SUITES, { files: {} }).costMs;
  let ticketAtStatic: TestSlotTicket | undefined;
  let nameAtStatic: string | undefined;
  const spawn = (file: string, args: string[], options: Parameters<typeof spawnSync>[2]) => {
    if (file === "git") return spawnSync(file, args, options);
    if (args.some(arg => arg.endsWith("census-precheck.mjs"))) return { status: 0, stdout: "fixture census precheck passed\n", stderr: "" };
    if (args.includes("preflight") && args.some(arg => arg.endsWith("src/run-task.ts"))) {
      const queueDir = testSlotQueueDir(dir);
      const name = (awaitlessReadNames(queueDir))[0];
      assert.ok(name, "the production preflight took its queue ticket before static work");
      nameAtStatic = name;
      ticketAtStatic = JSON.parse(readFileSync(join(queueDir, name), "utf8")) as TestSlotTicket;
      assert.equal(ticketAtStatic.costMs, expectedCostMs, "the queue ticket is priced before the static stage starts");
      return { status: 0, stdout: "fixture static preflight passed\n", stderr: "" };
    }
    if (args.includes("--test") && args.includes("test/leaf.test.ts")) return spawnSync(file, args, options);
    return { status: 0, stdout: "fixture step passed\n", stderr: "" };
  };
  const exitCode = main([], {
    root: f.root,
    select: selection,
    host: () => ({ cores: 8, load1: 0, headroomBytes: 32 * 1024 ** 3 }),
    spawn,
    testSlot: { dir, queue: true, slots: 1, waitBoundMs: 0, pollMs: 5, log: () => {} },
  });

  assert.equal(exitCode, 0, JSON.stringify(f.receipt()));
  assert.equal(f.receipt().capacity.costMs, expectedCostMs, "the capacity verdict records the same price");
  assert.equal(f.receipt().suiteQueue.ticketed, true);
  assert.ok(ticketAtStatic);
  assert.ok(nameAtStatic);
  assert.equal(existsSync(join(testSlotQueueDir(dir), nameAtStatic!)), false, "admission later drops the same ticket");
});

test("W1-T11915 criterion 4: setting a price does not change ticket identity and heartbeat preserves it", t => {
  const parent = mkdtempSync(join(tmpdir(), "rmd-w1-t12061-ticket-"));
  const dir = join(parent, "slots");
  mkdirSync(dir);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const arrivedAt = new Date(Date.now() - 10_000).toISOString();
  const ticket = takeTestSlotTicket(dir, { pid: process.pid, host: "w1-t12061-test", label: "preflight", arrivedAt,
    heartbeatAt: arrivedAt, heartbeatIntervalMs: 5 });
  const name = ticket.name;
  const price = 12_345;

  ticket.setPrice(price);
  const priced = JSON.parse(readFileSync(ticket.path, "utf8")) as TestSlotTicket;
  assert.equal(ticket.name, name);
  assert.equal(priced.arrivedAt, arrivedAt, "pricing does not reset the arrival clock");
  assert.equal(priced.costMs, price);
  ticket.beat(new Date(Date.now()).toISOString());
  const beaten = JSON.parse(readFileSync(ticket.path, "utf8")) as TestSlotTicket;
  assert.equal(beaten.costMs, price, "the heartbeat writes the updated ticket record");
  assert.equal(beaten.arrivedAt, arrivedAt);
  const malformedPrice = parseTestSlotTicket(JSON.stringify({ ...beaten, costMs: Number.NaN }));
  assert.ok(malformedPrice, "a malformed optional price does not make the ticket malformed");
  assert.equal(malformedPrice.costMs, undefined, "a malformed price is treated as unpriced");
  ticket.drop();
});

function awaitlessReadNames(queueDir: string): string[] {
  return readdirSync(queueDir).filter(name => name.endsWith(".json") && !name.startsWith("."));
}
