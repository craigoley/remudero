/**
 * `rmd decline` and `rmd restore` — the terminal's route to the console's two inbox verdicts. Both commands and both
 * serve routes (test/the-console-inbox-can-decline-a-proposal.test.ts, test/a-decline-can-be-taken-back.test.ts) go
 * through `applyProposalVerdict`, so these cases pin the command's own arms and the one live path from argv to a
 * ledger row.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { InboxClassification, Proposal } from "../src/lib/inbox.js";
import { proposalVerdictCommand } from "../src/lib/inbox-verdict-command.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { proposalVerdictCliCommand } from "../src/run-task.js";

type Found = { exists: boolean; classification?: InboxClassification };

function run(kind: "decline" | "restore", rest: string[], found: Found) {
  const recorded: Array<[string, string, string]> = [];
  const out: string[] = [];
  const err: string[] = [];
  const code = proposalVerdictCommand(kind, rest, {
    find: () => found,
    record: (step, id, reason) => recorded.push([step, id, reason]),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, recorded, out: out.join("\n"), err: err.join("\n") };
}

const notReady: Found = { exists: true, classification: { proposalId: "P1", state: "not_ready", reasons: [] } as InboxClassification };
const declined: Found = {
  exists: true,
  classification: { proposalId: "P1", state: "declined", reasons: [], declinedReason: "a duplicate" } as InboxClassification,
};
const ratified: Found = { exists: true, classification: { proposalId: "P1", state: "ratified", reasons: [] } as InboxClassification };

test("rmd decline records one panel.proposal_declined row with the reason verbatim and names the way back", () => {
  const r = run("decline", ["P1", "--reason", "legacy duplicate of skill-draft:8aa4"], notReady);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.recorded, [["panel.proposal_declined", "P1", "legacy duplicate of skill-draft:8aa4"]]);
  assert.match(r.out, /P1 DECLINED — take it back with rmd restore P1 --reason/);
});

test("rmd decline refuses an unknown, a ratified or an already-declined proposal and records nothing", () => {
  const unknown = run("decline", ["P9", "--reason", "r"], { exists: false });
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no active proposal "P9"/);
  const done = run("decline", ["P1", "--reason", "r"], ratified);
  assert.equal(done.code, 1);
  assert.match(done.err, /already RATIFIED — declining now cannot un-file/);
  const again = run("decline", ["P1", "--reason", "r"], declined);
  assert.equal(again.code, 1);
  assert.match(again.err, /was already declined \(a duplicate\)/);
  assert.deepEqual([...unknown.recorded, ...done.recorded, ...again.recorded], []);
});

test("rmd restore records panel.proposal_restored for a declined proposal and refuses one that is not declined", () => {
  const r = run("restore", ["P1", "--reason", "the decline was wrong"], declined);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.recorded, [["panel.proposal_restored", "P1", "the decline was wrong"]]);
  assert.match(r.out, /P1 RESTORED/);
  const refused = run("restore", ["P1", "--reason", "r"], notReady);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /is not declined \(state: not_ready\) — there is nothing to restore/);
  const done = run("restore", ["P1", "--reason", "r"], ratified);
  assert.match(done.err, /already RATIFIED — restoring it cannot un-file/);
  assert.deepEqual([...refused.recorded, ...done.recorded], []);
});

test("rmd decline without a reason, with an empty reason, or with a stray argument is a usage error that records nothing", () => {
  for (const rest of [["P1"], ["P1", "--reason", "  "], ["P1", "--reason"], ["--reason", "r"], ["P1", "--reason", "r", "--force"], []]) {
    const r = run("decline", rest, notReady);
    assert.equal(r.code, 2, `argv ${JSON.stringify(rest)}`);
    assert.match(r.err, /usage: rmd decline <proposalId> --reason "<text>"/);
    assert.deepEqual(r.recorded, []);
  }
});

test("rmd decline and rmd restore, end to end: a real registry, the live classification, and the ledger they share", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rmd-decline-cli-`));
  const errors: string[] = [];
  const savedError = console.error;
  const savedLog = console.log;
  try {
    console.error = (line: unknown) => void errors.push(String(line));
    console.log = () => {};
    mkdirSync(join(root, "state"), { recursive: true });
    const proposal: Proposal = { id: "skill-draft:legacy-1", summary: "s", evidenceAnchors: [] };
    writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [proposal] }), "utf8");
    const config = { claudeBin: "/usr/bin/true", root } as never;
    const rows = () =>
      readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.task_id === "skill-draft:legacy-1");

    assert.equal(proposalVerdictCliCommand("decline", ["skill-draft:legacy-1", "--reason", "legacy duplicate"], { config }), 0);
    assert.deepEqual(
      rows().map((l) => [l.step, l.origin, l.reason]),
      [["panel.proposal_declined", "rmd-cli", "legacy duplicate"]],
    );
    // The second decline must SEE the first: only a classification with the ledger's declines applied refuses it.
    assert.equal(proposalVerdictCliCommand("decline", ["skill-draft:legacy-1", "--reason", "again"], { config }), 1);
    assert.match(errors.join("\n"), /was already declined \(legacy duplicate\)/);
    assert.equal(proposalVerdictCliCommand("restore", ["skill-draft:legacy-1", "--reason", "wrong call"], { config }), 0);
    assert.equal(proposalVerdictCliCommand("restore", ["skill-draft:legacy-1", "--reason", "twice"], { config }), 1);
    assert.equal(proposalVerdictCliCommand("decline", ["no-such-proposal", "--reason", "r"], { config }), 1);
    assert.deepEqual(
      rows().map((l) => l.step),
      ["panel.proposal_declined", "panel.proposal_restored"],
    );
  } finally {
    console.error = savedError;
    console.log = savedLog;
    rmSync(root, { recursive: true, force: true });
  }
});
