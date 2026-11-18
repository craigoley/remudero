/**
 * W1-T13680 criteria 1, 2 and 10: `rmd move-task` lands the ops copy first, opens the public removal only after
 * that copy is verified on ops main, never credits the moved task as built, and leaves the public reservation ref
 * exactly where it was. Each run drives movePlanTask over two real Git origins (test/helpers/plan-move-world.ts).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { movePlanTask } from "#src/lib/plan-task-move.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { blobAt, moveWorld, OPS, PUBLIC, record, shard, type MoveRun, type MoveWorld } from "#test/helpers/plan-move-world.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ID = "W1-T1";
const ORIGINAL = record(ID, "  files: [src/lib/moved.ts]\n");
const copyOf = (text: string, commit: string) => text.replace(`- id: ${ID}\n`, `- id: ${ID}\n  moved_from: remudero@${commit}\n`);
const opened = (w: MoveWorld, run: MoveRun) => w.pulls.filter(pr => pr.number === run.out.pullRequest);

/** Every mover write carries no build credit: no run- branch, no Remudero-Task line in its commits or body. */
function assertUncredited(w: MoveWorld): void {
  assert.ok(w.pulls.length > 0, "positive control: the mover opened pull requests");
  for (const pr of w.pulls) {
    assert.match(pr.head, /^plan-move-W1-T\d+-\d+$/, pr.head);
    assert.doesNotMatch(pr.head, /^run-/);
    assert.doesNotMatch(pr.body, /^Remudero-Task:/m, pr.body);
    const log = w.sides[pr.repository].origin.git("log", "--format=%B", `main..${pr.head}`) || w.sides[pr.repository].origin.git("log", "-1", "--format=%B", pr.head);
    assert.doesNotMatch(log, /^Remudero-Task:/m, log);
  }
}

test("W1-T13680 criterion 1: the ops copy lands first, and the public removal opens only once that copy is on ops main", async t => {
  const w = moveWorld(t, { [ID]: ORIGINAL });
  const publicAtCopy = w.main("public");
  const first = await w.run();
  assert.equal(first.status, 0, first.lines.join("\n"));
  assert.equal(first.out.step, "copy");
  assert.equal(w.pulls.length, 1, "one pull request in the first run");
  const [copyPr] = w.pulls;
  assert.equal(copyPr!.repository, "ops", "the first run opens no public pull request");
  assert.deepEqual(copyPr!.files, [shard(ID)], "its only change adds the shard at its public path");
  assert.equal(blobAt(w.ops.origin.dir, `${copyPr!.head}:${shard(ID)}`), copyOf(ORIGINAL, publicAtCopy),
    "the ops copy is the original bytes plus one moved_from line after the id line");
  assert.equal(w.sides.ops.origin.git("diff", "--name-status", `main...${copyPr!.head}`), `A\t${shard(ID)}`);

  // The copy is not on ops main yet: the next run waits and opens nothing.
  const waiting = await w.run();
  assert.equal(waiting.out.step, "wait");
  assert.equal(w.pulls.length, 1);

  const opsMain = w.merge(copyPr!);
  const second = await w.run();
  assert.equal(second.status, 0, second.lines.join("\n"));
  assert.equal(second.out.step, "remove");
  const [removal] = opened(w, second);
  assert.equal(removal!.repository, "public");
  assert.equal(w.sides.public.origin.git("diff", "--name-status", `main...${removal!.head}`), `D\t${shard(ID)}`,
    "its only change deletes the shard");
  const blob = w.sides.public.origin.git("rev-parse", `main:${shard(ID)}`);
  const movedTo = `Remudero-Moved-To: ${OPS}@${opsMain} ${ID} path=${shard(ID)} blob=${blob}`;
  assert.ok(w.sides.public.origin.git("log", "-1", "--format=%B", removal!.head).split("\n").includes(movedTo), "the removal commit names the ops commit, path and blob");
  assert.ok(removal!.body.split("\n").includes(movedTo), removal!.body);

  w.merge(removal!);
  const done = await w.run();
  assert.equal(done.out.step, "complete", done.lines.join("\n"));
  assert.equal(w.pulls.length, 2, "nothing opens once only ops holds the id");
  assert.ok(w.holds("ops", ID) && !w.holds("public", ID));
});

