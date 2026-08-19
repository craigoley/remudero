import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PLAN_MAX_NEW_TASKS, planCommand } from "../src/run-task.js";
import { planArchitectPrompt, unreservedFiledIds } from "../src/lib/plan-architect.js";
import { reserveTaskIdBlock, taskIdReservationsDir, taskIdReservationPath } from "../src/lib/task-id-reservation.js";
import type { WorkerResult } from "../src/lib/worker.js";

// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────
// `rmd plan` files tasks but minted NOTHING: `planArchitectPrompt` took no id, so its worker
// chose one by reading the plan files — the eyeball path PR #1075's reservation mechanism
// exists to remove, still live in the second of the two filing lanes. impl-DV routes this lane
// through the same mint-and-reserve ordering `rmd triage` uses.
//
// The load-bearing claims a reader should be able to check here:
//   1. the ids are reserved BEFORE the paid worker starts (asserted from INSIDE the spawn);
//   2. every reserved id is released — the ones the worker used AND the ones it declined;
//   3. release survives a worker that throws;
//   4. a live cross-lane holder is skipped, not collided with.
//
// Offline throughout, on the same fixture shape as test/live-write-guard-command-sites.ts: a
// bare `git init` origin in TMPDIR, a `gh` shim, an injected spawn. No network, no paid worker.
// These runs are NOT wrapped in `withLiveWritesAllowed`, so each dies at its first push — which
// is AFTER the reservation, the spawn and the id check, and still inside the `finally` that
// releases. A run that dies mid-flight is exactly the case claim 2 is about.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

const VALID_TASK = (id: string, title: string): string =>
  [
    `- id: ${id}`,
    `  title: "${title}"`,
    "  repo: remudero",
    // impl-FS: the prompt now requires `origin:` on every new task (CI's `provenance` rule BLOCKS
    // its absence), so the fixture worker writes what a compliant worker writes.
    "  origin: architect",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    "  status: queued",
    "  attempts: 0",
    "",
  ].join("\n");

/**
 * File a task the way the CORRECTED prompt directs — its OWN shard at
 * plan/tasks.d/<id>-<slug>.yaml — rather than appending to the monolith.
 *
 * impl-FS (trap 2): these fixtures used `appendFileSync(join(cwd, "plan", "tasks.yaml"), …)`, which
 * is precisely the placement `monolithFilingViolations` blocks and the prompt no longer directs. A
 * fixture that simulates the worker doing the wrong thing encodes the defect as normal behaviour —
 * part of why nobody noticed the prompt was wrong for nineteen days. What is ASSERTED here (the
 * reserve-before-spawn ordering and the release-everything contract) is unchanged; only the
 * placement the fake worker writes has moved.
 */
function fileTaskAsShard(cwd: string, id: string, title: string): void {
  const shardDir = join(cwd, "plan", "tasks.d");
  mkdirSync(shardDir, { recursive: true });
  writeFileSync(join(shardDir, `${id}-fixture-filing.yaml`), VALID_TASK(id, title));
}

function fakeWorker(text: string): WorkerResult {
  return {
    sessionId: "PLAN-MINT-SESSION",
    costUsd: 0,
    numTurns: 1,
    text,
    blocks: [text],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    model: "claude-opus-5",
    effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalCostUsd: 0,
    billingMode: "subscription",
    verdict: "success",
    qualitySuspect: false,
    compactionEvents: [],
    childEnvKeys: [],
  } as unknown as WorkerResult;
}

