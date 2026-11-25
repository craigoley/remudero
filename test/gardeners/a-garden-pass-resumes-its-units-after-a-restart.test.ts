import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import {
  ciFrictionGardenSpec, gitCiFrictionOwnerSearch, type CiFrictionEscalationIssues, type CiFrictionGardenSources,
} from "#src/lib/ci-friction-gardener.js";
import { GARDEN_LEDGER_BUCKET_MS, type GardenerDeps } from "#src/lib/gardener.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const DAY = 24 * 3_600_000;
const ISSUE = "https://github.com/acme/remudero/issues/7";

/** One state dir and one repository shared by every daemon: each `daemon()` is a fresh spec, as after a restart. */
function fixture(t: TestContext) {
  const repo = gitRepo({ kind: "garden-resume" });
  t.after(() => repo.cleanup());
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-resume-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  mkdirSync(join(repo.dir, "test"));
  for (const name of ["a", "b", "c"]) {
    writeFileSync(join(repo.dir, "test", `${name}.test.ts`), "");
    repo.git("add", ".");
    repo.git("commit", "-qm", `test(garden): add suite ${name} (#${name.charCodeAt(0) - 96})`);
  }
  let now = Date.parse("2026-11-24T12:20:00Z");
  const clock = clockFromMillisFn(() => now);
  const rounds: LedgerRecord[] = ["a", "b", "c"].flatMap((name, index) => [
    { step: "sweep.disposed", run_id: "daemon-1", pr_number: index + 1, head_sha: name, ts: clock.iso() },
    { step: "fix.dispatch", run_id: "daemon-1", round: "resume", mode: "ci-log", head_sha: name, elapsed_ms: 600_000, ts: clock.iso(),
      ci_failures: [{ check: "ci-shard (1/8)", signature: `test/${name}.test.ts` }] },
  ]);
  // An escalation whose cause has sat below the ladder for nine days: the pass that finishes its inventory releases it.
  const stale: LedgerRecord[] = [
    { step: "ci-friction.remedy_escalated", origin: "ci-friction:check:stale-gate", issue_url: ISSUE, ts: new Date(now - 20 * DAY).toISOString() },
    { step: "ci-friction.remedy_below_ladder", cause: "check:stale-gate", ts: new Date(now - 9 * DAY).toISOString() },
  ];
  const searched: string[] = [];
  const events: Array<{ step: string; fields?: Record<string, unknown> }> = [];
  const closed: string[] = [];
  let stopAt: string | undefined;
  const issues: CiFrictionEscalationIssues = { listComments: () => [], close: (url) => { closed.push(url); } };
  const deps: GardenerDeps = {
    stateDir, repoRoot: repo.dir, clock, seed: 1,
    log: (step, fields) => events.push({ step, fields }),
    escalate: () => "https://github.com/acme/remudero/issues/1",
    openWorkspace: () => { throw new Error("no filing in this fixture"); },
  };
  const daemon = () => ciFrictionGardenSpec(deps, {
    ledgerRecords: () => [...rounds, ...stale],
    planState: () => ({ tasks: [] }),
    ownerSearch: gitCiFrictionOwnerSearch((args) => {
      if (args[0] === "log" && args[1] === "--diff-filter=A" && args[2] === "--format=%s") {
        const file = args.at(-1)!;
        searched.push(file);
        if (file === stopAt) throw new Error("daemon replaced mid-pass");
      }
      return repo.git(...args);
    }, "HEAD"),
    mintTaskId: () => "W1-T9001",
    issues,
    awaitReleases: true,
  } satisfies CiFrictionGardenSources);
  const pass = (row: string) => events.filter(({ step }) => step === row);
  return {
    repo, searched, events, closed, pass,
    advance(ms: number) { now += ms; },
    interrupt(file?: string) { stopAt = file; },
    daemon,
    /** An unrelated merge: main moves and no test file is added. */
    mergeElsewhere(name: string) {
      mkdirSync(join(repo.dir, "src"), { recursive: true });
      writeFileSync(join(repo.dir, "src", `${name}.ts`), "export {};\n");
      repo.git("add", ".");
      repo.git("commit", "-qm", `feat(garden): ${name} (#40)`);
    },
  };
}

test("W1-T14708: a garden pass interrupted by a restart resumes its computed units on the next daemon", async (t) => {
  const f = fixture(t);
  f.interrupt("test/c.test.ts");
  await assert.rejects(f.daemon().inventoryAsync!(), /daemon replaced mid-pass/);
  assert.deepEqual(f.searched.splice(0), ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]);

  // The replacement daemon starts after a merge to main and in the next ledger hour, as a 97-minute pass does.
  f.interrupt();
  f.mergeElsewhere("unrelated");
  f.advance(2 * GARDEN_LEDGER_BUCKET_MS);
  await f.daemon().inventoryAsync!();
  assert.deepEqual(f.searched.splice(0), ["test/c.test.ts"], "only the unit the cut-off pass never finished is computed");
  assert.deepEqual(f.pass("ci-friction.pass").at(-1)?.fields, { resumed_units: 2, fresh_units: 1 });

  // A unit whose own history changed is computed again: a commit since its save added that file.
  f.repo.git("rm", "-q", "test/b.test.ts");
  f.repo.git("commit", "-qm", "test(garden): drop suite b (#41)");
  writeFileSync(join(f.repo.dir, "test", "b.test.ts"), "");
  f.repo.git("add", ".");
  f.repo.git("commit", "-qm", "test(garden): restore suite b (#42)");
  await f.daemon().inventoryAsync!();
  assert.deepEqual(f.searched.splice(0), ["test/b.test.ts"]);
  assert.deepEqual(f.pass("ci-friction.pass").at(-1)?.fields, { resumed_units: 2, fresh_units: 1 });

  // A saved revision that is no longer an ancestor of main (a rewritten history) keeps nothing.
  f.repo.git("checkout", "-q", "--orphan", "rewritten");
  f.repo.git("commit", "-qm", "test(garden): rewritten history (#43)");
  await f.daemon().inventoryAsync!();
  assert.deepEqual(f.searched.splice(0), ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]);
});

test("W1-T14708: a resumed pass releases eligible escalations it found before the restart", async (t) => {
  const f = fixture(t);
  f.interrupt("test/b.test.ts");
  await assert.rejects(f.daemon().inventoryAsync!(), /daemon replaced mid-pass/);
  assert.deepEqual(f.closed, [], "the cut-off pass never reached its release stage");
  assert.equal(f.pass("ci-friction.remedy_released").length, 0);

  f.interrupt();
  f.mergeElsewhere("unrelated");
  f.advance(2 * GARDEN_LEDGER_BUCKET_MS);
  await f.daemon().inventoryAsync!();
  assert.deepEqual(f.pass("ci-friction.pass").at(-1)?.fields, { resumed_units: 1, fresh_units: 2 });
  assert.deepEqual(f.closed, [ISSUE], "the resumed pass closes the escalation that was due before the restart");
  assert.deepEqual(f.pass("ci-friction.remedy_released").map(({ fields }) => fields?.cause), ["check:stale-gate"]);
});
