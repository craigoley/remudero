/**
 * W1-T5348 — A MACHINE LANE NEVER OPENS A PLAN PR THAT IS ALREADY RED.
 *
 * MEASURED 09-25..10-02: 31 machine-lane plan-only PRs went red for 67.2 red-hours, and the 8 generator template
 * defects among them (#7946 a proof grepping a record id already on base, #7861 a declared path that did not exist,
 * #8725 a 105-character title, ...) were each detectable offline before the push. `planPrPreflight` runs those checks
 * on the exact tree about to be pushed; a red one refuses the push and ledgers `plan_pr.preflight_refused`.
 *
 * Every git fixture comes from test/helpers/git-repo.ts; GitHub is a recording fetcher / fake `gh`, never the network.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import { LANDING_BRANCH, landFeedback } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import {
  PlanPrPreflightRefusedError,
  planPrPreflight,
  planPrPreflightAllows,
  planPrPreflightAtCommit,
  refuseRedPlanPr,
  type PlanPrPreflightChecks,
  type PlanPrPreflightResult,
} from "../src/lib/plan-pr-emitter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gardenCheckout } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type LogRow = { step: string; extra?: Record<string, unknown> };

/** A `check-proof --base origin/main` stand-in for `grep:` proofs: 1 when the head misses, 5 when origin/main matches too. */
function grepAtHeadAndBase(cwd: string, proof: string): number {
  const m = /^grep: (.+) in (\S+)$/.exec(proof.trim());
  if (!m) return 2;
  const re = new RegExp(m[1], "m");
  const headPath = join(cwd, m[2]);
  if (!existsSync(headPath) || !re.test(readFileSync(headPath, "utf8"))) return 1;
  let base = "";
  try {
    base = execFileSync("git", ["-C", cwd, "show", `origin/main:${m[2]}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    base = "";
  }
  return re.test(base) ? 5 : 0;
}

const GREEN = { status: 0, output: "" };

/** Every check green except the proof check, which really greps the tree and origin/main. */
const offlineChecks: PlanPrPreflightChecks = {
  lintPlan: () => GREEN,
  taskIdExistence: () => GREEN,
  shardCensus: () => GREEN,
  checkProof: grepAtHeadAndBase,
};

function shard(id: string, proof: string): string {
  return [`- id: ${id}`, `  title: "a fixture task"`, "  repo: remudero", "  acceptance:", `    - claim: "it holds"`, `      proof: "${proof}"`, ""].join("\n");
}

/** A bare origin whose main carries `files`, plus a clone of it. */
function originWith(files: Record<string, string>, kind: string) {
  const seed = gitRepo({ kind: `${kind}-seed` });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed.dir, rel)), { recursive: true });
    writeFileSync(join(seed.dir, rel), text);
  }
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "chore: seed");
  const origin = gitRepo({ bare: true, kind: `${kind}-origin` });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: `${kind}-clone` });
  clone.git("config", "user.email", "g@example.invalid");
  clone.git("config", "user.name", "g");
  const heads = () => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
  return { origin, clone, heads };
}

// ── the pure verdict ─────────────────────────────────────────────────────────────────────────

test("a clean tree passes every check and an unreadable check is reported without refusing", () => {
  const f = originWith({ "README.md": "seed\n" }, "w5348-pure");
  const clean = planPrPreflight({ cwd: f.clone.dir, title: "chore(plan): file one task", body: "no acceptance block" }, offlineChecks);
  assert.deepEqual(clean, { ok: true, failures: [], unreadable: [] });

  const down = planPrPreflight(
    { cwd: f.clone.dir, title: "chore(plan): file one task", body: "" },
    {
      ...offlineChecks,
      taskIdExistence: () => ({ status: null, output: "" }),
      shardCensus: () => {
        throw new Error("spawn ENOENT");
      },
    },
  );
  assert.equal(down.ok, true, "a check that could not run never refuses");
  assert.deepEqual(
    down.unreadable.map((u) => u.check),
    ["task-id-existence", "shard-census"],
  );
  assert.match(down.unreadable[1].firstLine, /spawn ENOENT/);
});

test("each red check refuses by name: plan lint, unreserved id, over-long or untyped title, broken census", () => {
  const f = originWith({ "README.md": "seed\n" }, "w5348-red");
  const red = (output: string) => () => ({ status: 1, output });
  const r = planPrPreflight(
    { cwd: f.clone.dir, title: `chore(plan): ${"x".repeat(100)}`, body: "" },
    {
      ...offlineChecks,
      lintPlan: red("lint-plan-precheck: the plan lint CI runs on this diff REFUSES it [proof-dialect]:\n  ✗ W9-T1"),
      taskIdExistence: red("\ntask-id-existence: FAILED -- W9-T1 is not reserved"),
      shardCensus: red("TAP version 13\nnot ok 1 - every shard on main is lintable\n# fail 1"),
    },
  );
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.failures.map((x) => x.check),
    ["lint-plan", "task-id-existence", "pr-title", "shard-census"],
  );
  assert.match(r.failures[0].firstLine, /REFUSES it \[proof-dialect\]/);
  assert.match(r.failures[1].firstLine, /W9-T1 is not reserved/);
  assert.match(r.failures[2].firstLine, /header-max-length/);
  assert.match(r.failures[3].firstLine, /^not ok 1/);

  const untyped = planPrPreflight({ cwd: f.clone.dir, title: "Plan: file it", body: "" }, offlineChecks);
  assert.deepEqual(untyped.failures.map((x) => x.check), ["pr-title"]);
});

test("a PR-body proof that already passes at origin/main is red; a shard proof that fails at head is not", () => {
  const f = originWith({ "README.md": "seed\n", "plan/feedback/fb-acc.yaml": "id: fb-acc\nstatus: new\n" }, "w5348-proof");
  mkdirSync(join(f.clone.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(f.clone.dir, "plan", "tasks.d", "W9-T7-future.yaml"), shard("W9-T7", "grep: not-built-yet in src/later.ts"));
  f.clone.git("add", "-A");
  f.clone.git("commit", "-q", "-m", "chore(plan): file W9-T7");

  const stale = planPrPreflight(
    { cwd: f.clone.dir, title: "chore(feedback): land pending filings", body: "## Acceptance\n- fb-acc lands | grep: fb-acc in plan/feedback/fb-acc.yaml" },
    offlineChecks,
  );
  assert.equal(stale.ok, false, "the #7946 shape: the record id is already on origin/main, so the proof cannot discriminate");
  assert.equal(stale.failures[0].check, "proof-discrimination");
  assert.match(stale.failures[0].firstLine, /fb-acc/);

  const noTest = planPrPreflight({ cwd: f.clone.dir, title: "chore(plan): x", body: "## Acceptance\n- c | unit test: nothing" }, { ...offlineChecks, checkProof: () => 3 });
  assert.match(noTest.failures[0]?.firstLine ?? "", /matches no tests/);

  const flaky = planPrPreflight({ cwd: f.clone.dir, title: "chore(plan): x", body: "## Acceptance\n- c | grep: W9-T7 in plan/tasks.d/W9-T7-future.yaml" }, { ...offlineChecks, checkProof: () => 4 });
  assert.equal(flaky.ok, true, "an exec error is unreadable, not red");
  assert.equal(flaky.unreadable[0].check, "proof-discrimination");

  const filing = planPrPreflight({ cwd: f.clone.dir, title: "chore(plan): file W9-T7", body: "## Acceptance\n- filed | grep: W9-T7 in plan/tasks.d/W9-T7-future.yaml" }, offlineChecks);
  assert.deepEqual(filing, { ok: true, failures: [], unreadable: [] }, "an unbuilt task's own proof fails at head by design");
});

test("the lane helpers ledger a refusal and an unreadable check, and the throwing form names the checks", () => {
  const rows: LogRow[] = [];
  const log = (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra });
  const red: PlanPrPreflightResult = { ok: false, failures: [{ check: "pr-title", firstLine: "header-max-length: too long" }], unreadable: [{ check: "shard-census", firstLine: "absent" }] };
  assert.equal(planPrPreflightAllows(red, { lane: "plan", branch: "plan-garden-1", log }), false);
  assert.deepEqual(rows.map((r) => r.step), ["plan_pr.preflight_unreadable", "plan_pr.preflight_refused"]);
  assert.deepEqual(rows[1].extra, { lane: "plan", branch: "plan-garden-1", failures: red.failures });
  assert.throws(() => refuseRedPlanPr(red, { lane: "approve", branch: "run-x" }), (e: unknown) => e instanceof PlanPrPreflightRefusedError && /\[pr-title\]/.test(e.message));
  assert.doesNotThrow(() => refuseRedPlanPr({ ok: true, failures: [], unreadable: [] }, { lane: "approve", branch: "run-x" }));
});

// ── the real checks, shelled out against the exact tree ─────────────────────────────────────

test("the default checks really run on a materialized commit: an unreserved id and a stale shard proof refuse", () => {
  const f = originWith(
    {
      "README.md": "seed\n",
      "base.txt": "already-on-main\n",
      "package.json": JSON.stringify({ scripts: { "lint-plan:fast": "node fake-lint.mjs --base origin/main" } }),
      "fake-lint.mjs": "process.exit(0);\n",
      "scripts/task-id-existence-check.mjs": "console.error('task-id-existence: FAILED -- W9-T1 is not reserved');\nprocess.exit(1);\n",
      "test/every-shard-on-main-is-lintable.test.ts": "import { test } from 'node:test';\ntest('census', () => {});\n",
      "src/run-task.ts": "process.exit(process.argv[3].includes('already-on-main') ? 5 : 0);\n",
    },
    "w5348-real",
  );
  mkdirSync(join(f.clone.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(f.clone.dir, "plan", "tasks.d", "W9-T1-stale.yaml"), shard("W9-T1", "grep: already-on-main in base.txt"));
  writeFileSync(join(f.clone.dir, "plan", "tasks.d", "W9-T2-broken.yaml"), "- id: [\n");
  f.clone.git("add", "-A");
  f.clone.git("commit", "-q", "-m", "chore(plan): file W9-T1");
  const sha = f.clone.git("rev-parse", "HEAD");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(f.clone.dir, "node_modules"));

  const r = planPrPreflightAtCommit(f.clone.dir, sha, { title: "chore(plan): file W9-T1", body: "## Acceptance\n- filed | grep: W9-T1 in plan/tasks.d/W9-T1-stale.yaml" });
  assert.deepEqual(r.failures.map((x) => x.check), ["task-id-existence", "proof-discrimination"], JSON.stringify(r));
  assert.deepEqual(r.unreadable, [], JSON.stringify(r));
  assert.match(r.failures[1].firstLine, /already-on-main/);
  assert.doesNotMatch(f.clone.git("worktree", "list"), /plan-pr-preflight/, "the materialized tree is removed");

  const ghost = planPrPreflightAtCommit(f.clone.dir, "0".repeat(40), { title: "chore(plan): x", body: "" });
  assert.equal(ghost.ok, true);
  assert.equal(ghost.unreadable[0].check, "tree");

  const bare = gitRepo({ kind: "w5348-empty" });
  const absent = planPrPreflight({ cwd: bare.dir, title: "chore(plan): x", body: "## Acceptance\n- c | grep: x in README.md" });
  assert.equal(absent.ok, true, "no script in the tree is unreadable, never red");
  assert.deepEqual(absent.unreadable.map((u) => u.check), ["lint-plan", "task-id-existence", "proof-discrimination", "shard-census"]);
});

// ── the lanes ───────────────────────────────────────────────────────────────────────────────

function garden(cloneDir: string, fetcher: (args: string[]) => unknown, rows: LogRow[]) {
  return gardenCheckout({
    name: "ci-friction",
    repoDir: cloneDir,
    worktreesRoot: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w5348-wt-`)),
    owner: "acme",
    repo: "remudero",
    log: (step, extra) => rows.push({ step, extra }),
    clock: fixedClock(1790000005348),
    fetcher,
    preflight: (input) => planPrPreflight(input, offlineChecks),
  });
}

