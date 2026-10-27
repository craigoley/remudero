// W1-T9951: an author preflight takes its suite ticket first, runs its static stage on a memory admission while
// that ticket waits, and admits its suites in queue order; a cold typecheck never waits on a suite slot or ticket.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { typecheckStep } from "#src/lib/commit-message.js";
import { acquireTestSlot } from "#src/lib/test-slot.js";
import { takeTestSlotTicket, testSlotQueueDir } from "#src/lib/test-slot-queue.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const GiB = 1024 ** 3;
const SLOT_MODULE = pathToFileURL(join(REPO_ROOT, "src/lib/test-slot.ts")).href;
const QUEUE_MODULE = pathToFileURL(join(REPO_ROOT, "src/lib/test-slot-queue.ts")).href;
const AUTHOR = pathToFileURL(join(REPO_ROOT, "scripts/preflight-author.mjs")).href;
const SUITE_LABEL = "preflight-author:static-and-affected";

type Receipt = {
  verdict: string; steps: { name: string }[]; testSlot?: { outcome: string };
  staticAdmission?: { outcome: string; waitedMs: number; note: string };
  suiteQueue?: { ticketed: boolean; positionAtEnqueue: number | null; outcome?: string; reason?: string; waitedMs?: number };
};
type Main = (argv: string[], deps: Record<string, unknown>) => number;

/** A private, configured slot dir (so the FIFO queue is on), restored after the test. */
function slotEnvironment(t: TestContext): string {
  const dir = join(mkdtempSync(join(tmpdir(), "rmd-w1-t9951-")), "slots");
  mkdirSync(dir);
  const keys = ["RMD_TEST_SLOT_DIR", "RMD_TEST_SLOTS", "RMD_TEST_SLOT_PARENT"] as const;
  const saved = keys.map(key => [key, process.env[key]] as const);
  process.env.RMD_TEST_SLOT_DIR = dir;
  process.env.RMD_TEST_SLOTS = "1";
  delete process.env.RMD_TEST_SLOT_PARENT;
  t.after(() => {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });
  return dir;
}

/** The static step's own view of the host: which suite holder owns slot 1 and who is waiting in line. */
function observingStatic(slotDir: string, exitCode: number): string {
  return `
    import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
    const slot = ${JSON.stringify(join(slotDir, "slot-1.json"))}, queue = ${JSON.stringify(testSlotQueueDir(slotDir))};
    const tickets = existsSync(queue) ? readdirSync(queue).filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(queue + '/' + n, 'utf8')).label) : [];
    writeFileSync('coverage/static-ran.json', JSON.stringify({ slotLabel: existsSync(slot) ? JSON.parse(readFileSync(slot, 'utf8')).label : null, tickets }));
    process.exitCode = ${exitCode};
  `;
}

function authorFixture(t: TestContext, staticSource: string) {
  const repo = gitRepo({ kind: "w1-t9951-author", seedCommit: false });
  t.after(() => repo.cleanup());
  const root = repo.dir;
  for (const path of ["test/setup", "src", "scripts", "coverage"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), `${process.versions.node}\n`);
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json")));
  writeFileSync(join(root, "scripts/census-precheck.mjs"), "console.log('fixture census precheck passed');\n");
  writeFileSync(join(root, "scripts/lint-plan-offline.mjs"), "console.log('fixture plan lint passed');\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/run-task.ts"), "console.log('baseline');\n");
  writeFileSync(join(root, "test/leaf.test.ts"), "import { test } from 'node:test'; test('leaf', () => {});\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "test: baseline");
  repo.git("remote", "add", "origin", root);
  repo.git("checkout", "-b", "run-unfiled-w1-t9951-fixture");
  writeFileSync(join(root, "src/run-task.ts"), staticSource);
  repo.git("add", ".");
  repo.git("commit", "-m", "fix: change the static step");
  return {
    root,
    receipt: (): Receipt => JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8")),
    observed: (): { slotLabel: string | null; tickets: string[] } => JSON.parse(readFileSync(join(root, "coverage/static-ran.json"), "utf8")),
  };
}

function queuedTickets(slotDir: string): string[] {
  const queue = testSlotQueueDir(slotDir);
  return existsSync(queue) ? readdirSync(queue).filter(name => name.endsWith(".json")) : [];
}

const suites = () => ({ fullRun: false, suites: ["test/leaf.test.ts"], reasons: ["W1-T9951 fixture"] });

