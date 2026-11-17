/**
 * W1-T13183 — triage, the task-id reservation path, the repair feedback capture and the fold-debt pull run their
 * git and gh off the daemon loop.
 *
 * MEASURED 2026-11-16 09:45Z to 14:35Z (933 daemon.loop_stall_profile rows): sync ghExec 158 s, ghJson 146 s and
 * hostWorktreeGitResult 127 s held the daemon loop. Triage's id reservation and release, the repair filing capture and
 * the fold-debt pull were the callers. These tests drive each caller with node:child_process's synchronous APIs
 * replaced by a recorder, and prove the reservation keeps its one lock when two awaited writers race.
 *
 * LEFT ON THE LOOP (design 3, for a follow-up): isDispatchEligible's merged read and runStepsSync are not moved here.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { crc32 } from "node:zlib";
import { withDaemonGhTransportFloor } from "#src/lib/github-transport.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { FOLD_DEBT_INGESTED_STEP, FOLD_DEBT_MAIN_ARTIFACT } from "#src/lib/fold-debt-pull.js";
import {
  gatedRemoteRefReserverAsync,
  reserveTaskIdBlockRemoteAsync,
  TaskIdReservationError,
  taskIdReservationRef,
} from "#src/lib/task-id-reservation.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { gitRepo, originWithClone, type GitRepo } from "#test/helpers/git-repo.js";
import { withGhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import {
  captureRepairFeedbackWithPriorVerdictAsync,
  heldFromBlock,
  hostWorktreeGitAnswerAsync,
  releaseUnfiledReservationsAsync,
  triageCommand,
} from "#test/helpers/run-task-test.js";
import { buildSweepEffects, DEFAULT_SWEEP_POLICY } from "#test/helpers/sweep-test.js";

function scratch(kind: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t13183-${kind}-`));
}

type SyncName = "execFileSync" | "spawnSync" | "execSync";

/** Replaces node:child_process's sync APIs with a recorder that forwards to the real call. Only calls made while
 *  `armed` is true are kept, so fixture setup is not counted. */
