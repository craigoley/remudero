/**
 * W1-T13680 criterion 6: the migration preview refuses, each with its named reason, one whose refs/rmd-id ref is absent from the public repo, and one whose closed, unmerged
 * mover pull request added its unchanged public blob, then names the next eligible task with its exact bytes and
 * permission not_granted. The preview runs over two real Git origins (test/helpers/plan-move-world.ts): once in
 * process through the selection the CLI prints, once as the real verb through the CLI's own GitHub read (a gh shim).
 */
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { previewPlanTaskMigration, selectPlanTaskMigration } from "#src/lib/plan-task-migration.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { OPS, PUBLIC, moveWorld, record, shard } from "#test/helpers/plan-move-world.js";

// W1-T14875: the closed copy's ops-gate run is unread here, so every record in it stays refused, as before.
const UNREAD_GATE = async () => undefined;
// Reverse dispatch order reads the highest priority number first, so each refusal is met before the eligible task.
const at = (id: string, priority: number, extra = "") => record(id, extra).replace("priority: 1", `priority: ${priority}`);
const RECORDS = {
  "W1-T11": at("W1-T11", 9).replace("status: queued", "status: blocked"),
  "W1-T12": at("W1-T12", 8).replace("verify: auto", "verify: human"),
  "W1-T13": at("W1-T13", 7),
  "W1-T14": at("W1-T14", 6),
  "W1-T15": at("W1-T15", 5),
};

test("W1-T13680 criterion 6: the preview refuses not_queued, verify_human, reservation_absent and move_refused, and names the next eligible task", async t => {
  const w = moveWorld(t, RECORDS);
  w.pub.origin.git("update-ref", "-d", "refs/rmd-id/W1-T13");
  const blob = w.pub.origin.git("rev-parse", `main:${shard("W1-T14")}`);
  const refusal = w.openPull("ops", { head: "plan-move-W1-T14-1795000000000", state: "CLOSED",
    body: `Remudero-Move-Copy: W1-T14 path=${shard("W1-T14")} blob=${blob} from=remudero@${w.main("public")}\n` });
  for (const side of ["public", "ops"] as const) w.sides[side].clone.git("fetch", "--quiet", "origin");
  const o = { publicRoot: w.pub.clone.dir, publicCommit: w.main("public"), publicRepo: PUBLIC, opsRoot: w.ops.clone.dir, opsCommit: w.main("ops"), opsRepo: OPS };
  const previous = new Map([...Object.keys(w.env), "PATH", "HOME", "RMD_GH_CACHE_HOME", "RMD_SELF_SYNC_DONE"].map(key => [key, process.env[key]]));
  const restore = () => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  Object.assign(process.env, w.env);
  try {
    const selection = await selectPlanTaskMigration(o, async query => w.answer(query), {}, undefined, UNREAD_GATE);
    const refused = new Map(selection.refused.map(r => [r.id, r.reason]));
    // W1-T14345 (operator ruling 2026-11-22): a blocked record is open, so it is admitted, not refused not_queued.
    assert.equal(refused.get("W1-T11"), undefined);
    // W1-T14425 replaces the W1-T13680 contract that refused verify_human: an open verify:human record is admitted, since a release survives the move (W1-T14408).
    assert.equal(refused.get("W1-T12"), undefined);
    assert.equal(refused.get("W1-T13"), "reservation_absent");
    assert.equal(refused.get("W1-T14"), "move_refused");
    assert.equal(selection.outcome, "candidate");
    assert.equal(selection.permission, "not_granted");
    // W1-T14345: the selection is a batch of every eligible task; filed in one commit, they keep reverse dispatch order.
    assert.equal(selection.candidate?.id, "W1-T11");
    assert.deepEqual(selection.batch.map(member => member.id), ["W1-T11", "W1-T12", "W1-T15"]);
    assert.equal(selection.batch[2]?.yaml, RECORDS["W1-T15"]);
    assert.equal(selection.batch[2]?.originalBytesBase64, Buffer.from(RECORDS["W1-T15"]).toString("base64"));

    // Positive control for move_refused: a refused copy of a DIFFERENT blob does not refuse today's record.
    refusal.body = refusal.body.replace(blob, "f".repeat(40));
    const changed = await selectPlanTaskMigration(o, async query => w.answer(query), {}, undefined, UNREAD_GATE);
    assert.deepEqual(changed.batch.map(member => member.id), ["W1-T11", "W1-T12", "W1-T14", "W1-T15"]);

    // The real verb, reading GitHub through its own default reader (a gh shim answering the same model).
    refusal.body = refusal.body.replace("f".repeat(40), blob);
    const answer = join(w.root, "answer.json");
    writeFileSync(answer, JSON.stringify(w.answer("")));
    const shim = ghShim([{ when: "api graphql", stdoutFile: answer }, { when: "", exit: 97, stderr: "unexpected GitHub call" }]);
    t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
    const home = join(w.root, "home");
    Object.assign(process.env, { PATH: `${shim.dir}:${process.env.PATH}`, HOME: home, RMD_GH_CACHE_HOME: home, RMD_SELF_SYNC_DONE: "1" });
    const logs: string[] = [];
    const log = console.log;
    console.log = (...values: unknown[]) => { logs.push(values.join(" ")); };
    let status: number;
    try { status = await previewPlanTaskMigration(Object.entries(o).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, value])); }
    finally { console.log = log; }
    assert.equal(status, 0, logs.join("\n"));
    const printed = JSON.parse(logs.join("\n"));
    assert.equal(printed.permission, "not_granted");
    assert.equal(printed.candidate.id, "W1-T11");
    assert.deepEqual(printed.refused.filter((r: { id: string }) => ["W1-T11", "W1-T12", "W1-T13", "W1-T14"].includes(r.id)).map((r: { reason: string }) => r.reason),
      ["reservation_absent", "move_refused"]);
    // W1-T14875: the verb also asks what the closed copy's ops-gate run named; the shim refuses that read, so it stays refused.
    const gateRead = `api repos/${OPS}/pulls/${refusal.number}`;
    assert.ok(shim.calls().filter(call => call.startsWith("api graphql ")).length >= 2 && shim.calls().every(call => call.startsWith("api graphql ") || call === gateRead), "positive control: the verb read GitHub through the shim");
    // Unread evidence is UNKNOWN with permission not_granted, and bad usage is refused before any read.
    writeFileSync(answer, JSON.stringify({ errors: [{ message: "rate limited" }] }));
    logs.length = 0;
    console.log = (...values: unknown[]) => { logs.push(values.join(" ")); };
    let unknownStatus: number, usageStatus: number;
    try {
      unknownStatus = await previewPlanTaskMigration(Object.entries(o).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, value]));
      usageStatus = await previewPlanTaskMigration(["--public-root"]);
    } finally { console.log = log; }
    assert.deepEqual([unknownStatus, usageStatus], [1, 2]);
    assert.deepEqual(logs.map(line => JSON.parse(line)), [
      { outcome: "unknown", reason: "api_unreadable", permission: "not_granted" },
      { outcome: "unknown", reason: "usage", permission: "not_granted" },
    ]);
  } finally {
    restore();
  }
});