test("W1-T9951: static-preflight runs while the suite ticket waits", async (t) => {
  const slotDir = slotEnvironment(t);
  const f = authorFixture(t, observingStatic(slotDir, 0));
  const ready = join(slotDir, "..", "holder-ready");
  // A separate process holds the ONLY suite slot and a ticket ahead, until the static stage has reported
  // (or a bound passes, so the old order — slot first, static after — fails in seconds rather than hanging).
  const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { existsSync, writeFileSync } from 'node:fs';
    import { hostname } from 'node:os';
    import { acquireTestSlot } from ${JSON.stringify(SLOT_MODULE)};
    import { takeTestSlotTicket } from ${JSON.stringify(QUEUE_MODULE)};
    const lease = acquireTestSlot('suite-holder', { dir: ${JSON.stringify(slotDir)}, slots: 1, waitBoundMs: 0, log: () => {} });
    if (lease.outcome !== 'acquired') throw new Error(lease.note);
    const now = new Date().toISOString();
    const ticket = takeTestSlotTicket(${JSON.stringify(slotDir)}, { pid: process.pid, host: hostname(), label: 'ticket-ahead',
      arrivedAt: now, heartbeatAt: now, heartbeatIntervalMs: 50 });
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    const until = Date.now() + 8000;
    const timer = setInterval(() => {
      if (!existsSync(${JSON.stringify(join(f.root, "coverage/static-ran.json"))}) && Date.now() < until) return;
      clearInterval(timer); ticket.drop(); lease.release();
    }, 50);
  `], { cwd: REPO_ROOT, stdio: "ignore", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const exited = new Promise<void>(resolve => holder.once("exit", () => resolve()));
  t.after(async () => { if (holder.exitCode === null) holder.kill("SIGKILL"); await exited; });
  for (let i = 0; i < 1500 && !existsSync(ready); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(ready), "the holder never took the slot and its ticket");

  const { main } = await import(AUTHOR) as { main: Main };
  assert.equal(main([], { root: f.root, select: suites, testSlot: { pollMs: 50, log: () => {} } }), 0);
  const receipt = f.receipt();
  const seen = f.observed();
  assert.equal(seen.slotLabel, "suite-holder", "static-preflight ran while another run still held every suite slot");
  assert.deepEqual(seen.tickets.sort(), [SUITE_LABEL, "ticket-ahead"].sort(), "its own ticket was waiting, behind the one ahead");
  assert.deepEqual(receipt.steps.map(step => step.name), ["census-precheck", "static-preflight", "affected-tests"]);
  assert.equal(receipt.verdict, "passed");
  assert.equal(receipt.staticAdmission?.outcome, "admitted");
  assert.equal(receipt.suiteQueue?.ticketed, true);
  assert.equal(receipt.suiteQueue?.positionAtEnqueue, 2);
  assert.equal(receipt.suiteQueue?.outcome, "admitted");
  assert.equal(typeof receipt.suiteQueue?.waitedMs, "number");
  assert.equal(receipt.testSlot?.outcome, "acquired");
  assert.deepEqual(queuedTickets(slotDir), [], "the admitted ticket left the line");
});

test("W1-T9951: a failed static stage cancels its suite ticket", async (t) => {
  const { main } = await import(AUTHOR) as { main: Main };
  await t.test("a failed static-preflight never takes a suite slot", (t) => {
    const slotDir = slotEnvironment(t);
    const f = authorFixture(t, observingStatic(slotDir, 7));
    assert.equal(main([], { root: f.root, select: suites, testSlot: { log: () => {} } }), 1);
    const receipt = f.receipt();
    assert.deepEqual(f.observed().tickets, [SUITE_LABEL], "the ticket was taken before the static stage ran");
    assert.equal(receipt.verdict, "failed");
    assert.deepEqual(receipt.steps.map(step => step.name), ["census-precheck", "static-preflight"]);
    assert.equal(receipt.suiteQueue?.ticketed, true);
    assert.equal(receipt.suiteQueue?.outcome, "cancelled");
    assert.match(receipt.suiteQueue?.reason ?? "", /static-preflight did not succeed/);
    assert.equal(receipt.testSlot, undefined, "no suite slot was ever admitted");
    assert.equal(existsSync(join(slotDir, "slot-1.json")), false);
    assert.deepEqual(queuedTickets(slotDir), [], "the cancelled ticket left the line");
  });
  await t.test("a selection naming no suite cancels its ticket after static and plan lint pass", (t) => {
    const slotDir = slotEnvironment(t);
    const f = authorFixture(t, observingStatic(slotDir, 0));
    const planOnly = () => ({ fullRun: false, planOnly: true, suites: [], reasons: ["plan-only fixture"] });
    assert.equal(main([], { root: f.root, select: planOnly, testSlot: { log: () => {} } }), 0);
    const receipt = f.receipt();
    assert.deepEqual(receipt.steps.map(step => step.name), ["census-precheck", "static-preflight", "lint-plan-fast"]);
    assert.equal(receipt.suiteQueue?.outcome, "cancelled");
    assert.equal(receipt.suiteQueue?.reason, "the selection names no suite");
    assert.equal(receipt.testSlot, undefined);
    assert.equal(existsSync(join(slotDir, "slot-1.json")), false);
    assert.deepEqual(queuedTickets(slotDir), []);
  });
});

test("W1-T9951: a cold typecheck is admitted by memory, not by the suite queue", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t9951-cold-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const slots = join(root, "slots");
  mkdirSync(slots);
  mkdirSync(join(root, "tree", ".git"), { recursive: true });
  const tree = join(root, "tree");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(tree, "node_modules"));
  writeFileSync(join(tree, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: [], noEmit: true }, include: ["*.ts"] }));
  writeFileSync(join(tree, "a.ts"), "export const a = 1;\n");
  // Every suite slot is held (with a named 1 GiB peak) and a live ticket is ahead in line.
  const holder = acquireTestSlot("suite", { dir: slots, slots: 1, memoryBytes: 1 * GiB, log: () => {} });
  t.after(() => holder.release());
  assert.equal(holder.outcome, "acquired");
  const now = new Date().toISOString();
  const ahead = takeTestSlotTicket(slots, { pid: process.pid, host: "w1-t9951", label: "ticket-ahead", arrivedAt: now, heartbeatAt: now, heartbeatIntervalMs: 60_000 });
  t.after(() => ahead.drop());
  const staticLabels = () => readdirSync(slots).filter(name => name.startsWith("static-")).map(name => JSON.parse(readFileSync(join(slots, name), "utf8")).label);
  const run = (headroom: () => number | undefined, sleep: (ms: number) => void, logs: string[] = []) => {
    const during: string[][] = [];
    const step = typecheckStep(tree, () => { during.push(staticLabels()); return { status: 0, stdout: "", stderr: "" }; },
      { dir: slots, slots: 1, queue: true, pollMs: 5, waitBoundMs: 60_000, memoryHeadroom: headroom, sleep, log: line => logs.push(line) }, () => false);
    return { step, during };
  };

  // Roomy headroom: the cold check starts at once, with the slot still held and the ticket still ahead.
  let sleeps = 0;
  const roomy = run(() => 8 * GiB, () => { sleeps += 1; throw new Error("a roomy cold typecheck must not wait"); });
  assert.equal(roomy.step.ok, true, roomy.step.detail);
  assert.equal(sleeps, 0, "the cold typecheck never waited behind the held slot or the ticket ahead");
  assert.deepEqual(roomy.during, [["typecheck:preflight"]], "its own memory admission named its peak while it ran");
  assert.deepEqual(staticLabels(), [], "and released it after");

  // Short headroom: it waits on MEMORY, and starts once the headroom holds its peak beside the holder's.
  let headroom = 2 * GiB;
  const logs: string[] = [];
  const short = run(() => headroom, () => { sleeps += 1; headroom = 8 * GiB; }, logs);
  assert.equal(short.step.ok, true, short.step.detail);
  assert.equal(sleeps, 1);
  const waiting = logs.map(line => JSON.parse(line)).find(row => row.step === "test_slot.static_waiting");
  assert.ok(waiting, logs.join("\n"));
  assert.ok(waiting.holders.some((h: string) => h.startsWith("suite ")), "the live holder's named peak was counted");

  // No memory reading: static admission is open and says so — still never queued behind the suites.
  const unread = run(() => undefined, () => { throw new Error("an unread host must not wait"); });
  assert.equal(unread.step.ok, true, unread.step.detail);
  assert.equal(holder.outcome, "acquired");
  assert.equal(readdirSync(testSlotQueueDir(slots)).length, 1, "the ticket ahead is untouched");
});
