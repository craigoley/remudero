// W1-T12215: a refusal amendment and a plan repair open in the repository that holds the task. Each test drives the
// sweep's real effects (`buildSweepEffects`), and criterion 7 drives `runSweep`. The public checkout is the config
// root; the ops checkout is `<root>/repos/remudero-ops`, as the host file names it. git, GitHub and the plan preflight
// are recording fakes; the fake GitHub also serves the ops catalog that the lookup reads.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { Config } from "#src/lib/config.js";
import { appendLedger } from "#src/lib/ledger.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { planDestinationPath } from "#src/lib/plan-destination.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import type { Plan, Task } from "#src/lib/plan.js";
import { REFUSAL_AMENDMENT_STEP, extractRefusal } from "#src/lib/refusal-amendment.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { buildFixturePlanPrBody } from "#test/helpers/plan-pr-body-fixture.js";
import {
  PLAN_REPAIR_DISPATCH_STEP, buildSweepEffects, runSweep,
  type BuildSweepEffectsDeps, type OpenPrView, type ProofDiscriminationEvidence, type SweepDeps,
} from "#test/helpers/sweep-test.js";

const PUB_TASK = "W1-T96001";
const OPS_TASK = "W1-T96002";
const OPS = "acme/remudero-ops";
const RUN = "RUN-REFUSED-12215";
const REFUSAL = ["REFUSED:", "1. [premise-rotted] No headline at this checkout meets the task record's required condition"].join("\n");
const PROOF: ProofDiscriminationEvidence = {
  proofs: [{ claim: "the stale criterion", proof: "unit test: test/stale.test.ts", proofExec: "not_executable" }],
};
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const shard = (id: string): string =>
  [`- id: ${id}`, "  repo: remudero", "  status: queued", "  attempts: 0", "  acceptance:", `    - claim: ${PROOF.proofs[0]!.claim}`, `      proof: ${PROOF.proofs[0]!.proof}`, ""].join("\n");
/** The ops plan as the catalog reader takes it: a whole task record. */
const OPS_CATALOG = [`- id: ${OPS_TASK}`, "  title: Ops fixture", "  repo: remudero", "  status: queued", "  depends_on: []", "  type: implement",
  "  priority: 0", "  risk: high", "  budget_usd: 0.5", "  files: [src/fixture.ts]", "  design: Private design", "  acceptance:",
  "    - claim: canonical private criterion", '      proof: "grep: ops-fixture in src/fixture.ts"', ""].join("\n");
const task = (id: string): Task => ({ id, repo: "remudero", status: "queued", attempts: 0, title: "fixture" }) as unknown as Task;
type Row = Record<string, unknown>;
type HostFile = { kinds: string[] } | "absent" | "garbage";

