/**
 * @source-text-subject: this suite's subject is the text of .github/workflows/coverage-nightly.yml.
 *
 * W1-T5811 — A RED COVERAGE-NIGHTLY RUN RAISES A NEEDS-HUMAN ISSUE.
 *
 * W1-T5704's coverage-nightly.yml (#9246) ran with `permissions: contents: read` and called no
 * raiser, so a red floor measurement on main ended as a red run on a schedule nobody watches. The
 * four other scheduled jobs that alarm (mutation-nightly, clock-sweep, recovery-drill,
 * fleet-heartbeat-watch) do it through scripts/needs-human-issue.mjs: raise on failure, then
 * `--resolved --source` on the run that recovers.
 *
 * Each case drives the REAL step bodies from the workflow through bash, with a stub `gh` on PATH
 * and the repo's own scripts/, so the real needs-human-issue.mjs decides what to file. Each step's
 * real `if:` and `env:` are evaluated against the scenario's job results, so the wiring between
 * the merge job's `floor` output and the delivery job is under test too, not only the script.
 *
 * FALSIFIER: remove the raise step and the parse finds no needs-human-issue.mjs raise call.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(REPO_ROOT, ".github", "workflows");
const MARKER = "<!-- needs-human:coverage-nightly -->";

type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; env?: Record<string, string> };
type Job = { if?: string; needs?: string | string[]; permissions?: Record<string, string>; outputs?: Record<string, string>; steps?: Step[] };
type WorkflowDoc = { on?: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> };

const doc = parseYaml(readFileSync(join(WORKFLOWS, "coverage-nightly.yml"), "utf8")) as WorkflowDoc;

const isRaise = (s: Step) => (s.run ?? "").includes("node scripts/needs-human-issue.mjs") && !(s.run ?? "").includes("--resolved");
const isResolve = (s: Step) => (s.run ?? "").includes("node scripts/needs-human-issue.mjs --resolved");

/** The job that calls the raiser: there must be exactly one. */
function deliveryJob(): [string, Job] {
  const found = Object.entries(doc.jobs).filter(([, job]) => (job.steps ?? []).some(isRaise));
  assert.equal(found.length, 1, "exactly one coverage-nightly job must raise through scripts/needs-human-issue.mjs");
  return found[0]!;
}

function stepOf(job: Job, pick: (s: Step) => boolean, what: string): Step {
  const found = (job.steps ?? []).filter(pick);
  assert.equal(found.length, 1, `expected exactly one ${what} step`);
  return found[0]!;
}

/** A context lookup that throws on a key no scenario supplies, so a new expression is never read as ''. */
function lookup(ctx: Record<string, string>, key: string): string {
  assert.ok(Object.hasOwn(ctx, key), `unexpected expression context key: ${key}`);
  return ctx[key]!;
}

/** Resolves every `${{ <key> }}` in an env value from `ctx`. */
function resolveExpr(value: string, ctx: Record<string, string>): string {
  return value.replace(/\$\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key: string) => lookup(ctx, key));
}

/** Evaluates the only `if:` shapes this workflow uses: status functions and `<key> ==|!= '<lit>'`
 *  atoms joined by `&&`/`||`. Every step before the one evaluated succeeded in these scenarios, so
 *  `success()` is true and `failure()` false. Anything else throws rather than reading as true. */
function evalIf(expr: string | undefined, ctx: Record<string, string>): boolean {
  if (expr === undefined) return true;
  const bare = expr.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
  const atom = (a: string): boolean => {
    const t = a.trim();
    if (t === "always()" || t === "success()") return true;
    if (t === "failure()" || t === "cancelled()") return false;
    const m = /^([\w.-]+) (==|!=) '([^']*)'$/.exec(t);
    assert.ok(m, `unexpected if atom: ${t}`);
    const value = lookup(ctx, m[1]!);
    return m[2] === "==" ? value === m[3] : value !== m[3];
  };
  return bare.split("||").some((any) => any.split("&&").every(atom));
}

/** `gh` is every recorded call's raw joined argv, joined by newlines (a body's own newlines survive). */
type Run = { status: number; out: string; outputs: Record<string, string>; gh: string; dir: string };

/**
 * Runs one real step body the way Actions does (`bash -e`, plus the body's own `set -o`) in a
 * scratch directory whose `scripts` is the repo's own. `gh` is the shared test/helpers shim, which
 * records every call and answers `issue list` with `openIssues`.
 */
