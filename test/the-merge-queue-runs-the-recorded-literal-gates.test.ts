/**
 * W1-T5522 — the merge queue runs the recorded-literal ratchets.
 *
 * Comment-load, the learnings and CLAUDE.md caps, the duplication and cycle ceilings, claims,
 * lint-plan, task-id collisions and baseline-monotonic all run as STEPS of ci.yml's `commitlint`
 * job (W1-T4399). That job was guarded `pull_request`-only, so on a merge-group commit none of them
 * ran, and two PRs that each bump one recorded literal from one base (the 2026-09-24 comment-load
 * race, #7001 beside #6974) still merged together. The job now also runs on `merge_group`, every
 * base-reading gate there compares against `github.event.merge_group.base_sha` (the commit the queue
 * lands on), and ci-gate.yml's MERGE_GROUP_REQUIRED waits on the names it posts.
 *
 * The job is EXECUTED here, not grepped: every step body runs through bash with stub `node`, `npm`
 * and `git` binaries and the shared gh shim, all recording their argv, and each `if:`/`${{ }}` is
 * evaluated against a simulated event context, so the assertions are about the argv a gate reaches.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

import { ghShim } from "./helpers/gh-shim.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(REPO_ROOT, ".github", "workflows");
const RUNNER = join(REPO_ROOT, "scripts", "ci-gate-from-contract.mjs");
const runner = (await import(pathToFileURL(RUNNER).href)) as { contractRun: (text: string) => { env: Record<string, string> } };
const CONTRACT_ENV = runner.contractRun(readFileSync(join(WORKFLOWS, "ci-gate.yml"), "utf8")).env;
const REQUIRED = JSON.parse(CONTRACT_ENV.REQUIRED!) as string[];
const MERGE_GROUP_REQUIRED = JSON.parse(CONTRACT_ENV.MERGE_GROUP_REQUIRED!) as string[];

type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; "continue-on-error"?: boolean };
type Job = { name?: string; if?: string | boolean; env?: Record<string, string>; steps?: Step[] };
type Wf = { on?: unknown; jobs?: Record<string, Job> };
const ci = parseYaml(readFileSync(join(WORKFLOWS, "ci.yml"), "utf8")) as Wf;
const JOB = ci.jobs!.commitlint!;

const QUEUE_BASE = "b45e0000000000000000000000000000000000b5";
const GROUP_SHA = "9a0b0000000000000000000000000000000000c1";
const PR_HEAD = "beadf00d0000000000000000000000000000ead5";

type Ctx = Record<string, string | undefined>;
function eventContext(event: "merge_group" | "pull_request"): Ctx {
  return {
    "github.event_name": event,
    "github.token": "tok",
    "github.run_id": "7",
    "github.run_attempt": "1",
    "job.check_run_id": "11",
    "github.sha": event === "merge_group" ? GROUP_SHA : "5e5e000000000000000000000000000000000000",
    "github.event.merge_group.base_sha": event === "merge_group" ? QUEUE_BASE : undefined,
    "github.event.pull_request.head.sha": event === "pull_request" ? PR_HEAD : undefined,
  };
}

/** One `${{ }}` operand: a quoted literal or a context path (absent reads as the empty string). */
function operand(token: string, ctx: Ctx): string {
  const t = token.trim();
  const literal = /^'(.*)'$/.exec(t);
  if (literal) return literal[1]!;
  assert.match(t, /^[a-z_][\w.-]*$/i, `unsupported expression operand '${t}'`);
  return ctx[t] ?? "";
}
const unwrap = (expr: string) => /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(expr.trim())?.[1] ?? expr.trim();

/** An env value: literal text where each `${{ a || b || 'c' }}` reads as its first non-empty operand. */
function value(raw: string, ctx: Ctx): string {
  return raw.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_, expr: string) => expr.split("||").map((part) => operand(part, ctx)).find((v) => v !== "") ?? "");
}

