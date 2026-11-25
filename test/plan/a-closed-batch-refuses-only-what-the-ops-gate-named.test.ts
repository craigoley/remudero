/**
 * W1-T14875 — a closed mover batch refuses only the records its failed ops-gate run named (operator ruling 2026-11-25
 * 20:31Z). OBSERVED 2026-11-25: ops #859 copied six records; its ops-gate log named only W1-T2874, yet closing it left
 * W1-T9391, W1-T9392, W1-T9876, W1-T11515 and W1-T13178 refused for good. Each run drives movePlanTask over two real
 * Git origins (test/helpers/plan-move-world.ts); the gate's job log is the real #859 log's ops-gate step, trimmed.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as migration from "#src/lib/plan-task-migration.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { moveWorld, OPS, record, shard, type MoveWorld } from "#test/helpers/plan-move-world.js";

type Named = (repository: string, pull: number) => Promise<ReadonlySet<string> | undefined>;
// Namespace read: this file loads on a base without the new exports, so each test fails on its own assertion.
const api = migration as unknown as { opsGateNamedPaths?: (log: string) => ReadonlySet<string> | undefined; opsGateNamedRead?: Named };

/** The ops-gate step of a job log naming `paths`, as the gate printed it on ops #859. */
const gateLog = (paths: string[], findings = paths.length) => [
  "2026-11-25T17:34:05.4728183Z Finished in 1.594085s, 112.9175 runs/s, 596.5805 assertions/s.",
  "2026-11-25T17:34:05.4811107Z ##[group]Run ruby scripts/ops-gate.rb",
  "2026-11-25T17:34:05.4811326Z \u001b[36;1mruby scripts/ops-gate.rb\u001b[0m",
  "2026-11-25T17:34:05.4838331Z env:",
  "2026-11-25T17:34:05.4838458Z   OPS_GATE_BASE: HEAD^1",
  "2026-11-25T17:34:05.4838598Z ##[endgroup]",
  ...paths.map(p => `2026-11-25T17:34:10.8240115Z ${p}: acceptance item 7 has a 'proof' that does not start with 'unit test:' or 'grep:'; repair this record in the public repo, then move it`),
  "2026-11-25T17:34:10.8243996Z ops-gate: FAIL",
  "2026-11-25T17:34:10.8244419Z records read: 1325",
  `2026-11-25T17:34:10.8249621Z findings: ${findings} (shape ${findings}, unique 0, reserved 0, public-duplicate 0, dependency 0, feedback 0, decision 0, leak 0)`,
  "2026-11-25T17:34:10.8250572Z plan-review: PASS",
  "2026-11-25T17:34:10.8370691Z ##[error]Process completed with exit code 1.",
].join("\n");

/** A closed copy pull request on ops whose receipts name each id at its current public blob. */
function closedBatch(w: MoveWorld, ids: string[]) {
  const receipts = ids.map(id => `Remudero-Move-Copy: ${id} path=${shard(id)} blob=${w.pub.origin.git("rev-parse", `main:${shard(id)}`)} from=remudero@${w.main("public")}`);
  return w.openPull("ops", { head: "plan-move-batch-1795626384482", state: "CLOSED", body: `Each public record, byte for byte.\n\n${receipts.join("\n")}\n` });
}
const copied = (w: MoveWorld) => {
  const pr = w.pulls.at(-1)!;
  return w.sides[pr.repository].origin.git("diff", "--name-only", `main...${pr.head}`).split("\n").filter(Boolean).sort();
};

test("W1-T14875 criterion 1: a closed batch refuses only the record its ops-gate run named; the rest move", async t => {
  const w = moveWorld(t, { "W1-T1": record("W1-T1"), "W1-T2": record("W1-T2"), "W1-T3": record("W1-T3") });
  const batch = closedBatch(w, ["W1-T1", "W1-T2", "W1-T3"]);
  const asked: number[] = [];
  const opsGateNamed: Named = async (repository, pull) => { assert.equal(repository, OPS); asked.push(pull); return new Set([shard("W1-T2")]); };
  const run = await w.run(true, { opsGateNamed });
  assert.equal(run.out.step, "copy", run.lines.join("\n"));
  assert.deepEqual(copied(w), [shard("W1-T1"), shard("W1-T3")].sort(), "THE CLAIM: the unnamed members are copied, the named one is not");
  assert.ok(asked.length > 0 && asked.every(n => n === batch.number), "the reader was asked about the closed batch");
});

