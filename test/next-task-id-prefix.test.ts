/**
 * test/next-task-id-prefix.test.ts — W1-T4388: `rmd next-task-id --prefix <P> --repo <owner/name>`.
 *
 * The target repo is a LOCAL bare repository reached through `file://`, so the mint runs the real
 * `cloneTargetPlan` and the real `gitRemoteRefReserver` against a real origin with no network. The
 * open-PR read is injected, as in test/next-task-id-reserve.test.ts, so no `gh` call is made.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { cloneTargetPlan, nextTaskIdCommand } from "../src/run-task.js";
import {
  formatReservationAnchorMessage,
  nextPrefixedTaskIdStart,
  parsePrefixedTaskId,
  prefixedTaskIdsIn,
  type RemoteRefReserver,
  type RemoteReserveOutcome,
} from "../src/lib/task-id-reservation.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "./helpers/git-repo.js";

const REPO = "craigoley/remudero-console";
const FILER = "run-CONSOLE-T61-1790000000000";
const HOLDER = "operator-filing-1790000000000";

/** A console-shaped origin: CONSOLE-T57 in its plan, CONSOLE-T59 reserved, and CONSOLE-T60 held by
 *  a live branch — the ref a racing minter pushed after this mint listed the namespace. */
function consoleOrigin(): { bare: GitRepo; work: GitRepo; heldSha: string } {
  const bare = gitRepo({ bare: true, kind: "prefix-origin" });
  const work = gitRepo({ kind: "prefix-work" });
  mkdirSync(join(work.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(work.dir, "plan", "tasks.yaml"), "tasks:\n  - id: CONSOLE-T3\n  - id: W1-T9000\n");
  writeFileSync(join(work.dir, "plan", "tasks.d", "CONSOLE-T57-x.yaml"), "- id: CONSOLE-T57\n");
  work.git("add", "plan");
  work.git("commit", "--quiet", "-m", "plan");
  work.addRemote("origin", bare.dir);
  work.git("push", "--quiet", "origin", "main", `main:refs/heads/${HOLDER}`, "main:refs/rmd-id/CONSOLE-T59");
  const tree = work.git("hash-object", "-t", "tree", "/dev/null");
  const heldSha = work.git("commit-tree", tree, "-m", formatReservationAnchorMessage({ branch: HOLDER, pid: 1, host: "h", startedAt: "2026-09-23T00:00:00.000Z" }));
  work.git("push", "--quiet", "origin", `${heldSha}:refs/rmd-id/CONSOLE-T60`);
  return { bare, work, heldSha };
}

/** The target checkout, with CONSOLE-T60 hidden from the namespace listing to stage the race. */
function openHidingT60(bare: GitRepo, calls: string[][]) {
  return () => {
    const t = cloneTargetPlan(`file://${bare.dir}`);
    const run = (args: string[]) => {
      calls.push(args);
      const r = t.run(args);
      if (args[0] === "ls-remote" && args.includes("refs/rmd-id/CONSOLE-T*")) {
        return { ...r, stdout: r.stdout.split("\n").filter((l) => !l.endsWith("CONSOLE-T60")).join("\n") };
      }
      return r;
    };
    return { ...t, run };
  };
}

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  return { out, err, restore: () => { console.log = ol; console.error = oe; } };
}

