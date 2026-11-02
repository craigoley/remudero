// Operator 2026-11-01: "We need something that manages this running as a part of rmd on any repo its managing to keep
// things tidy." The issue-revalidation garden was self-only (registeredGardenEnabled returned isSelf for every garden,
// and the daemon built every garden over self.owner/self.repo), so a consumer repository's stale issues were never
// named. Now it runs on every managed target over THAT repository, never above shadow, with its pacing record and
// verdict history keyed by the repository. Every other garden stays self-only.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { test } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import type { DaemonSummary } from "#src/lib/daemon.js";
import {
  gardenChildNodeArgv, gardenPacingPath, GARDEN_PLAN_FLAG, GARDEN_REPO_FLAG, issueRevalidationGardenPass, issueRevalidationPolicyForTarget, registeredGardenEnabled,
  registeredGardenTargetArgs, REGISTERED_GARDEN_NAMES, type RegisteredGardenName,
} from "#src/lib/garden-registry.js";
import {
  ISSUE_REVALIDATION_VERDICT_STEP, productionIssueRevalidationPorts, runIssueRevalidationGarden, type IssueRevalidationPolicy,
} from "#src/lib/issue-revalidation-garden.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  daemonCommand, gardenTargetContext, issueRevalidationRunTaskPorts, parseGardenRunArgs, registeredGardenDueProbe, type GardenBuildContext,
} from "#src/run-task.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const clock = fixedClock(NOW);
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const ACT: IssueRevalidationPolicy = { mode: "act", maxClosesPerPass: 5 };
const consumer = { owner: "acme", repo: "consumer", isSelf: false };

test("a managed repo runs the issue garden in shadow: only issue-revalidation is enabled off self, naming the target", () => {
  for (const name of REGISTERED_GARDEN_NAMES) {
    assert.equal(registeredGardenEnabled(name, false, {}), name === "issue-revalidation", name);
    if (name !== "inbox") assert.equal(registeredGardenEnabled(name, true, {}), true, `${name} still runs on self`);
  }
  assert.deepEqual(registeredGardenTargetArgs("issue-revalidation", consumer), [GARDEN_REPO_FLAG, "acme/consumer"]);
  assert.deepEqual(registeredGardenTargetArgs("issue-revalidation", { ...consumer, isSelf: true }), [], "a self pass's argv is unchanged");
  assert.deepEqual(registeredGardenTargetArgs("plan", consumer), []);
  // No per-target block exists in policy.yaml: a non-self target is never above shadow, and off stays off.
  assert.equal(issueRevalidationPolicyForTarget(ACT, false).mode, "shadow");
  assert.equal(issueRevalidationPolicyForTarget(ACT, false).maxClosesPerPass, 5);
  assert.equal(issueRevalidationPolicyForTarget({ ...ACT, mode: "off" }, false).mode, "off");
  assert.equal(issueRevalidationPolicyForTarget(ACT, true).mode, "act", "the self repo keeps policy.yaml's mode");
});

test("a managed repo runs the issue garden in shadow: the garden child's --repo builds over that target and its checkout", () => {
  const self = { owner: "craigoley", repo: "remudero" };
  assert.deepEqual(gardenTargetContext("issue-revalidation", "acme/consumer", self, "/cfg"),
    { owner: "acme", repo: "consumer", isSelf: false, targetRoot: join("/cfg", "repos", "consumer") });
  assert.deepEqual(gardenTargetContext("issue-revalidation", undefined, self, "/cfg"), {});
  assert.deepEqual(gardenTargetContext("issue-revalidation", "CraigOley/Remudero", self, "/cfg"), {}, "naming self is self");
  assert.deepEqual(gardenTargetContext("plan", "acme/consumer", self, "/cfg"), {}, "a self-only garden never reads a target");
});