test("W1-T13680 criterion 2: no public removal opens for an ops copy that differs, or whose pull request is open, unmerged or closed; mover pull requests carry no build credit; one step per run", async t => {
  // An ops main record that differs from the bound original by one byte besides its moved_from line.
  const differs = moveWorld(t, { [ID]: ORIGINAL });
  differs.commitTo("ops", { [shard(ID)]: copyOf(ORIGINAL, differs.main("public")).replace("Move fixture", "Move fixturE") }, "a hand copy");
  const held = await differs.run();
  assert.equal(held.out.step, "held", held.lines.join("\n"));
  assert.equal(held.out.reason, "ops_copy_differs");
  assert.equal(differs.pulls.length, 0, "no pull request opens for a copy that differs");
  // The same copy byte for byte (positive control): the removal does open.
  differs.commitTo("ops", { [shard(ID)]: copyOf(ORIGINAL, differs.main("public")) }, "an exact copy");
  assert.equal((await differs.run()).out.step, "remove");

  // The ops pull request open, then closed unmerged: no public pull request either time.
  const refused = moveWorld(t, { [ID]: ORIGINAL });
  const copy = await refused.run();
  assert.equal(copy.out.step, "copy");
  assert.equal((await refused.run()).out.step, "wait");
  refused.close(refused.pulls[0]!);
  const after = await refused.run();
  assert.equal(after.out.step, "none", after.lines.join("\n"));
  assert.equal(refused.pulls.filter(pr => pr.repository === "public").length, 0, "a closed ops pull request opens no public one");

  // A whole move: every mover write is uncredited, and every run prints one step with the evidence it read.
  const whole = moveWorld(t, { [ID]: ORIGINAL });
  const runs: MoveRun[] = [await whole.run()];
  whole.merge(whole.pulls[0]!);
  runs.push(await whole.run());
  whole.merge(whole.pulls[1]!);
  runs.push(await whole.run());
  assertUncredited(whole);
  for (const [i, run] of runs.entries()) {
    assert.equal(run.lines.length, 1, `run ${i} prints one line`);
    assert.equal(typeof run.out.step, "string");
    assert.equal(run.out.publicCommit !== undefined && run.out.opsCommit !== undefined, true, "it names both commits it read");
  }
  assert.deepEqual(runs.map(run => run.out.step), ["copy", "remove", "complete"]);
  assert.ok(runs[0]!.out.evidence && runs[1]!.out.evidence, "a step prints the evidence it read");
  assert.equal(whole.pulls.length, 2, "at most one pull request per run");
  assert.deepEqual(whole.ledger.map(row => [row.step, row.move_step, row.outcome]), [["plan.move.step", "copy", "opened"], ["plan.move.step", "remove", "opened"]]);

  // Unread or changed evidence is UNKNOWN and takes no step; bad usage is refused before any read.
  const unread = moveWorld(t, { [ID]: ORIGINAL });
  const api = await unread.run(true, { graphql: async () => ({ errors: [{ message: "rate limited" }] }) });
  assert.deepEqual([api.status, api.out.step, api.out.reason], [1, "unknown", "api_unreadable"]);
  const usageLines: string[] = [];
  assert.equal(await movePlanTask(["--apply", "--apply"], { ledger: () => { throw new Error("no write"); }, print: line => { usageLines.push(line); } }), 2);
  assert.deepEqual(JSON.parse(usageLines[0]!), { step: "unknown", reason: "usage" });
  assert.equal(unread.pulls.length + unread.ledger.length, 0);

  // The real CLI: help reads nothing, and bad usage is refused by the verb itself before any read or write.
  const cli = (args: string[]) => spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(REPO_ROOT, "src/run-task.ts"), "move-task", ...args], {
    cwd: unread.root, encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH, HOME: join(unread.root, "home"), RMD_SELF_SYNC_DONE: "1", LANG: "C",
      ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}), ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) } });
  const help = cli(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /rmd move-task --public-root <path>/);
  const bad = cli(["--apply", "--apply"]);
  assert.equal(bad.status, 2, bad.stderr);
  assert.deepEqual(JSON.parse(bad.stdout.trim()), { step: "unknown", reason: "usage" });

  // Without --apply the verb prints the step it would take and writes nothing.
  const dry = moveWorld(t, { [ID]: ORIGINAL });
  const refsBefore = [dry.pub.origin.git("show-ref"), dry.ops.origin.git("show-ref")];
  const preview = await dry.run(false);
  assert.equal(preview.out.step, "copy");
  assert.equal(preview.out.would, true);
  assert.deepEqual([dry.pub.origin.git("show-ref"), dry.ops.origin.git("show-ref")], refsBefore);
  assert.equal(dry.pulls.length + dry.ledger.length + dry.preflights.length, 0);
});

