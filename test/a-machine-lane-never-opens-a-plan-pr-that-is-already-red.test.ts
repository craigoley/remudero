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
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { fixedClock } from "../src/lib/clock.js";
import * as landing from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import * as emitter from "../src/lib/plan-pr-emitter.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gardenCheckout } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";
// @ts-expect-error -- test executes the untyped executable module directly.
import { classifyUnreadableOpenPrSurface } from "../scripts/task-id-existence-check.mjs";

// Namespace imports, so this file LOADS at a base that lacks these symbols and each test fails there by name — the
// proof then discriminates instead of reading "discrimination unknown" off a module-load error.
const { LANDING_BRANCH, landFeedback } = landing;
const { PlanPrPreflightRefusedError, TASK_ID_UNREADABLE_RE, planPrPreflight, planPrPreflightAllows, planPrPreflightAtCommit, refuseRedPlanPr } = emitter;
type PlanPrPreflightChecks = emitter.PlanPrPreflightChecks;
type PlanPrPreflightResult = emitter.PlanPrPreflightResult;

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

test("failure summaries prefer a real marker line over incidental marker text", () => {
  const f = originWith({ "README.md": "seed\n" }, "w5348-summary");
  const result = planPrPreflight(
    { cwd: f.clone.dir, title: "chore(plan): file a task", body: "" },
    {
      ...offlineChecks,
      lintPlan: () => ({ status: 1, output: "download FAILED from cache\n✗ W9-T1 [proof-dialect] invalid proof\n" }),
    },
  );
  assert.equal(result.failures[0]?.firstLine, "✗ W9-T1 [proof-dialect] invalid proof");
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

test("TASK_ID_UNREADABLE_RE reads the script's own required-but-unreadable refusal as unreadable, never a collision", () => {
  const required = classifyUnreadableOpenPrSurface("open-prs", { owner: "acme", repo: "remudero" }, true);
  assert.equal(required.refuse, true);
  assert.equal(TASK_ID_UNREADABLE_RE.test(required.message), true);
  assert.equal(TASK_ID_UNREADABLE_RE.test("task-id-existence: FAILED -- W9-T1 is declared on origin/main"), false);
});

// ── the real checks, shelled out against the exact tree ─────────────────────────────────────

function lintPrecheckFiles(): Record<string, string> {
  return Object.fromEntries(["scripts/lint-plan-precheck.mjs", "scripts/lib/argv.mjs", "scripts/lib/git.mjs"]
    .map((path) => [path, readFileSync(join(REPO_ROOT, path), "utf8")]));
}

test("the emitter loads in a source-only sandbox and reports the absent lint script as unreadable", () => {
  const sandbox = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w5348-source-only-`));
  try {
    for (const dir of ["src", "plan"]) cpSync(join(REPO_ROOT, dir), join(sandbox, dir), { recursive: true });
    for (const file of ["package.json", "tsconfig.json"]) copyFileSync(join(REPO_ROOT, file), join(sandbox, file));
    symlinkSync(join(REPO_ROOT, "node_modules"), join(sandbox, "node_modules"));
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_V8_COVERAGE: undefined };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import { planPrPreflight, renderAcceptanceBlock } from './src/lib/plan-pr-emitter.ts';
      console.log(JSON.stringify({
        block: renderAcceptanceBlock([{ claim: 'filed', proof: 'grep: id in shard.yaml' }]),
        result: planPrPreflight({ cwd: process.cwd(), title: 'chore(plan): file a task', body: '' })
      }));
    `], { cwd: sandbox, encoding: "utf8", env });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    const { block, result } = JSON.parse(child.stdout);
    assert.equal(block, "Acceptance:\n- filed | grep: id in shard.yaml");
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.unreadable.find((u: { check: string }) => u.check === "lint-plan"), {
      check: "lint-plan", firstLine: "scripts/lint-plan-precheck.mjs is absent from the tree",
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the default checks really run on a materialized commit: an unreserved id and a stale shard proof refuse", () => {
  const f = originWith(
    {
      ...lintPrecheckFiles(),
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

test("the default lint precheck refuses a named violation and reports an execution error as unreadable", () => {
  const f = originWith({
    ...lintPrecheckFiles(),
    "package.json": JSON.stringify({ scripts: { "lint-plan:fast": "node fake-lint.mjs --base origin/main" } }),
    "fake-lint.mjs": "console.error('✗ W9-T1\\n    [proof-dialect] invalid proof'); process.exit(1);\n",
  }, "w5348-real-lint");
  mkdirSync(join(f.clone.dir, "plan"));
  writeFileSync(join(f.clone.dir, "plan", "new.yaml"), "id: W9-T1\n");
  f.clone.git("add", "-A");
  f.clone.git("commit", "-q", "-m", "chore(plan): file a task");
  const input = { cwd: f.clone.dir, title: "chore(plan): file a task", body: "" };
  const { lintPlan: _unused, ...checks } = offlineChecks;
  const red = planPrPreflight(input, checks);
  assert.equal(red.ok, false);
  assert.deepEqual(red.failures.map((x) => x.check), ["lint-plan"]);
  assert.match(red.failures[0].firstLine, /REFUSES.*proof-dialect/);
  assert.deepEqual(red.unreadable, []);

  writeFileSync(join(f.clone.dir, "fake-lint.mjs"), "console.error('lint unavailable'); process.exit(2);\n");
  const unreadable = planPrPreflight(input, checks);
  assert.equal(unreadable.ok, true);
  assert.deepEqual(unreadable.failures, []);
  assert.deepEqual(unreadable.unreadable.map((x) => x.check), ["lint-plan"]);
  assert.match(unreadable.unreadable[0].firstLine, /exited 2.*not blocking/);
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

test("feedback-landing's accept path never pushes a landing whose proof already passes at origin/main (#7946)", () => {
  // An attachment's template proof is `grep: . in <path>`, and a change that only DELETES a line leaves no line the
  // pushed bytes hold that base lacks — so no discriminating proof exists and the template proof stands, red.
  const rel = "plan/feedback/attachments/fb-acc.txt";
  const f = originWith({ "README.md": "seed\n", [rel]: "kept\ndropped\n" }, "w5348-landing");
  writeFileSync(join(f.clone.dir, rel), "kept\n");
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

// ── a status-change landing's proof discriminates ─────────────────────────────────────────────

/** Real `grep -arn` hits — the executor's own invocation — of a `grep:` proof against `text`. */
function realGrepHits(proof: string, text: string): number {
  const m = /^grep: (.+) in (\S+)$/.exec(proof);
  assert.ok(m, `not a grep proof: ${proof}`);
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w5348-grep-`));
  try {
    writeFileSync(join(dir, "f"), text);
    const r = spawnSync("grep", ["-arn", "--", m[1], join(dir, "f")], { encoding: "utf8" });
    assert.ok(r.status === 0 || r.status === 1, `grep could not run the pattern ${m[1]}: ${r.stderr}`);
    return r.stdout.split("\n").filter(Boolean).length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a changed record's landing proof names one line only its new state holds, and real grep misses it at base", () => {
  const rel = "plan/feedback/fb-acc.yaml";
  const at = (base: string | undefined, head: string) => ({ base: () => base, head: () => head });
  const statusFlip = landing.discriminatingLandingProof(rel, at("id: fb-acc\nstatus: proposed\nraw: a note\n", "id: fb-acc\nstatus: accepted\nraw: a note\nproposal_pr: 12\n"));
  assert.equal(statusFlip, `grep: ^status: accepted$ in ${rel}`, "the lifecycle line is preferred over any other added line");

  // Every metacharacter is a one-character bracket; a line holding `\`, `^` or a bracket is never chosen.
  const base = "summary: a.b\n";
  const head = "summary: a.b\nweird: back\\slash ^caret [x]\nnote: a.b*(c)+{d}|$e?\n";
  const escaped = landing.discriminatingLandingProof(rel, at(base, head));
  assert.equal(escaped, `grep: ^note: a[.]b[*][(]c[)][+][{]d[}][|][$]e[?]$ in ${rel}`);
  assert.equal(realGrepHits(escaped!, head), 1, "the pushed bytes match");
  assert.equal(realGrepHits(escaped!, base), 0, "the merge-base misses");
  assert.equal(realGrepHits(escaped!, "note: aXb*(c)+{d}|$e?\n"), 0, "a bracketed dot is a literal dot");
  assert.equal(realGrepHits(statusFlip!, "status: accepted\n"), 1);
  assert.equal(realGrepHits(statusFlip!, "status: accepted_later\n"), 0, "the line is anchored whole");

  assert.equal(landing.discriminatingLandingProof(rel, at(undefined, "id: fb-new\n")), undefined, "a NEW path keeps its template proof");
  assert.equal(landing.discriminatingLandingProof(rel, at("a\nb\n", "a\n")), undefined, "a pure deletion has no line to name");
  assert.equal(landing.discriminatingLandingProof(rel, at("a\nb\n", "b\na\n")), undefined, "a reorder has no line to name");
  assert.equal(landing.discriminatingLandingProof(rel, at("a\n", "a\n" + "x".repeat(200) + "\n")), undefined, "wrapped prose is not a proof");
});

test("a feedback status-change landing pushes, opens its PR with a discriminating proof, and refreshes it on the next push", () => {
  const rel = "plan/feedback/fb-acc.yaml";
  const f = originWith({ "README.md": "seed\n", [rel]: "id: fb-acc\nstatus: new\nraw: a note\n" }, "w5348-status-change");
  // THE REPRODUCTION: the template every feedback landing used to render already passes at origin/main.
  writeFileSync(join(f.clone.dir, rel), "id: fb-acc\nstatus: grilling\nraw: a note\n");
  assert.equal(grepAtHeadAndBase(f.clone.dir, `grep: fb-acc in ${rel}`), 5, "the old template proof passes at base too");

  const bodies: string[] = [];
  const rows: LogRow[] = [];
  const { gh, calls } = fakeGh();
  const opts = {
    gh,
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }),
    planPrPreflight: (sha: string, pr: { title: string; body: string }) => (bodies.push(pr.body), planPrPreflightAtCommit(f.clone.dir, sha, pr, offlineChecks)),
  };
  const r = withLiveWritesAllowed(() => landFeedback(f.clone.dir, opts));
  assert.equal(r.landed, true, JSON.stringify(r));
  assert.equal(r.pushed, true);
  assert.deepEqual(f.heads(), [LANDING_BRANCH, "main"]);
  assert.equal(rows.some((row) => row.step === "plan_pr.preflight_refused"), false);
  const create = calls.find((c) => c[1] === "create")!;
  const body = create[create.indexOf("--body") + 1];
  assert.equal(body, bodies[0], "the PR carries exactly the body the preflight judged");
  assert.match(body, /^- fb-acc lands as a durable inbox entry \| grep: \^status: grilling\$ in plan\/feedback\/fb-acc\.yaml$/m);

  // The record moves again while its PR is open: the push rewrites the open PR's body over REST to the new line.
  writeFileSync(join(f.clone.dir, rel), "id: fb-acc\nstatus: proposed\nraw: a note\n");
  const patches: string[][] = [];
  const openGh = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ url: "https://github.com/o/r/pull/77" }]);
    if (args[0] === "api" && args[2] === "PATCH") return (patches.push(args), "{}");
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  const second = withLiveWritesAllowed(() => landFeedback(f.clone.dir, { ...opts, gh: openGh }));
  assert.equal(second.landed, true, JSON.stringify(second));
  assert.equal(second.error, undefined);
  assert.equal(patches.length, 1);
  assert.equal(patches[0][3], "repos/o/r/pulls/77");
  assert.match(patches[0][5], /grep: \^status: proposed\$ in plan\/feedback\/fb-acc\.yaml/);

  const failing = (args: string[]): string => {
    if (args[0] === "api") throw new Error("HTTP 502");
    return openGh(args);
  };
  writeFileSync(join(f.clone.dir, rel), "id: fb-acc\nstatus: accepted\nraw: a note\n");
  const third = withLiveWritesAllowed(() => landFeedback(f.clone.dir, { ...opts, gh: failing }));
  assert.equal(third.landed, true, "the push landed; only the body refresh failed");
  assert.match(third.error ?? "", /refreshing the body of https:\/\/github\.com\/o\/r\/pull\/77 failed: HTTP 502/);
});

test("the plan-reconcile, decisions and ci-learning landings each render a proof that misses their merge-base", () => {
  const f = originWith(
    {
      "README.md": "seed\n",
      "plan/tasks.d/W9-T7-done.yaml": "- id: W9-T7\n  status: queued\n  acceptance:\n    - claim: c\n      proof: \"grep: seed in README.md\"\n",
      "plan/tasks.d/W9-T8-lesson.yaml": "- id: W9-T8\n  author_class: machine\n  title: first wording\n",
      "plan/decisions.d/W9-T9-r1.md": "an earlier record\n",
    },
    "w5348-families",
  );
  const bodies: Array<{ title: string; body: string }> = [];
  const capture = (sha: string, pr: { title: string; body: string }) => (bodies.push(pr), planPrPreflightAtCommit(f.clone.dir, sha, pr, offlineChecks));
  const run = <T>(fn: () => T): T => withLiveWritesAllowed(fn);

  const reconciled = run(() =>
    landing.landPlanReconcileShards(
      f.clone.dir,
      [{ relPath: "plan/tasks.d/W9-T7-done.yaml", content: "- id: W9-T7\n  status: merged\n  acceptance:\n    - claim: c\n      proof: \"grep: seed in README.md\"\n" }],
      { gh: fakeGh().gh, planPrPreflight: capture },
    ),
  );
  assert.equal(reconciled.landed, true, JSON.stringify(reconciled));
  assert.match(bodies.at(-1)!.body, /\| grep: \^  status: merged\$ in plan\/tasks\.d\/W9-T7-done\.yaml$/m);

  const decided = run(() =>
    landing.recordDecision(
      f.clone.dir,
      { taskId: "W9-T9", runId: "r1", options: ["a", "b"], chosen: "a", band: "low", reason: "measured", ts: "2026-10-03T00:00:00.000Z" },
      { gh: fakeGh().gh, planPrPreflight: capture },
    ),
  );
  assert.equal(decided.landed, true, JSON.stringify(decided));
  const decisionProof = /\| (grep: .+ in plan\/decisions\.d\/W9-T9-r1\.md)$/m.exec(bodies.at(-1)!.body)?.[1];
  assert.ok(decisionProof && decisionProof !== "grep: . in plan/decisions.d/W9-T9-r1.md", bodies.at(-1)!.body);

  const stateRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w5348-ci-learning-`));
  try {
    const pending = join(stateRoot, "state", "ci-learning-pending", "plan", "tasks.d", "W9-T8-lesson.yaml");
    mkdirSync(dirname(pending), { recursive: true });
    writeFileSync(pending, "- id: W9-T8\n  author_class: machine\n  title: second wording\n");
    const filed = run(() =>
      landing.landCiLearningShards([], f.clone.dir, {
        stateRoot,
        mintTaskId: () => "W9-T99",
        planOrigins: [],
        renderShard: () => "",
        recordVerdict: () => ({ ok: true, reason: "" }),
        gh: fakeGh().gh,
        planPrPreflight: capture,
      }),
    );
    assert.equal(bodies.at(-1)!.title, "chore(ci-learning): land pending lessons", JSON.stringify(filed));
    assert.match(bodies.at(-1)!.body, /\| grep: \^  title: second wording\$ in plan\/tasks\.d\/W9-T8-lesson\.yaml$/m);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("a changed shard's proofs that origin/main already declares are not this PR's to discriminate; a new one is", () => {
  const rel = "plan/tasks.d/W9-T7-done.yaml";
  const before = shard("W9-T7", "grep: seed in README.md");
  const f = originWith({ "README.md": "seed\n", [rel]: before }, "w5348-shard-proofs");
  writeFileSync(join(f.clone.dir, rel), before.replace("  repo: remudero\n", "  repo: remudero\n  status: merged\n"));
  f.clone.git("commit", "-q", "-am", "chore(plan): reconcile W9-T7");
  const statusOnly = planPrPreflight({ cwd: f.clone.dir, title: "chore(plan): reconcile credited task statuses", body: "" }, offlineChecks);
  assert.deepEqual(statusOnly, { ok: true, failures: [], unreadable: [] }, "a merged task's own proof passing at base is not a red");

  writeFileSync(join(f.clone.dir, rel), `${before}    - claim: "a second claim"\n      proof: "grep: se in README.md"\n`);
  f.clone.git("commit", "-q", "-am", "chore(plan): add a proof to W9-T7");
  const added = planPrPreflight({ cwd: f.clone.dir, title: "chore(plan): add a proof", body: "" }, offlineChecks);
  assert.equal(added.ok, false, JSON.stringify(added));
  assert.match(added.failures[0].firstLine, /grep: se in README\.md/);
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
