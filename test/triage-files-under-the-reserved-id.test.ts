/**
 * test/triage-files-under-the-reserved-id.test.ts — W1-T2326.
 *
 * `triageCommandLocked` used to derive `reservedIds`/`reservedTaskId` from `localIdBlock`, which
 * starts at the ADVISORY `mint.n`, and prompt the worker with that. `reserveTaskIdBlockRemote` ran
 * 100+ lines later, inside `decision.action === "propose"`, and its `remoteIdBlock.taskIds` reached
 * nothing but the `triage.id_minted` row — so the lane reserved one id and filed under another.
 *
 * Every test here drives the REAL `triageCommand` against a REAL local bare origin (no network),
 * with `gh` shimmed on PATH and `spawn` injected — the same harness `test/triage-id-mint.test.ts`
 * established. The DIVERGENCE is forced by pre-creating `refs/rmd-id/` refs on that origin so the
 * remote reserver must advance past the advisory id: nothing else about the run changes, and the
 * only question is which number reaches the worker.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { triageCommand } from "../src/run-task.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { WorkerResult } from "../src/lib/worker.js";

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

function fakeWorker(text: string): WorkerResult {
  return {
    sessionId: "T2326", costUsd: 0, numTurns: 1, text, blocks: [text], stderr: "",
    subtype: "success", isError: false, apiError: false, model: "claude-opus-5", effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalCostUsd: 0, billingMode: "subscription", verdict: "success", qualitySuspect: false,
    compactionEvents: [], childEnvKeys: [],
  } as unknown as WorkerResult;
}

const TASK_FIELDS = ["  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0"].join("\n");

/** A bare origin whose plan tops out at W1-T9 (so the advisory mint is W1-T10), plus one `new`
 *  feedback entry. `heldIds` are pre-created `refs/rmd-id/` refs — the lever that forces the remote
 *  reservation to advance past the advisory number. */
function makeOrigin(feedbackId: string, heldIds: string[]): string {
  const bare = mkdtempSync(join(tmpdir(), "t2326-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "t2326-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed, "plan", "tasks.yaml"), `- id: W1-T9\n  title: "seed"\n${TASK_FIELDS}\n`);
  // `applyPlanProposalCommit` stages `plan/ MASTER-PLAN.md` in one `git add`, so an absent
  // MASTER-PLAN.md fails the pathspec and throws BEFORE the id check below can run. The fixture
  // needs it for the same reason the real repo has it.
  writeFileSync(join(seed, "MASTER-PLAN.md"), "# MASTER-PLAN (fixture)\n");
  writeFileSync(
    join(seed, "plan", "feedback", `${feedbackId}.yaml`),
    [`id: ${feedbackId}`, "ts: '2026-08-26T00:00:00.000Z'", "raw: fixture entry for W1-T2326",
      "attachments: []", "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"),
  );
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed plan");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  // The held reservations, pushed as the allocator's own ref shape. An empty commit is enough —
  // `reserveTaskIdRemote` only asks whether the ref EXISTS.
  for (const id of heldIds) {
    const sha = git(seed, "commit-tree", git(seed, "rev-parse", "HEAD^{tree}").trim(), "-m", `rmd-id reservation held-by-another-caller ${id}`).trim();
    git(seed, "push", "--quiet", "origin", `${sha}:refs/rmd-id/${id}`);
  }
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

interface RunResult {
  ledger: Array<Record<string, unknown>>;
  prompts: string[];
  configRoot: string;
  cleanup: () => void;
}

/** Drive the real `triageCommand` once. `fileAs` decides which id the fake worker files under,
 *  given the id the prompt actually named. */
async function runTriage(heldIds: string[], fileAs: (promptedId: string) => string | null): Promise<RunResult> {
  const feedbackId = `fb-t2326-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
  const bare = makeOrigin(feedbackId, heldIds);
  const home = mkdtempSync(join(tmpdir(), "t2326-home-"));
  const configRoot = mkdtempSync(join(tmpdir(), "t2326-root-"));
  const shimDir = mkdtempSync(join(tmpdir(), "t2326-gh-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  const prompts: string[] = [];
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }));
    process.env.HOME = home;

    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["-C", repoDir, "config", "user.name", "t"], { encoding: "utf8" });
    execFileSync("git", ["-C", repoDir, "config", "user.email", "t@t"], { encoding: "utf8" });

    writeFileSync(join(shimDir, "gh"), [
      "#!/bin/sh",
      'case "$*" in',
      '  *"pr list"*) echo "[]" ;;',
      '  *"pr create"*) echo "https://github.com/craigoley/remudero/pull/999" ;;',
      `  *"--json headRefName"*) git -C ${bare} for-each-ref --format='{"headRefName":"%(refname:short)"}' refs/heads/run-* | tail -1 ;;`,
      "  *\"--json body\"*) echo '{\"body\":\"\"}' ;;",
      '  *"pr diff"*) echo "" ;;',
      "  *) exit 1 ;;",
      "esac", "",
    ].join("\n"), { mode: 0o755 });
    process.env.PATH = `${shimDir}:${savedPath}`;

    await withLiveWritesAllowed(() =>
      triageCommand([feedbackId], {
        spawn: async (args: { cwd: string; prompt: string; tools?: string[] }) => {
          if ((args.tools ?? []).length === 0) return fakeWorker("{}");
          prompts.push(args.prompt);
          const prompted = /USE EXACTLY `(W\d+-T\d+)`/.exec(args.prompt)?.[1];
          assert.ok(prompted, "the triage prompt must name an id");
          const id = fileAs(prompted);
          if (id === null) return fakeWorker("NO_TASK: nothing to file");
          const dir = join(args.cwd, "plan", "tasks.d");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${id}-fixture.yaml`), [
            `- id: ${id}`, `  title: "a clean task filed for the W1-T2326 proof"`,
            "  repo: remudero", "  origin: architect", "  depends_on: []", "  type: implement",
            "  verify: auto", "  status: queued", "  attempts: 0",
            "  files: [test/triage-files-under-the-reserved-id.test.ts]", "  acceptance:",
            '    - claim: "the thing holds"',
            '      proof: "unit test: test/triage-files-under-the-reserved-id.test.ts"', "",
          ].join("\n"));
          return fakeWorker(`PROPOSED: file ${id} for feedback#${feedbackId}`);
        },
      }),
    ).catch(() => undefined); // no real backend for the post-PR steps in this fixture

    const path = join(configRoot, "state", "ledger.ndjson");
    const ledger = existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
    return {
      ledger, prompts, configRoot,
      cleanup: () => {
        process.env.PATH = savedPath;
        if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
        for (const d of [shimDir, home, configRoot, bare]) rmSync(d, { recursive: true, force: true });
      },
    };
  } catch (e) {
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    for (const d of [shimDir, home, configRoot, bare]) rmSync(d, { recursive: true, force: true });
    throw e;
  }
}