/** The ops catalog as GitHub's git API serves it: one pinned commit whose plan/tasks.yaml holds the ops task. */
function opsCatalogRoutes(text: string): (path: string) => unknown {
  const hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(text), tree = hash(commit + "root"), plan = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(text)}\0${text}`);
  const base = `repos/${OPS}`;
  return (path) => {
    if (path === base) return { id: 42, full_name: OPS, default_branch: "main" };
    if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
    if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
    if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [{ path: "plan", sha: plan, type: "tree", mode: "040000" }] };
    if (path === `${base}/git/trees/${plan}`) return { sha: plan, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
    if (path === `${base}/git/blobs/${blob}`) return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
    throw new Error(`no fixture route for ${path}`);
  };
}

function world(t: TestContext, host: HostFile, preflight: PlanPrPreflightResult = GREEN) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12215-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const opsDir = join(root, "repos", "remudero-ops");
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(opsDir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.d", `${PUB_TASK}-fixture.yaml`), shard(PUB_TASK));
  writeFileSync(join(opsDir, "plan", "tasks.d", `${OPS_TASK}-fixture.yaml`), shard(OPS_TASK));
  if (host === "garbage") writeFileSync(planDestinationPath(join(root, "state")), "{ not json");
  else if (host !== "absent") writeFileSync(planDestinationPath(join(root, "state")), JSON.stringify({ repository: OPS, kinds: host.kinds }));
  const ledger = join(root, "state", "ledger.ndjson");
  const git: Array<{ dir: string; args: string[] }> = [];
  const gh: string[][] = [];
  const catalogReads: string[] = [];
  const worktreeAdds: Array<{ repoDir: string; branch: string }> = [];
  const worktreeRemoves: string[] = [];
  const pushes: string[] = [];
  const preflights: Array<{ dir: string; codeRoot?: string }> = [];
  const landingPrs = new Map<string, string>();
  const existing = new Map<string, string>(); // "<owner>/<repo> <branch>" -> an open PR on that head
  const catalog = opsCatalogRoutes(OPS_CATALOG);
  const deps: BuildSweepEffectsDeps = {
    owner: "acme",
    repo: "remudero",
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: ledger,
    runId: "SWEEP-W1-T12215",
    plan: { tasks: [task(PUB_TASK)], byId: new Map([[PUB_TASK, task(PUB_TASK)]]) } as unknown as Plan,
    log: (step, extra) => appendLedger(ledger, { run_id: "SWEEP-W1-T12215", task_id: "SWEEP", step, ...extra }),
    nowMsImpl: () => Date.now(),
    // The landing's git and the repair's git, recorded by the checkout each call runs in.
    planRepairGitImpl: (_file, args) => {
      const dir = args[0] === "-C" ? args[1]! : "";
      git.push({ dir, args: args.slice(2) });
      if (args.includes("push")) pushes.push(dir);
      if (args.includes("rev-parse")) return `${args.at(-1) === "origin/main" ? "ma1n5ha" : args.at(-1)!.includes(":") ? "ba5eb10b" : "c0ffee"}\n`;
      if (args.includes("hash-object")) return "a3e9dedb10b\n";
      if (args.includes("write-tree")) return `tree-of-${dir}\n`;
      if (args.includes("commit-tree")) return "c0ffee\n";
      return "";
    },
    worktreeAddImpl: (repoDir, worktreePath, branch) => {
      worktreeAdds.push({ repoDir, branch });
      mkdirSync(join(worktreePath, "plan", "tasks.d"), { recursive: true });
    },
    worktreeRemoveImpl: (repoDir) => void worktreeRemoves.push(repoDir),
    gitPushRunBranchImpl: (dir) => void pushes.push(dir),
    ghJsonImpl: (args) => {
      gh.push(args);
      if (args[0] === "pr" && args[1] === "list") {
        const url = landingPrs.get(args[args.indexOf("--repo") + 1] ?? "");
        return url ? [{ url }] : [];
      }
      if (args[0] === "pr" && args[1] === "create") {
        const repo = args[args.indexOf("--repo") + 1] ?? "none";
        const url = `https://github.com/${repo}/pull/${9000 + landingPrs.size + 1}`;
        landingPrs.set(repo, url);
        return url;
      }
      if (args[0] === "pr" && args[1] === "view") return { state: "OPEN" };
      if (args[0] === "api" && args.length === 2 && !args[1]!.includes("/pulls")) {
        catalogReads.push(args[1]!);
        return catalog(args[1]!);
      }
      const probe = /^repos\/([^/]+\/[^/]+)\/pulls\?head=[^:]+:(.+)&state=open$/.exec(args[1] ?? "");
      if (args[0] === "api" && probe) {
        const url = existing.get(`${probe[1]} ${probe[2]}`);
        return url ? [{ html_url: url, number: Number(url.split("/").at(-1)) }] : [];
      }
      const created = /repos\/([^/]+\/[^/]+)\/pulls$/.exec(args.find((a) => a.startsWith("repos/")) ?? "");
      return args.includes("--method") && created ? { html_url: `https://github.com/${created[1]}/pull/7001`, number: 7001 } : [];
    },
    planPrPreflightImpl: (dir, _sha, pr) => {
      preflights.push({ dir, ...(pr.codeRoot === undefined ? {} : { codeRoot: pr.codeRoot }) });
      return preflight;
    },
    buildPlanPrBodyImpl: buildFixturePlanPrBody,
    reloadPlanForFixImpl: () => undefined,
  } as BuildSweepEffectsDeps;
  const rows = (): Row[] => (existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : []);
  const pr = (taskId: string): OpenPrView => ({
    prNumber: 12215, prUrl: "https://github.com/acme/remudero/pull/12215", taskId, reviewState: "success", checksState: "green",
    unmetCriteria: [], priorStrikes: 2, lastActivityAt: "2026-11-14T11:00:00.000Z", headSha: "12215aaaa", autoMergeArmed: false,
  });
  const pendingMeta = (id: string): Row => JSON.parse(readFileSync(join(root, "state", "task-files-landing-pending", "plan", "tasks.d", `${id}-fixture.yaml.meta.json`), "utf8")) as Row;
  return {
    root, opsDir, ledger, git, gh, catalogReads, worktreeAdds, worktreeRemoves, pushes, preflights, existing, rows, pr, pendingMeta,
    effects: buildSweepEffects(deps),
    creates: () => gh.filter((a) => (a[0] === "pr" && a[1] === "create") || a.includes("--method")),
  };
}

const candidate = (taskId: string) => ({ taskId, runId: RUN, reportExcerpt: REFUSAL, refusals: extractRefusal(REFUSAL) });
const amend = (w: ReturnType<typeof world>, taskId: string) => withLiveWritesAllowed(() => w.effects.draftRefusalAmendments!([candidate(taskId)]));
const repair = (w: ReturnType<typeof world>, taskId: string) => withLiveWritesAllowed(() => w.effects.dispatchPlanOnlyRepair!(w.pr(taskId), PROOF));
const repoOf = (args: string[]): string | undefined => (args.includes("--repo") ? args[args.indexOf("--repo") + 1] : undefined);