/** An `if:` condition: `always()`, `false`, or `a == 'b'` terms joined by `||`. Anything else throws. */
function condition(raw: string | boolean | undefined, ctx: Ctx): boolean {
  if (raw === undefined) return true;
  if (raw === false) return false;
  const expr = unwrap(String(raw));
  if (expr === "always()") return true;
  return expr.split("||").some((term) => {
    const eq = /^(.*?)==(.*)$/.exec(term.trim());
    assert.ok(eq, `unsupported if: term '${term.trim()}'`);
    return operand(eq[1]!, ctx) === operand(eq[2]!, ctx);
  });
}

// One stub for every tool the job shells out to: it records "<tool> <argv>" (and, for npm, a
// non-empty BASE_SHA beside it), answers the three calls whose stdout a step reads, and exits 1 for
// a call matching FAIL_ON so a red gate can be driven.
const STUB = `#!/usr/bin/env bash
tool="$(basename "$0")"
echo "$tool $*" >> "$CALL_LOG"
if [ "$tool" = npm ] && [ -n "\${BASE_SHA:-}" ]; then echo "env BASE_SHA=$BASE_SHA" >> "$CALL_LOG"; fi
case "$tool $*" in
  *diff-class.mjs*) echo SOURCE ;;
  *containment-diff-trigger.ts*) echo "matched=false" >> "$GITHUB_OUTPUT" ;;
  *bundled-gate-report.mjs*) echo "$2" ;;
esac
case "$tool $*" in *"\${FAIL_ON:-@never@}"*) exit 1 ;; esac
exit 0
`;

type JobRun = { ran: boolean; calls: Map<string, string[]>; outcomes: Map<string, string>; failures: string[] };

/** Runs the commitlint job for `event`: its job `if:`, then each step's `if:`, env and real body. */
function runJob(event: "merge_group" | "pull_request", failOn = ""): JobRun {
  const ctx = eventContext(event);
  const result: JobRun = { ran: condition(JOB.if, ctx), calls: new Map(), outcomes: new Map(), failures: [] };
  if (!result.ran) return result;
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5522-`));
  ctx["runner.temp"] = dir;
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, ".github", "scripts"), { recursive: true });
  for (const tool of ["node", "npm", "git"]) writeFileSync(join(dir, "bin", tool), STUB, { mode: 0o755 });
  // The reporter's check-run posts go through the shared gh shim, which answers each with exit 0.
  const checks = ghShim([], { kind: "w1t5522" });
  writeFileSync(join(dir, ".github", "scripts", "leak-grep.sh"), 'echo "leak-grep.sh $*" >> "$CALL_LOG"\n');
  const jobEnv = Object.fromEntries(Object.entries(JOB.env ?? {}).map(([k, v]) => [k, value(String(v), ctx)]));
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GITHUB_") && k !== "BASE_SHA" && k !== "GATE_BASE"));
  let ghSeen = 0;
  (JOB.steps ?? []).forEach((step, index) => {
    if (!step.run) return;
    const key = step.id ?? `#${index}`;
    if (!condition(step.if, ctx)) {
      result.outcomes.set(key, "skipped");
      ctx[`steps.${key}.outcome`] = "skipped";
      return;
    }
    const log = join(dir, `calls-${index}.log`);
    const output = join(dir, `output-${index}.txt`);
    writeFileSync(log, "");
    writeFileSync(output, "");
    writeFileSync(join(dir, `step-${index}.sh`), step.run);
    const stepEnv = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, value(String(v), ctx)]));
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, `step-${index}.sh`)], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...baseEnv,
        PATH: `${join(dir, "bin")}:${checks.dir}:${process.env.PATH}`,
        CALL_LOG: log,
        FAIL_ON: failOn,
        GITHUB_EVENT_NAME: event,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: dir,
        ...(event === "pull_request" ? { GITHUB_BASE_REF: "main", GITHUB_HEAD_REF: "run-x" } : {}),
        ...jobEnv,
        ...stepEnv,
      },
    });
    const ghCalls = checks.calls().slice(ghSeen).map((c) => `gh ${c}`);
    ghSeen += ghCalls.length;
    result.calls.set(key, [...readFileSync(log, "utf8").split("\n").filter(Boolean), ...ghCalls]);
    result.outcomes.set(key, r.status === 0 ? "success" : "failure");
    if (r.status !== 0 && step["continue-on-error"] !== true) result.failures.push(`${key}: ${r.stdout}${r.stderr}`);
    for (const line of readFileSync(output, "utf8").split("\n")) {
      const kv = /^([\w-]+)=(.*)$/.exec(line);
      if (kv) ctx[`steps.${key}.outputs.${kv[1]}`] = kv[2];
    }
    ctx[`steps.${key}.outcome`] = result.outcomes.get(key);
  });
  return result;
}