test("W1-T14875 criterion 2: invariant:an-unread-gate-keeps-the-whole-batch-refused", async t => {
  for (const [why, answer] of [
    ["unread", async () => undefined],
    ["failed read", async () => { throw new Error("HTTP 401"); }],
  ] as const) {
    const w = moveWorld(t, { "W1-T1": record("W1-T1"), "W1-T2": record("W1-T2"), "W1-T3": record("W1-T3") });
    const batch = closedBatch(w, ["W1-T1", "W1-T2"]);
    const asked: number[] = [];
    const opsGateNamed: Named = async (_repository, pull) => { asked.push(pull); return answer(); };
    const run = await w.run(true, { opsGateNamed });
    assert.equal(run.out.step, "copy", `${why}: ${run.lines.join("\n")}`);
    // The refusal is the reader's answer: the mover asked what the gate named and kept the batch because it could not tell.
    assert.ok(asked.length > 0 && asked.every(n => n === batch.number), `${why}: the mover asked the gate reader about the closed batch`);
    assert.deepEqual(copied(w), [shard("W1-T3")], `THE CLAIM (${why}): every member of the batch stays refused`);
  }
});

test("W1-T14875 criterion 3: the gate's job log names its records only when it reads whole", () => {
  const parse = api.opsGateNamedPaths!;
  const p = "plan/tasks.d/W1-T2874-fresh-heartbeat-greenlights-an-exhausted-dead-container.yaml";
  assert.deepEqual([...parse(gateLog([p]))!], [p], "THE CLAIM: the #859 log names W1-T2874 alone");
  assert.deepEqual([...parse(gateLog([p, p]))!], [p], "two findings on one record name it once");
  assert.equal(parse(gateLog([p], 3)), undefined, "a count that disagrees with the finding lines reads nothing");
  assert.equal(parse(gateLog(["deploy/entrypoint.sh"])), undefined, "a finding on a non-record names no record, so nothing is read");
  assert.equal(parse(gateLog([])), undefined, "a FAIL with no finding line reads nothing");
  assert.equal(parse(gateLog([p]).replace("ops-gate: FAIL", "ops-gate: PASS")), undefined, "a passing gate named nothing");
  assert.equal(parse(gateLog([p]).replace("##[group]Run ruby scripts/ops-gate.rb", "##[group]Run something else")), undefined, "no gate step, no reading");
  assert.equal(parse(gateLog([p]).replace(/##\[endgroup\]/, "")), undefined, "a step whose output never starts reads nothing");
});

test("W1-T14875: the live reader follows the pull request to its one failed ops-gate job log", async t => {
  const read = api.opsGateNamedRead!;
  const dir = join(process.env.TMPDIR ?? "/tmp", `rmd-gate-named-${process.pid}`);
  const p = shard("W1-T2");
  const files = { pull: join(dir, "pull.json"), runs: join(dir, "runs.json"), one: join(dir, "one.json"), none: join(dir, "none.json"), log: join(dir, "log.txt") };
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(files.pull, JSON.stringify({ number: 859, head: { sha: "c".repeat(40) } }));
  writeFileSync(files.one, JSON.stringify({ total_count: 2, check_runs: [{ id: 139388529414, name: "ops-gate", conclusion: "failure" }, { id: 7, name: "ops-gate", conclusion: "cancelled" }] }));
  writeFileSync(files.none, JSON.stringify({ total_count: 1, check_runs: [{ id: 8, name: "ops-gate", conclusion: "success" }] }));
  writeFileSync(files.log, gateLog([p]));
  const previous = new Map(["PATH", "HOME", "RMD_GH_CACHE_HOME", "RMD_SELF_SYNC_DONE"].map(k => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const shimmed = (runs: string) => {
    const shim = ghShim([
      { when: `api repos/${OPS}/pulls/859`, stdoutFile: files.pull },
      { when: `api repos/${OPS}/commits/${"c".repeat(40)}/check-runs`, stdoutFile: runs },
      { when: `api repos/${OPS}/actions/jobs/139388529414/logs`, stdoutFile: files.log },
      { when: "", exit: 97, stderr: "unexpected GitHub call" },
    ]);
    t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
    Object.assign(process.env, { PATH: `${shim.dir}:${previous.get("PATH")}`, HOME: dir, RMD_GH_CACHE_HOME: dir, RMD_SELF_SYNC_DONE: "1" });
    return shim;
  };
  const shim = shimmed(files.one);
  assert.deepEqual([...(await read(OPS, 859))!], [p], "THE CLAIM: the failed run's log names the record");
  assert.equal(shim.calls().filter(c => c.includes("/logs")).length, 1, "positive control: the job log was read through gh");
  shimmed(files.none);
  assert.equal(await read(OPS, 859), undefined, "no failed ops-gate run: the gate named nothing");
});