function syncSpawnRecorder(t: TestContext): { calls: string[]; arm(on: boolean): void } {
  const calls: string[] = [];
  let armed = false;
  const cp = childProcess as unknown as Record<SyncName, (...a: unknown[]) => unknown>;
  for (const name of ["execFileSync", "spawnSync", "execSync"] as const) {
    const real = cp[name];
    t.mock.method(cp, name, (...a: unknown[]) => {
      if (armed) calls.push([name, String(a[0]), ...(Array.isArray(a[1]) ? a[1].map(String) : [])].join(" "));
      return real(...a);
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { calls, arm: (on) => void (armed = on) };
}

/** The shared origin-and-clone fixture with the clone on a run branch: the shape a triage worktree has. */
function runBranchFixture(kind: string): { origin: GitRepo; work: GitRepo; cleanup(): void } {
  const parent = scratch(kind);
  const { origin, clone } = originWithClone(join(parent, "work"));
  clone.git("config", "user.name", "remudero-test");
  clone.git("config", "user.email", "test@remudero.invalid");
  clone.git("checkout", "--quiet", "-b", `run-TRIAGE-${kind}`);
  return { origin, work: clone, cleanup: () => (origin.cleanup(), rmSync(parent, { recursive: true, force: true })) };
}

/** The reserver triage builds, over the awaited git it now uses. */
function triageReserver(dir: string, log: (step: string, fields: Record<string, unknown>) => void = () => {}) {
  return gatedRemoteRefReserverAsync({ run: (args) => hostWorktreeGitAnswerAsync(dir, args), lane: "triage", log });
}

const reservedOn = (origin: GitRepo): string[] =>
  origin.git("for-each-ref", "--format=%(refname)", "refs/rmd-id/").split("\n").filter(Boolean);

/** The plan a triage origin holds, as test/triage-remote-reservation-timing seeds it: one task and one new entry. */
function triagePlanSeed(feedbackId: string): Record<string, string> {
  return {
    "MASTER-PLAN.md": "# MASTER-PLAN\n",
    "plan/tasks.d/.keep": "",
    "plan/tasks.yaml": ["- id: W1-T4", '  title: "a seed task the plan loader accepts"', "  repo: remudero",
      "  depends_on: []", "  type: implement", "  design: |", "    NO-INVARIANTS: synthetic lint fixture with no inherited behavior to preserve",
      "  verify: auto", "  status: queued", "  attempts: 0", ""].join("\n"),
    [`plan/feedback/${feedbackId}.yaml`]: [`id: ${feedbackId}`, "ts: '2026-11-16T00:00:00.000Z'",
      "raw: fixture entry for the W1-T13183 triage reservation proof", "attachments: []", "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"),
  };
}

function fakeWorker(text: string): WorkerResult {
  return { sessionId: "T13183", costUsd: 0, numTurns: 1, text, blocks: [text], stderr: "", subtype: "success", isError: false,
    apiError: false, model: "claude-opus-5", effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalCostUsd: 0, billingMode: "subscription", verdict: "success", qualitySuspect: false, compactionEvents: [], childEnvKeys: [] } as unknown as WorkerResult;
}

/** Reservation-shaped sync git: the anchor commit, the claim push and triage's landed-shard probe. */
const reservationGit = (call: string): boolean =>
  call.includes("refs/rmd-id/") || call.includes(" commit-tree ") || (call.includes(" hash-object ") && call.includes("/dev/null"))
  || / cat-file -e origin\/main:/.test(call);

test("W1-T13183 criterion 1: a daemon-loop triage reserves and releases its id block through hostWorktreeGitAsync, never the sync git leaf", async (t) => {
  const feedbackId = `fb-t13183-${Date.now()}`;
  const home = scratch("home");
  const configRoot = scratch("root");
  const savedHome = process.env.HOME;
  const originUrl = String(childProcess.execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" })).trim();
  const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
  const repoDir = join(configRoot, "repos", repoName);
  mkdirSync(dirname(repoDir), { recursive: true });
  const { origin, clone } = originWithClone(repoDir, { seed: triagePlanSeed(feedbackId) });
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot, installRoot: REPO_ROOT }));
    clone.git("config", "user.name", "remudero-test");
    clone.git("config", "user.email", "test@remudero.invalid");
    process.env.HOME = home;

    const recorder = syncSpawnRecorder(t);
    await withGhShim([{ when: "pr list", stdout: "[]" }], async () => {
      recorder.arm(true);
      await withDaemonGhTransportFloor(() => withLiveWritesAllowed(() => triageCommand([feedbackId], {
        spawn: async () => fakeWorker("I am still thinking about this feedback entry."),
      }))).catch(() => undefined); // the error path rethrows; the reservation and its release are what this reads
      recorder.arm(false);
    });

    const ledger = readFileSync(join(configRoot, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const released = ledger.filter((r) => r.step === "task_id.reservation_released" && r.lane === "triage");
    assert.ok(released.length >= 1, "triage reserved a remote block and gave it back, so the reservation and release both ran");
    assert.deepEqual(reservedOn(origin), [], "every reserved id was released");
    assert.deepEqual(recorder.calls.filter(reservationGit), [],
      "no reservation or release git ran through a synchronous child process (hostWorktreeGitResult runs execFileSync)");
  } finally {
    process.env.HOME = savedHome;
    origin.cleanup();
    for (const d of [home, configRoot]) rmSync(d, { recursive: true, force: true });
  }
});

// ── the fold-debt fixture: an artifact zip built in-process (STORED members), as test/ci-filed-fold-debt ──

function artifactZip(members: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(members)) {
    const path = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30 + path.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    path.copy(local, 30);
    const central = Buffer.alloc(46 + path.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE(offset, 42);
    path.copy(central, 46);
    parts.push(local, data);
    directory.push(central);
    offset += local.length + data.length;
  }
  const listing = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length, 8);
  end.writeUInt16LE(directory.length, 10);
  end.writeUInt32LE(listing.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, listing, end]);
}

const OWNER = "acme";
const REPO = "widgets";
const FOLD_ID = "fold-debt-CLAUDE-md-46123";
const FOLD_TEXT = [`id: ${FOLD_ID}`, "ts: '2026-11-16T00:00:00.000Z'", "raw: CLAUDE.md is 46123 bytes > cap 44000 bytes", "attachments: []",
  "origin: gate", "status: new", ""].join("\n");
/** One main-lane artifact. Each test lists its own id: the sweep keeps settled artifact ids for the process. */
const mainListing = (id: number) =>
  ({ artifacts: [{ id, name: FOLD_DEBT_MAIN_ARTIFACT, expired: false, created_at: "2026-11-16T00:00:00Z", workflow_run: { id: 9000 + id, head_sha: "a".repeat(40) } }] });

