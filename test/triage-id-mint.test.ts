import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { main, nextTaskIdCommand, triageCommand } from "../src/run-task.js";
import { SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { WorkerResult } from "../src/lib/worker.js";

/** A minimal, byte-cheap `WorkerResult` — only the fields the harness actually reads matter, the
 *  rest are filler so the type checks. */
function mintFakeWorker(text: string): WorkerResult {
  return {
    sessionId: "MINT-SESSION",
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

// THE WIRING, not just the helper: `mintNextTaskId` is proven in isolation by test/task-id.test.ts,
// but the falsifier for the 2/2 collision class (W1-T256->257 #770, W1-T260->261 #775) is that
// `rmd triage` ACTUALLY derives the id across tasks.yaml + every tasks.d shard + open plan PRs and
// hands it to the worker. This drives the real `triageCommand` against a REAL local bare "origin"
// (no network), with `gh` shimmed on PATH so the open-PR read is deterministic, and reads the
// resulting `triage.id_minted` ledger line — the harness's own record of what it minted.
//
// Its own file (never appended to run-task.test.ts) per the retro rule: that file crashes at the
// FILE level under --experimental-test-coverage often enough to zero a coverage-load-bearing
// test's record nondeterministically.

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

/**
 * A bare origin whose `main` carries the exact collision shape: the monolith's highest id is
 * W1-T5, but a `plan/tasks.d/` shard already owns W1-T9 — so a monolith-only mint hands back a
 * taken id. Plus one `status: new` feedback entry for the triage to read.
 */
function makeOriginWithPlan(feedbackId: string): string {
  const bare = mkdtempSync(join(tmpdir(), "mint-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "mint-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  // Full task shape (not just id/title): once W1-T1011 moved `triage.id_minted` to fire only on
  // a PROPOSED verdict, this seed plan is now actually LOADED by the propose-path collision guard
  // (assertProposedPlanLoads) and linted (lintFiledTasks) — a bare id/title pair fails BOTH with
  // "missing required field", which is not the thing under test here.
  const taskFields = ["  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0"].join("\n");
  writeFileSync(
    join(seed, "plan", "tasks.yaml"),
    `- id: W1-T4\n  title: "a"\n${taskFields}\n- id: W1-T5\n  title: "b"\n${taskFields}\n`,
  );
  writeFileSync(join(seed, "plan", "tasks.d", "W1-T9-shard.yaml"), `- id: W1-T9\n  title: "shard-owned"\n${taskFields}\n`);
  writeFileSync(
    join(seed, "plan", "feedback", `${feedbackId}.yaml`),
    [
      `id: ${feedbackId}`,
      "ts: '2026-07-28T00:00:00.000Z'",
      "raw: fixture entry for the triage id-mint wiring",
      "attachments: []",
      "origin: cli",
      "status: new",
      "proposal_pr: null",
      "",
    ].join("\n"),
  );
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed plan");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

test("TRIAGE ID MINT (the #770/#775 collision class): `rmd triage` derives the id across tasks.yaml, the tasks.d shards, AND open plan PRs, and ledgers it once the verdict is PROPOSED", async () => {
  const feedbackId = `fb-mint-wiring-${Date.now()}`;
  const bare = makeOriginWithPlan(feedbackId);
  const home = mkdtempSync(join(tmpdir(), "mint-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "mint-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "mint-ghshim-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    // A complete config so loadConfig() takes its read path (no `which claude` shell-out) — the
    // `spawn` this test injects below is what actually stands in for the worker.
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2),
    );
    process.env.HOME = home;

    // The repo `triageCommand` will worktree from, pre-seeded at the path resolveOwnerRepo()
    // resolves against THIS checkout's real origin url (so the real `gh repo clone` is skipped).
    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "remudero-test"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@remudero.invalid"], { encoding: "utf8" });

    // `gh` shimmed: the mint's open-PR read returns ONE open PR that already minted W1-T12 — an
    // id that exists in NO plan file anywhere, which is exactly the #770 gap (an id reserved by a
    // PR that has not merged). `pr create`/`--json headRefName`/`pr diff` are answered too, only
    // so the run can reach the PROPOSED branch the `triage.id_minted` row now lives behind
    // (W1-T1011) — this proof cares about the mint's provenance, not what happens after.
    //
    // W1-T2324: the mint's own open-PR read moved off `gh pr list --json ...` (GraphQL) onto
    // `gh api repos/<o>/<r>/pulls?state=open&per_page=100` (REST) — see openPrMintTexts,
    // src/run-task.ts. The shimmed row shape moves with it: REST's `head.ref`, never the old
    // `gh --json`-shaped `headRefName`.
    writeFileSync(
      join(shimDir, "gh"),
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *"pulls?state=open"*) echo \'[{"number":998,"html_url":"https://github.com/craigoley/remudero/pull/998","title":"chore(plan): file W1-T12","body":"adds W1-T12","head":{"ref":"run-TRIAGE-x"}}]\' ;;',
        '  *"pr create"*) echo "https://github.com/craigoley/remudero/pull/999" ;;',
        `  *"--json headRefName"*) git -C ${bare} for-each-ref --format='{"headRefName":"%(refname:short)"}' refs/heads/run-* | tail -1 ;;`,
        "  *\"--json body\"*) echo '{\"body\":\"\"}' ;;",
        '  *"pr diff"*) echo "" ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${shimDir}:${savedPath}`;

    // Since W1-T1011, `triage.id_minted` is written once — when `decideTriage` returns
    // `propose` — rather than unconditionally before `spawn`. So this proof must actually file a
    // clean task under the reserved id and return PROPOSED to observe the row at all; a worker
    // that never resolves a verdict (this test's old `/usr/bin/true` stub) now ledgers nothing.
    await withLiveWritesAllowed(() =>
      triageCommand([feedbackId], {
        spawn: async (args: { cwd: string; prompt: string; tools?: string[] }) => {
          if ((args.tools ?? []).length === 0) {
            return mintFakeWorker("{}"); // the decision-summary rung — content unused by this proof
          }
          const id = /USE EXACTLY `(W\d+-T\d+)`/.exec(args.prompt)?.[1];
          assert.ok(id, `triage prompt must name the reserved id; got: ${args.prompt.slice(0, 200)}`);
          const dir = join(args.cwd, "plan", "tasks.d");
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, `${id}-fixture.yaml`),
            [
              `- id: ${id}`,
              `  title: "a clean task filed for the triage id-mint wiring proof"`,
              "  repo: remudero",
              "  origin: architect",
              "  depends_on: []",
              "  type: implement",
              "  verify: auto",
              "  status: queued",
              "  attempts: 0",
              "  files: [test/triage-id-mint.test.ts]",
              "  acceptance:",
              '    - claim: "the thing holds"',
              '      proof: "unit test: test/triage-id-mint.test.ts"',
              "",
            ].join("\n"),
          );
          return mintFakeWorker(`PROPOSED: file ${id} for feedback#${feedbackId}`);
        },
      }),
    ).catch(() => undefined); // diff-provenance/ci-gate steps have no real backend in this fixture

    const ledger = readFileSync(join(configRoot, "state", "ledger.ndjson"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const minted = ledger.filter((l) => l.step === "triage.id_minted");
    assert.equal(minted.length, 1, "the mint is ledgered exactly once per triage run, once the verdict is PROPOSED");
    assert.equal(minted[0].minted_id, "W1-T13", "max is the OPEN PR's W1-T12 — above both the monolith (5) and the shard (9)");
    assert.equal(minted[0].source_monolith, 5);
    assert.equal(minted[0].source_shards, 9, "the shard source is what a monolith-only read misses (#775)");
    assert.equal(minted[0].source_open_prs, 12, "the open-PR source is what a main-only read misses (#770)");
    assert.deepEqual(minted[0].degraded, [], "every source was readable — no floor caveat on this mint");
  } finally {
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

// ── `rmd next-task-id`: the OPERATOR-facing mint (both 2026-07-25 collisions were minted by
// hand, in an operator session, not by the triage worker — the command is what makes the same
// derivation available to a human without re-deriving it by eye).

/** A plan fixture on disk; `shard` (when given) is written into plan/tasks.d/. */
function planOnDisk(monolith: string, shard?: { name: string; text: string }): string {
  const root = mkdtempSync(join(tmpdir(), "mint-cli-plan-"));
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, monolith);
  if (shard) {
    mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(root, "plan", "tasks.d", shard.name), shard.text);
  }
  return planPath;
}

test("nextTaskIdCommand --offline: prints the id + its provenance and exits 0, reading the shards as well as the monolith", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  const planPath = planOnDisk("- id: W1-T5\n", { name: "W1-T9-x.yaml", text: "- id: W1-T9\n" });
  const code = await nextTaskIdCommand(["--plan", planPath, "--offline"]);
  assert.equal(code, 0);
  // W1-T278: the plan fixture lives outside this checkout's repoRoot, so the git-history
  // source has nothing to scan — "history -", never a degradation (see
  // test/next-task-id-history.test.ts for the in-tree-history cases).
  // W1-T2710 added the `remote plan` term; this fixture plan lives outside any git repo, so the
  // reader answers nothing and the line reads `-` — an UNMEASURED gap, not a measured zero.
  assert.match(
    logs.join("\n"),
    /W1-T10 \(max 9 across tasks\.yaml 5, shards 9, open PRs not enumerated, remote plan -, history -\)/,
  );
  assert.match(logs.join("\n"), /--offline: open plan PRs were NOT read/, "the reduced scope is stated, never implied");
});

test("nextTaskIdCommand: a DEGRADED source exits 1 — the id is a floor, so a script must not consume it as authoritative", async (t) => {
  t.mock.method(console, "log", () => {});
  // An unreadable shard (a DIRECTORY where a shard file is expected) may own a higher id than
  // anything readable — the mint returns a usable id but must not claim it is safe.
  const planPath = planOnDisk("- id: W1-T5\n");
  mkdirSync(join(dirname(planPath), "tasks.d", "unreadable.yaml"), { recursive: true });
  assert.equal(await nextTaskIdCommand(["--plan", planPath, "--offline"]), 1);
});

test("nextTaskIdCommand: an unknown flag exits 2 (usage), and an unreadable plan exits 2 — never a silent mint", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  assert.equal(await nextTaskIdCommand(["--bogus"]), 2);
  assert.equal(await nextTaskIdCommand(["--plan", join(tmpdir(), "no-such-dir-mint", "tasks.yaml"), "--offline"]), 2);
});

class NextTaskIdExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

test("main(): `rmd next-task-id` actually ROUTES to nextTaskIdCommand and exits with its code", async (t) => {
  const exitMock = ((code?: number): never => {
    throw new NextTaskIdExitCalled(code);
  }) as typeof process.exit;
  t.mock.method(process, "exit", exitMock);
  const logSpy = t.mock.method(console, "log", () => {});
  const planPath = planOnDisk("- id: W1-T41\n");
  const originalArgv = process.argv;
  const originalGuard = process.env[SELF_SYNC_GUARD_ENV];
  process.argv = ["node", "run-task.js", "next-task-id", "--plan", planPath, "--offline"];
  process.env[SELF_SYNC_GUARD_ENV] = "1";
  try {
    let caught: unknown;
    await main().catch((e) => {
      caught = e;
    });
    assert.ok(caught instanceof NextTaskIdExitCalled, "main() must reach process.exit via nextTaskIdCommand's return value");
    assert.equal((caught as NextTaskIdExitCalled).code, 0);
    assert.match(logSpy.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /W1-T42/);
  } finally {
    process.argv = originalArgv;
    if (originalGuard === undefined) delete process.env[SELF_SYNC_GUARD_ENV];
    else process.env[SELF_SYNC_GUARD_ENV] = originalGuard;
  }
});