function runStep(
  step: Step,
  ctx: Record<string, string>,
  setup: (dir: string) => void,
  openIssues: Array<{ number: number; body: string; title: string }> = [],
  dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5811-`)),
): Run {
  assert.ok(step.run, `${step.name} has no run: body`);
  assert.ok(!step.run.includes("${{"), `${step.name}: a run: body must read its inputs from env:, never interpolate an expression`);
  if (!existsSync(join(dir, "scripts"))) symlinkSync(join(REPO_ROOT, "scripts"), join(dir, "scripts"));
  const gh = ghShim(
    [
      // One line, no backslash escapes: the shim's `/bin/sh` echo would expand a `\n` in a body.
      { when: "issue list", stdout: JSON.stringify(openIssues) },
      { when: "issue create", stdout: "https://github.com/craigoley/remudero/issues/9999" },
    ],
    { kind: "w1t5811-gh" },
  );
  setup(dir);
  const stepEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.env ?? {})) stepEnv[k] = resolveExpr(String(v), ctx);
  writeFileSync(join(dir, "step.sh"), step.run);
  const r = spawnSync("bash", ["--noprofile", "--norc", "-e", join(dir, "step.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...stepEnv,
      PATH: `${gh.dir}:${dirname(process.execPath)}:${process.env.PATH}`,
      GITHUB_OUTPUT: join(dir, "outputs.txt"),
    },
  });
  const outputs: Record<string, string> = {};
  const raw = existsSync(join(dir, "outputs.txt")) ? readFileSync(join(dir, "outputs.txt"), "utf8") : "";
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const calls = gh.calls().join("\n");
  rmSync(gh.dir, { recursive: true, force: true });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}`, outputs, gh: calls, dir };
}

/** The `${{ }}` context of one scenario: the needs results plus the run identity every raiser passes. */
function context(shards: string, merge: string, floor: string): Record<string, string> {
  return {
    "needs.shards.result": shards,
    "needs.merge.result": merge,
    "needs.merge.outputs.floor": floor,
    "github.token": "stub-token",
    "github.server_url": "https://github.com",
    "github.repository": "craigoley/remudero",
    "github.run_id": "4242",
    "github.event_name": "schedule",
  };
}

/** Writes the shard artifacts the download step would leave: `exits[n]` is shard n's test-exit,
 *  `null` a shard that died before its upload (no artifact at all). */
function shardArtifacts(exits: Array<number | null>) {
  return (dir: string) => {
    exits.forEach((code, i) => {
      if (code === null) return;
      mkdirSync(join(dir, "coverage-shards", `coverage-shard-${i + 1}`), { recursive: true });
      writeFileSync(join(dir, "coverage-shards", `coverage-shard-${i + 1}`, "test-exit"), `${code}\n`);
    });
  };
}

/** Drives the delivery job end to end for one scenario: download guard, judge, raise, resolve. */
function driveDelivery(
  ctx: Record<string, string>,
  exits: Array<number | null>,
  openIssues: Array<{ number: number; body: string; title: string }> = [],
) {
  const [, job] = deliveryJob();
  const download = stepOf(job, (s) => (s.uses ?? "").startsWith("actions/download-artifact@"), "download");
  const verdictStep = stepOf(job, (s) => s.id === "verdict", "verdict");
  const raise = stepOf(job, isRaise, "raise");
  const resolve = stepOf(job, isResolve, "resolve");
  const downloaded = evalIf(download.if, ctx);
  const judged = runStep(verdictStep, ctx, downloaded ? shardArtifacts(exits) : () => {});
  assert.equal(judged.status, 0, judged.out);
  const stepCtx = { ...ctx, "steps.verdict.outputs.verdict": judged.outputs.verdict ?? "" };
  const raised = evalIf(raise.if, stepCtx) ? runStep(raise, stepCtx, () => {}, openIssues, judged.dir) : undefined;
  const resolved = evalIf(resolve.if, stepCtx) ? runStep(resolve, stepCtx, () => {}, openIssues, judged.dir) : undefined;
  const result = { downloaded, verdict: judged.outputs.verdict, raised, resolved };
  rmSync(judged.dir, { recursive: true, force: true });
  return result;
}

/** The `gh issue create` call's text, from its first argument through its body; '' when none ran. */
const created = (r: Run | undefined) => {
  const log = r?.gh ?? "";
  const at = log.indexOf("issue create ");
  return at < 0 ? "" : log.slice(at);
};

test("W1-T5811: only the delivery job is granted issues: write, the top level stays read-only, and no pull_request event reaches it", () => {
  assert.deepEqual(doc.permissions, { contents: "read" }, "the top-level token stays least-privilege");
  const [deliveryId, job] = deliveryJob();
  assert.deepEqual(job.permissions, { contents: "read", issues: "write" }, `${deliveryId} needs exactly issues: write to deliver`);
  for (const [jobId, other] of Object.entries(doc.jobs)) {
    if (jobId !== deliveryId) assert.equal(other.permissions, undefined, `${jobId} must not widen the read-only token`);
  }
  // It must judge the WHOLE run, including the night a shard died and the merge was skipped.
  assert.deepEqual([job.needs ?? []].flat().sort(), ["merge", "shards"]);
  assert.equal(job.if, "always()", "a skipped merge must not skip the alarm about it");
  // Never on a pull_request event: the workflow registers no PR trigger at all.
  assert.ok(!("pull_request" in (doc.on ?? {})) && !("pull_request_target" in (doc.on ?? {})));
  // The floor verdict the delivery names is the ratchet step's own outcome, exported by the merge job.
  const merge = doc.jobs.merge!;
  assert.equal(merge.outputs?.floor, "${{ steps.ratchet.outcome }}");
  assert.ok(stepOf(merge, (s) => s.id === "ratchet", "ratchet").run?.includes("node scripts/coverage-ratchet.mjs --lcov"));
});

