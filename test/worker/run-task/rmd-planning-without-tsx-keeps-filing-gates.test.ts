import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { PLAN_MAX_NEW_TASKS } from "#src/run-task.js";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12517: a PROPOSED `rmd plan` result from a target repository without tsx still crosses every existing
// filing gate before anything is published. Each scenario is a REAL node process running the real planCommand
// under the harness's own loader, the real spawnWorker and the real default Codex probe, from a target cwd
// that carries no tsx. The Architect is a deterministic Codex stub that edits files in its own plan worktree.
// Only the publication boundary is local: planCommand's `prCreateExec` seam records the one call that would
// open a pull request. Nothing here proves hosted CI, the ordinary review or the protected merge has passed;
// those keep their authority after publication. (Why the children use `node --import <tsx> src/run-task.ts`
// rather than bin/rmd: the tsx CLI listens on a unix socket the worker sandbox refuses.)

const HARNESS_LOADER = pathToFileURL(createRequire(join(REPO_ROOT, "package.json")).resolve("tsx")).href;
const CHILD_DEADLINE_MS = 180_000;
const OUTPUT_TAIL_CHARS = 16_384;
const BRIEF = "file a task that bounds the retry loop";
const SEED_ID = "W1-T10";
const SEED_PLAN = `- id: ${SEED_ID}\n  title: seeded target task\n  repo: target\n  type: implement\n  status: queued\n`;
const PR_URL = "https://github.com/owner/target/pull/7";
const LIMITS = {
  rateLimits: { limitId: "codex", primary: { usedPercent: 20 } },
  rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 20 } } },
};

function stubModels() {
  const table = parseYaml(readFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), "utf8")) as { capabilities: { codex: Record<string, Record<string, string[]>> } };
  const ids = table.capabilities.codex.frontier!.high!;
  assert.ok(ids.length > 0, "positive control: the ladder names at least one Codex model for the Architect");
  return ids.map((id) => ({
    id, displayName: id, defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })),
  }));
}

/** What the Architect stub does on `exec`: write `files` (relative to its worktree; `{{ID}}` is the first
 *  id the harness reserved) and finish with `verdict`. */
interface Scenario { files: Record<string, string>; verdict: string }

function codexStub(path: string, log: string, scenario: Scenario): void {
  writeFileSync(path, `#!${process.execPath}
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const log = ${JSON.stringify(log)};
const scenario = ${JSON.stringify(scenario)};
const record = (entry) => appendFileSync(log, JSON.stringify({ ...entry, cwd: process.cwd() }) + "\\n");
const mode = process.argv[2];
let input = "";
if (mode === "app-server") {
  process.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
    for (let newline = input.indexOf("\\n"); newline >= 0; newline = input.indexOf("\\n")) {
      const request = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      record({ mode, method: request.method });
      const result = request.id === 1 ? {} : request.id === 2 ? ${JSON.stringify(LIMITS)}
        : request.id === 3 ? { data: ${JSON.stringify(stubModels())}, nextCursor: null } : undefined;
      if (result !== undefined) process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
    }
  });
} else {
  process.stdin.on("data", (chunk) => { input += chunk.toString("utf8"); });
  process.stdin.on("end", () => {
    const id = /RESERVED these ids for this run: (W1-T\\d+)/.exec(input)?.[1] ?? "NO-RESERVED-ID";
    for (const [file, text] of Object.entries(scenario.files)) {
      const target = file.split("{{ID}}").join(id);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text.split("{{ID}}").join(id));
    }
    record({ mode, argv: process.argv.slice(2), id, wrote: Object.keys(scenario.files).map((f) => f.split("{{ID}}").join(id)) });
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "stub-thread" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: scenario.verdict.split("{{ID}}").join(id) } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }) + "\\n");
  });
}
`);
  chmodSync(path, 0o755);
}

const GIT_IDENTITY = { GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...GIT_IDENTITY } });

/** The driver evaluated by each child: the real planCommand with only the publication boundary recorded. */
const CHILD_DRIVER = `
const fixture = JSON.parse(process.env.RMD_PLAN_GATES_FIXTURE);
const { planCommand } = await import(fixture.runTaskUrl);
const published = [];
let outcome;
try {
  const code = await planCommand(["--mode=create", fixture.brief], {
    prCreateExec: (file, args, options) => { published.push({ file, args, cwd: options.cwd }); return JSON.stringify({ html_url: fixture.prUrl, number: 7 }) + "\\n"; },
  });
  outcome = { code };
} catch (error) {
  outcome = { threw: String(error && error.message || error).slice(0, 1500) };
}
process.stdout.write("OUTCOME " + JSON.stringify({ outcome, published }) + "\\n");
process.exit(0);
`;

