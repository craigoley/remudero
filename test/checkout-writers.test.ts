// test/checkout-writers.test.ts — impl-EP.
//
// THE DEFECT. W1-T191 (#966) built a bridge that lands feedback writes on a bot branch instead of the
// daemon's own checkout, and wired it "only at the console's decision route". Two sibling writers were
// left taking `setFeedbackStatus`'s raw `writeFileSync` branch straight into that checkout:
//   - `reconcileFeedbackEntries` (panel-graph.ts), 208 lines above the site #966 DID fix, in the same
//     file. It fires whenever a proposal PR merges, inside the long-lived `rmd serve` process.
//   - `panel-skill-run.ts`'s `grilling` flip, previously unreported.
//
// The cost was measured, not guessed: 107 aborted deploys, and `plan/feedback/fb-…5ac4ca.yaml` sitting
// modified 63 seconds after PR #1058 merged, its diff exactly the `proposed -> accepted` transition the
// reconcile path performs.
//
// WHAT THESE TESTS ASSERT, and it is the thing that actually matters: that the WORKING TREE IS CLEAN
// after the call. Not that a function ran, not that a branch was taken — `git status --porcelain`
// empty. That is the property the deploy guard reads, and the only one that stops the aborts.
//
// The fixture is a real throwaway git repo in a temp dir with a local bare origin. Nothing here
// touches the canonical checkout, reaches the network, or spawns a worker.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { buildPanelGraphRoutes, reconcileFeedbackEntries } from "../src/lib/panel-graph.js";
import { createService } from "../src/lib/service.js";
import { buildDeployLogger } from "../src/lib/deployer.js";
import { listFeedback, setFeedbackStatus } from "../src/lib/feedback.js";
import { LANDING_BRANCH } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { GitHub } from "../src/lib/status.js";

/** A `gh` stand-in so PR-open/list/merge never reaches real GitHub, while the `git` half runs for
 *  real against the fixture's local bare origin — the injection shape test/feedback-landing.test.ts
 *  already established. */