test("W1-T12215 criterion 1: a refusal amendment for an ops task reads the ops checkout and opens in the ops repository", async (t) => {
  const w = world(t, { kinds: ["task"] });
  const [result] = await amend(w, OPS_TASK);
  assert.equal(result!.outcome, "drafted");
  assert.equal(result!.prUrl, "https://github.com/acme/remudero-ops/pull/9001");
  assert.ok(w.catalogReads.length > 0, "the lookup read the ops catalog");
  assert.deepEqual(w.pushes, [w.opsDir], "the landing pushes from the ops checkout");
  assert.deepEqual(w.creates().map(repoOf), [OPS], "the landing pull request opens in the ops repository");
  assert.deepEqual(w.preflights.map((p) => p.dir), [w.opsDir], "the preflight reads the ops tree");
  assert.equal(w.pendingMeta(OPS_TASK).repository, OPS, "the staged amendment waits for the ops repository");
  const staged = readFileSync(join(w.root, "state", "task-files-landing-pending", "plan", "tasks.d", `${OPS_TASK}-fixture.yaml`), "utf8");
  assert.match(staged, /# refusal-amendment \(W1-T96002, run RUN-REFUSED-12215,/, "the amended text is the ops task file's");
  assert.ok(existsSync(join(w.root, "state", "dispatch-repair", `${OPS_TASK}.json`)), "the ops task is held from dispatch");
});

test("W1-T12215 criterion 2: a plan repair for an ops task opens in the ops repository", async (t) => {
  const w = world(t, { kinds: ["task"] });
  assert.equal(await repair(w, OPS_TASK), true);
  assert.deepEqual(w.worktreeAdds.map((a) => a.repoDir), [w.opsDir], "the worktree is cut from the ops checkout");
  assert.deepEqual(w.worktreeRemoves, [w.opsDir]);
  assert.deepEqual(w.creates().map((a) => a.find((x) => x.startsWith("repos/"))), [`repos/${OPS}/pulls`]);
  assert.deepEqual(w.preflights.map((p) => p.codeRoot), [w.root], "the ops tree is checked with the public code");
  const row = w.rows().filter((r) => r.step === PLAN_REPAIR_DISPATCH_STEP).at(-1);
  assert.equal(row?.outcome, "dispatched");
  assert.equal(row?.plan_repair_pr, "https://github.com/acme/remudero-ops/pull/7001");
});

test("W1-T12215 criterion 3: an amendment and a repair for a public task open in the public repository, also with task in the kinds", async (t) => {
  const w = world(t, { kinds: ["task"] });
  const [result] = await amend(w, PUB_TASK);
  assert.equal(result!.outcome, "drafted");
  assert.equal(result!.prUrl, "https://github.com/acme/remudero/pull/9001");
  assert.deepEqual(w.pushes, [w.root]);
  assert.equal(w.pendingMeta(PUB_TASK).repository, "acme/remudero");
  assert.equal(await repair(w, PUB_TASK), true);
  assert.deepEqual(w.worktreeAdds.map((a) => a.repoDir), [w.root]);
  assert.deepEqual(w.creates().map((a) => repoOf(a) ?? a.find((x) => x.startsWith("repos/"))), ["acme/remudero", "repos/acme/remudero/pulls"]);
  assert.equal(w.preflights.at(-1)?.codeRoot, undefined, "a public tree keeps its own code root");
  assert.deepEqual(w.catalogReads, [], "a task the public plan holds needs no ops read");
});

test("W1-T12215 criterion 4: the probe for an amendment that is already open reads the repository that holds the task", async (t) => {
  const w = world(t, { kinds: ["task"] });
  w.existing.set(`${OPS} refusal-amendment/${OPS_TASK}`, "https://github.com/acme/remudero-ops/pull/8001");
  w.existing.set(`${OPS} plan-repair/${OPS_TASK}`, "https://github.com/acme/remudero-ops/pull/8002");
  const [result] = await amend(w, OPS_TASK);
  assert.equal(result!.outcome, "deduped");
  assert.equal(result!.prUrl, "https://github.com/acme/remudero-ops/pull/8001");
  assert.equal(await repair(w, OPS_TASK), true);
  assert.equal(w.rows().filter((r) => r.step === PLAN_REPAIR_DISPATCH_STEP).at(-1)?.plan_repair_pr, "https://github.com/acme/remudero-ops/pull/8002");
  const probes = w.gh.filter((a) => a[0] === "api" && a[1]!.includes("/pulls?head="));
  assert.deepEqual(probes.map((a) => a[1]!.split("/pulls")[0]), [`repos/${OPS}`, `repos/${OPS}`]);
  assert.equal(w.creates().length, 0);
  assert.deepEqual(w.worktreeAdds, []);
});

test("W1-T12215 criterion 5: an unreadable lookup opens no amendment and no repair, and the sweep reports the outcome code", async (t) => {
  const w = world(t, "garbage");
  const [result] = await amend(w, OPS_TASK);
  assert.equal(result!.outcome, "lookup_unreadable");
  assert.equal(result!.reason, "destination-unreadable");
  assert.equal(await repair(w, OPS_TASK), false, "an unreadable lookup spends no repair");
  const row = w.rows().filter((r) => r.step === PLAN_REPAIR_DISPATCH_STEP).at(-1);
  assert.equal(row?.outcome, "lookup_unreadable");
  assert.equal(row?.reason, "destination-unreadable");
  assert.equal(w.creates().length, 0);
  assert.deepEqual(w.pushes, []);
  assert.deepEqual(w.worktreeAdds, []);
  assert.ok(!existsSync(join(w.root, "state", "dispatch-repair", `${OPS_TASK}.json`)), "no task is held on a guess");
  // Through the sweep: the code is logged and no amendment row is written, so the next pass asks again.
  const ledger = join(w.root, "state", "sweep-ledger.ndjson");
  appendLedger(ledger, { run_id: RUN, task_id: OPS_TASK, step: "verdict", verdict: "no_pr", report_excerpt: REFUSAL });
  const logged: Row[] = [];
  await withLiveWritesAllowed(() => runSweep([], { ...sweepDeps(ledger, { draftRefusalAmendments: w.effects.draftRefusalAmendments }), log: (step: string, extra?: Row) => void logged.push({ step, ...extra }) } as SweepDeps));
  assert.deepEqual(logged.filter((r) => r.step === "sweep.refusal_amendment.error").map((r) => [r.outcome, r.reason]), [["lookup_unreadable", "destination-unreadable"]]);
  const ledgerRows = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
  assert.equal(ledgerRows.filter((r) => r.step === REFUSAL_AMENDMENT_STEP).length, 0);
});

test("W1-T12215 criterion 6: with no host file, both paths make the same calls on the same repository as today", async (t) => {
  const w = world(t, "absent");
  const [pub] = await amend(w, PUB_TASK);
  assert.equal(pub!.outcome, "drafted");
  assert.equal(await repair(w, PUB_TASK), true);
  assert.ok(w.git.every((c) => c.dir === w.root || c.dir.includes(`plan-repair-${PUB_TASK}-`)), "every git call runs in the public checkout or its repair worktree");
  assert.ok(!w.git.some((c) => c.dir === w.opsDir));
  assert.deepEqual(w.worktreeAdds.map((a) => a.repoDir), [w.root]);
  assert.deepEqual(w.creates().map((a) => repoOf(a) ?? a.find((x) => x.startsWith("repos/"))), ["acme/remudero", "repos/acme/remudero/pulls"]);
  assert.deepEqual(w.catalogReads, [], "no ops catalog is read");
  assert.ok(w.preflights.every((p) => p.codeRoot === undefined));
  // A task the public plan does not hold is closed, as it was before the lookup.
  const [other] = await amend(w, OPS_TASK);
  assert.equal(other!.outcome, "task_closed");
  assert.deepEqual(w.catalogReads, []);
});

function sweepDeps(path: string, extra: Partial<SweepDeps>): SweepDeps {
  return { arm: () => "armed", close: () => {}, dispatchFix: () => {}, escalate: () => {}, ledgerPath: path, runId: "SWEEP-W1-T12215", ...extra };
}

test("W1-T12215 criterion 7: the sweep asks the lookup which repository holds the task and records the ops amendment", async (t) => {
  const w = world(t, { kinds: [] });
  const ledger = join(w.root, "state", "sweep-ledger.ndjson");
  appendLedger(ledger, { run_id: RUN, task_id: OPS_TASK, step: "verdict", verdict: "no_pr", report_excerpt: REFUSAL });
  await withLiveWritesAllowed(() => runSweep([], sweepDeps(ledger, { draftRefusalAmendments: w.effects.draftRefusalAmendments })));
  const drafted = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row).filter((r) => r.step === REFUSAL_AMENDMENT_STEP);
  assert.equal(drafted.length, 1);
  assert.equal(drafted[0]!.task_id, OPS_TASK);
  assert.equal(drafted[0]!.outcome, "drafted", "an ops task is no longer closed for want of a public record");
  assert.equal(drafted[0]!.pr_url, "https://github.com/acme/remudero-ops/pull/9001");
  assert.ok(w.catalogReads.length > 0, "the sweep read the ops catalog through the lookup");
});