interface ChildRun { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function runDriver(cwd: string, fixture: Record<string, string>, env: NodeJS.ProcessEnv): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", HARNESS_LOADER, "--input-type=module", "--eval", CHILD_DRIVER],
      { cwd, env: { ...env, RMD_PLAN_GATES_FIXTURE: JSON.stringify(fixture) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL_CHARS); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL_CHARS); });
    const deadline = setTimeout(() => child.kill("SIGKILL"), CHILD_DEADLINE_MS);
    child.once("error", (error) => { clearTimeout(deadline); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(deadline); resolve({ code, signal, stdout, stderr }); });
  });
}

/** Run a repository script from `cwd` under the harness's loader, as the pre-push hook would. */
function runScript(cwd: string, script: string, args: string[]): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", HARNESS_LOADER, join(REPO_ROOT, "scripts", script), ...args], {
      cwd, env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...GIT_IDENTITY, NODE_V8_COVERAGE: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function ancestorResolvesTsx(dir: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, "node_modules", "tsx"))) return at;
    if (dirname(at) === at) return undefined;
  }
}

function assertTargetCarriesNoLoader(target: string, when: string): void {
  const rel = relative(REPO_ROOT, target);
  assert.ok(rel.startsWith("..") || isAbsolute(rel), `${when}: the target sits outside Core's tree`);
  assert.equal(ancestorResolvesTsx(target), undefined, `${when}: no ancestor of the target resolves tsx`);
  assert.equal(existsSync(join(target, "node_modules")), false, `${when}: the target has no node_modules`);
  assert.equal(existsSync(join(target, "package.json")), false, `${when}: the target declares no dependency`);
}

interface StubCall { mode: string; method?: string; argv?: string[]; id?: string; wrote?: string[]; cwd: string }
interface LedgerRow { step?: string; [key: string]: unknown }
interface Published { file: string; args: string[]; cwd: string }

/** One PROPOSED run in a disposable target fixture, observed at the Architect, the ledger, the origin and
 *  the publisher. `inspect` runs against the origin while the fixture still exists. */
