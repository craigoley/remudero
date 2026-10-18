/**
 * test/next-task-id-reserves-several-ids-with-one-open-pr-read.test.ts — W1-T9683: `rmd next-task-id
 * --count N` reserves N ids from ONE mint (one open-PR read, one history scan) instead of N calls
 * that each spend a GitHub read slot. This file drives the reservation half in
 * src/lib/task-id-reservation.ts; the command's own output and its single open-PR read are proven
 * in test/next-task-id-reserve.test.ts, which already imports src/run-task.ts (the affected-reach
 * ratchet holds that importer count).
 *
 * A NAMESPACE import, so at a base without these exports each test fails on its own assertion
 * rather than the whole file failing to load.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import * as reservation from "#src/lib/task-id-reservation.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "#test/helpers/git-repo.js";

type Handle = reservation.RemoteReservationHandle;
type KeepingHeld = (start: number, count: number, one: (from: number) => Handle) => { held: Handle[]; error?: unknown };
type ParseCount = (rest: readonly string[]) => { count: number; explicit: boolean } | { error: string };
type DescribeHeld = (held: readonly { taskId: string }[], count: number) => { held: string; partial?: string };

function api(): { keepingHeld: KeepingHeld; parseCount: ParseCount; describeHeld: DescribeHeld } {
  const r = reservation as unknown as Record<string, unknown>;
  for (const name of ["reserveTaskIdsKeepingHeld", "parseTaskIdCount", "describeHeldTaskIds"])
    assert.equal(typeof r[name], "function", `task-id-reservation exports ${name}`);
  return {
    keepingHeld: r.reserveTaskIdsKeepingHeld as KeepingHeld,
    parseCount: r.parseTaskIdCount as ParseCount,
    describeHeld: r.describeHeldTaskIds as DescribeHeld,
  };
}

/** A reserver whose k-th push (0-based) gets `outcomeAt(k)`. */
function stubReserver(outcomeAt: (k: number) => reservation.RemoteReserveOutcome): reservation.RemoteRefReserver & { tried: string[] } {
  const tried: string[] = [];
  return {
    tried,
    mintAnchor: () => "ANCHOR-SHA",
    attempt(taskId: string) {
      tried.push(taskId);
      return outcomeAt(tried.length - 1);
    },
  };
}

test("W1-T9683: --count 3 reserves three consecutive ids, each walk starting above the last held", () => {
  const { keepingHeld, describeHeld } = api();
  const reserver = stubReserver(() => "created");
  const starts: number[] = [];
  const { held, error } = keepingHeld(500, 3, (from) => {
    starts.push(from);
    return reservation.reserveTaskIdRemote(from, reserver);
  });
  assert.equal(error, undefined);
  assert.deepEqual(held.map((h) => h.taskId), ["W1-T500", "W1-T501", "W1-T502"]);
  assert.deepEqual(starts, [500, 501, 502], "each walk starts above the id the last one held");
  assert.deepEqual(reserver.tried, ["W1-T500", "W1-T501", "W1-T502"], "one ref push per id");
  assert.deepEqual(describeHeld(held, 3), { held: "HELD 3 of 3: W1-T500 W1-T501 W1-T502" });
});

test("W1-T9683: --count parses a positive whole number and is refused beside the flags that do not reserve here", () => {
  const { parseCount } = api();
  assert.deepEqual(parseCount([]), { count: 1, explicit: false }, "absent is one id, today's output");
  assert.deepEqual(parseCount(["--count", "4", "--reserve", "--branch", "b"]), { count: 4, explicit: true });
  for (const flag of ["--offline", "--no-reserve", "--audit", "--prefix", "--repo"])
    assert.match(String((parseCount(["--count", "2", flag]) as { error: string }).error), new RegExp(`--count and ${flag} are contradictory`));
  for (const bad of ["0", "-1", "2.5", "x", "99999999999999999999"])
    assert.match(String((parseCount(["--count", bad]) as { error: string }).error), /--count needs a positive whole number/, bad);
  assert.match(String((parseCount(["--count"]) as { error: string }).error), /got nothing/);
});