test("W1-T5811: a red shard raises one needs-human issue that names the red shard and the shard that uploaded nothing", () => {
  const r = driveDelivery(context("failure", "skipped", ""), [0, 0, 1, 0, null, 0, 0, 0]);
  assert.equal(r.downloaded, true, "a red run downloads the shard exits it names");
  assert.equal(r.verdict, "red");
  assert.equal(r.resolved, undefined, "a red run must never close the escalation");
  assert.ok(r.raised, "a red run must raise");
  assert.equal(r.raised.status, 0, r.raised.out);
  const body = created(r.raised);
  assert.ok(body, `expected gh issue create, got ${r.raised.gh}`);
  // The title, the label, and the source marker leading the body, so the recovery can find it.
  assert.ok(body.startsWith(`issue create --title coverage-nightly is failing --label needs-human --body ${MARKER}`), body);
  assert.match(body, /shard 3\/8: the instrumented suite was red \(exit 1\)/);
  assert.match(body, /shard 5\/8: no artifact/);
  assert.doesNotMatch(body, /shard 1\/8/, "a green shard is not named");
  assert.match(body, /actions\/runs\/4242/, "auditable from the issue alone");
});

test("W1-T5811: a floor below the baseline raises, naming the floor", () => {
  const r = driveDelivery(context("success", "failure", "failure"), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(r.verdict, "red");
  assert.equal(r.resolved, undefined);
  const body = created(r.raised);
  assert.match(body, /floor: the absolute-floor ratchet FAILED/);
  assert.doesNotMatch(body, /shard \d\/8:/, "with every shard green, no shard is blamed");
});

test("W1-T5811: a second red night comments on the open issue instead of filing a duplicate", () => {
  const open = [{ number: 777, body: `${MARKER} older night`, title: "coverage-nightly is failing" }];
  const r = driveDelivery(context("success", "failure", "failure"), [0, 0, 0, 0, 0, 0, 0, 0], open);
  assert.equal(created(r.raised), "", "no second issue");
  assert.match(r.raised?.gh ?? "", /^issue comment 777 --body <!-- needs-human:coverage-nightly -->/m);
});

test("W1-T5811: a green run raises nothing and closes the open coverage-nightly escalation", () => {
  const open = [
    { number: 777, body: `${MARKER} older night`, title: "coverage-nightly is failing" },
    { number: 778, body: "<!-- needs-human:mutation-nightly --> x", title: "mutation-nightly is failing" },
  ];
  const r = driveDelivery(context("success", "success", "success"), [0, 0, 0, 0, 0, 0, 0, 0], open);
  assert.equal(r.downloaded, false, "a green night downloads nothing it will not report");
  assert.equal(r.verdict, "green");
  assert.equal(r.raised, undefined, "a green night stays silent");
  assert.ok(r.resolved, "a green night must run the resolver");
  assert.equal(r.resolved.status, 0, r.resolved.out);
  const acted = [...r.resolved.gh.matchAll(/^issue (comment|close) (\d+)/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(acted, [["comment", "777"], ["close", "777"]], "only coverage-nightly's own thread is closed");
});

test("W1-T5811: a judge that wrote no verdict still raises, never stays silent", () => {
  const [, job] = deliveryJob();
  const raise = stepOf(job, isRaise, "raise");
  const ctx = { ...context("failure", "skipped", ""), "steps.verdict.outputs.verdict": "" };
  assert.equal(evalIf(raise.if, ctx), true, "only a proven-green verdict may skip the raise");
  const r = runStep(raise, ctx, () => {});
  assert.equal(r.status, 0, r.out);
  assert.match(created(r), /no report/, "the issue says the report is missing rather than filing nothing");
  rmSync(r.dir, { recursive: true, force: true });
});

test("W1-T5811: every scheduled workflow that raises a needs-human issue also resolves it — five raisers including coverage-nightly", () => {
  const raisers = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml") && readFileSync(join(WORKFLOWS, f), "utf8").includes("needs-human-issue.mjs"))
    .map((f) => f.replace(/\.yml$/, ""))
    .sort();
  assert.deepEqual(raisers, ["clock-sweep", "coverage-nightly", "fleet-heartbeat-watch", "mutation-nightly", "recovery-drill"]);
  const census = readFileSync(join(REPO_ROOT, "test", "a-recovered-scheduled-job-leaves-its-escalation-open-forever.test.ts"), "utf8");
  const listed = /const files = \[([^\]]*)\]/.exec(census)?.[1] ?? "";
  assert.deepEqual([...listed.matchAll(/"([\w-]+)"/g)].map((m) => m[1]).sort(), raisers, "the raiser census must list every raiser");
  assert.match(census, /assert\.equal\(raisers\.length, 5,/, "and count five");
});
