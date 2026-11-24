import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { ciFrictionGardenSpec, gitCiFrictionOwnerSearch, type CiFrictionGardenSources } from "#src/lib/ci-friction-gardener.js";
import * as gardener from "#src/lib/gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { gitRepo } from "#test/helpers/git-repo.js";

function stateDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-units-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ciFixture(t: TestContext, existingRepo?: ReturnType<typeof gitRepo>, fileRemedy = false) {
  const repo = existingRepo ?? gitRepo({ kind: "garden-units" });
  const dir = stateDir(t);
  if (existingRepo === undefined) {
    t.after(() => repo.cleanup());
    mkdirSync(join(repo.dir, "test"));
    for (const name of ["a", "b"]) writeFileSync(join(repo.dir, "test", `${name}.test.ts`), "");
    if (fileRemedy) {
      mkdirSync(join(repo.dir, "src"));
      writeFileSync(join(repo.dir, "src", "garden-owner.ts"), "export const works = true;\n");
      writeFileSync(join(repo.dir, "test", "b.test.ts"), 'import { works } from "#src/garden-owner.js";\nvoid works;\n');
    }
    repo.git("add", ".");
    repo.git("commit", "-qm", "test(garden): add suites (#1)");
    writeFileSync(join(repo.dir, "test", "c.test.ts"), "");
    repo.git("add", "test/c.test.ts");
    repo.git("commit", "-qm", "test(garden): add a suite without an adding pull request");
  }
  let now = Date.parse("2026-11-20T12:20:00Z");
  let stopAt: string | undefined;
  const clock = clockFromMillisFn(() => now);
  const rows: LedgerRecord[] = ["a", "b", "c"].flatMap((name, index) => [
    { step: "sweep.disposed", run_id: "daemon-1", pr_number: index + 1, head_sha: name, ts: clock.iso() },
    { step: "fix.dispatch", run_id: "daemon-1", round: "resume", mode: "ci-log", head_sha: name, elapsed_ms: 600_000, ts: clock.iso(),
      ci_failures: [{ check: "ci-shard (1/8)", signature: `test/${name}.test.ts` }] },
  ]);
  const searched: string[] = [];
  const events: Array<{ step: string; fields?: Record<string, unknown> }> = [];
  const escalations: unknown[] = [];
  const filings: Array<{ opts: gardener.GardenLandOpts; shard: string }> = [];
  const deps: gardener.GardenerDeps = {
    stateDir: dir, repoRoot: repo.dir, clock, seed: 1,
    log: (step, fields) => events.push({ step, fields }),
    escalate: (escalation) => (escalations.push(escalation), "https://github.com/acme/remudero/issues/1"),
    openWorkspace: () => ({ root: repo.dir, branch: "garden-units", land: (opts) => {
      filings.push({ opts, shard: readFileSync(join(repo.dir, opts.paths[0]!), "utf8") });
      return "https://github.com/acme/remudero/pull/99";
    }, dispose: () => {} }),
  };
  const sources = (): CiFrictionGardenSources => ({
    ledgerRecords: () => rows,
    planState: () => ({ tasks: [] }),
    ownerSearch: gitCiFrictionOwnerSearch((args) => {
      if (args[0] === "log") {
        const file = args.at(-1)!;
        searched.push(file);
        if (file === stopAt) throw new Error("interrupted lookup");
      }
      return repo.git(...args);
    }, "HEAD"),
    mintTaskId: () => "W1-T9001",
  });
  return {
    dir, repo, searched, events, escalations, filings,
    advance(ms: number) { now += ms; },
    interrupt(file?: string) { stopAt = file; },
    inventory: () => ciFrictionGardenSpec(deps, sources()).inventory(),
    run: () => gardener.runGarden(ciFrictionGardenSpec(deps, sources()), deps),
  };
}

test("W1-T13989 criterion 1: a new journal instance resumes only finished units for this garden", (t) => {
  const dir = stateDir(t);
  const journal = gardener.gardenUnitJournal(dir, "a", 1);
  assert.equal(journal.has("first", "input"), false);
  journal.done("first", "input", { output: 7 });
  journal.done("__proto__", "input");
  const resumed = gardener.gardenUnitJournal(dir, "a", 1);
  assert.equal(resumed.has("first", "input"), true);
  assert.deepEqual(resumed.get("first", "input"), { output: 7 });
  assert.equal(resumed.has("__proto__", "input"), true);
  assert.equal(resumed.has("unfinished", "input"), false);
  assert.equal(gardener.gardenUnitJournal(dir, "b", 1).has("first", "input"), false);
});