async function proposeFrom(scenario: Scenario) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-plan-gates-")));
  let shim: GhShim | undefined;
  try {
    const bare = join(root, "origin", "owner", "target.git"), target = join(root, "target");
    const home = join(root, "home"), state = join(root, "state-root"), cli = join(root, "cli"), codexHome = join(root, "codex-home"), privateTmp = join(root, "tmp");
    for (const dir of [bare, home, state, cli, codexHome, privateTmp, join(home, ".config", "remudero")]) mkdirSync(dir, { recursive: true });
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(root, "clone", "-q", bare, target);
    mkdirSync(join(target, "plan"), { recursive: true });
    mkdirSync(join(target, ".remudero"));
    cpSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), join(target, ".remudero", "mounts.yaml"));
    writeFileSync(join(target, "plan", "tasks.yaml"), SEED_PLAN);
    writeFileSync(join(target, "MASTER-PLAN.md"), "# Target plan\n"); // planCommand stages plan/ and MASTER-PLAN.md
    git(target, "add", "-A");
    git(target, "commit", "-qm", "seed the target plan");
    git(target, "push", "-q", "origin", "HEAD:main");
    git(root, "clone", "-q", bare, join(state, "repos", "target"));
    const calls = join(cli, "calls.ndjson"), codexBin = join(cli, "codex");
    codexStub(codexBin, calls, scenario);
    // The shared PATH shim: records every call and answers an empty list, so nothing reaches GitHub.
    shim = ghShim([{ when: "", stdout: "[]" }], { kind: "rmd-plan-gh" });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({
      claudeBin: join(cli, "no-claude-in-this-fixture"), root: state, installRoot: REPO_ROOT,
      workerProviders: { enabled: ["codex"], codexBin, codexHome, capacityCacheMs: 60_000 },
    }));
    assertTargetCarriesNoLoader(target, "before");
    const mainBefore = git(target, "rev-parse", "HEAD").trim();
    const env: NodeJS.ProcessEnv = {
      PATH: `${shim.dir}:${process.env.PATH}`, LANG: process.env.LANG, HOME: home, TMPDIR: privateTmp,
      RMD_TEST_SLOT_DIR: join(privateTmp, "test-slots"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      ...GIT_IDENTITY, NODE_V8_COVERAGE: undefined,
    };
    const run = await runDriver(target, { runTaskUrl: pathToFileURL(join(REPO_ROOT, "src", "run-task.ts")).href, brief: BRIEF, prUrl: PR_URL }, env);
    assertTargetCarriesNoLoader(target, "after");
    const evidence = `exit=${run.code} signal=${run.signal}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
    const line = run.stdout.split("\n").find((entry) => entry.startsWith("OUTCOME "));
    assert.ok(line, `the child reported an outcome\n${evidence}`);
    const { outcome, published } = JSON.parse(line.slice("OUTCOME ".length)) as { outcome: { code?: number; threw?: string }; published: Published[] };
    const read = <T>(path: string): T[] => existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((entry) => JSON.parse(entry) as T) : [];
    const heads = git(root, "--git-dir", bare, "for-each-ref", "--format=%(refname:short)", "refs/heads").trim().split("\n").filter(Boolean);
    const pushed = heads.filter((head) => head !== "main");
    // Standing rule 15 on real checkouts, by the real pre-push script: the Architect's pushed branch, and the
    // same criteria edit riding beside an implementation file the way an implementation worker would write it.
    const rule15: { architect?: ChildRun; worker?: ChildRun } = {};
    if (pushed.length === 1) {
      const inspect = join(root, "inspect");
      git(root, "clone", "-q", bare, inspect);
      git(inspect, "checkout", "-q", pushed[0]!);
      rule15.architect = await runScript(inspect, "rule15-precheck.mjs", ["--base", "origin/main"]);
      git(inspect, "checkout", "-q", "-b", "worker-edits-its-own-criteria", "origin/main");
      writeFileSync(join(inspect, "plan", "tasks.yaml"), `${SEED_PLAN}  acceptance:\n    - claim: the seeded task is done\n      proof: "grep: seeded in plan/tasks.yaml"\n`);
      mkdirSync(join(inspect, "src"));
      writeFileSync(join(inspect, "src", "retry.ts"), "export const retries = 3;\n");
      git(inspect, "add", "-A");
      git(inspect, "commit", "-qm", "worker edit");
      rule15.worker = await runScript(inspect, "rule15-precheck.mjs", ["--base", "origin/main"]);
    }
    return {
      rule15,
      evidence, outcome, published, calls: read<StubCall>(calls), gh: shim.calls(),
      ledger: read<LedgerRow>(join(state, "state", "ledger.ndjson")), stdout: run.stdout,
      pushed, mainAfter: git(root, "--git-dir", bare, "rev-parse", "main").trim(), mainBefore,
      /** What each pushed branch changes against main, read while the fixture still exists. */
      branches: Object.fromEntries(pushed.map((branch) => [branch, {
        footprint: git(root, "--git-dir", bare, "diff", "--name-only", `main...${branch}`).trim().split("\n").filter(Boolean),
        diff: git(root, "--git-dir", bare, "diff", `main...${branch}`),
      }])) as Record<string, { footprint: string[]; diff: string }>,
      targetEntries: git(target, "status", "--porcelain").trim(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
    if (shim) rmSync(shim.dir, { recursive: true, force: true });
  }
}

type Proposed = Awaited<ReturnType<typeof proposeFrom>>;

function assertArchitectRan(run: Proposed, label: string): StubCall {
  const execs = run.calls.filter((call) => call.mode === "exec");
  assert.ok(execs.length >= 1, `${label}: the real Codex launch reached the Architect stub\n${run.evidence}`);
  assert.ok(run.calls.some((call) => call.method === "model/list"), `${label}: the real probe's handshake completed against the stub`);
  const first = execs[0]!;
  assert.ok(first.id && /^W1-T\d+$/.test(first.id), `${label}: the Architect was handed a reserved id`);
  const minted = run.ledger.find((row) => row.step === "plan.id_minted");
  assert.equal((minted?.reserved as string[] | undefined)?.length, PLAN_MAX_NEW_TASKS, `${label}: the id reservation ran before the Architect`);
  const start = run.ledger.find((row) => row.step === "plan.start");
  assert.equal(start?.mode, "create", `${label}: the verb ran the requested mode`);
  assert.equal(start?.brief, BRIEF, `${label}: the verb carried the requested brief`);
  assert.ok(start && typeof start.architect === "string" && typeof start.worker === "string", `${label}: the tier pair was ledgered`);
  assert.notEqual(start.architect, start.worker, `${label}: the Architect tier is not the worker tier`);
  assert.ok(first.argv!.includes("--model"), `${label}: the Architect launch carried a routed model`);
  assert.equal(run.targetEntries, "", `${label}: the target checkout itself stays clean`);
  return first;
}

