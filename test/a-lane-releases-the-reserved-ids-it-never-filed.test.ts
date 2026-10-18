/**
 * test/a-lane-releases-the-reserved-ids-it-never-filed.test.ts — W1-T9488.
 *
 * Triage, plan and batch approve reserve a whole block of `refs/rmd-id/<id>` on origin before their
 * worker or gate decides what to file, and used to leave every id they did not file there for good
 * (2026-10-14 census: 807 of triage's 843 reservations held by no shard, branch or PR). Each lane now
 * gives back, in its `finally`, every reserved id its pushed branch does not declare — leased on the
 * sha it pushed, through `releaseTaskIdReservation`.
 *
 * EVERYTHING HERE IS REAL but the worker and `gh`: a bare fixture origin, a managed clone, real
 * worktrees, real `git push`. The assertions read the refs that are left on the fixture origin.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { approveCommand, laneReleaseReason, releaseUnfiledReservations, triageCommand } from "../src/run-task.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { WorkerResult } from "../src/lib/worker.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const SAVED = { HOME: process.env.HOME, PATH: process.env.PATH };
afterEach(() => {
  process.env.HOME = SAVED.HOME;
  process.env.PATH = SAVED.PATH;
});

type Row = Record<string, unknown>;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

function fakeWorker(text: string): WorkerResult {
  return {
    sessionId: "T9488", costUsd: 0, numTurns: 1, text, blocks: [text], stderr: "",
    subtype: "success", isError: false, apiError: false, model: "claude-opus-5", effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    totalCostUsd: 0, billingMode: "subscription", verdict: "success", qualitySuspect: false,
    compactionEvents: [], childEnvKeys: [],
  } as unknown as WorkerResult;
}

const TASK_FIELDS = ["  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", "  attempts: 0"].join("\n");

/** The fixture world: a bare origin, a managed clone of it at `<root>/repos/<repo>`, and a HOME whose config points at it. */
function world(kind: string, seed: (dir: string) => void) {
  const bare = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-origin-`));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { env: GIT_ENV });
  const seedDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-seed-`));
  execFileSync("git", ["init", "--quiet", "-b", "main", seedDir], { env: GIT_ENV });
  mkdirSync(join(seedDir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seedDir, "plan", "tasks.yaml"), `- id: W1-T9\n  title: "seed"\n${TASK_FIELDS}\n`);
  writeFileSync(join(seedDir, "MASTER-PLAN.md"), "# MASTER-PLAN (fixture)\n");
  seed(seedDir);
  git(seedDir, "add", "-A");
  git(seedDir, "commit", "--quiet", "-m", "chore: seed plan");
  git(seedDir, "remote", "add", "origin", bare);
  git(seedDir, "push", "--quiet", "origin", "main");
  rmSync(seedDir, { recursive: true, force: true });

  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-root-`));
  const remoteUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
  const repoDir = join(root, "repos", remoteUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2]!);
  mkdirSync(dirname(repoDir), { recursive: true });
  execFileSync("git", ["clone", "--quiet", bare, repoDir], { env: GIT_ENV });
  git(repoDir, "config", "user.name", "t");
  git(repoDir, "config", "user.email", "t@t");
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${kind}-home-`));
  const config = { claudeBin: "/usr/bin/true", root, installRoot: REPO_ROOT };
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify(config));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledger = (): Row[] => {
    const path = join(root, "state", "ledger.ndjson");
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : [];
  };
  /** The `refs/rmd-id/*` names still on the fixture origin. */
  const reservedRefs = (): string[] =>
    git(bare, "for-each-ref", "--format=%(refname)", "refs/rmd-id/").split("\n").filter(Boolean).map((r) => r.replace("refs/rmd-id/", ""));
  return {
    bare, root, repoDir, home, config, ledger, reservedRefs,
    cleanup: () => { for (const d of [bare, root, home]) rmSync(d, { recursive: true, force: true }); },
  };
}