test("W1-T13989 criterion 2: ci-friction uses committed lookup results and counts fresh and resumed units", (t) => {
  const f = ciFixture(t);
  f.interrupt("test/b.test.ts");
  assert.throws(f.inventory, /interrupted lookup/);
  assert.deepEqual(f.searched.splice(0), ["test/a.test.ts", "test/b.test.ts"]);
  f.interrupt();
  f.run();
  assert.deepEqual(f.searched, ["test/b.test.ts", "test/c.test.ts"]);
  const row = f.events.find(({ step }) => step === "ci-friction.pass");
  assert.equal(row?.fields?.resumed_units, 1);
  assert.equal(row?.fields?.fresh_units, 2);
});

test("W1-T13989 criterion 3: unknown inputs and damaged journals run the unit again", (t) => {
  const f = ciFixture(t);
  f.inventory();
  const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
  assert.deepEqual(f.searched.splice(0), files);
  f.repo.git("commit", "-qm", "chore(garden): change the pinned revision", "--allow-empty");
  f.inventory();
  assert.deepEqual(f.searched.splice(0), files);
  f.advance(gardener.GARDEN_LEDGER_BUCKET_MS);
  f.inventory();
  assert.deepEqual(f.searched.splice(0), files);
  const path = gardener.gardenUnitJournalPath(f.dir, "ci-friction");
  writeFileSync(path, "{");
  f.inventory();
  assert.deepEqual(f.searched.splice(0), files);
  assert.equal(f.events.filter(({ step }) => step === "garden.unit_journal_failed").length, 1);
  f.inventory();
  assert.deepEqual(f.searched, []);
});

test("W1-T13989 criterion 4: resuming leaves the same decision, escalation and garden state", (t) => {
  const resumed = ciFixture(t);
  resumed.interrupt("test/c.test.ts");
  assert.throws(resumed.inventory, /interrupted lookup/);
  resumed.interrupt();
  const resumedPass = resumed.run();
  const uninterrupted = ciFixture(t, resumed.repo);
  const fullPass = uninterrupted.run();
  assert.ok(fullPass.plan?.actions.length);
  assert.equal(uninterrupted.escalations.length, 1);
  assert.deepEqual(resumedPass, fullPass);
  assert.deepEqual(resumed.escalations, uninterrupted.escalations);
  const resumedState = readFileSync(gardener.gardenStatePath(resumed.dir, "ci-friction"), "utf8");
  const fullState = readFileSync(gardener.gardenStatePath(uninterrupted.dir, "ci-friction"), "utf8");
  assert.equal(resumedState, fullState);
  assert.deepEqual(resumed.searched.slice(3), ["test/c.test.ts"]);
});

test("W1-T13989 criterion 4: resuming files the same shard and preserves byte-identical garden state", (t) => {
  const resumed = ciFixture(t, undefined, true);
  resumed.interrupt("test/c.test.ts");
  assert.throws(resumed.inventory, /interrupted lookup/);
  resumed.interrupt();
  const resumedPass = resumed.run();
  const uninterrupted = ciFixture(t, resumed.repo);
  const fullPass = uninterrupted.run();
  assert.equal(fullPass.prUrl, "https://github.com/acme/remudero/pull/99");
  assert.equal(uninterrupted.filings.length, 1);
  assert.deepEqual(resumedPass, fullPass);
  assert.deepEqual(resumed.filings, uninterrupted.filings);
  assert.equal(readFileSync(gardener.gardenStatePath(resumed.dir, "ci-friction"), "utf8"),
    readFileSync(gardener.gardenStatePath(uninterrupted.dir, "ci-friction"), "utf8"));
});

test("an unreadable journal and subsequent write refusals leave all units due and report once", (t) => {
  const dir = stateDir(t);
  mkdirSync(gardener.gardenUnitJournalPath(dir, "ci-friction"));
  const failures: Array<Record<string, unknown> | undefined> = [];
  const journal = gardener.gardenUnitJournal(dir, "ci-friction", 1, {
    log: (step, fields) => {
      assert.equal(step, "garden.unit_journal_failed");
      failures.push(fields);
    },
  });
  journal.done("first", "input");
  journal.done("second", "input");
  assert.equal(journal.has("first", "input"), false);
  assert.equal(journal.has("second", "input"), false);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.operation, "read");
});