test("W1-T9683: a partial --count prints only the ids it holds and exits non-zero", () => {
  const { keepingHeld, describeHeld } = api();
  // Origin answers twice, then becomes unreachable on the third id: fail-closed, and the two
  // already pushed stay held.
  const reserver = stubReserver((k) => (k === 2 ? "unreachable" : "created"));
  const { held, error } = keepingHeld(700, 3, (from) => reservation.reserveTaskIdRemote(from, reserver));
  assert.deepEqual(held.map((h) => h.taskId), ["W1-T700", "W1-T701"], "the two held ids are kept");
  assert.ok(error instanceof reservation.TaskIdReservationError, "the failure is handed back, not swallowed");
  assert.equal(error.outcome, "unreachable");
  assert.equal(reserver.tried[2], "W1-T702", "the third id was tried");
  const summary = describeHeld(held, 3);
  assert.equal(summary.held, "HELD 2 of 3: W1-T700 W1-T701");
  assert.equal(summary.held.includes("W1-T702"), false, "the id it does not hold is never printed");
  assert.match(String(summary.partial), /PARTIAL — holds 2 of 3; could not reserve the other 1/);
  // POSITIVE CONTROL on the partial head: a full block and an empty one carry none.
  assert.equal(describeHeld([], 3).partial, undefined);
  assert.equal(describeHeld(held, 2).partial, undefined);
  assert.equal(describeHeld([], 3).held, "HELD 0 of 3: (none)");
});

test("W1-T9683: a contested id is skipped and --count is still met under one holder", () => {
  const { keepingHeld } = api();
  const origin = gitRepo({ bare: true, kind: "w9683-origin" });
  const work = gitRepo({ cloneFrom: origin.dir, kind: "w9683-work" });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
    GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
    GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  };
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: work.dir, encoding: "utf8", env });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const filer = "plan-file-w9683-test";
  const rival = "plan-file-w9683-rival";
  const outcomes: string[] = [];
  let contestedId = "";
  // A concurrent minter claims the id just above our FIRST win, after the reserver cached its
  // floor, so the second walk meets real contention on origin instead of skipping by the floor.
  const run = (args: string[]) => {
    const r = git(args);
    const won = args[0] === "push" && r.status === 0 ? /:refs\/rmd-id\/W1-T(\d+)$/.exec(args[2] ?? "") : null;
    if (won && !contestedId) {
      contestedId = `W1-T${Number(won[1]) + 1}`;
      const tree = git(["hash-object", "-t", "tree", "/dev/null"]).stdout.trim();
      const msg = reservation.formatReservationAnchorMessage({ branch: rival, pid: 4242, host: "rival-host", startedAt: new Date().toISOString(), source: "automatic" });
      const sha = git(["commit-tree", tree, "-m", msg]).stdout.trim();
      assert.equal(git(["push", "origin", `${sha}:refs/rmd-id/${contestedId}`, `${sha}:refs/heads/${rival}`]).status, 0, "the rival claim landed");
    }
    return r;
  };
  const base = reservation.gitRemoteRefReserver({ run, filingBranch: filer, policyCurrency: () => ({ status: "current" }), say: () => {} });
  const reserver: reservation.RemoteRefReserver = {
    ...base,
    attempt: (taskId, anchor) => {
      const outcome = base.attempt(taskId, anchor);
      outcomes.push(`${taskId}:${outcome}`);
      return outcome;
    },
  };
  const { held, error } = keepingHeld(1056, 3, (from) => reservation.reserveTaskIdRemote(from, reserver));
  assert.equal(error, undefined, String(error));
  const ids = held.map((h) => h.taskId);
  assert.equal(ids.length, 3, "the count is still met");
  assert.ok(contestedId, "control: the rival really claimed an id mid-walk");
  assert.ok(outcomes.includes(`${contestedId}:taken`), `the walk met the rival's claim on origin: ${outcomes.join(", ")}`);
  assert.equal(ids.includes(contestedId), false, "the contested id is skipped");
  assert.deepEqual(ids, ["W1-T1056", "W1-T1058", "W1-T1059"], "the walk advanced past it to the next free ids");
  for (const id of ids) {
    const holder = reservation.parseReservationHolderLine(origin.git("log", "-1", "--format=%B", `refs/rmd-id/${id}`));
    assert.equal(holder.status === "known" && holder.holder.branch, filer, `origin's ${id} names the one filing branch`);
  }
  const rivalHolder = reservation.parseReservationHolderLine(origin.git("log", "-1", "--format=%B", `refs/rmd-id/${contestedId}`));
  assert.equal(rivalHolder.status === "known" && rivalHolder.holder.branch, rival, "the rival's claim is untouched");
});