test("a managed repo runs the issue garden in shadow: the daemon on a non-self target spawns only that pass, with --repo", async (t) => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}managed-garden-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const originalHomedir = os.homedir;
  t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  t.after(() => { os.homedir = originalHomedir; syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true }); });
  const spawned: Array<{ name: RegisteredGardenName; args: readonly string[] }> = [];
  const code = await daemonCommand(["--repo", "acme/consumer", "--plan", planPath, "--max", "0"], {
    gardenPassSpawn: async (name, args) => { spawned.push({ name, args }); return 0; },
    runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
      const started = (deps.gardens ?? []).map((start) => start(60_000));
      await flush(); await flush();
      for (const garden of started) garden.stop();
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(spawned, [{ name: "issue-revalidation", args: [GARDEN_REPO_FLAG, "acme/consumer", GARDEN_PLAN_FLAG, planPath] }]);
  const inventory = JSON.parse(readFileSync(join(root, "state", "gardener-runtime.json"), "utf8")) as { gardens: Array<{ name: string; enabled: boolean }> };
  assert.deepEqual(inventory.gardens.filter((g) => g.enabled).map((g) => g.name), ["issue-revalidation"]);
});

// The reviewer's counterexample (#16084): `rmd daemon --repo acme/consumer --plan <file>` reads <file> and never clones,
// but its garden child got only `--repo`, so it read `<root>/repos/consumer/plan/tasks.yaml` (absent: ENOENT on the
// first issue). The daemon's real spawn argv, through the real child node argv and the child's own parse, must name
// the target and resolve the --plan file, whose task is then the issue's referent.
test("a managed repo runs the issue garden in shadow: the daemon's garden child argv carries its --plan and the child reads it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}managed-garden-plan-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "consumer-tasks.yaml");
  writeFileSync(planPath, "- id: W9-T1\n  title: one\n  repo: consumer\n  type: implement\n  status: queued\n  attempts: 0\n");
  const originalHomedir = os.homedir;
  t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  t.after(() => { os.homedir = originalHomedir; syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true }); });
  const spawned: Array<{ name: RegisteredGardenName; args: readonly string[] }> = [];
  const code = await daemonCommand(["--repo", "acme/consumer", "--plan", planPath, "--max", "0"], {
    gardenPassSpawn: async (name, args) => { spawned.push({ name, args }); return 0; },
    runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
      const started = (deps.gardens ?? []).map((start) => start(60_000));
      await flush(); await flush();
      for (const garden of started) garden.stop();
      return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
    },
  });
  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  const { name, args } = spawned[0]!;
  const entry = "/opt/rmd/run-task.js";
  const argv = gardenChildNodeArgv(name, args, 512, { execArgv: [], entry }, false, () => {});
  const childRest = argv.slice(argv.indexOf(entry) + 2);
  assert.deepEqual(argv.slice(argv.indexOf(entry) + 1, argv.indexOf(entry) + 4), ["garden", "run", "issue-revalidation"]);
  const parsed = parseGardenRunArgs(childRest);
  assert.ok(!("error" in parsed), JSON.stringify(parsed));
  const target = gardenTargetContext(parsed.name, parsed.repoFlag, { owner: "craigoley", repo: "remudero" }, root, parsed.planFlag);
  assert.deepEqual(target, { owner: "acme", repo: "consumer", isSelf: false, targetRoot: join(root, "repos", "consumer"), planPath });
  assert.equal(existsSync(target.targetRoot!), false, "a --plan daemon never clones: the checkout's plan is not the target's");
  const ports = issueRevalidationRunTaskPorts({ owner: target.owner!, repo: target.repo!, repoRoot: REPO_ROOT, stateDir: join(root, "state"),
    log: () => {}, planRoot: target.targetRoot, planPath: target.planPath });
  const issue = { number: 1, url: "https://github.com/acme/consumer/issues/1", title: "t", body: "**Task:** W9-T1\n", labels: [] };
  assert.equal(ports.hasReferent(issue as never), true, "the --plan file's task is the issue's referent");
  assert.equal(ports.hasReferent({ ...issue, body: "**Task:** W9-T2\n" } as never), false);
  assert.deepEqual(parseGardenRunArgs(["run", "issue-revalidation", GARDEN_PLAN_FLAG, planPath]),
    { error: `rmd garden: ${GARDEN_PLAN_FLAG} names a managed target's plan and needs ${GARDEN_REPO_FLAG}` });
});