/** The sweep effect the daemon builds, over a throwaway checkout; sync gh seams throw so a sync read fails loudly. */
function foldDebtEffects(extra: Partial<Parameters<typeof buildSweepEffects>[0]>) {
  const root = gitRepo({ kind: "w1-t13183-fold" }).dir;
  const logged: string[] = [];
  const effects = buildSweepEffects({
    owner: OWNER, repo: REPO, config: { root: REPO } as never, ledgerPath: "/dev/null/ledger.ndjson", runId: "t13183",
    plan: { tasks: [], byId: new Map() } as never, log: (step, fields) => void logged.push(`${step} ${JSON.stringify(fields ?? {})}`), policy: DEFAULT_SWEEP_POLICY, repoRoot: root,
    ghJsonImpl: () => { throw new Error("the sync ghJson seam was read"); },
    ghBufferImpl: () => { throw new Error("the sync gh buffer seam was read"); },
    landFeedbackImpl: () => ({ landed: true }),
    ...extra,
  });
  return { root, logged, pull: () => effects.pullFoldDebt!(new Set()) };
}

/** Points a fresh fixture repo's home at another repository, so a capture files upstream through gh. */
function homePointedElsewhere(): GitRepo {
  const repo = gitRepo({ kind: "w1-t13183-capture" });
  repo.git("remote", "add", "origin", "https://github.com/someone-else/otherrepo.git");
  mkdirSync(join(repo.dir, ".remudero"), { recursive: true });
  writeFileSync(join(repo.dir, ".remudero", "home-repo.json"), JSON.stringify({ repo: "home-owner/home-repo" }));
  return repo;
}

/** The home repo's API as the upstream filing reads it; the most specific substring first. */
const UPSTREAM_ROUTES: GhShimRoute[] = [
  { when: "/git/ref/heads/main", stdout: `{"object":{"sha":"${"b".repeat(40)}"}}` },
  { when: "/git/refs ", stdout: "{}" },
  { when: "/contents/", stdout: "{}" },
  { when: "repos/home-owner/home-repo/pulls ", stdout: '{"html_url":"https://github.com/home-owner/home-repo/pull/7"}' },
  { when: "api repos/home-owner/home-repo", stdout: '{"default_branch":"main"}' },
];

const FILING = { id: "repair-t13183-window-1", origin: "repair#ci-flake", raw: "- PR #1 https://github.com/acme/widgets/pull/1\n" };

test("W1-T13183 criterion 2: the repair feedback capture and the fold-debt pull read GitHub through the awaited gh helpers", async () => {
  // The fold-debt pull over the daemon's awaited seams: each read resolves on a later timer, and the sync seams throw.
  const reads: string[] = [];
  const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 5));
  const zip = artifactZip({ [`${FOLD_ID}.yaml`]: FOLD_TEXT });
  const fold = foldDebtEffects({
    readJsonImpl: (args: string[]) => {
      reads.push(args[1]);
      return later<unknown>(args[1].includes(`${FOLD_DEBT_MAIN_ARTIFACT}&`) ? mainListing(77) : { artifacts: [] });
    },
    readBufferImpl: (args: string[]) => {
      reads.push(args[1]);
      return later(zip);
    },
  });
  const rows = await fold.pull();
  assert.equal(reads.length, 3, `both listings and the one download were awaited reads: ${reads.join(", ")}`);
  assert.deepEqual(rows.filter((r) => r.step === FOLD_DEBT_INGESTED_STEP).map((r) => r.entry_ids), [[FOLD_ID]]);
  assert.equal(readFileSync(join(fold.root, "plan", "feedback", `${FOLD_ID}.yaml`), "utf8"), FOLD_TEXT);

  // The repair capture's upstream filing runs the real `gh` (a PATH shim) through ghTextAsync, awaited.
  const repo = homePointedElsewhere();
  await withGhShim(UPSTREAM_ROUTES, async (shim) => {
    await captureRepairFeedbackWithPriorVerdictAsync(repo.dir, FILING, () => {});
    const entry = readFileSync(join(repo.dir, "plan", "feedback", `${FILING.id}.yaml`), "utf8");
    assert.match(entry, /pr_url: https:\/\/github.com\/home-owner\/home-repo\/pull\/7/, "the upstream PR was opened through gh");
    assert.ok(shim.calls().some((c) => c.startsWith("api repos/home-owner/home-repo/pulls")), shim.calls().join(" | "));
  });
  repo.cleanup();
});