function makeOrigin(): string {
  const bare = mkdtempSync(join(tmpdir(), "planmint-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "planmint-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed, "plan", "tasks.yaml"), VALID_TASK("W1-T4", "a seed task the plan loader accepts"));
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER PLAN\n\nfixture\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed plan");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

function writeGhShim(dir: string): void {
  writeFileSync(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"pr list"*) echo "[]" ;;',
      '  *"headRefName"*) printf \'{"headRefName":"%s"}\\n\' "${RMD_SHIM_BRANCH:-main}" ;;',
      '  *"--json body"*) echo \'{"body":""}\' ;;',
      '  *"pr diff"*) echo "" ;;',
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

interface HarnessCtx {
  configRoot: string;
  /** The directory the lane's reservations land in — the thing under test. */
  reservationsDir: string;
  /** The throwaway bare origin every push in this run lands on — W1-T949: exposed so a caller
   *  can read back `refs/rmd-id/*` after the run, not just the local reservation directory. */
  bareOrigin: string;
}

/** Run `body` with HOME/PATH/config pointed at throwaway fixtures; returns the parsed ledger. */
async function withHarness(body: (ctx: HarnessCtx) => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const bare = makeOrigin();
  const home = mkdtempSync(join(tmpdir(), "planmint-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "planmint-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "planmint-shim-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  const savedBranch = process.env.RMD_SHIM_BRANCH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2),
    );
    process.env.HOME = home;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
    }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    writeGhShim(shimDir);
    process.env.PATH = `${shimDir}:${savedPath}`;

    await body({ configRoot, reservationsDir: taskIdReservationsDir(configRoot), bareOrigin: bare });

    const p = join(configRoot, "state", "ledger.ndjson");
    return existsSync(p)
      ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    if (savedBranch === undefined) delete process.env.RMD_SHIM_BRANCH;
    else process.env.RMD_SHIM_BRANCH = savedBranch;
    for (const d of [bare, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
}

/** Reserved ids visible on disk right now, as integers, ascending. */
function idsOnDisk(dir: string): number[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^W\d+-T(\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

const BRIEF = ["--mode=create", "a", "fixture", "brief", "for", "the", "plan", "lane", "mint"];

test("plan lane reserves its task ids BEFORE the paid worker spawns", async () => {
  let seenAtSpawn: number[] = [];
  let promptSeen = "";

  await withHarness(async ({ reservationsDir }) => {
    await planCommand(BRIEF, {
      spawn: async (args: { cwd: string; prompt: string }) => {
        // Read the reservation directory from INSIDE the spawn: whatever is here is what was
        // taken BEFORE any money could be spent. An empty list would mean the lane still mints
        // nothing, or mints after the worker — the two orderings impl-DV exists to rule out.
        seenAtSpawn = idsOnDisk(reservationsDir);
        promptSeen = args.prompt;
        fileTaskAsShard(args.cwd, `W1-T${seenAtSpawn[0]}`, "filed by the fixture worker");
        return fakeWorker(`PROPOSED: file W1-T${seenAtSpawn[0]} for the plan-lane mint fixture`);
      },
    }).catch(() => undefined);
  });

  assert.equal(seenAtSpawn.length, PLAN_MAX_NEW_TASKS, `a full block was held at spawn time; saw ${JSON.stringify(seenAtSpawn)}`);
  for (let i = 1; i < seenAtSpawn.length; i++) {
    assert.equal(seenAtSpawn[i], seenAtSpawn[0] + i, "the block is contiguous from its first id");
  }
  // The worker is TOLD its ids — a reservation the worker cannot see reserves nothing useful.
  for (const n of seenAtSpawn) {
    assert.ok(promptSeen.includes(`W1-T${n}`), `the prompt names reserved id W1-T${n}`);
  }
});

// ── W1-T949: THE REMOTE HALF — every reserved id gets its OWN ref on the shared origin, not
// just the first. Before this the plan lane reserved a full LOCAL block (the test above) but
// called `reserveTaskIdRemote` nowhere at all, so a plan run filing five tasks pushed ZERO refs
// any other writer could see (rationale (3)). This drives the REAL lane end to end (a real `git
// push` against the fixture's own bare origin, exactly `test/live-write-guard-command-sites.ts`'s
// shape) and reads the refs back off that origin — the substrate every writer actually shares,
// not the worker-sandbox-local reservation directory the test above already covers.
test("plan lane pushes ONE remote ref PER reserved id, not just the first", async () => {
  let seenAtSpawn: number[] = [];

  const ledger = await withHarness(async ({ reservationsDir, bareOrigin }) => {
    await planCommand(BRIEF, {
      spawn: async (args: { cwd: string }) => {
        seenAtSpawn = idsOnDisk(reservationsDir);
        fileTaskAsShard(args.cwd, `W1-T${seenAtSpawn[0]}`, "filed by the fixture worker");
        return fakeWorker(`PROPOSED: file W1-T${seenAtSpawn[0]} for the plan-lane remote-mint fixture`);
      },
    }).catch(() => undefined);

    const refs = execFileSync("git", ["-C", bareOrigin, "for-each-ref", "--format=%(refname)", "refs/rmd-id/"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    assert.equal(
      refs.length,
      PLAN_MAX_NEW_TASKS,
      `expected one refs/rmd-id/* ref per reserved id (${PLAN_MAX_NEW_TASKS}), the shared remote saw ${JSON.stringify(refs)}`,
    );
    for (const n of seenAtSpawn) {
      assert.ok(refs.includes(`refs/rmd-id/W1-T${n}`), `W1-T${n}'s own ref must have reached the shared origin`);
    }
  });

  assert.equal(ledger.filter((l) => l.step === "plan.id_minted").length, 1);
  assert.ok(
    Array.isArray((ledger.find((l) => l.step === "plan.id_minted") as { remote_refs?: unknown })?.remote_refs),
    "plan.id_minted must ledger the pushed refs, not just the local reservation",
  );
});

test("plan lane releases EVERY reserved id, including the ones the worker declined to use", async () => {
  let heldAtSpawn = 0;
  let leftBehind: number[] = [];

  const ledger = await withHarness(async ({ reservationsDir }) => {
    await planCommand(BRIEF, {
      spawn: async (args: { cwd: string }) => {
        heldAtSpawn = idsOnDisk(reservationsDir).length;
        const first = idsOnDisk(reservationsDir)[0];
        // File ONE task against a block of PLAN_MAX_NEW_TASKS: the other ids are declined, and
        // are the exact ids a leak would strand (nobody ever files them, so nobody ever frees
        // them). This is the phantom-id trap the plan already carries four instances of.
        fileTaskAsShard(args.cwd, `W1-T${first}`, "one task out of a block of five");
        return fakeWorker(`PROPOSED: file W1-T${first} only`);
      },
    }).catch(() => undefined);
    leftBehind = idsOnDisk(reservationsDir);
  });

  assert.equal(heldAtSpawn, PLAN_MAX_NEW_TASKS, "the block was held during the run");
  assert.deepEqual(leftBehind, [], "no id survives the run — used or unused, they all go back");
  assert.equal(ledger.filter((l) => l.step === "plan.id_minted").length, 1, "the mint is ledgered");
});

test("plan lane releases its reserved ids when the worker THROWS", async () => {
  let leftBehind: number[] = [];

  await withHarness(async ({ reservationsDir }) => {
    await planCommand(BRIEF, {
      spawn: async () => {
        assert.equal(idsOnDisk(reservationsDir).length, PLAN_MAX_NEW_TASKS, "held before the throw");
        throw new Error("fixture worker died mid-run");
      },
    }).catch(() => undefined);
    leftBehind = idsOnDisk(reservationsDir);
  });

  assert.deepEqual(leftBehind, [], "a crashed run strands nothing — the release is in the finally");
});

test("plan lane SKIPS ids a live cross-lane holder already reserved", async () => {
  let seenAtSpawn: number[] = [];
  const HELD_THROUGH = 40; // far above the fixture plan's highest id (W1-T4), so the mint lands inside it

  await withHarness(async ({ reservationsDir }) => {
    // Stand in for a concurrent `rmd triage` (or a second plan lane) holding a swathe of ids.
    // `process.pid` is this very process, so every holder is unambiguously LIVE and none is
    // eligible for the dead-holder reclamation path.
    mkdirSync(reservationsDir, { recursive: true });
    for (let n = 1; n <= HELD_THROUGH; n++) {
      writeFileSync(
        taskIdReservationPath(reservationsDir, n),
        JSON.stringify({ id: n, pid: process.pid, host: "fixture", startedAt: new Date().toISOString(), purpose: "cross-lane holder" }),
      );
    }

    await planCommand(BRIEF, {
      spawn: async (args: { cwd: string }) => {
        seenAtSpawn = idsOnDisk(reservationsDir).filter((n) => n > HELD_THROUGH);
        fileTaskAsShard(args.cwd, `W1-T${seenAtSpawn[0]}`, "filed above the held range");
        return fakeWorker(`PROPOSED: file W1-T${seenAtSpawn[0]}`);
      },
    }).catch(() => undefined);
  });

  assert.equal(seenAtSpawn.length, PLAN_MAX_NEW_TASKS, `the whole block landed above the held range; saw ${JSON.stringify(seenAtSpawn)}`);
  assert.ok(
    seenAtSpawn[0] > HELD_THROUGH,
    `the lane skipped every live holder — first reserved id W1-T${seenAtSpawn[0]} is above W1-T${HELD_THROUGH}`,
  );
});

// ── reserveTaskIdBlock in isolation ──────────────────────────────────────────────────

test("reserveTaskIdBlock hands back a contiguous run of ids and frees all of them on releaseAll", () => {
  const dir = mkdtempSync(join(tmpdir(), "planmint-block-"));
  try {
    const block = reserveTaskIdBlock(7, 4, dir);
    assert.deepEqual(block.ids, [7, 8, 9, 10]);
    assert.deepEqual(idsOnDisk(dir), [7, 8, 9, 10]);
    block.releaseAll();
    assert.deepEqual(idsOnDisk(dir), [], "releaseAll frees the whole block");
    block.releaseAll(); // idempotent, so a finally and a signal handler may both call it
    assert.deepEqual(idsOnDisk(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reserveTaskIdBlock strands nothing when acquisition fails PART WAY through", () => {
  const dir = mkdtempSync(join(tmpdir(), "planmint-partial-"));
  try {
    // A live holder on every id in reach, plus maxScan=1, means the FIRST two acquisitions
    // succeed and the third has nowhere to go and throws. Without the rollback the two winners
    // would sit on disk forever with no handle in anyone's hands.
    writeFileSync(
      taskIdReservationPath(dir, 3),
      JSON.stringify({ id: 3, pid: process.pid, host: "h", startedAt: "now", purpose: "blocker" }),
    );
    assert.throws(() => reserveTaskIdBlock(1, 3, dir, { maxScan: 1 }), /no free task id/);
    assert.deepEqual(idsOnDisk(dir), [3], "only the pre-existing blocker remains; the partial block rolled back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reserveTaskIdBlock refuses a non-positive count instead of silently reserving nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "planmint-count-"));
  try {
    assert.throws(() => reserveTaskIdBlock(1, 0, dir), TypeError);
    assert.throws(() => reserveTaskIdBlock(1, 1.5, dir), TypeError);
    assert.deepEqual(idsOnDisk(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── prompt + output validation (pure) ────────────────────────────────────────────────

test("planArchitectPrompt states the reserved ids, and is byte-identical to the old prompt when none are reserved", () => {
  const withIds = planArchitectPrompt("create", "a brief", "RUN-1", ["W1-T90", "W1-T91"]);
  assert.match(withIds, /RESERVED TASK IDS/);
  assert.match(withIds, /W1-T90, W1-T91/);
  assert.match(withIds, /Do NOT invent an id/);

  // An empty reservation list must add NOTHING — the pre-impl-DV prompt is the fallback for any
  // caller that does not reserve, and a stray heading would change what every such run is told.
  assert.equal(planArchitectPrompt("create", "a brief", "RUN-1", []), planArchitectPrompt("create", "a brief", "RUN-1"));
  assert.doesNotMatch(planArchitectPrompt("create", "a brief", "RUN-1"), /RESERVED TASK IDS/);
});

test("unreservedFiledIds names the ids a worker filed outside its reservation, and nothing else", () => {
  const diff = [
    "--- a/plan/tasks.yaml",
    "+++ b/plan/tasks.yaml",
    "+- id: W1-T90",
    "+  title: reserved and used",
    "+- id: W1-T500",
    "+  title: invented by the worker",
    "+- id: W1-T500",
    "+  title: a duplicate of the same invention",
    "-- id: W1-T77",
  ].join("\n");

  assert.deepEqual(unreservedFiledIds(diff, ["W1-T90", "W1-T91"]), ["W1-T500"]);
  assert.deepEqual(unreservedFiledIds(diff, ["W1-T90", "W1-T500"]), [], "nothing to report when every filed id was reserved");
  assert.deepEqual(unreservedFiledIds("", ["W1-T90"]), [], "an empty diff files nothing");
  // A REMOVED id line is not a filing — only additions count.
  assert.deepEqual(unreservedFiledIds("-- id: W1-T77\n", []), []);
});

// ── the empty-config regression PR #1075 shipped ─────────────────────────────────────

test("the reservation path works with an EMPTY config file — CI's normal state", () => {
  const home = mkdtempSync(join(tmpdir(), "planmint-emptycfg-"));
  const dir = mkdtempSync(join(tmpdir(), "planmint-emptycfg-dir-"));
  const savedHome = process.env.HOME;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), ""); // zero bytes, exactly as CI has it
    process.env.HOME = home;

    // PR #1075 shipped a `loadConfig()` on a CI-exercised path and died with "Unexpected end of
    // JSON input" here. Every function impl-DV adds takes its directory as an ARGUMENT and reads
    // no config; this asserts that property rather than trusting it.
    const block = reserveTaskIdBlock(1, 2, dir);
    assert.deepEqual(block.ids, [1, 2]);
    block.releaseAll();
    assert.deepEqual(idsOnDisk(dir), []);
    assert.match(planArchitectPrompt("create", "b", "R", ["W1-T1"]), /W1-T1/);
    assert.deepEqual(unreservedFiledIds("+- id: W1-T9\n", []), ["W1-T9"]);
  } finally {
    process.env.HOME = savedHome;
    for (const d of [home, dir]) rmSync(d, { recursive: true, force: true });
  }
});