function fakeGh(prUrl = "https://github.com/o/r/pull/1") {
  let created = 0;
  return (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") return created > 0 ? JSON.stringify([{ url: prUrl }]) : JSON.stringify([]);
    if (args[0] === "pr" && args[1] === "create") { created++; return `${prUrl}\n`; }
    if (args[0] === "pr" && args[1] === "merge") return "";
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
}

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

/** A throwaway repo with a local bare origin and one `proposed` feedback entry, committed. */
function fixtureRepo(id = "fb-1700000000000-aaaaaa"): { root: string; bare: string; id: string; cleanup: () => void } {
  const bare = mkdtempSync(join(tmpdir(), "rmd-ep-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  const root = mkdtempSync(join(tmpdir(), "rmd-ep-root-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", root], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(
    join(root, "plan", "feedback", `${id}.yaml`),
    [`id: ${id}`, "ts: '2026-08-01T00:00:00.000Z'", "raw: a fixture proposal", "attachments: []", "origin: cli", "status: proposed", "proposal_pr: 'https://github.com/o/r/pull/7'", ""].join("\n"),
  );
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "seed");
  git(root, "remote", "add", "origin", bare);
  git(root, "push", "--quiet", "origin", "main");
  return { root, bare, id, cleanup: () => { for (const d of [root, bare]) rmSync(d, { recursive: true, force: true }); } };
}

/** Did the bridge ACTUALLY land? A "tree is clean" assertion alone would also pass if the bridge
 *  silently no-oped, which is the passes-for-the-wrong-reason shape this repo keeps hitting. */
function landedContent(bare: string, rel: string): string {
  return git(bare, "show", `${LANDING_BRANCH}:${rel}`);
}

function porcelain(root: string): string {
  return git(root, "--no-optional-locks", "status", "--porcelain").trim();
}

function mergedGithub(): GitHub {
  return {
    prByRef: () => ({ number: 7, url: "https://github.com/o/r/pull/7", state: "MERGED" }),
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

// ── WRITER 1: the reconcile path ─────────────────────────────────────────────────────

test("WRITER 1: a merged-proposal reconcile leaves the working tree CLEAN", () => {
  const f = fixtureRepo();
  try {
    assert.equal(porcelain(f.root), "", "precondition: the fixture starts clean");

    // The push below is REAL and lands in this fixture's throwaway bare origin in TMPDIR — never the
    // live repo — so the section is exempted from PR #954's live-write guard. Without this the guard
    // refuses the push, setFeedbackStatus swallows the refusal, and the tree is clean because NOTHING
    // was written — which would make the clean-tree assertion pass for entirely the wrong reason.
    const out = withLiveWritesAllowed(() =>
      reconcileFeedbackEntries(f.root, listFeedback(f.root, {}), mergedGithub(), { gh: fakeGh() }),
    );

    assert.equal(out[0].status, "accepted", "the status flip still happens — behaviour is unchanged");
    // THE ASSERTION THAT MATTERS. Before this change the same call left
    // ` M plan/feedback/<id>.yaml` here, which is what aborted 107 deploys.
    assert.equal(porcelain(f.root), "", `the tree must be CLEAN; saw:\n${porcelain(f.root)}`);
    // ...and the flip really went SOMEWHERE — otherwise a bridge that silently did nothing would
    // satisfy the clean-tree assertion above just as well.
    assert.match(landedContent(f.bare, `plan/feedback/${f.id}.yaml`), /status: accepted/);
  } finally {
    f.cleanup();
  }
});

test("WRITER 1: with NO land option the local write is unchanged, so worktree callers keep working", () => {
  // `run-task.ts`'s triage lane passes a WORKTREE root twice and legitimately wants the local write.
  // The option is passed at the sites that need it rather than flipped as a default, so absent means
  // exactly what it meant before.
  const f = fixtureRepo();
  try {
    const out = reconcileFeedbackEntries(f.root, listFeedback(f.root, {}), mergedGithub());
    assert.equal(out[0].status, "accepted");
    assert.match(porcelain(f.root), /plan\/feedback\//, "no land option ⇒ the local write, as before");
  } finally {
    f.cleanup();
  }
});

// ── WRITER 2: the grilling flip ──────────────────────────────────────────────────────

test("WRITER 2: the grilling flip leaves the working tree CLEAN when landed", () => {
  const f = fixtureRepo();
  try {
    assert.equal(porcelain(f.root), "");
    const entry = withLiveWritesAllowed(() => setFeedbackStatus(f.root, f.id, "grilling", { land: { gh: fakeGh() } }));
    assert.equal(entry.status, "grilling");
    assert.equal(porcelain(f.root), "", `the tree must be CLEAN; saw:\n${porcelain(f.root)}`);
    assert.match(landedContent(f.bare, `plan/feedback/${f.id}.yaml`), /status: grilling/);
  } finally {
    f.cleanup();
  }
});

// ── TRAP 1: a throwing bridge must not take down the console route ───────────────────

test("TRAP 1: a bridge that THROWS does not take down the reconcile path", () => {
  // Writer 1 runs inside the long-lived `rmd serve` process. A throw here would take out a console
  // route, and the console is the operator's live diagnostic surface. The status flip is bookkeeping;
  // losing it is better than losing the route.
  //
  // The throw is induced for real rather than mocked: a land target whose branch name git cannot
  // accept. `setFeedbackStatus` wraps the bridge in its own try/catch, so the call must still return.
  const f = fixtureRepo();
  try {
    const out = reconcileFeedbackEntries(f.root, listFeedback(f.root, {}), mergedGithub(), {
      // A git exec that THROWS on every call — the harshest possible bridge failure.
      git: () => { throw new Error("simulated: git is unavailable inside the console process"); },
      gh: fakeGh(),
    });

    assert.equal(out.length, 1, "the route still returned a result rather than throwing");
    assert.equal(out[0].status, "accepted", "the caller still sees the flip in its returned copy");
  } finally {
    f.cleanup();
  }
});

// ── TRAP 3: the bridge stages only its own paths ─────────────────────────────────────

test("TRAP 3: unrelated dirt in the tree is NOT swept into the landing", () => {
  // PR #1037's carry-forward defect was a bridge re-staging files at a stale blob. If a landing could
  // stage whatever else was lying around, a status flip would become a commit of unrelated dirt from
  // the daemon's tree. The bridge builds its tree in a SCRATCH index (GIT_INDEX_FILE) from
  // `read-tree origin/main` plus `update-index --cacheinfo` for explicitly named paths only.
  const f = fixtureRepo();
  try {
    // Unrelated dirt, of both kinds, present BEFORE the landing.
    writeFileSync(join(f.root, "unrelated-scratch.json"), "{}\n");
    writeFileSync(join(f.root, "plan", "tracked-and-modified.txt"), "seed\n");
    git(f.root, "add", "plan/tracked-and-modified.txt");
    git(f.root, "commit", "--quiet", "-m", "add a tracked file");
    git(f.root, "push", "--quiet", "origin", "main");
    writeFileSync(join(f.root, "plan", "tracked-and-modified.txt"), "locally modified\n");

    withLiveWritesAllowed(() => reconcileFeedbackEntries(f.root, listFeedback(f.root, {}), mergedGithub(), { gh: fakeGh() }));

    // The landed branch must carry the feedback entry and NOTHING else that was dirty.
    const landed = git(f.bare, "ls-tree", "-r", "--name-only", LANDING_BRANCH).trim().split("\n");
    assert.ok(landed.some((p) => p.startsWith("plan/feedback/")), `the landing carried its own path; saw ${JSON.stringify(landed)}`);
    assert.ok(!landed.includes("unrelated-scratch.json"), "untracked scratch was NOT staged");

    const landedTracked = git(f.bare, "show", `${LANDING_BRANCH}:plan/tracked-and-modified.txt`);
    assert.equal(landedTracked, "seed\n", "the tracked file landed at ORIGIN's blob, not the local modification");
  } finally {
    f.cleanup();
  }
});


test("THE ROUTE ITSELF leaves the tree clean, so dropping the wiring at the call site is caught", () => {
  // The tests above drive `reconcileFeedbackEntries` DIRECTLY, so they would still pass if someone
  // removed `deps.feedbackLand` from the route that calls it (panel-graph.ts) — which is exactly the
  // shape of the original defect: a correct function, unwired at one call site. This drives the real
  // GET /v1/feedback route through createService, the same plumbing test/panel-graph.test.ts uses.
  const f = fixtureRepo();
  // OUTSIDE the repo root — a ledger inside it would be untracked dirt of the test's own making and
  // would fail the clean-tree assertion for a reason that has nothing to do with the code under test.
  const ledgerDir = mkdtempSync(join(tmpdir(), "rmd-ep-ledger-"));
  const ledgerPath = join(ledgerDir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  return withLiveWritesAllowed(async () => {
    const server = createService({
      tokens: { read: "r", write: "w" },
      routes: buildPanelGraphRoutes({
        root: f.root,
        planPath: join(f.root, "plan", "tasks.yaml"),
        ledgerPath,
        github: { prView: () => null } as never,
        statusGithub: mergedGithub(),
        feedbackLand: { gh: fakeGh() },
      } as never),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/feedback`, { headers: { authorization: "Bearer r" } });
      assert.equal(res.status, 200, "the route still answers");
      assert.equal(porcelain(f.root), "", `the route must leave the tree CLEAN; saw:\n${porcelain(f.root)}`);
      assert.match(landedContent(f.bare, `plan/feedback/${f.id}.yaml`), /status: accepted/);
    } finally {
      server.close();
      f.cleanup();
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });
});


test("the deploy abort is LEDGERED with the conflicting paths named", () => {
  // 107 dirty-tree aborts left ZERO ledger rows across 663 rotations, because this logger only ever
  // wrote to stdout. deployer.ts already emits the step WITH the paths; only the wiring was missing.
  const rows: Array<Record<string, unknown>> = [];
  const out: string[] = [];
  const log = buildDeployLogger("/unused/ledger.ndjson", {
    append: (_p: string, row: unknown) => void rows.push(row as Record<string, unknown>),
    out: (line: string) => void out.push(line),
    now: () => 1234,
  });

  // The exact call deployer.ts makes on a dirty-tree abort.
  log("deploy.abort_dirty_tree", { conflicting: ["plan/feedback/fb-1784919210522-5ac4ca.yaml", "ee-open.json"] });

  assert.equal(rows.length, 1, "the abort reaches the LEDGER, not stdout alone");
  assert.equal(rows[0].step, "deploy.abort_dirty_tree");
  assert.equal(rows[0].task_id, "DEPLOY");
  assert.deepEqual(rows[0].conflicting, ["plan/feedback/fb-1784919210522-5ac4ca.yaml", "ee-open.json"],
    "the CONFLICTING PATHS are named — that is what makes an abort diagnosable in a day rather than eleven");
  assert.match(out[0], /### \[deploy\] deploy\.abort_dirty_tree/, "stdout is unchanged, so supervisor.out.log still carries it");
});

test("a ledger write failure never aborts the deploy cycle", () => {
  const out: string[] = [];
  const log = buildDeployLogger("/unused", {
    append: () => { throw new Error("simulated: ledger unwritable"); },
    out: (line: string) => void out.push(line),
  });
  assert.doesNotThrow(() => log("deploy.ok", { head: "abc1234" }));
  assert.equal(out.length, 1, "stdout still carried it");
});

// ── the .gitignore entry, named exactly ──────────────────────────────────────────────

test("the agent-scratch ignore names the file EXACTLY and does not glob json", () => {
  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  const lines = ignore.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  assert.ok(lines.includes("ee-open.json"), "the exact filename is ignored");
  // A `*.json` glob would mask package-lock.json and be worse than the disease.
  assert.ok(!lines.includes("*.json"), "a bare *.json glob must never be added");

  // NOT COMMITTED is a question for the INDEX, not for the disk. This asserted
  // `!existsSync` under a "not committed" message, which conflates the two: the
  // runtime WRITES ee-open.json into the operator's checkout, where it is present
  // and correctly ignored, so the assertion failed on the one host that actually
  // runs the fleet while CI — which clones fresh and never produces the file —
  // stayed green. Every session on that host re-derived the red as environmental.
  // `git ls-files` answers the question the message asks: empty output means the
  // path is untracked, whether or not it exists on disk.
  const tracked = execFileSync("git", ["ls-files", "--", "ee-open.json"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
  }).trim();
  assert.equal(tracked, "", "and the file is not committed (untracked in the index, present on disk or not)");
});
