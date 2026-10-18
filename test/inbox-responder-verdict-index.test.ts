import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { registryThreadItems } from "#src/lib/inbox-responder.js";
import { plainInboxMessage, plainSourceFingerprint, plainStorePath, plainTemplate } from "#src/lib/inbox-plain.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const proof = "test/inbox-responder-verdict-index.test.ts";
const proposal = (n: number) => ({ id: `verify-human:W1-T${n}`, summary: `Decision ${n}`, evidenceAnchors: [] });

function fixture(t: TestContext) {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}verdict-index-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  return { stateDir, ledgerPath: join(stateDir, "ledger.ndjson") };
}

test(`${proof}: real-file verdicts preserve alternation, owners, order and plain output`, (t) => {
  const { stateDir, ledgerPath } = fixture(t);
  const proposals = [proposal(6), proposal(2), proposal(1), proposal(3), proposal(4), proposal(5),
    { ...proposal(7), id: "proof-debt:W1-T7" }];
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals }));
  const storedProposal = proposals[0]!;
  const stored = { ...plainTemplate(storedProposal), sourceFingerprint: plainSourceFingerprint(storedProposal) };
  const plainStore = { [storedProposal.id]: stored };
  writeFileSync(plainStorePath(stateDir), JSON.stringify(plainStore));
  const rows = [
    { step: "panel.proposal_declined", task_id: proposal(1).id, reason: "first" },
    { step: "panel.proposal_restored", task_id: proposal(1).id },
    { step: "panel.proposal_declined", task_id: proposal(1).id, reason: "again" },
    { step: "panel.proposal_declined", task_id: proposal(2).id, reason: "" },
    { step: "panel.proposal_declined", task_id: proposal(3).id },
    { step: "panel.proposal_declined", task_id: proposal(4).id, reason: 42 },
    { step: "panel.proposal_declined", task_id: proposal(5).id, reason: "old" },
    { step: "panel.proposal_restored", task_id: proposal(5).id },
    { step: "panel.proposal_declined", task_id: [proposal(6).id], reason: "ignored" },
    { step: "ratify.approved", task_id: proposal(1).id },
    { step: "ratify.approved", task_id: proposal(6).id },
  ];
  writeFileSync(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const items = registryThreadItems(stateDir, ledgerPath);
  assert.deepEqual(items, proposals.slice(0, 6).map((p) => ({
    proposalId: p.id, summary: p.summary, plain: plainInboxMessage(p, plainStore),
    state: [1, 2, 3, 4].some((n) => p.id === proposal(n).id) ? "declined" : "ready",
  })));
  assert.deepEqual(items[0]!.plain, stored, "the current plain-store entry is served intact");
  appendFileSync(ledgerPath, JSON.stringify({ step: "panel.proposal_restored", task_id: proposal(1).id }) + "\n");
  assert.equal(registryThreadItems(stateDir, ledgerPath).find((item) => item.proposalId === proposal(1).id)!.state, "ready");
});

test(`${proof}: absent ledger and stores preserve ready items and template output`, (t) => {
  const { stateDir, ledgerPath } = fixture(t);
  assert.deepEqual(registryThreadItems(stateDir, ledgerPath), []);
  const p = proposal(1);
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: [p] }));
  assert.deepEqual(registryThreadItems(stateDir, ledgerPath), [{
    proposalId: p.id, summary: p.summary, plain: plainTemplate(p), state: "ready",
  }]);
});

test(`${proof}: fixed-ledger row inspections are independent of proposal count`, (t) => {
  const { stateDir, ledgerPath } = fixture(t);
  const rows = Array.from({ length: 40 }, (_, n) => ({
    countedLedgerRow: true, task_id: proposal(n).id, step: "panel.proposal_declined", reason: "wait",
  }));
  writeFileSync(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const parse = JSON.parse;
  let inspections = 0;
  let parsedRows = 0;
  const countedParse = t.mock.method(JSON, "parse", (text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    const value = parse(text, reviver);
    if (value?.countedLedgerRow === true) {
      parsedRows++;
      for (const field of ["task_id", "step", "reason"]) {
        const original = value[field];
        Object.defineProperty(value, field, { get: () => { inspections++; return original; } });
      }
    }
    return value;
  });
  try {
    const measure = (count: number) => {
      writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({
        proposals: Array.from({ length: count }, (_, n) => proposal(n)),
      }));
      inspections = 0;
      parsedRows = 0;
      const items = registryThreadItems(stateDir, ledgerPath);
      assert.equal(items.length, count);
      assert.ok(items.every((item) => item.state === "declined"));
      assert.equal(parsedRows, rows.length, "the real fixed ledger was parsed exactly once");
      assert.ok(inspections > 0, "positive control: verdict evaluation inspected ledger fields");
      return inspections;
    };
    const one = measure(1);
    assert.equal(measure(30), one, "adding proposals must not multiply fixed-ledger inspections");
  } finally {
    countedParse.mock.restore();
  }
});
