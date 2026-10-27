// W1-T9951: an author preflight takes its suite ticket first, runs its static stage on a memory admission while
// that ticket waits, and admits its suites in queue order; a cold typecheck never waits on a suite slot or ticket.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { typecheckStep } from "#src/lib/commit-message.js";
import { acquireTestSlot, admitStaticWork, enqueueTestSlot } from "#src/lib/test-slot.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
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

test("static admission preserves a pre-existing temporary file or symlink", async (t) => {
  for (const kind of ["file", "symlink"] as const) {
    await t.test(kind, (t) => {
      const root = mkdtempSync(join(tmpdir(), "rmd-static-record-safety-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const slots = join(root, "slots");
      mkdirSync(slots);
      const target = join(root, "target");
      writeFileSync(target, "preserve this content");
      let temporary = "";
      const admission = admitStaticWork("static-file-safety", {
        dir: slots, memoryBytes: GiB, log: () => {},
        memoryHeadroom: () => {
          const records = readdirSync(slots);
          assert.equal(records.length, 1, "the initial peak was published before checking headroom");
          temporary = join(slots, `.${records[0]}.tmp`);
          if (kind === "symlink") symlinkSync(target, temporary);
          else writeFileSync(temporary, "preserve this content");
          return undefined;
        },
      });
      t.after(() => admission.release());
      assert.equal(readFileSync(target, "utf8"), "preserve this content");
      assert.equal(readFileSync(temporary, "utf8"), "preserve this content");
      assert.equal(lstatSync(temporary).isSymbolicLink(), kind === "symlink");
      assert.equal(admission.outcome, "open");
      assert.match(admission.note, /no memory reading/);
      assert.match(admission.note, /UNRECORDED.*EEXIST/);
      admission.release();
      assert.deepEqual(readdirSync(slots), [temporary.slice(slots.length + 1)], "release preserves the foreign entry");
    });
  }
});

test("W1-T9951: static-preflight runs while the suite ticket waits", async (t) => {
  // Loaded BEFORE the holder starts its bound: a cold import under host load must not spend the holder's window.
  const { main } = await import(AUTHOR) as { main: Main };
  const slotDir = slotEnvironment(t);
  const f = authorFixture(t, observingStatic(slotDir, 0));
  const ready = join(slotDir, "..", "holder-ready");
  // A separate process holds the ONLY suite slot and a ticket ahead, until the static stage has reported
  // (or a bound passes, so the old order — slot first, static after — fails within the bound rather than hanging).
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
    const until = Date.now() + 30000;
    const timer = setInterval(() => {
      if (!existsSync(${JSON.stringify(join(f.root, "coverage/static-ran.json"))}) && Date.now() < until) return;
      clearInterval(timer); ticket.drop(); lease.release();
    }, 50);
  `], { cwd: REPO_ROOT, stdio: "ignore", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const exited = new Promise<void>(resolve => holder.once("exit", () => resolve()));
  t.after(async () => { if (holder.exitCode === null) holder.kill("SIGKILL"); await exited; });
  for (let i = 0; i < 1500 && !existsSync(ready); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(ready), "the holder never took the slot and its ticket");

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

function scratch(t: TestContext, prefix: string): { root: string; slots: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${prefix}`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const slots = join(root, "slots");
  mkdirSync(slots);
  return { root, slots };
}

test("an unusable ticket queue leaves the suite stage to unqueued admission", (t) => {
  const slots = slotEnvironment(t);
  // A plain file where the ticket line's directory belongs: the ticket cannot be taken.
  writeFileSync(`${slots}.queue`, "not a directory");
  const logs: string[] = [];
  const hold = enqueueTestSlot("unqueueable", { dir: slots, queue: true, log: line => logs.push(line) });
  assert.equal(hold.ticketed, false);
  assert.equal(hold.position, undefined);
  assert.match(hold.note, /^queue unavailable \(.+\); admission polls unqueued$/);
  hold.cancel("never admitted");
  assert.deepEqual(logs, [], "no ticket was taken, so none was cancelled or reported");
});

test("static admission opens, and says so, when no slot directory can be resolved", () => {
  const absentTmp = join(tmpdir(), `rmd-w1-t9951-absent-${randomUUID()}`, "tmp");
  // A test process with no configured slot dir mints one under TMPDIR at module load; an absent TMPDIR makes that fail.
  const script = `
    process.env.TMPDIR = ${JSON.stringify(absentTmp)};
    process.env.NODE_TEST_CONTEXT = 'child-v8';
    delete process.env.RMD_TEST_SLOT_DIR; delete process.env.RMD_TEST_SLOT_PARENT;
    const { admitStaticWork } = await import(${JSON.stringify(SLOT_MODULE)});
    const a = admitStaticWork('no-slot-dir', { memoryBytes: 1, log: () => {} });
    console.log(JSON.stringify({ outcome: a.outcome, executionAllowed: a.executionAllowed, waitedMs: a.waitedMs, note: a.note }));
  `;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  assert.equal(run.status, 0, run.stderr);
  const admission = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}") as { outcome: string; executionAllowed: boolean; waitedMs: number; note: string };
  assert.equal(admission.outcome, "open");
  assert.equal(admission.executionAllowed, true);
  assert.equal(admission.waitedMs, 0);
  assert.match(admission.note, /static admission OPEN: slot directory unresolved \(.*ENOENT.*\); no peak could be counted/);
});

test("a nested static stage is covered by its ancestor's static record", (t) => {
  const { slots } = scratch(t, "w1-t9951-nested-");
  const common = { dir: slots, log: () => {}, isPidAlive: () => true, memoryHeadroom: () => undefined };
  // The author's own static admission, recorded under its parent's pid: this process is that pid's descendant.
  const ancestor = admitStaticWork("author-static", { ...common, memoryBytes: GiB, pid: process.ppid });
  t.after(() => ancestor.release());
  assert.equal(ancestor.outcome, "open");
  const nested = admitStaticWork("nested-static", { ...common, memoryBytes: GiB });
  assert.equal(nested.outcome, "inherited");
  assert.equal(nested.executionAllowed, true);
  assert.ok(nested.note.includes(`inherited from ancestor static-`) && nested.note.includes(`(author-static, pid ${process.ppid})`), nested.note);
  assert.equal(readdirSync(slots).filter(name => name.startsWith("static-")).length, 1, "only the ancestor's record remains");
});

test("a static stage past its wait bound runs anyway and names the holders it ran beside", (t) => {
  const { slots } = scratch(t, "w1-t9951-bound-");
  const holder = acquireTestSlot("suite", { dir: slots, slots: 1, memoryBytes: 8 * GiB, memoryHeadroom: () => 64 * GiB, log: () => {} });
  t.after(() => holder.release());
  assert.equal(holder.outcome, "acquired");
  const logs: string[] = [];
  const starved = admitStaticWork("starved-static", { dir: slots, memoryBytes: GiB, memoryHeadroom: () => GiB, waitBoundMs: 0,
    sleep: () => { throw new Error("a zero wait bound must not sleep"); }, log: line => logs.push(line) });
  t.after(() => starved.release());
  assert.equal(starved.outcome, "wait_bound_exceeded");
  assert.equal(starved.executionAllowed, true);
  assert.match(starved.note, /WAIT BOUND EXCEEDED.*headroom 1024 MiB < 9216 MiB beside suite \(pid \d+, 8192 MiB\); ran anyway/);
  const row = logs.map(line => JSON.parse(line)).find(entry => entry.step === "test_slot.static_wait_bound_exceeded");
  assert.ok(row, logs.join("\n"));
  assert.equal(row.holders.length, 1);
});

test("an unreadable static record names no peak, and an unreadable slot record hands the judgment to the slot", async (t) => {
  // A DIRECTORY at a record path is a uid-independent denial: no record can be read from it, at any uid.
  await t.test("static record", (t) => {
    const { slots } = scratch(t, "w1-t9951-unreadable-static-");
    mkdirSync(join(slots, `static-${randomUUID()}.json`));
    const admitted = admitStaticWork("beside-unreadable-static", { dir: slots, memoryBytes: GiB, memoryHeadroom: () => 8 * GiB, log: () => {} });
    t.after(() => admitted.release());
    assert.equal(admitted.outcome, "admitted");
    assert.match(admitted.note, /and 0 live holder\(s\)/);
  });
  await t.test("slot record", (t) => {
    const { slots } = scratch(t, "w1-t9951-unreadable-slot-");
    mkdirSync(join(slots, "slot-1.json"));
    const handed = admitStaticWork("beside-unreadable-slot", { dir: slots, slots: 1, memoryBytes: GiB, memoryHeadroom: () => 64 * GiB, waitBoundMs: 0, sleep: () => {}, log: () => {} });
    t.after(() => handed.release());
    assert.equal(handed.outcome, "slot");
    assert.match(handed.note, /^slot-1\.json needs private coordination/);
  });
});

test("a static record that vanishes while the directory is scanned is skipped", (t) => {
  const { slots } = scratch(t, "w1-t9951-vanish-");
  const holder = acquireTestSlot("suite", { dir: slots, slots: 1, memoryBytes: GiB, memoryHeadroom: () => 64 * GiB, log: () => {} });
  t.after(() => holder.release());
  assert.equal(holder.outcome, "acquired");
  const planted = join(slots, `static-${randomUUID()}.json`);
  writeFileSync(planted, JSON.stringify({ pid: process.pid, host: "w1-t9951", startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), label: "vanishing" }));
  // The scan lists the planted record, then reads the suite holder's record first (it sorts earlier) and asks the
  // clock about it: that is where the planted record disappears, before the scan reaches it.
  const clock = {
    now: () => {
      const own = readdirSync(slots).filter(name => name.startsWith("static-") && name !== basename(planted));
      if (own.length > 0 && existsSync(planted)) unlinkSync(planted);
      return Date.now();
    },
    date: () => new Date(), iso: () => new Date().toISOString(),
  };
  const admitted = admitStaticWork("racing-static", { dir: slots, memoryBytes: GiB, memoryHeadroom: () => 8 * GiB, clock, log: () => {} });
  t.after(() => admitted.release());
  assert.equal(existsSync(planted), false, "the record vanished during the scan");
  assert.equal(admitted.outcome, "admitted");
  assert.match(admitted.note, /and 1 live holder\(s\)/, "only the suite holder was counted");
});