/** The reporter's `report "<name>" ...` lines, each with the step ids whose outcome it reads. */
function reportLines(): Array<{ name: string; steps: string[] }> {
  const reporter = JOB.steps!.at(-1)!;
  const stepOfVar = new Map(
    Object.entries(reporter.env ?? {}).flatMap(([k, v]) => {
      const m = /steps\.([\w-]+)\.outcome/.exec(String(v));
      return m ? [[k, m[1]!] as const] : [];
    }),
  );
  return [...reporter.run!.matchAll(/^\s*report "([^"]+)"(.*)$/gm)].map((m) => ({
    name: m[1]!,
    steps: [...m[2]!.matchAll(/\$\{(OUTCOME_\w+)\}/g)].map((v) => {
      const id = stepOfVar.get(v[1]!);
      assert.ok(id, `${v[1]} names no step outcome`);
      return id!;
    }),
  }));
}

/** Every check run the reporter posted, as [name, head_sha]. */
function posted(run: JobRun): Array<[string, string]> {
  const reporterKey = `#${JOB.steps!.length - 1}`;
  return (run.calls.get(reporterKey) ?? [])
    .filter((c) => c.startsWith("gh api ") && c.includes("/check-runs"))
    .map((c) => {
      const m = /-f name=(\S+) -f head_sha=(\S*)/.exec(c);
      assert.ok(m, `unparsed check-run post: ${c}`);
      return [m[1]!, m[2]!];
    });
}

// The argv each base-reading or PR-scoped step reaches today on pull_request, recorded verbatim.
const PR_ARGV: Record<string, string[]> = {
  install: ["npm ci"],
  classify: ["git diff --name-only HEAD^1...HEAD", "node scripts/diff-class.mjs --changed-files changed-files.txt"],
  "rule-checks": ["node --import tsx scripts/list-rule-suites.mjs --run"],
  "leak-grep": ["leak-grep.sh "],
  "learnings-budget-ratchet": ["npm run --silent learnings-budget-ratchet"],
  "claude-md-budget-ratchet": ["npm run --silent claude-md-budget-ratchet", "env BASE_SHA=HEAD^1"],
  "jscpd-gate": ["npm run --silent jscpd"],
  claims: ["npm run --silent claims"],
  "assertion-discrimination": ["npm run --silent assertion-discrimination"],
  "lint-plan": ["npm run --silent lint-plan -- --base HEAD^1"],
  depcruise: ["npm run --silent depcruise"],
  "cycle-ratchet": ["npm run --silent cycle-ratchet"],
  "containment-probe": ["git diff --name-only HEAD^1...HEAD", "node --import tsx .github/scripts/containment-diff-trigger.ts changed-files.txt"],
  "api-client-drift": ["npm run --silent api-client:check"],
  "no-hand-rolled-fetch": ["npm run --silent no-hand-rolled-fetch:check"],
  "prompt-surface-gate": ["git fetch --no-tags origin main", "node --import tsx scripts/prompt-surface-gate.mjs --base origin/main"],
  "task-id-existence": ["npm run --silent task-id-existence:check -- --require-open-prs"],
  "source-size": ["npm run --silent source-size-signal"],
  "comment-load-ratchet": ["npm run --silent comment-load-signal"],
  "expiring-fixture-census": ["node scripts/expiring-fixture-census.mjs"],
  "console-parity": ["npm run --silent console-parity"],
  "baseline-monotonic": ["node scripts/baseline-monotonic-check.mjs"],
};