/** Drive the real `triageCommand` once; `fileIds` are the ids the fake worker files (none ⇒ NO_TASK). */
async function runTriage(fileIds: string[]) {
  const feedbackId = `fb-t9488-${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;
  const w = world("t9488-triage", (dir) => {
    mkdirSync(join(dir, "plan", "feedback"), { recursive: true });
    writeFileSync(join(dir, "plan", "feedback", `${feedbackId}.yaml`), [`id: ${feedbackId}`, "ts: '2026-10-18T00:00:00.000Z'", "raw: fixture entry for W1-T9488", "attachments: []", "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"));
  });
  const shim = ghShim([
    { when: "pr list", stdout: "[]" },
    { when: "pr create", stdout: "https://github.com/craigoley/remudero/pull/999" },
    { when: "--json headRefName", stdout: JSON.stringify({ headRefName: "main" }) },
    { when: "--json body", stdout: JSON.stringify({ body: "" }) },
    { when: "pr diff", stdout: "" },
  ], { kind: "t9488-gh" });
  process.env.HOME = w.home;
  process.env.PATH = `${shim.dir}:${SAVED.PATH}`;
  const heldDuringWorker: string[][] = [];
  await withLiveWritesAllowed(() =>
    triageCommand([feedbackId], {
      config: w.config as never,
      spawn: async (args: { cwd: string; prompt: string; tools?: string[] }) => {
        if ((args.tools ?? []).length === 0) return fakeWorker("{}");
        heldDuringWorker.push(w.reservedRefs());
        if (fileIds.length === 0) return fakeWorker("nothing to file");
        mkdirSync(join(args.cwd, "plan", "tasks.d"), { recursive: true });
        for (const id of fileIds) {
          writeFileSync(join(args.cwd, "plan", "tasks.d", `${id}-fixture.yaml`), [
            `- id: ${id}`, `  title: "a clean task ${id} filed for the W1-T9488 proof"`, TASK_FIELDS, "  origin: architect",
            "  files: [test/a-lane-releases-the-reserved-ids-it-never-filed.test.ts]", "  acceptance:",
            '    - claim: "the thing holds"',
            '      proof: "unit test: test/a-lane-releases-the-reserved-ids-it-never-filed.test.ts"', "",
          ].join("\n"));
        }
        return fakeWorker(`PROPOSED: file ${fileIds.join(", ")} for feedback#${feedbackId}`);
      },
    }),
  ).catch(() => undefined); // no real backend for the post-PR steps in this fixture
  return { w, feedbackId, heldDuringWorker };
}

test("a triage run that files nothing releases every remote id it reserved", async () => {
  const { w, feedbackId, heldDuringWorker } = await runTriage([]);
  try {
    assert.deepEqual(heldDuringWorker[0], ["W1-T10", "W1-T11", "W1-T12"], "positive control: the worker ran while the whole block was held on origin");
    assert.deepEqual(w.reservedRefs(), [], "every reserved ref is gone from origin once the run ended");
    const released = w.ledger().filter((l) => l.step === "task_id.reservation_released");
    assert.deepEqual(released.map((l) => l.reserved_id).sort(), ["W1-T10", "W1-T11", "W1-T12"]);
    for (const row of released) {
      assert.equal(row.lane, "triage");
      assert.equal(row.outcome, "released");
      assert.match(String(row.reason), new RegExp(`triage ${feedbackId}: verdict error`), "the reason names the verdict");
      assert.match(String(row.reason), /no branch pushed/);
    }
  } finally {
    w.cleanup();
  }
});