// ── ACCEPTANCE 1 + 2: the prompt comes from the REMOTE block, taken BEFORE the prompt ─────────

test("criterion 1/2: with the advisory id already held on origin, the worker is prompted with the RESERVED id and files under it — the reservation is taken before the prompt exists", async () => {
  // The plan tops out at W1-T9, so the advisory mint is W1-T10. Two reservation refs are already
  // held by "another caller", so the remote reserver must advance to W1-T12.
  const r = await runTriage(["W1-T10", "W1-T11"], (prompted) => prompted);
  try {
    assert.equal(r.prompts.length, 1, "exactly one worker prompt");
    const prompted = /USE EXACTLY `(W\d+-T\d+)`/.exec(r.prompts[0]!)![1];
    assert.equal(prompted, "W1-T12", "the prompt names the id the REMOTE reservation actually took, not the advisory W1-T10");
    assert.doesNotMatch(r.prompts[0]!, /USE EXACTLY `W1-T10`/, "the advisory id never reaches the worker");

    const minted = r.ledger.filter((l) => l.step === "triage.id_minted");
    assert.equal(minted.length, 1, "one mint row per proposed run");
    assert.equal(minted[0]!.mint_id, "W1-T10", "the advisory is still recorded as the advisory");
    assert.equal(minted[0]!.minted_id, "W1-T12", "and the reservation is what was actually taken");
    assert.deepEqual(minted[0]!.reserved_ids, ["W1-T12", "W1-T13", "W1-T14"], "the whole block is remote-reserved, contiguously above the held refs");

    // The FILING itself — the thing the defect got wrong.
    const check = r.ledger.filter((l) => l.step === "triage.id_check");
    assert.equal(check.length, 1);
    assert.equal(check[0]!.ok, true, "the id the worker filed under is inside the reserved block");
    assert.deepEqual(check[0]!.unreserved, []);
  } finally {
    r.cleanup();
  }
});

// ── ACCEPTANCE 7: the ledger separates reserved-vs-advisory from local-vs-advisory ────────────