test("W1-T5522: a group commit runs the ratchets against the queue base", () => {
  const run = runJob("merge_group");
  assert.ok(run.ran, "the commitlint job must run on a merge_group commit, or no recorded-literal ratchet runs there");
  assert.deepEqual(run.failures, [], "only continue-on-error gate steps may fail");
  const at = (id: string) => run.calls.get(id) ?? [];

  // The five gates the claim names reach the queue base, never HEAD^1 or a live origin/main.
  assert.deepEqual(at("comment-load-ratchet"), [`npm run --silent comment-load-signal -- --base ${QUEUE_BASE}`]);
  assert.deepEqual(at("baseline-monotonic"), [`node scripts/baseline-monotonic-check.mjs --base ${QUEUE_BASE}`]);
  assert.deepEqual(at("lint-plan"), [`npm run --silent lint-plan -- --base ${QUEUE_BASE}`]);
  assert.deepEqual(at("task-id-existence"), [`node scripts/task-id-existence-check.mjs --base ${QUEUE_BASE}`]);
  assert.deepEqual(at("source-size"), [`npm run --silent source-size-signal -- --base ${QUEUE_BASE}`]);
  // The diff-reading steps and the CLAUDE.md net-byte comparand read it too.
  assert.equal(at("classify")[0], `git diff --name-only ${QUEUE_BASE}...HEAD`);
  assert.equal(at("containment-probe")[0], `git diff --name-only ${QUEUE_BASE}...HEAD`);
  assert.deepEqual(at("claude-md-budget-ratchet"), ["npm run --silent claude-md-budget-ratchet", `env BASE_SHA=${QUEUE_BASE}`]);
  // expiring-fixture-census has no base flag: origin/main is pointed at the queue base first.
  assert.deepEqual(at("expiring-fixture-census"), [`git update-ref refs/remotes/origin/main ${QUEUE_BASE}`, "node scripts/expiring-fixture-census.mjs"]);
  const all = [...run.calls.values()].flat();
  for (const call of all) {
    assert.ok(!call.includes("HEAD^1"), `a group commit's first parent is the previous queue entry, never a base: ${call}`);
    assert.ok(!/(^|\s)origin\/main(\s|$)/.test(call) && !call.startsWith("git fetch"), `origin/main is behind a stacked group's base: ${call}`);
  }

  // Every gate step reached its command (the class simulated is SOURCE), and every post lands on
  // the group commit github.sha — pull_request.head.sha is empty here.
  for (const line of reportLines()) {
    for (const id of line.steps) if (id !== "prompt-surface-gate") assert.equal(run.outcomes.get(id), "success", id);
  }
  const posts = posted(run);
  assert.deepEqual(posts.map(([name]) => name), reportLines().map((l) => l.name));
  assert.ok(posts.length >= 16);
  for (const [name, sha] of posts) assert.equal(sha, GROUP_SHA, `${name} must post on the group commit`);
});

test("W1-T5522: the pull_request steps are unchanged and the PR-only steps skip", () => {
  const pr = runJob("pull_request");
  assert.ok(pr.ran);
  assert.deepEqual(pr.failures, []);
  // Every step reaches exactly the argv (and the CLAUDE.md BASE_SHA) it reached before this task.
  for (const [id, argv] of Object.entries(PR_ARGV)) assert.deepEqual(pr.calls.get(id), argv, id);
  assert.deepEqual(
    [...pr.calls.keys()].filter((k) => !k.startsWith("#")).sort(),
    Object.keys(PR_ARGV).sort(),
    "every id'd step is pinned above",
  );
  for (const [name, sha] of posted(pr)) assert.equal(sha, PR_HEAD, `${name} still posts on the PR head`);

  // On the group commit the PR-scoped step is skipped (its skip reports success), and
  // task-id-existence drops --require-open-prs: the queued PR is still open and would match itself.
  const group = runJob("merge_group");
  assert.equal(group.outcomes.get("prompt-surface-gate"), "skipped");
  assert.equal(group.calls.get("prompt-surface-gate"), undefined);
  assert.ok(!(group.calls.get("task-id-existence") ?? []).some((c) => c.includes("--require-open-prs")));
  const promptPost = posted(group).filter(([name]) => name === "prompt-surface-gate");
  assert.equal(promptPost.length, 1, "the skipped gate still posts");
  const promptCall = group.calls.get(`#${JOB.steps!.length - 1}`)!.find((c) => c.includes("name=prompt-surface-gate"))!;
  assert.match(promptCall, /conclusion=success/);
  // The title lint left this job (W1-T5695): nothing here posts `commitlint`, on either event.
  assert.ok(!reportLines().some((l) => l.name === "commitlint"));
  // The merge_group arms leave every OTHER step's argv identical to pull_request.
  const rebased = new Set(["classify", "claude-md-budget-ratchet", "lint-plan", "containment-probe", "prompt-surface-gate", "task-id-existence", "source-size", "comment-load-ratchet", "expiring-fixture-census", "baseline-monotonic"]);
  for (const [id, argv] of Object.entries(PR_ARGV)) if (!rebased.has(id)) assert.deepEqual(group.calls.get(id), argv, id);
});

