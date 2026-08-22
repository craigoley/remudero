import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TRIAGE_MAX_NEW_TASKS, triageCommand } from "../src/run-task.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { WorkerResult } from "../src/lib/worker.js";

// W1-T1011: THE ORDERING THIS FILE PROVES. `rmd triage` mints a task id and reserves it on TWO
// stores — a LOCAL one (this process's own sandbox, released on every exit path) and a REMOTE
// one (a permanent `refs/rmd-id/<id>` ref, `task-id-reservation.ts`'s own "NOTHING RELEASES A
// RESERVATION" doctrine). Before this task both were taken together, before the worker ever ran:
// measured over the retained ledger union, 21 of 64 minted ids belonged to a run that then
// errored, permanently burning a remote ref for work that produced nothing. This file drives the
// REAL `triageCommandLocked` (via the exported `triageCommand`) against a real local bare
// "origin" — the same fixture shape test/triage.test.ts's W1-T348 suite already established — and
// reads the ordering/absence of `refs/rmd-id/*` back off that origin, never a mock of the
// reservation primitive itself (that primitive is proven in isolation by
// test/task-id-reservation.test.ts; this file's subject is WHEN the lane calls it).

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

/** A bare "origin" seeded with one `status: new` feedback entry and a monolith whose highest id
 *  is W1-T4 — the SAME fixture shape test/triage.test.ts's W1-T348 suite uses, so the mint
 *  deterministically starts at W1-T5. */