const GOOD_SHARD = `- id: {{ID}}
  title: Bound the retry loop of the target worker
  repo: target
  depends_on: []
  type: implement
  verify: auto
  principles: {tdd: strict}
  budget_usd: 5.00
  risk: low
  origin: architect
  plan_refs: ["§1"]
  files:
    - src/retry.ts
    - test/retry.test.ts
  status: queued
  attempts: 0
  rationale: |
    Settled by lookup: is this already filed or already decided? -> no, the seeded plan holds only
    ${SEED_ID} (plan/tasks.yaml).
  design: |
    Bound the retry loop at three attempts and surface the last error to the caller.
  acceptance:
    - claim: The retry loop stops after three attempts
      proof: "unit test: test/retry.test.ts"
  falsifier: |
    Raise the bound and the retry suite fails.
`;
const SHARD_FILE = "plan/tasks.d/{{ID}}-bound-the-retry-loop.yaml";

// One run per scenario, shared by the tests that inspect it.
const memo = new Map<string, Promise<Proposed>>();
const once = (key: string, scenario: Scenario): Promise<Proposed> => {
  let run = memo.get(key);
  if (!run) memo.set(key, run = proposeFrom(scenario));
  return run;
};
const VALID: Scenario = { files: { [SHARD_FILE]: GOOD_SHARD }, verdict: "PROPOSED: file {{ID}}, bound the retry loop" };
const BAD_PROOF: Scenario = {
  files: { [SHARD_FILE]: GOOD_SHARD.replace('proof: "unit test: test/retry.test.ts"', "proof: the retry loop stops after three attempts") },
  verdict: "PROPOSED: file {{ID}}, bound the retry loop",
};
const OUT_OF_PLAN: Scenario = {
  files: { [SHARD_FILE]: GOOD_SHARD, "src/retry.ts": "export const retries = 3;\n" },
  verdict: "PROPOSED: file {{ID}} and implement it",
};
const TIMEOUT = { timeout: 2 * CHILD_DEADLINE_MS + 60_000 };

test("W1-T12517 a valid plan-only proposal from a target without tsx reaches the publisher once", TIMEOUT, async () => {
  const run = await once("valid", VALID);
  const architect = assertArchitectRan(run, "valid");
  assert.equal(run.published.length, 1, `exactly one pull request creation reached the publication boundary\n${run.evidence}`);
  const [publication] = run.published as [Published];
  assert.match(publication.file, /^gh$/);
  // The existing publisher: a REST pull-request creation against the TARGET's owner/repo.
  assert.deepEqual(publication.args.slice(0, 4), ["api", "--method", "POST", "repos/owner/target/pulls"]);
  assert.equal(run.pushed.length, 1, "exactly one run branch was pushed to the origin");
  const branch = run.pushed[0]!;
  assert.match(branch, /^run-PLAN-create-\d+$/);
  assert.ok(publication.args.includes(`head=${branch}`), "the publisher was handed the pushed run branch");
  assert.ok(publication.args.includes("base=main"), "the publisher targets the target's main");
  // The footprint is the Architect's one shard, and nothing outside plan scope.
  const shard = `plan/tasks.d/${architect.id}-bound-the-retry-loop.yaml`;
  assert.deepEqual(run.branches[branch]!.footprint, [shard]);
  const body = publication.args.find((arg) => arg.startsWith("body=")) ?? "";
  assert.ok(body.includes(`plan/tasks.d/${architect.id}-bound-the-retry-loop.yaml`), "the body names the changed plan shard");
  assert.ok(body.includes(`grep: id: ${architect.id} in ${shard}`), "the harness, not the Architect, wrote the filing's acceptance proof");
  assert.equal(run.mainAfter, run.mainBefore, "nothing landed on the target's main");
  assert.equal(run.ledger.some((row) => row.step === "plan.relint_refused"), false, `the relint gate passed the valid proposal\n${run.evidence}`);
  assert.equal(run.ledger.some((row) => row.step === "plan.error"), false, `no plan gate errored on the valid proposal\n${run.evidence}`);
  // Past publication the existing run-ownership guard takes over. Offline it cannot resolve the fake PR's
  // head and FAILS CLOSED, so this suite stops where it stops: nothing here claims CI, review or merge passed.
  const ownership = run.ledger.find((row) => row.step === "verdict");
  assert.equal(ownership?.verdict, "pr_attribution_failed");
  assert.equal(ownership?.claimed_url, PR_URL);
  assert.equal(ownership?.owned_branch, branch);
  assert.equal(run.ledger.some((row) => row.step === "pr.opened"), false, "the verb recorded no opened PR once ownership failed closed");
  const verdict = run.ledger.find((row) => row.step === "plan.verdict");
  assert.equal(verdict?.action, "propose");
  const id = run.ledger.find((row) => row.step === "plan.id_check");
  assert.deepEqual(id?.unreserved, [], "the Architect filed only an id the harness reserved");
});