test("W1-T13680 criterion 10: the public reservation ref is unchanged across a completed, a rolled-back and a restored move, and next-task-id never offers the moved id", async t => {
  // Completed.
  const done = moveWorld(t, { [ID]: ORIGINAL });
  const before = done.reservations();
  assert.match(before, /^refs\/rmd-id\/W1-T1 [0-9a-f]{40}$/);
  await done.run(); done.merge(done.pulls[0]!);
  await done.run(); done.merge(done.pulls[1]!);
  const complete = await done.run();
  assert.equal(complete.out.step, "complete");
  assert.deepEqual((complete.out.completed as Array<{ reservationUnchanged: boolean }>).map(c => c.reservationUnchanged), [true]);
  assert.equal(done.reservations(), before, "a completed move leaves refs/rmd-id/W1-T1 where it was");

  // Rolled back: the public copy is claimed after the copy lands.
  const rolled = moveWorld(t, { [ID]: ORIGINAL });
  const rolledBefore = rolled.reservations();
  await rolled.run(); rolled.merge(rolled.pulls[0]!);
  rolled.pub.origin.git("update-ref", `refs/rmd-dispatch/${ID}`, rolled.main("public"));
  assert.equal((await rolled.run()).out.step, "rollback");
  rolled.merge(rolled.pulls[1]!);
  assert.equal(rolled.reservations(), rolledBefore, "a rolled-back move leaves the reservation where it was");

  // Restored: the ops copy vanished after the public removal landed.
  const restored = moveWorld(t, { [ID]: ORIGINAL });
  const restoredBefore = restored.reservations();
  await restored.run(); restored.merge(restored.pulls[0]!);
  await restored.run(); restored.merge(restored.pulls[1]!);
  restored.commitTo("ops", { [shard(ID)]: null }, "a hand deletion");
  assert.equal((await restored.run()).out.step, "restore");
  restored.merge(restored.pulls[2]!);
  assert.equal(restored.reservations(), restoredBefore, "a restored move leaves the reservation where it was");

  // next-task-id over the public checkout after the completed move: the history scan still holds W1-T1.
  done.pub.clone.git("fetch", "--quiet", "origin");
  done.pub.clone.git("checkout", "--quiet", "-B", "main", "origin/main");
  assert.equal(done.holds("public", ID), false, "positive control: the public plan no longer declares W1-T1");
  const home = join(done.root, "home"); mkdirSync(home, { recursive: true });
  const mint = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(REPO_ROOT, "src/run-task.ts"), "next-task-id", "--offline",
    "--plan", join(done.pub.clone.dir, "plan/tasks.yaml")], { cwd: done.pub.clone.dir, encoding: "utf8", timeout: 120_000,
    env: { PATH: process.env.PATH, HOME: home, RMD_SELF_SYNC_DONE: "1", LANG: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) } });
  assert.equal(mint.status, 0, mint.stderr);
  assert.match(mint.stdout, /\bW1-T2\b/, mint.stdout);
  assert.doesNotMatch(mint.stdout.replace(/W1-T1\d/g, ""), /^W1-T1$/m, mint.stdout);
  void PUBLIC;
});

test("W1-T13680 criterion 1: the verb's default ports run the emitter's own preflight and open the ops copy through GitHub's REST create; a red preflight pushes nothing", async t => {
  // A red preflight: nothing is pushed or opened, and the row says why.
  const red = moveWorld(t, { [ID]: ORIGINAL });
  const refused = await red.run(true, { preflight: async () => ({ ok: false, failures: [{ check: "lint-plan", firstLine: "red" }], unreadable: [] }) });
  assert.equal(refused.status, 1);
  assert.equal(refused.out.outcome, "preflight_refused", refused.lines.join("\n"));
  assert.equal(red.ops.origin.git("for-each-ref", "refs/heads/plan-move-*"), "", "a refused preflight pushes no branch");
  assert.deepEqual(red.ledger.map(row => row.outcome), ["preflight_refused"]);
  assert.equal(red.pulls.length, 0);

  const w = moveWorld(t, { [ID]: ORIGINAL });
  const answer = join(w.root, "answer.json");
  writeFileSync(answer, JSON.stringify(w.answer("")));
  const created = JSON.stringify({ number: 7, html_url: `https://github.com/${OPS}/pull/7` });
  const shim = ghShim([{ when: "api graphql", stdoutFile: answer }, { when: `--method POST repos/${OPS}/pulls`, stdout: created },
    { when: "", exit: 97, stderr: "unexpected GitHub call" }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const home = join(w.root, "home"); mkdirSync(home, { recursive: true });
  const keys = ["PATH", "HOME", "RMD_GH_CACHE_HOME", "RMD_SELF_SYNC_DONE"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { PATH: `${shim.dir}:${process.env.PATH}`, HOME: home, RMD_GH_CACHE_HOME: home, RMD_SELF_SYNC_DONE: "1" });
  const logs: string[] = [];
  const log = console.log;
  try {
    // The CLI's own GitHub read, the emitter's real preflight over the exact ops commit, REST create and printer.
    console.log = (...values: unknown[]) => { logs.push(values.join(" ")); };
    const opened = await w.run(true, { graphql: undefined, createPull: undefined, preflight: undefined, print: undefined });
    console.log = log;
    assert.equal(opened.status, 0, logs.join("\n"));
    const printed = JSON.parse(logs.at(-1)!);
    assert.equal(printed.step, "copy");
    assert.equal(printed.pullRequest, 7);
    // The fixture holds none of the public lint scripts: the real preflight ran and reported its checks unreadable.
    assert.ok((w.ledger[0]!.preflight_unreadable as string[]).length > 0, JSON.stringify(w.ledger));
    // The shim logs each call's argv joined on one line, and the body's own newlines split it: read the whole log.
    const calls = shim.calls().join("\n");
    assert.equal(shim.calls().filter(call => call.startsWith("api --method POST")).length, 1, calls);
    assert.ok(calls.includes(`-f head=${printed.branch} -f base=main`), calls);
    assert.match(w.ops.origin.git("for-each-ref", "--format=%(refname)", "refs/heads/plan-move-*"), /^refs\/heads\/plan-move-W1-T1-\d+$/);
  } finally {
    console.log = log;
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
