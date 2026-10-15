/**
 * test/next-task-id-reserves-several-ids-with-one-open-pr-read.test.ts — W1-T9683: `rmd next-task-id
 * --count N` reserves N ids from ONE open-PR read and one history scan, instead of N calls each
 * spending a GitHub read slot. Stub reservers drive the count and partial arms; the contested arm
 * runs the DEFAULT git-backed reserver over a disposable local bare origin, so the holder each ref
 * records is read back from origin itself.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

import { nextTaskIdCommand as runNextTaskIdCommand } from "../src/run-task.js";
import {
  formatReservationAnchorMessage,
  parseReservationHolderLine,
  type RemoteRefReserver,
  type RemoteReserveOutcome,
} from "../src/lib/task-id-reservation.js";
import { gitRepo, GIT_REPO_FIXTURE_IDENTITY } from "./helpers/git-repo.js";

const mintRepo = gitRepo({ kind: "w9683-mint-plan" });
mkdirSync(join(mintRepo.dir, "plan"), { recursive: true });
writeFileSync(join(mintRepo.dir, "plan", "tasks.yaml"), "- id: W1-T1055\n  title: seed\n");
mintRepo.git("add", "plan/tasks.yaml");
mintRepo.git("commit", "--quiet", "-m", "fixture plan");

type Deps = Parameters<typeof runNextTaskIdCommand>[2];

/** Runs the command against the fixture plan, counting open-PR reads and capturing both streams. */
async function nextTaskId(rest: string[], deps: Deps = {}): Promise<{ code: number; out: string; err: string; openPrReads: number }> {
  let openPrReads = 0;
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  let code: number;
  try {
    code = await runNextTaskIdCommand(rest, {}, {
      holderOf: () => "fleet",
      ...deps,
      openPrTexts: () => {
        openPrReads++;
        return [];
      },
      repoRoot: mintRepo.dir,
    });
  } finally {
    console.log = ol;
    console.error = oe;
  }
  return { code, out: out.join("\n"), err: err.join("\n"), openPrReads };
}

/** A reserver whose k-th attempt (0-based) gets `outcomeAt(k, taskId)`. */
function stubReserver(outcomeAt: (k: number, taskId: string) => RemoteReserveOutcome): RemoteRefReserver & { tried: string[] } {
  const tried: string[] = [];
  return {
    tried,
    mintAnchor: () => "ANCHOR-SHA",
    attempt(taskId: string): RemoteReserveOutcome {
      tried.push(taskId);
      return outcomeAt(tried.length - 1, taskId);
    },
  };
}

const reservedIds = (out: string): string[] => [...out.matchAll(/^RESERVED (W1-T\d+) on origin/gm)].map((m) => m[1]);
const idNumber = (id: string): number => Number(id.slice("W1-T".length));

test("W1-T9683: --count 3 reserves three consecutive ids with one open-PR read", async () => {
  const reserver = stubReserver(() => "created");
  const r = await nextTaskId(["--count", "3"], { reserver });
  assert.equal(r.code, 0, r.err);
  const ids = reservedIds(r.out);
  assert.equal(ids.length, 3, `three RESERVED lines:\n${r.out}`);
  assert.deepEqual(ids.map(idNumber), [0, 1, 2].map((i) => idNumber(ids[0]) + i), "consecutive, each above the last");
  assert.deepEqual(reserver.tried, ids, "three ref pushes, one per id");
  assert.equal(r.openPrReads, 1, "ONE open-PR read for all three");
  assert.match(r.out, new RegExp(`^HELD 3 of 3: ${ids.join(" ")}$`, "m"), "the final line lists every id held");

  // POSITIVE CONTROL: without --count the verb still reserves exactly one and prints no HELD line.
  const one = await nextTaskId([], { reserver: stubReserver(() => "created") });
  assert.equal(reservedIds(one.out).length, 1);
  assert.doesNotMatch(one.out, /^HELD /m, "today's output is unchanged when --count is absent");
});