function makeOrigin(feedbackId: string): string {
  const bare = mkdtempSync(join(tmpdir(), "t1011-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "t1011-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  // W1-T1089: applyPlanProposalCommit's `git add -A -- plan/ MASTER-PLAN.md` fails LOUD (fatal
  // pathspec error) when the file is entirely absent — true of every real triage worktree (a
  // full clone), so this fixture needs one too now that triage's propose-path commit routes
  // through the same shared function `rmd plan` does.
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN\n", "utf8");
  writeFileSync(
    join(seed, "plan", "tasks.yaml"),
    ["- id: W1-T4", '  title: "a seed task the plan loader accepts"', "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0", ""].join("\n"),
  );
  writeFileSync(
    join(seed, "plan", "feedback", `${feedbackId}.yaml`),
    [`id: ${feedbackId}`, "ts: '2026-08-19T00:00:00.000Z'", "raw: fixture entry for the W1-T1011 remote-reservation-timing proof", "attachments: []", "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"),
  );
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed plan");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

function fakeWorker(text: string): WorkerResult {
  return {
    sessionId: "T1011-SESSION",
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

const SUMMARY_PAYLOAD = {
  headline: "W1-T1011 remote-reservation-timing fixture",
  what_happened: "The fixture Architect proposed a plan-only change.",
  decision: "Review and merge the proposal PR.",
  options: [
    { label: "merge", consequence: "the proposed task enters the plan" },
    { label: "reject", consequence: "the feedback is filed away with no new task" },
  ],
};

/** Standard gh shim: `pr list` empty (so the mint's open-PR source sees nothing), the REST
 *  create (`gh api --method POST repos/.../pulls`, W1-T1202) answers a fixed `html_url`,
 *  `--json headRefName` answers from the bare origin's OWN pushed `run-*` branch (read live
 *  off disk), `pr diff` empty. Identical shape to test/triage.test.ts's W1-T348 shim — this
 *  file drives the same real round-trip, not a shortcut past it. */
function writeGhShim(shimDir: string, bare: string): void {
  writeFileSync(
    join(shimDir, "gh"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"pr list"*) echo "[]" ;;',
      '  *"api --method POST"*) echo \'{"html_url":"https://github.com/craigoley/remudero/pull/999","number":999}\' ;;',
      `  *"--json headRefName"*) git -C ${bare} for-each-ref --format='{"headRefName":"%(refname:short)"}' refs/heads/run-* | tail -1 ;;`,
      "  *\"--json body\"*) echo '{\"body\":\"\"}' ;;",
      '  *"pr diff"*) echo "" ;;',
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

/** Every id currently reserved on `bare`'s remote id-reservation namespace — `[]` when none. */
function remoteReservedIds(bare: string): string[] {
  return execFileSync("git", ["-C", bare, "for-each-ref", "--format=%(refname)", "refs/rmd-id/"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

interface Fixture {
  bare: string;
  home: string;
  configRoot: string;
  shimDir: string;
}

function setupFixture(feedbackId: string, prefix: string): Fixture {
  const bare = makeOrigin(feedbackId);
  const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
  const configRoot = mkdtempSync(join(tmpdir(), `${prefix}-root-`));
  const shimDir = mkdtempSync(join(tmpdir(), `${prefix}-ghshim-`));
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2));

  const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
  const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
  const repoDir = join(configRoot, "repos", repoName);
  mkdirSync(dirname(repoDir), { recursive: true });
  execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

  writeGhShim(shimDir, bare);
  return { bare, home, configRoot, shimDir };
}

function teardownFixture(f: Fixture, savedHome: string | undefined, savedPath: string | undefined): void {
  process.env.HOME = savedHome;
  process.env.PATH = savedPath;
  for (const d of [f.bare, f.home, f.configRoot, f.shimDir]) rmSync(d, { recursive: true, force: true });
}

// ── Criterion 1: an error before a verdict exists takes no remote reservation ────────────────

test("W1-T1011: a triage run that fails before a verdict takes no remote reservation", async () => {
  const feedbackId = `fb-t1011-error-${Date.now()}`;
  const f = setupFixture(feedbackId, "t1011-error");
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    process.env.HOME = f.home;
    process.env.PATH = `${f.shimDir}:${savedPath}`;

    await withLiveWritesAllowed(() =>
      triageCommand([feedbackId], {
        // The Architect prints no ALREADY_DECIDED:/AMBIGUOUS:/PROPOSED: line at all — decideTriage
        // has no verdict to act on and returns `action: "error"` BEFORE any propose/grill branch,
        // and in particular before the permanent remote reservation this task moved.
        spawn: async () => fakeWorker("I looked into this feedback entry and I am still thinking about it."),
      }),
    ).catch(() => undefined); // triageCommandLocked rethrows the error path — we only care about the ref

    assert.deepEqual(remoteReservedIds(f.bare), [], "an errored-before-verdict run must take NO refs/rmd-id/* ref");

    const ledger = readFileSync(join(f.configRoot, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(ledger.some((row) => row.step === "triage.error"), "the run recorded its error step");
    assert.ok(!ledger.some((row) => row.step === "triage.id_minted"), "no permanent mint was ever logged");
  } finally {
    teardownFixture(f, savedHome, savedPath);
  }
});

// ── Criterion 2: a PROPOSED verdict reserves the id before the shard is written ──────────────

test("W1-T1011: a proposed verdict reserves the id before the shard is written", async () => {
  const feedbackId = `fb-t1011-propose-${Date.now()}`;
  const f = setupFixture(feedbackId, "t1011-propose");
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;

  // A pre-receive hook on the bare "origin" — the SAME mechanism a real GitHub remote's push
  // protection would use — checks, at the moment the run branch carrying the shard commit
  // ARRIVES on the remote, whether a `refs/rmd-id/*` ref already exists there. That is the
  // observable "before" this criterion asks for: not a code-reading assertion about call order,
  // but the actual remote state at the moment the shard becomes visible to any other reader.
  const orderLog = join(mkdtempSync(join(tmpdir(), "t1011-order-")), "order.log");
  writeFileSync(
    join(f.bare, "hooks", "pre-receive"),
    [
      "#!/bin/sh",
      "while read oldrev newrev refname; do",
      '  case "$refname" in',
      "    refs/heads/run-*)",
      "      if git for-each-ref refs/rmd-id/ | grep -q .; then",
      `        echo "reservation-before-branch-push" >> "${orderLog}"`,
      "      else",
      `        echo "reservation-MISSING-at-branch-push" >> "${orderLog}"`,
      "      fi",
      "      ;;",
      "  esac",
      "done",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    process.env.HOME = f.home;
    process.env.PATH = `${f.shimDir}:${savedPath}`;

    let filedId: string | undefined;
    await withLiveWritesAllowed(() =>
      triageCommand([feedbackId], {
        spawn: async (args: { cwd: string; prompt: string; tools?: string[] }) => {
          if ((args.tools ?? []).length === 0) {
            // The decision-summary rung's own spawn shape (buildDecisionSummarySpawnArgs).
            return fakeWorker(JSON.stringify(SUMMARY_PAYLOAD));
          }
          const id = /USE EXACTLY `(W\d+-T\d+)`/.exec(args.prompt)?.[1];
          assert.ok(id, `triage prompt must name the reserved id; got: ${args.prompt.slice(0, 200)}`);
          filedId = id;
          const dir = join(args.cwd, "plan", "tasks.d");
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, `${id}-fixture.yaml`),
            [
              `- id: ${id}`,
              `  title: "a clean task filed for the W1-T1011 remote-reservation-timing proof"`,
              "  repo: remudero",
              "  origin: architect",
              "  depends_on: []",
              "  type: implement",
              "  verify: auto",
              "  status: queued",
              "  attempts: 0",
              "  files: [test/triage-remote-reservation-timing.test.ts]",
              "  acceptance:",
              '    - claim: "the thing holds"',
              '      proof: "unit test: test/triage-remote-reservation-timing.test.ts"',
              "",
            ].join("\n"),
          );
          return fakeWorker(`PROPOSED: file ${id!} for feedback#${feedbackId}`);
        },
      }),
    ).catch(() => undefined); // later gating (ci/review) has no real backend in this fixture

    assert.ok(filedId, "the fixture Architect filed an id");
    assert.ok(orderLog && readFileSync(orderLog, "utf8").trim().length > 0, "the run branch was pushed at least once");
    const orderLines = readFileSync(orderLog, "utf8").trim().split("\n");
    assert.equal(
      orderLines[0],
      "reservation-before-branch-push",
      "the FIRST push of the run branch (carrying the shard commit) must already see the remote reservation",
    );
    assert.ok(orderLines.every((l) => l === "reservation-before-branch-push"), "every push after that stays ordered too");

    // The lane reserves the WHOLE block remotely (TRIAGE_MAX_NEW_TASKS ids, unchanged by this
    // task — see reserveTaskIdBlockRemote's own doc), starting at the filed id; the unused rest
    // are held too, never released (task-id-reservation.ts's own doctrine).
    const reserved = remoteReservedIds(f.bare);
    assert.equal(reserved.length, TRIAGE_MAX_NEW_TASKS, `the whole reserved block holds a permanent ref, got ${reserved.join(", ")}`);
    assert.ok(reserved.includes(`refs/rmd-id/${filedId}`), `the filed id ${filedId} holds a permanent remote ref: ${reserved.join(", ")}`);

    const ledger = readFileSync(join(f.configRoot, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const minted = ledger.find((row) => row.step === "triage.id_minted");
    assert.ok(minted, "the permanent mint IS logged once the verdict is propose");
    assert.equal(minted.minted_id, filedId);
  } finally {
    teardownFixture(f, savedHome, savedPath);
  }
});

// ── Criterion 3: an ALREADY_DECIDED verdict takes no remote reservation ──────────────────────

test("W1-T1011: an already decided verdict takes no remote reservation", async () => {
  const feedbackId = `fb-t1011-already-${Date.now()}`;
  const f = setupFixture(feedbackId, "t1011-already");
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    process.env.HOME = f.home;
    process.env.PATH = `${f.shimDir}:${savedPath}`;

    await withLiveWritesAllowed(() =>
      triageCommand([feedbackId], {
        // ALREADY_DECIDED with no files changed ⇒ decideTriage returns `action: "no_task"`,
        // never `"propose"` — the ONLY branch this task's permanent reservation now lives in.
        spawn: async () => fakeWorker("ALREADY_DECIDED: MASTER-PLAN.md §7B already covers this"),
      }),
    ).catch(() => undefined); // PR-gating steps have no real backend in this fixture

    assert.deepEqual(remoteReservedIds(f.bare), [], "an already-decided verdict files nothing and reserves nothing remotely");

    const ledger = readFileSync(join(f.configRoot, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(!ledger.some((row) => row.step === "triage.id_minted"), "no permanent mint was ever logged");
  } finally {
    teardownFixture(f, savedHome, savedPath);
  }
});

// ── Criterion 4: an unwritable LOCAL reservation still refuses before any spend ──────────────

test("W1-T1011: a reservation that cannot be written still refuses before any spend", async () => {
  const feedbackId = `fb-t1011-unwritable-${Date.now()}`;
  const f = setupFixture(feedbackId, "t1011-unwritable");
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    process.env.HOME = f.home;
    process.env.PATH = `${f.shimDir}:${savedPath}`;

    // The LOCAL reservation directory's OWN PATH is pre-occupied by a plain file, so
    // `reserveTaskIdBlock`'s `mkdirSync(dir, { recursive: true })` throws ENOTDIR/EEXIST before
    // a single id is ever attempted — this is still the PRE-`spawn` guard W1-T1011's design
    // preserves unchanged: an id that cannot be claimed LOCALLY still throws before the worker
    // is spawned, regardless of when the REMOTE half of the reservation now moves to.
    mkdirSync(join(f.configRoot, "state"), { recursive: true });
    writeFileSync(join(f.configRoot, "state", "task-id-reservations"), "not a directory");

    let spawnCalled = false;
    await assert.rejects(
      () =>
        withLiveWritesAllowed(() =>
          triageCommand([feedbackId], {
            spawn: async () => {
              spawnCalled = true;
              throw new Error("spawn must never be called when the local reservation cannot be written");
            },
          }),
        ),
      /cannot create the task-id reservation directory/,
    );

    assert.equal(spawnCalled, false, "the paid worker was never started");
    assert.deepEqual(remoteReservedIds(f.bare), [], "a run refused before spend takes no remote reservation either");

    const ledger = readFileSync(join(f.configRoot, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(
      ledger.some((row) => row.step === "triage.error" && /cannot create the task-id reservation directory/.test(String(row.error))),
      "the refusal is a durable, structured ledger event",
    );
  } finally {
    teardownFixture(f, savedHome, savedPath);
  }
});