test("a lane that files fewer ids than it reserved releases only the unused ones", async () => {
  const { w, heldDuringWorker } = await runTriage(["W1-T10"]);
  try {
    assert.deepEqual(heldDuringWorker[0], ["W1-T10", "W1-T11", "W1-T12"], "positive control: three ids were held while the worker ran");
    const branches = git(w.bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/run-*").split("\n").filter(Boolean);
    assert.equal(branches.length, 1, "positive control: the run pushed its branch");
    assert.match(git(w.bare, "ls-tree", "-r", "--name-only", branches[0]!), /plan\/tasks\.d\/W1-T10-fixture\.yaml/, "the branch declares W1-T10");
    assert.deepEqual(w.reservedRefs(), ["W1-T10"], "the id the pushed branch declares keeps its reservation; the unused tail is gone");
    const released = w.ledger().filter((l) => l.step === "task_id.reservation_released");
    assert.deepEqual(released.map((l) => l.reserved_id).sort(), ["W1-T11", "W1-T12"]);
    assert.match(String(released[0]!.reason), /verdict propose; branch declares 1 id/);
  } finally {
    w.cleanup();
  }
});

test("a lane whose push outcome is unknown releases nothing, and a lane that pushed nothing releases everything", () => {
  const calls: string[][] = [];
  const rows: Row[] = [];
  const sha = "a".repeat(40);
  const mk = () => ["W1-T1", "W1-T2"].map((taskId) => ({ taskId, sha }));
  const run = (args: string[]) => { calls.push(args); return { status: 0, stdout: "", stderr: "" }; };
  const opts = { run, lane: "triage", reason: "r", log: (step: string, fields: Record<string, unknown>) => void rows.push({ step, ...fields }) };
  const unknown = mk();
  releaseUnfiledReservations(unknown, "unknown", opts);
  assert.equal(calls.length, 0, "no git call: the branch may carry the id");
  assert.deepEqual(rows.map((r) => r.outcome), ["push_outcome_unknown", "push_outcome_unknown"]);
  assert.deepEqual(unknown, [], "the held list is drained");
  releaseUnfiledReservations(mk(), undefined, opts);
  assert.equal(calls.filter((c) => c[0] === "ls-remote").length, 2, "nothing pushed: both are released (absent refs are a no-op)");
  assert.equal(laneReleaseReason("plan", "verdict propose", ["W1-T1"]), "plan: verdict propose; branch declares 1 id(s)");
  assert.equal(laneReleaseReason("plan", "errored: boom", "unknown"), "plan: errored: boom; push outcome unknown");
});

/** A batch approve of two proposals over the REAL gateway, in a world the caller may break first. */
function batchWorld(break_: (w: ReturnType<typeof world>) => void) {
  const ids = ["P-ONE", "P-TWO"];
  const w = world("t9488-batch", () => {});
  break_(w);
  writeFileSync(join(w.root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: ids.map((id) => ({ id, summary: `ratify ${id}`, evidenceAnchors: [] })) }));
  writeFileSync(
    join(w.root, "state", "inbox-drafts.json"),
    JSON.stringify(Object.fromEntries(ids.map((id, i) => [id, {
      proposalId: id,
      fragmentYaml: `- id: NEW-${i + 1}\n  title: ${i === 0 ? "a quiet zebra crossing" : "a loud giraffe parade"}\n  repo: remudero\n  type: implement\n  verify: human\n  origin: architect\n`,
      stampLine: `- ${id} (plan) — RATIFIED -> NEW-${i + 1}.`,
      anchorFingerprint: "",
    }]))),
  );
  const shim = ghShim([{ when: "pulls?", stdout: "[]" }], { kind: "t9488-batch-gh" });
  const run = async (): Promise<Row[]> => {
    process.env.HOME = w.home;
    process.env.PATH = `${shim.dir}:${SAVED.PATH}`;
    await assert.rejects(withLiveWritesAllowed(() => approveCommand(ids, { config: w.config as never })));
    const rows = w.ledger();
    assert.equal(rows.filter((r) => r.step === "approve.id_materialized").length, 2, "positive control: both members' ids were reserved and materialized before the failure");
    return rows;
  };
  return { w, run };
}

test("a batch approve that fails before its push releases every member's reservation", async () => {
  // Every commit in the managed clone (and so in the batch's worktree) must be signed and no key exists, so it is refused: both members' blocks are
  // reserved and their shards written, and the run dies before anything is pushed.
  const { w, run } = batchWorld((fx) => {
    git(fx.repoDir, "config", "commit.gpgsign", "true");
  });
  try {
    const rows = await run();
    assert.equal(git(w.bare, "for-each-ref", "refs/heads/run-*").trim(), "", "positive control: no branch reached origin");
    assert.deepEqual(w.reservedRefs(), [], "no member's reservation is left on origin");
    const released = rows.filter((r) => r.step === "task_id.reservation_released");
    assert.deepEqual(released.map((r) => r.reserved_id).sort(), ["W1-T10", "W1-T11"]);
    for (const row of released) {
      assert.equal(row.lane, "approve-batch");
      assert.match(String(row.reason), /errored: .*; no branch pushed/);
    }
  } finally {
    w.cleanup();
  }
});

test("a batch approve that fails after its push keeps the ids its branch declares", async () => {
  // The body emission refuses (the fixture's grep proofs cannot prove the head) AFTER the push: the branch carries both ids.
  const { w, run } = batchWorld(() => {});
  try {
    const rows = await run();
    assert.match(git(w.bare, "for-each-ref", "refs/heads/run-*"), /run-APPROVE-BATCH-/, "positive control: the branch reached origin");
    assert.deepEqual(w.reservedRefs(), ["W1-T10", "W1-T11"], "a pushed branch's declared ids keep their reservations");
    assert.deepEqual(rows.filter((r) => r.step === "task_id.reservation_released"), []);
  } finally {
    w.cleanup();
  }
});
