import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as review from "../src/lib/review.js";
import * as reservation from "../src/lib/task-id-reservation.js";
import { gitRepo } from "./helpers/git-repo.js";

const gate = await import(new URL("../scripts/task-id-existence-check.mjs", import.meta.url).href);
const ID = "W1-T96076";
const REF = `refs/rmd-id/${ID}`;
const FILE = `plan/tasks.d/${ID}-fixture.yaml`;
const A = "codex/portable-fixture-plan-1791286800000";
const B = "file-followups2-1791286555509";
const C = "run-third-reclaimer";
const START = "2026-10-06T11:36:25.567Z";

function message(branch: string, elapsed: number, parent?: string): string {
  return reservation.formatReservationAnchorMessage({
    branch, pid: branch === A ? 51234 : 70707, host: branch === A ? "Mac-mini" : "Remudero",
    startedAt: new Date(Date.parse(START) + elapsed).toISOString(),
    source: parent === undefined ? "automatic" : "reclaimed", takenOverFrom: parent,
  });
}

function fixture(messages: string[]) {
  const origin = gitRepo({ bare: true, kind: "holder-chain-origin" });
  const work = gitRepo({ kind: "holder-chain-work" });
  work.addRemote("origin", origin.dir);
  work.git("push", "--quiet", "origin", "main");
  const tree = work.git("hash-object", "-t", "tree", "/dev/null");
  let sha: string | undefined;
  for (const body of messages.toReversed()) {
    sha = work.git("commit-tree", tree, ...(sha ? ["-p", sha] : []), "-m", body);
  }
  work.git("push", "--quiet", "origin", `${sha}:${REF}`);
  const run = (args: string[]) => {
    const result = spawnSync("git", ["-C", work.dir, ...args], { encoding: "utf8" });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
  };
  return { work, run };
}

async function assertParity(messages: string[], winner: string, filers: string[]) {
  const { work, run } = fixture(messages);
  const sync = reservation.readReservationAnchors([ID], run);
  const awaited = await reservation.readReservationAnchorsAsync([ID], reservation.gitReservationRunnerAsync(work.dir));
  assert.deepEqual(awaited, sync);
  const anchor = sync.get(ID);
  assert.equal(anchor?.status, "present");
  if (anchor?.status !== "present") throw new Error("anchor missing");
  assert.equal(anchor.message.trim(), messages[0]);
  const record = gate.readReservationHolderRecord("origin", work.dir, REF);
  const adjudicated = gate.adjudicateReservationHolder(record);
  assert.equal(adjudicated.holder.branch, winner);
  const reserved = gate.resolveReservedIds("origin", work.dir, { readHoldersFor: new Set([ID]) });
  for (const filer of filers) {
    const diff = `diff --git a/${FILE} b/${FILE}\n+++ b/${FILE}\n@@\n+- id: ${ID}\n`;
    mkdirSync(join(work.dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(work.dir, FILE), `- id: ${ID}\n`);
    const findings = review.taskIdOwnershipFindings(diff, [{ id: ID, file: FILE }], [], filer, work.dir);
    assert.deepEqual(await review.taskIdOwnershipFindingsAsync(diff, [{ id: ID, file: FILE }], [], filer, work.dir), findings);
    const conflicts = gate.evaluateReservationHolderConflicts([ID], new Map([[ID, [{ file: FILE, line: 1 }]]]), reserved, filer, work.dir);
    if (filer === winner) {
      assert.deepEqual(findings, []);
      assert.deepEqual(conflicts, []);
    } else {
      assert.deepEqual(findings, [{ id: ID, file: FILE, kind: "foreign", holder: winner }]);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].holderBranch, winner);
    }
  }
  assert.deepEqual(anchor.chain?.map((body) => body.trim()), messages);
  if (adjudicated.takeover?.winner === "original") {
    const loser = adjudicated.takeover.reclaimer.branch;
    const note = gate.reservationHandoffNoteLine(winner, loser);
    const diff = `diff --git a/${FILE} b/${FILE}\n+++ b/${FILE}\n@@\n+- id: ${ID}\n+  note: |\n+    ${note}\n`;
    writeFileSync(join(work.dir, FILE), `- id: ${ID}\n  note: |\n    ${note}\n`);
    assert.deepEqual(review.taskIdOwnershipFindings(diff, [{ id: ID, file: FILE }], [], loser, work.dir), [{ id: ID, file: FILE, kind: "foreign", holder: winner }]);
    assert.equal(gate.evaluateReservationHolderConflicts([ID], new Map([[ID, [{ file: FILE, line: 1 }]]]), reserved, loser, work.dir).length, 1);
  }
}