type Row = { name: string; status: string; conclusion: string | null };
function runGate(runs: Row[]) {
  const page = JSON.stringify([{ check_runs: runs.map((r) => ({ ...r, started_at: "2026-10-05T00:00:00Z" })) }]);
  const shim = ghShim([{ when: "check-runs", stdout: page }], { kind: "w1t5522" });
  const bin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5522-bin-`));
  writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const r = spawnSync(process.execPath, [RUNNER, "--event", "merge_group"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${shim.dir}:${bin}:${process.env.PATH}`, GH_TOKEN: "t", REPO: "o/r", SHA: GROUP_SHA, GRACE_WINDOW_SECONDS: "0", WAIT_CAP_SECONDS: "0", RETRY_BACKOFF_SECONDS: "0" },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

function mergeGroupJobNames(): string[] {
  const names: string[] = [];
  for (const f of readdirSync(WORKFLOWS).filter((n) => /\.ya?ml$/.test(n))) {
    const wf = parseYaml(readFileSync(join(WORKFLOWS, f), "utf8")) as Wf;
    if (wf.on === null || typeof wf.on !== "object" || !("merge_group" in wf.on)) continue;
    for (const job of Object.values(wf.jobs ?? {})) {
      if (typeof job.name === "string" && REQUIRED.includes(job.name) && condition(job.if, eventContext("merge_group"))) names.push(job.name);
    }
  }
  return names;
}

test("W1-T5522: a red comment-load ratchet on the group commit fails the gate", () => {
  // The census, from the executed run: a reported name counts when one of its constituent steps
  // really ran on the group commit, plus every REQUIRED job that runs on merge_group.
  const group = runJob("merge_group");
  const reportedReal = reportLines()
    .filter((l) => REQUIRED.includes(l.name) && l.steps.some((id) => group.outcomes.get(id) !== "skipped"))
    .map((l) => l.name);
  const census = [...new Set([...mergeGroupJobNames(), ...reportedReal])].sort();
  assert.deepEqual([...MERGE_GROUP_REQUIRED].sort(), census);
  assert.equal(MERGE_GROUP_REQUIRED.length, 18);
  assert.ok(MERGE_GROUP_REQUIRED.length >= 18);
  for (const out of ["prompt-surface-gate", "mutation-ratchet", "commitlint"]) assert.ok(!MERGE_GROUP_REQUIRED.includes(out), out);

  // A failing comment-load-signal on the group commit posts a red comment-load-ratchet check...
  const red = runJob("merge_group", "comment-load-signal");
  assert.equal(red.outcomes.get("comment-load-ratchet"), "failure");
  const conclusions = new Map(
    red.calls.get(`#${JOB.steps!.length - 1}`)!.map((c) => [/-f name=(\S+)/.exec(c)?.[1], /conclusion=(\w+)/.exec(c)?.[1]]),
  );
  assert.equal(conclusions.get("comment-load-ratchet"), "failure");
  // ...and the merge-group gate, every other required check green, refuses it by name.
  const green = (names: string[]): Row[] => names.map((name) => ({ name, status: "completed", conclusion: "success" }));
  const pass = runGate(green(MERGE_GROUP_REQUIRED));
  assert.equal(pass.status, 0, pass.out);
  const fail = runGate(green(MERGE_GROUP_REQUIRED).map((r) => (r.name === "comment-load-ratchet" ? { ...r, conclusion: "failure" } : r)));
  assert.notEqual(fail.status, 0, fail.out);
  assert.ok(fail.out.includes("  - comment-load-ratchet"), fail.out);
});
