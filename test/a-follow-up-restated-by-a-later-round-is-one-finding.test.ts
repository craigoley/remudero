/**
 * test/a-follow-up-restated-by-a-later-round-is-one-finding.test.ts — W1-T9103.
 *
 * A follow-up restated by a later round of its own run is one finding to the fleet lane, and a shared task id alone no
 * longer merges two (operator ruling 2026-10-13). The fixtures are the 2026-10-13 ledger's pairs: two rounds of one run
 * on PR #6382 and two on PR #6874, and the two entries of one report row on PR #6562.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fleetLaneStorePath, readFleetLaneStore, triageFleetLaneAsync, writeClassificationSnapshot, type Sameness } from "#src/lib/fleet-lane.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const PR = (n: number) => `https://github.com/craigoley/remudero/pull/${n}`;
const mint = (text: string, task: string, run: string, pr: number) => `follow-up harvest [task]: ${text} — from ${task} (run ${run}, ${PR(pr)})`;

interface Item { id: string; text: string; task?: string; run: string; pr: number }
const item = (run: string, ts: string, index: number, text: string, pr: number, task = "W1-T6000"): Item => ({ id: `followup:${run}:${ts}:${index}`, text, task, run, pr });

const R6382 = "DAEMON-1789988067712";
const A6382 = item(R6382, "2026-09-21T11:36:12.220Z", 0, "seed scripts/test-tier-manifest.json for test/gate-posture-production-adapter.test.ts", 6382);
const B6382 = item(R6382, "2026-09-21T11:46:50.359Z", 0, "also seed scripts/test-tier-manifest.json, since coverage-ratchet needs the new test listed", 6382);
const R6874 = "DAEMON-1790195083951";
const A6874 = item(R6874, "2026-09-23T20:44:02.312Z", 1, "escalate the recurring runner-pool certificate failure to the operator", 6874);
const B6874 = item(R6874, "2026-09-23T20:49:00.333Z", 1, "raise a human ask: the runner pool keeps failing its TLS certificate check", 6874);
const R6562 = "DAEMON-1790081891181";
const A6562 = item(R6562, "2026-09-22T13:57:41.950Z", 0, "teach diff-class.mjs a docs lane", 6562);
const B6562 = item(R6562, "2026-09-22T13:57:41.950Z", 1, "teach the CLAUDE.md budget ratchet about the diff class", 6562);

function lane(items: Item[], drafted: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t9103-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "inbox-proposals.json"), JSON.stringify({ proposals: items.map((i) => ({ id: i.id, summary: mint(i.text, i.task ?? "W1-T6000", i.run, i.pr), evidenceAnchors: [] })) }));
  writeFileSync(join(stateDir, "inbox-drafts.json"), JSON.stringify(Object.fromEntries(drafted.map((id) => [id, { proposalId: id, fragmentYaml: "[]", stampLine: "", anchorFingerprint: "" }]))));
  writeClassificationSnapshot(stateDir, items.map((i) => ({ proposalId: i.id, state: "ready" })));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  const calls: Array<[string, string]> = [];
  const approved: string[] = [];
  let answer: Sameness = "distinct";
  const pass = (merged = 0) => triageFleetLaneAsync({
    stateDir, ledgerPath, mergedLastDay: () => merged, approve: (id) => void approved.push(id),
    sameFinding: (earlier, later) => { calls.push([earlier, later]); return answer; },
  });
  const ledger = () => {
    try {
      return readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  };
  return { root, stateDir, calls, approved, pass, ledger, answer: (a: Sameness) => { answer = a; } };
}

test("W1-T9103: a later round naming the same path is one finding", async (t) => {
  const f = lane([A6382, B6382]);
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const pass = await f.pass();
  assert.deepEqual(pass.merged, [A6382.id], "the earlier round is folded into the later one");
  assert.deepEqual(f.calls, [], "a shared path needs no judge");
  const decided = f.ledger().filter((l) => l.step === "fleet_lane.decided");
  assert.deepEqual(decided.map((d) => [d.task_id, d.decision, d.into]), [[A6382.id, "merge", B6382.id]]);
  assert.ok(f.ledger().some((l) => l.step === "panel.proposal_declined" && l.task_id === A6382.id));
  assert.equal(readFleetLaneStore(f.stateDir)[B6382.id], undefined, "the later finding stays open");
});

test("W1-T9103: the judge merges a restatement in other words", async (t) => {
  const f = lane([A6874, B6874]);
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.answer("same");
  const pass = await f.pass();
  assert.deepEqual(pass.merged, [A6874.id]);
  assert.equal(f.calls.length, 1);
  assert.ok(!f.calls[0]![0].includes("follow-up harvest") && !f.calls[0]![1].includes("— from"), "the judge sees both texts with the minted affix stripped");
  assert.deepEqual(f.calls[0], [A6874.text, B6874.text], "earlier first, later second");
  assert.equal(readFleetLaneStore(f.stateDir)[A6874.id]?.decision, "merge");
});

test("W1-T9103: entries of one report row stay distinct", async (t) => {
  const f = lane([A6562, B6562]);
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.answer("same");
  const pass = await f.pass();
  assert.deepEqual(pass.merged, [], "two entries of one row are distinct by construction");
  assert.deepEqual(f.calls, [], "and are never offered to the judge");
  const same = lane([
    item(R6562, "2026-09-22T13:57:41.950Z", 0, "teach scripts/diff-class.mjs a docs lane", 6562),
    item(R6562, "2026-09-22T13:57:41.950Z", 1, "teach scripts/diff-class.mjs a docs lane again", 6562),
  ]);
  t.after(() => rmSync(same.root, { recursive: true, force: true }));
  assert.deepEqual((await same.pass()).merged, [], "not even a shared path merges entries of one row");
});

test("W1-T9103: a pair is judged once and an unavailable judge merges nothing", async (t) => {
  const f = lane([A6874, B6874]);
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.answer("unavailable");
  assert.deepEqual((await f.pass()).merged, []);
  assert.equal(f.calls.length, 1);
  const rows = f.ledger().filter((l) => l.step === "fleet_lane.sameness_unavailable");
  assert.equal(rows.length, 1, "the unavailable answer is named in the ledger");
  assert.equal(rows[0]!.earlier, A6874.id);
  assert.equal(rows[0]!.task_id, B6874.id);
  assert.equal(existsSync(fleetLaneStorePath(f.stateDir)), false, "unavailable stores nothing");
  f.answer("distinct");
  assert.deepEqual((await f.pass()).merged, []);
  assert.equal(f.calls.length, 2, "an unavailable pair is asked again");
  await f.pass();
  await f.pass();
  assert.equal(f.calls.length, 2, "a stored verdict is never asked again");
  assert.equal(JSON.parse(readFileSync(fleetLaneStorePath(f.stateDir), "utf8"))["fleet-lane:sameness"][`${A6874.id} ${B6874.id}`], "distinct");
  assert.deepEqual(Object.keys(readFleetLaneStore(f.stateDir)), [], "the verdict is not a decision about any finding");
  const lost = lane([A6874, B6874]);
  t.after(() => rmSync(lost.root, { recursive: true, force: true }));
  const thrower = await triageFleetLaneAsync({
    stateDir: lost.stateDir, ledgerPath: lost.stateDir + "/ledger.ndjson", mergedLastDay: () => 0, approve: () => {},
    sameFinding: () => { throw new Error("no provider"); },
  });
  assert.deepEqual(thrower.merged, [], "a judge that throws merges nothing");
  assert.equal(lost.ledger().filter((l) => l.step === "fleet_lane.sameness_unavailable").length, 1);
});

test("W1-T9103: two distinct asks naming one task stay two items", async (t) => {
  const first = item("W1-T6000-run-a", "2026-10-01T08:00:00.000Z", 0, "add a retry to the fetch in the poller", 7001);
  const second = item("W1-T6000-run-b", "2026-10-02T08:00:00.000Z", 0, "document the poller's timeout in the runbook", 7002);
  const f = lane([first, second], [first.id]);
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  f.answer("distinct");
  const pass = await f.pass(5);
  assert.deepEqual(pass.merged, [], "a shared task id alone does not merge (operator ruling 2026-10-13)");
  assert.equal(f.calls.length, 1, "the pair goes to the judge");
  assert.deepEqual(pass.filed, [first.id], "the drafted ask is filed");
  assert.equal(readFleetLaneStore(f.stateDir)[second.id], undefined, "the other ask is still its own open item");
});

test("W1-T9103: two asks naming one task and one file merge", async (t) => {
  const first = item("W1-T6000-run-a", "2026-10-01T08:00:00.000Z", 0, "fix the off-by-one in src/lib/poller.ts", 7001);
  const second = item("W1-T6000-run-b", "2026-10-02T08:00:00.000Z", 0, "src/lib/poller.ts also drops the last page", 7002);
  const f = lane([first, second]);
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const pass = await f.pass();
  assert.deepEqual(pass.merged, [first.id], "the later report's finding is kept");
  assert.deepEqual(f.calls, [], "a shared path needs no judge");
});