/** The reserver's `commit-tree` runs in the target clone; a CI runner configures no identity. */
async function withFixtureIdentity<T>(body: () => Promise<T>): Promise<T> {
  const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const;
  const saved = keys.map((k) => process.env[k]);
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = GIT_REPO_FIXTURE_IDENTITY.name;
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = GIT_REPO_FIXTURE_IDENTITY.email;
  try {
    return await body();
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
}

const selfGitForbidden = (args: string[]): never => {
  throw new Error(`the prefixed mint touched the SELF repo's git: ${args.join(" ")}`);
};

test("W1-T4388: a prefixed mint reserves the id on the target repo's origin and skips a held one", async () => {
  const { bare, heldSha } = consoleOrigin();
  const calls: string[][] = [];
  const cap = capture();
  let code: number;
  try {
    code = await withFixtureIdentity(() =>
      nextTaskIdCommand(["--prefix", "CONSOLE", "--repo", REPO], {}, {
        openTargetRepo: openHidingT60(bare, calls),
        openPrTexts: () => ["feat: CONSOLE-T58 split\nbody", "run-CONSOLE-T58-1790193411130"],
        filingBranch: FILER,
        runGit: selfGitForbidden,
      }),
    );
  } finally {
    cap.restore();
  }
  assert.equal(code, 0, cap.err.join("\n"));
  assert.deepEqual(cap.out, [`RESERVED CONSOLE-T61 on ${REPO}'s origin (refs/rmd-id/CONSOLE-T61) after 2 attempt(s)`]);
  const pushed = calls.filter((a) => a[0] === "push").map((a) => a[2].split(":")[1]);
  assert.deepEqual(pushed, ["refs/rmd-id/CONSOLE-T60", "refs/rmd-id/CONSOLE-T61"], "the walk started above T59's ref and advanced past the held T60");
  assert.ok(bare.git("rev-parse", "--verify", "refs/rmd-id/CONSOLE-T61"), "the claim landed on the TARGET's origin");
  assert.equal(bare.git("rev-parse", "refs/rmd-id/CONSOLE-T60"), heldSha, "the held reservation was left untouched");
  assert.equal(bare.git("for-each-ref", "refs/rmd-id/W1-T*"), "", "no W1-T ref was written to the target");
});

test("W1-T4388: a W1-T mint without a prefix is unchanged", async () => {
  const { work } = consoleOrigin();
  const tried: string[] = [];
  const reserver: RemoteRefReserver = {
    mintAnchor: () => "ANCHOR-SHA",
    attempt(taskId: string): RemoteReserveOutcome {
      tried.push(taskId);
      return "created";
    },
  };
  const cap = capture();
  try {
    await nextTaskIdCommand(["--reserve"], {}, {
      repoRoot: work.dir,
      reserver,
      holderOf: () => "unknown",
      openPrTexts: () => [],
      openTargetRepo: () => assert.fail("a mint without --prefix opened a consumer repo"),
    });
  } finally {
    cap.restore();
  }
  assert.equal(tried.length, 1);
  assert.match(tried[0], /^W1-T[0-9]+$/);
  assert.match(cap.out.join("\n"), new RegExp(`^RESERVED ${tried[0]} on origin \\(refs/rmd-id/${tried[0]}\\) after 1 attempt\\(s\\)$`, "m"));
});

test("W1-T4388: parsePrefixedTaskId splits any family and refuses a suffixed id", () => {
  assert.deepEqual(parsePrefixedTaskId("CONSOLE-T58"), { prefix: "CONSOLE", n: 58 });
  assert.deepEqual(parsePrefixedTaskId("W1-T4388"), { prefix: "W1", n: 4388 });
  assert.deepEqual(parsePrefixedTaskId("PORTAL-T7"), { prefix: "PORTAL", n: 7 });
  assert.equal(parsePrefixedTaskId("W1-T1B"), null);
  assert.equal(parsePrefixedTaskId("console-T5"), null);
  assert.equal(parsePrefixedTaskId("CONSOLE"), null);
});

test("W1-T4388: prefixed ids are read only for their own family and bound", () => {
  const texts = ["CONSOLE-T5 XCONSOLE-T90 CONSOLE-T6B refs/rmd-id/CONSOLE-T7", "run-CONSOLE-T8-179 W1-T99 CONSOLE-T900000"];
  assert.deepEqual(prefixedTaskIdsIn(texts, "CONSOLE"), [5, 7, 8]);
  assert.equal(nextPrefixedTaskIdStart(texts, "CONSOLE"), 9);
  assert.equal(nextPrefixedTaskIdStart(texts, "PORTAL"), 1, "a family with no ids starts at one");
});

test("W1-T4388: a prefixed mint refuses malformed or contradictory arguments", async () => {
  const { work } = consoleOrigin();
  for (const args of [
    ["--prefix", "CONSOLE"],
    ["--repo", REPO],
    ["--prefix", "console", "--repo", REPO],
    ["--prefix", "CONSOLE", "--repo", "remudero-console"],
    ["--prefix", "CONSOLE", "--repo", REPO, "--offline"],
    ["--prefix", "CONSOLE", "--repo", REPO, "--no-reserve"],
  ]) {
    const cap = capture();
    let code: number;
    try {
      code = await nextTaskIdCommand(args, {}, { repoRoot: work.dir, openTargetRepo: () => assert.fail(`opened a repo for ${args.join(" ")}`) });
    } finally {
      cap.restore();
    }
    assert.equal(code, 2, args.join(" "));
    assert.match(cap.err.join("\n"), /--prefix <P> needs --repo <owner\/name>/);
  }
});

test("W1-T4388: a trailing -T on the prefix names the same family", async () => {
  const { bare } = consoleOrigin();
  const cap = capture();
  try {
    await withFixtureIdentity(() =>
      nextTaskIdCommand(["--prefix", "CONSOLE-T", "--repo", REPO], {}, {
        openTargetRepo: () => cloneTargetPlan(`file://${bare.dir}`),
        openPrTexts: () => [],
        filingBranch: FILER,
      }),
    );
  } finally {
    cap.restore();
  }
  assert.match(cap.out.join("\n"), /^RESERVED CONSOLE-T61 /m, "the listed T60 ref is skipped without a push");
});

test("W1-T4388: an unread surface refuses the prefixed mint and claims nothing", async () => {
  const { bare } = consoleOrigin();
  const failures: Array<[string, (args: string[]) => boolean, (() => string[]) | undefined]> = [
    ["ls-remote", (a) => a[0] === "ls-remote", () => []],
    ["open PRs", () => false, () => { throw new Error("gh: rate limited"); }],
  ];
  for (const [label, fails, openPrTexts] of failures) {
    const calls: string[][] = [];
    const cap = capture();
    let code: number;
    try {
      code = await nextTaskIdCommand(["--prefix", "CONSOLE", "--repo", REPO], {}, {
        openTargetRepo: () => {
          const t = cloneTargetPlan(`file://${bare.dir}`);
          return { ...t, run: (args: string[]) => (calls.push(args), fails(args) ? { status: 128, stdout: "", stderr: "fatal: unable to access" } : t.run(args)) };
        },
        openPrTexts,
        filingBranch: FILER,
      });
    } finally {
      cap.restore();
    }
    assert.equal(code, 2, label);
    assert.match(cap.err.join("\n"), /REFUSED/, label);
    assert.match(cap.err.join("\n"), new RegExp(REPO), label);
    assert.equal(calls.filter((a) => a[0] === "push").length, 0, `${label}: nothing was pushed`);
  }
});

test("W1-T4388: cloneTargetPlan reads the target plan and an unreadable target throws", () => {
  const { bare } = consoleOrigin();
  const t = cloneTargetPlan(`file://${bare.dir}`);
  assert.equal(t.planTexts.length, 2);
  assert.match(t.planTexts.join("\n"), /CONSOLE-T57/);
  assert.match(t.run(["remote", "get-url", "origin"]).stdout, new RegExp(bare.dir));
  t.dispose();
  assert.throws(() => cloneTargetPlan(`file://${bare.dir}-absent`), /cannot read file:.*main plan \(git clone\)/);
});

test("W1-T4388: a target without plan shards reads tasks.yaml alone", () => {
  const bare = gitRepo({ bare: true, kind: "prefix-origin" });
  const work = gitRepo({ kind: "prefix-work" });
  mkdirSync(join(work.dir, "plan"));
  writeFileSync(join(work.dir, "plan", "tasks.yaml"), "- id: PORTAL-T4\n");
  work.git("add", "plan");
  work.git("commit", "--quiet", "-m", "plan");
  work.addRemote("origin", bare.dir);
  work.git("push", "--quiet", "origin", "main");
  const t = cloneTargetPlan(`file://${bare.dir}`);
  assert.deepEqual(t.planTexts, ["- id: PORTAL-T4\n"]);
  const checkout = t.run(["rev-parse", "--show-toplevel"]).stdout.trim();
  assert.ok(existsSync(checkout));
  t.dispose();
  assert.equal(existsSync(checkout), false, "dispose removes the target checkout");
});