test("W1-T9683: --count is refused beside the flags that do not reserve here, and needs a positive whole number", async () => {
  for (const flags of [["--offline"], ["--no-reserve"], ["--audit"], ["--prefix", "CONSOLE", "--repo", "o/r"]]) {
    const reserver = stubReserver(() => "created");
    const r = await nextTaskId(["--count", "2", ...flags], { reserver });
    assert.equal(r.code, 2, `--count beside ${flags[0]} is refused`);
    assert.match(r.err, new RegExp(`--count and ${flags[0]} are contradictory`));
    assert.deepEqual(reserver.tried, [], "and nothing was pushed");
  }
  for (const bad of ["0", "-1", "2.5", "x"]) {
    const r = await nextTaskId(["--count", bad], { reserver: stubReserver(() => "created") });
    assert.equal(r.code, 2, `--count ${bad} is refused`);
    assert.match(r.err, /--count needs a positive whole number/);
  }
  const missing = await nextTaskId(["--count"], { reserver: stubReserver(() => "created") });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /--count needs a positive whole number, got nothing/);
  // POSITIVE CONTROL: an explicit --reserve beside --count is accepted.
  const reserving = await nextTaskId(["--count", "2", "--reserve"], { reserver: stubReserver(() => "created") });
  assert.equal(reserving.code, 0, reserving.err);
  assert.equal(reservedIds(reserving.out).length, 2);
});

test("W1-T9683: a partial --count prints only the ids it holds and exits non-zero", async () => {
  // Origin answers twice, then becomes unreachable on the third id.
  const reserver = stubReserver((k) => (k === 2 ? "unreachable" : "created"));
  const r = await nextTaskId(["--count", "3"], { reserver });
  assert.equal(r.code, 2, "a short block exits non-zero");
  const ids = reservedIds(r.out);
  assert.equal(ids.length, 2, `only the two held ids are RESERVED:\n${r.out}`);
  const unheld = reserver.tried[2];
  assert.ok(unheld && !ids.includes(unheld), "the third candidate was tried and is not reported held");
  assert.equal(r.out.includes(unheld), false, `the id it does not hold is never printed on stdout:\n${r.out}`);
  assert.match(r.out, new RegExp(`^HELD 2 of 3: ${ids.join(" ")}$`, "m"));
  assert.match(r.err, /PARTIAL — holds 2 of 3; could not reserve the other 1/);
  assert.match(r.err, /origin is unreachable/, "fail-closed: the refusal names the unreachable origin");
});

test("W1-T9683: a contested id is skipped and --count is still met under one holder", async () => {
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
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const filer = "plan-file-w9683-test";
  const rival = "plan-file-w9683-rival";
  let contestedId = "";
  // A concurrent minter claims the id just above our FIRST win, after our floor read — so the
  // second walk meets real contention on origin rather than skipping it by the cached floor.
  const runGit = (args: string[]) => {
    const r = git(args);
    const won = args[0] === "push" && r.status === 0 ? /:refs\/rmd-id\/W1-T(\d+)$/.exec(args[2] ?? "") : null;
    if (won && !contestedId) {
      contestedId = `W1-T${Number(won[1]) + 1}`;
      const tree = git(["hash-object", "-t", "tree", "/dev/null"]).stdout.trim();
      const msg = formatReservationAnchorMessage({ branch: rival, pid: 4242, host: "rival-host", startedAt: new Date().toISOString(), source: "automatic" });
      const sha = git(["commit-tree", tree, "-m", msg]).stdout.trim();
      assert.equal(git(["push", "origin", `${sha}:refs/rmd-id/${contestedId}`, `${sha}:refs/heads/${rival}`]).status, 0, "the rival claim landed");
    }
    return r;
  };
  const r = await nextTaskId(["--count", "3", "--branch", filer], {
    runGit,
    holderOf: undefined,
    policyCurrency: () => ({ status: "current" }),
  });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const ids = reservedIds(r.out);
  assert.equal(ids.length, 3, `the count is still met:\n${r.out}`);
  assert.ok(contestedId, "control: the rival really claimed an id mid-walk");
  assert.equal(ids.includes(contestedId), false, "the contested id is skipped");
  assert.equal(idNumber(ids[1]), idNumber(contestedId) + 1, "the walk advanced past it to the next free id");
  assert.match(r.out, new RegExp(`^\\(${contestedId}: HELD BY ${rival}`, "m"), "the contested id is reported, never silently skipped");
  assert.ok(r.out.indexOf(contestedId) < r.out.indexOf(`RESERVED ${ids[1]}`), "reported beside the id it displaced");
  assert.equal(r.openPrReads, 1, "one open-PR read for the whole block");
  for (const id of ids) {
    const holder = parseReservationHolderLine(origin.git("log", "-1", "--format=%B", `refs/rmd-id/${id}`));
    assert.equal(holder.status, "known", `origin holds ${id} with a readable holder`);
    assert.equal(holder.status === "known" && holder.holder.branch, filer, `${id} names the --branch holder`);
  }
  const rivalHolder = parseReservationHolderLine(origin.git("log", "-1", "--format=%B", `refs/rmd-id/${contestedId}`));
  assert.equal(rivalHolder.status === "known" && rivalHolder.holder.branch, rival, "the rival's claim is untouched");
});