test("W1-T13183 criterion 3: on the daemon loop host, none of these callers reaches execFileSync, spawnSync or execSync", async (t) => {
  const recorder = syncSpawnRecorder(t);
  const onLoop = async <T>(fn: () => Promise<T>): Promise<T> => {
    recorder.arm(true);
    try {
      return await withDaemonGhTransportFloor(fn);
    } finally {
      recorder.arm(false);
    }
  };

  // Triage's reservation: a block whose first id is held by `main` long ago, so the reclaim and its policy read run too.
  const f = runBranchFixture("guard");
  try {
    const stale = f.work.git("commit-tree", f.work.git("hash-object", "-t", "tree", "/dev/null").trim(), "-m",
      "rmd-id reservation 1@old 2026-01-01T00:00:00.000Z\n\nrmd-id holder branch=main started_at=2026-01-01T00:00:00.000Z").trim();
    f.work.git("push", "--quiet", "origin", `${stale}:${taskIdReservationRef("W1-T500")}`);
    const reserver = triageReserver(f.work.dir);
    const block = await onLoop(() => reserveTaskIdBlockRemoteAsync(500, 3, reserver));
    assert.equal(block.ids.length, 3);
    const held = heldFromBlock(block, reserver);
    await onLoop(() => releaseUnfiledReservationsAsync(held, undefined, {
      run: (args) => hostWorktreeGitAnswerAsync(f.work.dir, args), lane: "triage", reason: "W1-T13183 guard", log: () => {},
    }));
    assert.ok(reservedOn(f.origin).length <= 1, "the release gave back every id this run won (a stale holder it could not take may stay)");
  } finally {
    f.cleanup();
  }

  // The repair feedback capture, with its landed-entry read and upstream filing.
  const repo = homePointedElsewhere();
  await withGhShim(UPSTREAM_ROUTES, () => onLoop(() => captureRepairFeedbackWithPriorVerdictAsync(repo.dir, FILING, () => {})));
  repo.cleanup();

  // The fold-debt pull over its DEFAULT readers: ghJsonAsync for the listings, a byte-keeping ghTextAsync for the zip.
  const zipDir = scratch("zip");
  const zipPath = join(zipDir, "artifact.zip");
  const zip = artifactZip({ [`${FOLD_ID}.yaml`]: FOLD_TEXT });
  writeFileSync(zipPath, zip);
  writeFileSync(join(zipDir, "main.json"), JSON.stringify(mainListing(78)));
  const fold = foldDebtEffects({});
  const rows = await withGhShim([
    { when: `name=${FOLD_DEBT_MAIN_ARTIFACT}&`, stdoutFile: join(zipDir, "main.json") },
    { when: "actions/artifacts?name=", stdout: '{"artifacts":[]}' },
    { when: "actions/artifacts/78/zip", stdoutFile: zipPath },
  ], () => onLoop(() => fold.pull()));
  rmSync(zipDir, { recursive: true, force: true });
  assert.deepEqual(rows.filter((r) => r.step === FOLD_DEBT_INGESTED_STEP).map((r) => r.entry_ids), [[FOLD_ID]],
    `the zip arrived byte for byte through the awaited text read; the sweep logged: ${fold.logged.join(" | ")}`);

  assert.deepEqual(recorder.calls, [], "no caller reached a synchronous child process on the daemon loop");
});

test("W1-T13183 criterion 4: two concurrent awaited reservations of the same next id end with one holder and one refusal", async () => {
  const f = runBranchFixture("race");
  try {
    const [a, b] = [triageReserver(f.work.dir), triageReserver(f.work.dir)];
    const settled = await Promise.allSettled([
      reserveTaskIdBlockRemoteAsync(700, 1, a, { maxScan: 1 }),
      reserveTaskIdBlockRemoteAsync(700, 1, b, { maxScan: 1 }),
    ]);
    const won = settled.filter((s) => s.status === "fulfilled");
    const refused = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    assert.equal(won.length, 1, "exactly one writer holds W1-T700");
    assert.equal(refused.length, 1, "the other is refused");
    assert.ok(refused[0].reason instanceof TaskIdReservationError, String(refused[0].reason));
    const holder = (won[0] as PromiseFulfilledResult<{ handles: Array<{ anchor: string }> }>).value.handles[0].anchor;
    assert.equal(f.origin.git("rev-parse", taskIdReservationRef("W1-T700")).trim(), holder, "origin's ref is the winner's anchor");
  } finally {
    f.cleanup();
  }
});