test("a managed repo runs the issue garden in shadow: it reads the target's issues, ledgers verdicts and closes nothing", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}managed-garden-state-`));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const url = (repo: string, n: number) => `https://github.com/acme/${repo}/issues/${n}`;
  const reads: string[][] = [], writes: string[] = [], rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const listing = JSON.stringify([{ number: 7, html_url: url("consumer", 7), title: "stale", body: "**Task:** PR-3\n**Class:** BLOCKED\n",
    labels: [], created_at: at(-200), updated_at: at(-100) }]);
  const ports = productionIssueRevalidationPorts({
    owner: "acme", repo: "consumer", stateDir, repoRoot: REPO_ROOT, log: (step, extra = {}) => void rows.push({ step, extra }), clock,
    managedTarget: true, policy: () => issueRevalidationPolicyForTarget(ACT, false),
    hasReferent: () => true,
    referentVerdicts: async () => new Map([[7, { verdict: "resolved" as const, reason: "merged", citation: "PR #3 merged" }]]),
    judgeText: async () => { throw new Error("no judge for a referent issue"); },
    readText: async (args) => { reads.push(args); return args[1]!.includes("/comments") ? "[]" : listing; },
    issues: { closeWithComment: async (u) => void writes.push(`close ${u}`), comment: async (u) => void writes.push(`comment ${u}`) },
    // Both repositories' verdicts share one ledger: only this target's, named by its issue_url, are its history.
    readLedgerRows: () => [
      { ts: at(-2), step: ISSUE_REVALIDATION_VERDICT_STEP, issue_number: 7, issue_url: url("remudero", 7), verdict: "still-true" },
      { ts: at(-3), step: ISSUE_REVALIDATION_VERDICT_STEP, issue_number: 7, issue_url: url("consumer", 7), verdict: "unknown" },
      { ts: at(-1), step: ISSUE_REVALIDATION_VERDICT_STEP, issue_number: 8, verdict: "still-true" },
    ],
  });
  const prior = ports.priorVerdicts();
  assert.deepEqual([...prior.keys()], [7], "an unkeyed row is never a managed target's history");
  assert.equal(prior.get(7)?.verdict, "unknown", "the self repo's issue #7 is not the consumer's #7");
  const summary = await runIssueRevalidationGarden(ports);
  assert.equal(summary.mode, "shadow");
  assert.deepEqual(reads[0], ["api", "repos/acme/consumer/issues?state=open&per_page=100", "--paginate"]);
  assert.deepEqual(writes, [], "shadow writes nothing to the target's GitHub");
  const verdict = rows.find((r) => r.step === ISSUE_REVALIDATION_VERDICT_STEP)!.extra;
  assert.equal(verdict.issue_url, url("consumer", 7));
  assert.equal(verdict.verdict, "resolved");
  assert.equal(verdict.acted, false);
});

test("a managed repo runs the issue garden in shadow: two targets never share one pacing record", async (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}managed-garden-pacing-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const consumerPath = gardenPacingPath(stateDir, "issue-revalidation", "acme/consumer");
  const selfPath = gardenPacingPath(stateDir, "issue-revalidation");
  assert.notEqual(consumerPath, selfPath);
  assert.notEqual(consumerPath, gardenPacingPath(stateDir, "issue-revalidation", "acme/other"));
  const quiet = { policy: () => ({ mode: "off" as const, maxClosesPerPass: 5 }) };
  const ports = { ...productionIssueRevalidationPorts({ owner: "acme", repo: "consumer", stateDir, repoRoot: REPO_ROOT, log: () => {},
    hasReferent: () => false, referentVerdicts: async () => new Map(), judgeText: async () => "" }), ...quiet };
  await issueRevalidationGardenPass(stateDir, ports, clock, "acme/consumer")();
  assert.ok(existsSync(consumerPath), "the target's pass records its own pacing");
  assert.equal(existsSync(selfPath), false, "and never the self repo's");
  // The garden the daemon builds over a managed target reads THAT record: quiet for days, it is not due; self has none.
  writeFileSync(consumerPath, JSON.stringify({ lastPassAt: new Date().toISOString(), lastNewAt: "2026-01-01T00:00:00.000Z" }) + "\n");
  const ctx: GardenBuildContext = { config: { root } as Config, repoRoot: REPO_ROOT, owner: "craigoley", repo: "remudero",
    log: () => {}, raiseDuplicate: () => "" };
  const managed = registeredGardenDueProbe("issue-revalidation", { ...ctx, owner: "acme", repo: "consumer", isSelf: false, targetRoot: root });
  const self = registeredGardenDueProbe("issue-revalidation", ctx);
  await flush();
  assert.equal(await managed(), false);
  assert.equal(await self(), true);
});