test("W1-T12517 an acceptance proof with no dialect prefix is refused before publication", TIMEOUT, async () => {
  const run = await once("bad-proof", BAD_PROOF);
  assertArchitectRan(run, "bad proof");
  const refusal = run.ledger.find((row) => row.step === "plan.relint_refused");
  assert.ok(refusal, `the relint gate refused the proposal\n${run.evidence}`);
  assert.deepEqual(refusal.checks, ["proof-dialect"], "the refusal names the proof-dialect check and nothing else");
  assert.match((refusal.violations as string[]).join("\n"), /free prose — not executable/, "the refusal says the proof cannot execute");
  assert.deepEqual(run.published, [], "the publisher was never called");
  assert.deepEqual(run.pushed, [], "no branch was pushed to the origin");
  assert.equal(run.outcome.code, 1, `the verb exits non-zero\n${run.evidence}`);
  assert.equal(run.gh.some((call) => call.startsWith("pr ")), false, "no gh pr call was made");
  assert.equal(run.ledger.some((row) => row.step === "pr.opened"), false, "no PR was recorded");
});

test("W1-T12517 an edit outside plan scope is refused before publication", TIMEOUT, async () => {
  const run = await once("out-of-plan", OUT_OF_PLAN);
  assertArchitectRan(run, "out of plan");
  const error = run.ledger.find((row) => row.step === "plan.error");
  assert.ok(error, `the plan-scope gate refused the proposal\n${run.evidence}`);
  assert.match(String(error.error), /outside plan scope/);
  assert.match(String(error.error), /src\/retry\.ts/);
  assert.deepEqual(run.published, [], "the publisher was never called");
  assert.deepEqual(run.pushed, [], "no branch was pushed to the origin");
  assert.equal(run.outcome.code, 1, `the verb exits non-zero\n${run.evidence}`);
  assert.equal(run.ledger.some((row) => row.step === "pr.opened"), false, "no PR was recorded");
});

test("W1-T12517 no worker can edit its own implementation criteria", TIMEOUT, async () => {
  const valid = await once("valid", VALID);
  const { architect, worker } = valid.rule15;
  assert.ok(architect && worker, "positive control: both Rule 15 checks ran against real checkouts");
  // The Architect's accepted proposal files criteria and is plan-only: the one exemption. planCommand ran the
  // same script before its push, so its own output carries the verdict too.
  assert.equal(architect.code, 0, `the Architect's pushed branch passes\n${architect.stdout}${architect.stderr}`);
  assert.match(architect.stdout, /rule15-precheck: OK -- criteria changed, but the diff is plan-only/);
  assert.match(valid.stdout, /rule15-precheck: OK -- criteria changed, but the diff is plan-only/, "planCommand ran the gate before pushing");
  // The same kind of criteria edit beside an implementation file — what an implementation worker would be
  // doing to its own task — is refused by the reviewer's own predicate.
  assert.equal(worker.code, 1, `an implementation diff that adds its own criterion is refused\n${worker.stdout}${worker.stderr}`);
  assert.match(worker.stderr, /THIS DIFF WILL BE REFUSED under Standing rule 15/);
  assert.match(worker.stderr, /plan paths {2}\(belong in their own plan-only PR\): plan\/tasks\.yaml/);
  assert.match(worker.stderr, /other paths \(stay in this one\): {17}src\/retry\.ts/);
});