test("test/the-review-holder-check-reads-the-whole-takeover-chain.test.ts proves holder parity", async () => {
  await assertParity([message(B, 14_749, A), message(A, 0)], A, [A, B]);
  await assertParity([message(C, 44_749, B), message(B, 14_749, A), message(A, 0)], A, [A, B, C]);
  await assertParity([message(B, reservation.RESERVATION_PUSH_GRACE_MS, A), message(A, 0)], B, [A, B]);
  // C is inside B's grace but past A's: measure against the rightful holder.
  await assertParity([message(C, reservation.RESERVATION_PUSH_GRACE_MS + 1, B), message(B, 14_749, A), message(A, 0)], C, [A, B, C]);
});

test("an unweighable takeover chain keeps its head", () => {
  const parse = (body: string) => ({ holder: gate.parseReservationHolderLine(body), fields: gate.parseReservationHolderFields(body) });
  const head = parse(message(C, 44_749, B));
  const root = parse(message(A, 0));
  for (const body of [
    message(B, 14_749), message("main", 14_749, A), message("unknown", 14_749, A),
    message(B, 14_749, "someone-else"),
    "rmd-id holder branch=file-followups2-1791286555509 source=reclaimed taken_over_from=codex%2Fportable-fixture-plan-1791286800000 started_at=bad-time",
    "legacy reservation", "", "rmd-id holder branch=%zz",
  ]) {
    assert.deepEqual(gate.adjudicateReservationChain([head, parse(body), root]), head);
  }
  assert.deepEqual(gate.adjudicateReservationChain([head]), head);
  assert.deepEqual(gate.adjudicateReservationChain([]).holder.status, "unreadable");
});

test("an empty legacy commit remains a link and makes the chain unweighable", async () => {
  await assertParity([message(C, 44_749, B), "", message(A, 0)], C, [A, B, C]);
});

test("both reservation readers bound their first-parent log to sixteen links", async () => {
  const messages = Array.from({ length: 18 }, (_, i) => message(`run-${i}`, i * 1000, i ? `run-${i - 1}` : undefined)).toReversed();
  const { work, run } = fixture(messages);
  const calls: string[][] = [];
  const counted = (args: string[]) => { calls.push(args); return run(args); };
  const sync = reservation.readReservationAnchors([ID], counted).get(ID);
  const awaited = (await reservation.readReservationAnchorsAsync([ID], async (args) => counted(args))).get(ID);
  assert.deepEqual(awaited, sync);
  assert.equal(sync?.status, "present");
  if (sync?.status !== "present") throw new Error("anchor missing");
  assert.equal(sync.chain?.length, 16);
  const record = gate.readReservationHolderRecord("origin", work.dir, REF, (args: string[]) => counted(args));
  assert.equal(record.chain.length, 16);
  const logs = calls.filter((args) => args[0] === "log");
  assert.equal(logs.length, 3);
  for (const args of logs) assert.deepEqual(args.slice(0, -1), ["log", "--first-parent", "-n", "16", "--format=%B%x00"]);
});

test("reservation chain read failures retain their stated unknown outcomes", () => {
  const failure = { status: 128, stdout: "", stderr: "log refused" };
  for (const failedCommand of ["fetch", "log"]) {
    const record = gate.readReservationHolderRecord("origin", "/unused", REF, (args: string[]) => args[0] === failedCommand ? failure : { status: 0, stdout: "", stderr: "" });
    assert.equal(record.holder.status, "unreadable");
    assert.equal(record.holder.reason, `could not ${failedCommand === "fetch" ? "fetch" : "read"} ${REF}`);
  }
});
