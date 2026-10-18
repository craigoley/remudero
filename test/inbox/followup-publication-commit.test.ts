import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as retro from "#src/lib/retro.js";
import { loadProposalRegistry } from "#src/lib/inbox.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

function source(): retro.LedgerRecord[] {
  return [{ ts: new Date().toISOString(), run_id: "fixture-run", task_id: "fixture-task",
    step: "report.followups", entries: [{ type: "task", text: "repair the notification retry contract" }] }];
}

function marks(path: string): retro.LedgerRecord[] {
  return existsSync(path) ? retro.parseLedger(readFileSync(path, "utf8")) : [];
}

test("a failed followup publication leaves its source retryable", t => {
  const root = ownedFixtureDir(t, "followup-publication").dir;
  const ledgerPath = join(root, "ledger.ndjson");
  const blocked = join(root, "not-a-directory");
  writeFileSync(blocked, "fixture file, not a registry directory");
  const records = source();
  assert.throws(() => retro.publishFollowupHarvest(retro.mineFollowups(records), {
    registryPath: join(blocked, "inbox-proposals.json"), ledgerPath,
  }), /ENOTDIR|EEXIST/);
  assert.equal(marks(ledgerPath).length, 0, "the real default writer must not acknowledge a rejected registry write");
  const retry = retro.mineFollowups([...records, ...marks(ledgerPath)]);
  assert.equal(retry.candidates.length, 1);
  const registryPath = join(root, "inbox-proposals.json");
  assert.equal(retro.publishFollowupHarvest(retry, { registryPath, ledgerPath })[0]?.routed, true);
  assert.equal(loadProposalRegistry(registryPath).length, 1);
  assert.equal(marks(ledgerPath).filter(r => r.step === "followup.harvested").length, 1);
  assert.equal(retro.mineFollowups([...records, ...marks(ledgerPath)]).candidates.length, 0);
});

test("a followup saved before a failed acknowledgement replays without duplicate proposals", t => {
  const root = ownedFixtureDir(t, "followup-acknowledgement").dir;
  const registryPath = join(root, "inbox-proposals.json");
  const ledgerPath = join(root, "ledger.ndjson");
  const records = source();
  assert.throws(() => retro.publishFollowupHarvest(retro.mineFollowups(records), {
    registryPath, ledgerPath, writeLedger: () => { throw new Error("fixture acknowledgement failed"); },
  }), /fixture acknowledgement failed/);
  assert.equal(loadProposalRegistry(registryPath).length, 1, "publication completes before its acknowledgement");
  assert.equal(marks(ledgerPath).length, 0);
  retro.publishFollowupHarvest(retro.mineFollowups(records), { registryPath, ledgerPath });
  assert.equal(loadProposalRegistry(registryPath).length, 1, "stable proposal ids make the replay idempotent");
  assert.equal(retro.mineFollowups([...records, ...marks(ledgerPath)]).candidates.length, 0);
});

test("a declined followup is acknowledged without inventing a proposal", t => {
  const root = ownedFixtureDir(t, "followup-declined").dir;
  const registryPath = join(root, "inbox-proposals.json");
  const ledgerPath = join(root, "ledger.ndjson");
  const records = source();
  (records[0]!.entries as Array<{ type: string }>)[0]!.type = "action";
  const result = retro.publishFollowupHarvest(retro.mineFollowups(records), { registryPath, ledgerPath });
  assert.equal(result[0]?.routed, false);
  assert.equal(existsSync(registryPath), false);
  assert.equal(retro.mineFollowups([...records, ...marks(ledgerPath)]).candidates.length, 0);
});

test("a failed publication does not consume a newly remeasured fix followup", t => {
  const root = ownedFixtureDir(t, "followup-remeasurement").dir;
  const ledgerPath = join(root, "ledger.ndjson");
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const at = (n: number) => new Date(now + n * day).toISOString();
  writeLedger([{ ts: at(-1), step: "fixture.failed" }, { ts: at(0), step: "control" }], {
    dir: root, rotations: [{ at: at(-2), rows: [
      { ts: at(-4), step: "control" }, { ts: at(-3), step: "fixture.failed" },
    ] }],
  });
  const tasks = parseTasksFromYaml(JSON.stringify([{ id: "W1-T1", title: "repair the fixture symptom",
    repo: "remudero", type: "implement", symptom_query: { pattern: "fixture.failed", direction: "decrease" } }]), "fixture");
  const harvest = () => {
    const h = retro.mineFollowups([]);
    h.fixRemeasurement = { tasks, now,
      github: { findMergedByTrailer: () => ({ number: 1, url: "https://github.com/o/r/pull/1" }),
        headRefName: () => "run-W1-T1-1" } };
    return h;
  };
  const deps = { ledgerPath, reportFix: () => {}, readMergedPr: () => ({ state: "MERGED", mergedAt: at(-2),
    body: "Remudero-Task: W1-T1", headRefName: "run-W1-T1-1" }) };
  const blocked = join(root, "not-a-directory");
  writeFileSync(blocked, "fixture");
  assert.throws(() => retro.publishFollowupHarvest(harvest(), {
    ...deps, registryPath: join(blocked, "registry.json"),
  }), /ENOTDIR|EEXIST/);
  assert.equal(marks(ledgerPath).filter(r => r.step === "fix.remeasured").length, 0);
  const registryPath = join(root, "inbox-proposals.json");
  const retry = harvest();
  retro.publishFollowupHarvest(retry, { ...deps, registryPath });
  assert.equal(retry.candidates.length, 1, "the uncommitted measurement earns its followup again");
  assert.equal(loadProposalRegistry(registryPath).length, 1);
  assert.equal(marks(ledgerPath).filter(r => r.step === "fix.remeasured").length, 1);
  const later = harvest();
  retro.publishFollowupHarvest(later, { ...deps, registryPath });
  assert.equal(later.candidates.length, 0, "a committed measurement is still idempotent");
});