test("a garden land whose shard's only proof greps a line already on origin/main neither pushes nor opens a PR", () => {
  const f = originWith({ "README.md": "seed\n", "base.txt": "already-on-main\n" }, "w5348-garden");
  const rows: LogRow[] = [];
  const calls: string[][] = [];
  const ws = garden(f.clone.dir, (args) => (calls.push(args), { html_url: "https://github.com/acme/remudero/pull/1", number: 1 }), rows);
  try {
    mkdirSync(join(ws.root, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(ws.root, "plan", "tasks.d", "W9-T3-stale.yaml"), shard("W9-T3", "grep: already-on-main in base.txt"));
    const pr = withLiveWritesAllowed(() => ws.land({ paths: ["plan/tasks.d/W9-T3-stale.yaml"], title: "chore(plan): ci-friction files one cause", body: "b" }));
    assert.equal(pr, undefined, "the lane's not-landed outcome");
    assert.deepEqual(f.heads(), ["main"], "nothing was pushed");
    assert.deepEqual(calls, [], "no PR was opened");
    const refused = rows.find((r) => r.step === "plan_pr.preflight_refused");
    assert.equal(refused?.extra?.lane, "ci-friction");
    assert.equal(refused?.extra?.branch, "ci-friction-garden-1790000005348");
    assert.deepEqual((refused?.extra?.failures as Array<{ check: string }>).map((x) => x.check), ["proof-discrimination"]);
  } finally {
    ws.dispose();
  }
});

test("a clean garden land pushes and opens its PR as today", () => {
  const f = originWith({ "README.md": "seed\n" }, "w5348-garden-clean");
  const rows: LogRow[] = [];
  const ws = garden(f.clone.dir, () => ({ html_url: "https://github.com/acme/remudero/pull/2", number: 2 }), rows);
  try {
    mkdirSync(join(ws.root, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(ws.root, "plan", "tasks.d", "W9-T4-new.yaml"), shard("W9-T4", "grep: not-built-yet in src/later.ts"));
    const pr = withLiveWritesAllowed(() => ws.land({ paths: ["plan/tasks.d/W9-T4-new.yaml"], title: "chore(plan): ci-friction files one cause", body: "b" }));
    assert.equal(pr, "https://github.com/acme/remudero/pull/2");
    assert.deepEqual(f.heads(), ["ci-friction-garden-1790000005348", "main"]);
    assert.equal(rows.some((r) => r.step.startsWith("plan_pr.")), false);
  } finally {
    ws.dispose();
  }
});

function fakeGh() {
  const calls: string[][] = [];
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/77\n";
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  return { gh, calls };
}

test("feedback-landing's accept path never pushes a landing whose record id is already on origin/main (#7946)", () => {
  const f = originWith({ "README.md": "seed\n", "plan/feedback/fb-acc.yaml": "id: fb-acc\nstatus: new\nraw: a note\n" }, "w5348-landing");
  writeFileSync(join(f.clone.dir, "plan", "feedback", "fb-acc.yaml"), "id: fb-acc\nstatus: accepted\nraw: a note\n");
  const rows: LogRow[] = [];
  const { gh, calls } = fakeGh();
  let preflights = 0;
  const planPrPreflight = (sha: string, pr: { title: string; body: string }) => (preflights++, planPrPreflightAtCommit(f.clone.dir, sha, pr, offlineChecks));
  const opts = { gh, log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }), planPrPreflight };

  const first = withLiveWritesAllowed(() => landFeedback(f.clone.dir, opts));
  assert.equal(first.landed, false);
  assert.match(first.error ?? "", /preflight refused.*proof-discrimination/);
  assert.deepEqual(f.heads(), ["main"], `nothing was pushed to ${LANDING_BRANCH}`);
  assert.equal(calls.filter((c) => c[1] === "create").length, 0, "no PR was opened");
  const refused = rows.find((r) => r.step === "plan_pr.preflight_refused");
  assert.equal(refused?.extra?.lane, "feedback-landing");
  assert.equal(refused?.extra?.branch, LANDING_BRANCH);

  const again = withLiveWritesAllowed(() => landFeedback(f.clone.dir, opts));
  assert.equal(again.landed, false);
  assert.equal(preflights, 1, "an unchanged refused tree is not re-checked on the next poll");
});

test("a clean feedback landing still pushes and opens its PR", () => {
  const f = originWith({ "README.md": "seed\n" }, "w5348-landing-clean");
  mkdirSync(join(f.clone.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(f.clone.dir, "plan", "feedback", "fb-new.yaml"), "id: fb-new\nstatus: new\nraw: fresh\n");
  const { gh, calls } = fakeGh();
  const r = withLiveWritesAllowed(() =>
    landFeedback(f.clone.dir, { gh, planPrPreflight: (sha, pr) => planPrPreflightAtCommit(f.clone.dir, sha, pr, offlineChecks) }),
  );
  assert.equal(r.landed, true, JSON.stringify(r));
  assert.equal(r.pushed, true);
  assert.deepEqual(f.heads(), [LANDING_BRANCH, "main"]);
  assert.equal(calls.filter((c) => c[1] === "create").length, 1);
});