test("criterion 7: the mint row carries reserved_differs_from_advisory, and reserved_above_mint reads FALSE through the same divergence — the false friend answers a different question", async () => {
  const r = await runTriage(["W1-T10", "W1-T11"], (prompted) => prompted);
  try {
    const row = r.ledger.find((l) => l.step === "triage.id_minted")!;
    assert.equal(row.reserved_differs_from_advisory, true, "the reservation (W1-T12) differs from the advisory (W1-T10)");
    assert.equal(
      row.reserved_above_mint,
      false,
      "reserved_above_mint compares the LOCAL block against the advisory, and the local store was empty — so it reads false through a real divergence, exactly as it did through both degraded rows of 2026-08-26",
    );
  } finally {
    r.cleanup();
  }
});

// ── ACCEPTANCE 5 + 6: the mismatch is REPORTED, and reporting decides nothing ─────────────────

test("criterion 5/6: a worker that files outside the reserved block is reported with BOTH lists, and the run still proposes — the check refuses nothing and escalates nothing", async () => {
  // The worker ignores the id it was given and files under a number nobody reserved.
  const r = await runTriage(["W1-T10", "W1-T11"], () => "W1-T77");
  try {
    const check = r.ledger.filter((l) => l.step === "triage.id_check");
    assert.equal(check.length, 1, "the check runs on every proposed run, not only on failure");
    assert.equal(check[0]!.ok, false);
    assert.deepEqual(check[0]!.unreserved, ["W1-T77"], "the report names the id that was filed");
    assert.deepEqual(check[0]!.reserved, ["W1-T12", "W1-T13", "W1-T14"], "and the block it should have come from");

    // REPORT-ONLY: the run reached the mint row (i.e. it proposed) and opened no escalation.
    assert.equal(r.ledger.filter((l) => l.step === "triage.id_minted").length, 1, "the run still proposed — the check refuses nothing");
    assert.equal(r.ledger.filter((l) => String(l.step).startsWith("escalation.")).length, 0, "no escalation is opened by the check");
    assert.equal(r.ledger.filter((l) => l.step === "triage.grill_opened").length, 0, "and no grill");
  } finally {
    r.cleanup();
  }
});

// ── ACCEPTANCE 8: a run that never proposes is bounded in what it holds ───────────────────────

test("criterion 8: a run that resolves NO_TASK still takes exactly one block and no more, and releases its local half", async () => {
  const r = await runTriage([], () => null);
  try {
    assert.equal(r.ledger.filter((l) => l.step === "triage.id_minted").length, 0, "no mint row — the run never proposed");
    assert.equal(r.ledger.filter((l) => l.step === "triage.id_check").length, 0, "and no id check");
    // The local half has a release path and must have used it, whatever the verdict.
    const dir = join(r.configRoot, "state", "task-id-reservations");
    const left = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".")) : [];
    assert.deepEqual(left, [], "localIdBlock.releaseAll() ran in the finally — the local reservation is not leaked by a non-proposing run");
  } finally {
    r.cleanup();
  }
});

// ── ACCEPTANCE 3 + 4: the source itself, read as text ─────────────────────────────────────────

test("criterion 3/4: no identifier is named as though it were reserved while bound to an advisory-derived value, and the linter grades the same list the prompt used", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  // CONTROL FIRST: the file is readable and the region under test is present.
  assert.match(src, /const reservedHeadTaskId = reservedIds\[0\];/, "control: the renamed identifier exists");

  // The trap name must not survive as an IDENTIFIER. It may appear in prose explaining why.
  const asIdentifier = /(?:const|let|var)\s+reservedTaskId\b|\breservedTaskId\s*[,)=]/g;
  assert.deepEqual(src.match(asIdentifier), null, "`reservedTaskId` must not exist as an identifier at any commit");

  // The prompt, the relint loop's filedIds and the linter all read ONE list, and that list is the
  // remote block. Asserted on the assignment rather than on each consumer, which is what makes it
  // a single source rather than three that happen to agree today.
  assert.match(src, /const reservedIds = remoteIdBlock\.taskIds;/, "reservedIds is the remote block");
  assert.match(src, /initialPrompt: triagePrompt\(entry, runId, reservedHeadTaskId, reservedIds\.slice\(1\)\)/, "the prompt reads it");
  assert.match(src, /lintFiledTasks\(worktreePath, reservedIds,/, "and so does the linter inside the loop");

  // The spend gate is unchanged and still pre-spawn.
  assert.match(src, /localIdBlock = reserveTaskIdBlock\(mint\.n, TRIAGE_MAX_NEW_TASKS, taskIdReservationsDir\(config\.root\)/, "the local block is still taken from the advisory, before spawn");
  assert.match(src, /localIdBlock\?\.releaseAll\(\);/, "and still released in the finally");
});
