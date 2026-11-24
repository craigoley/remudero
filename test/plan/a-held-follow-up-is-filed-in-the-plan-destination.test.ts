import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";

import type { Config } from "#src/lib/config.js";
import { landingIdentity, taskFilesLandingBranchAsync } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { actOnParkedPr, PARKED_PR_REMEDY_STEP, parkedPrFacts, parkedPrRemedy, takeParkedPrRemedy, type ParkedPrHost,
  type ParkedPrSubject } from "#src/lib/parked-pr-remedy.js";
import type { PlanDestination } from "#src/lib/plan-destination.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { buildSweepEffects, type BuildSweepEffectsDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { originWithClone } from "#test/helpers/git-repo.js";
import { buildFixturePlanPrBody } from "#test/helpers/plan-pr-body-fixture.js";

// W1-T14344: the parked-PR remedy (W1-T12709) wrote each held follow-up, a NEW task file, in the catalog of its parent, so a
// public parent's follow-up landed in the public catalog through the task-files landing even with the task kind switched to
// the plan destination. The W1-T12200 rule: a file is edited in the repository that holds it; only a NEW file follows the
// switch. The fixture runs the production sweep effects, so the switch is read where the sweep wires the remedy.

const ID = "W1-T900344", PUBLIC = "fixture/remudero", OPS = "fixture-private/ops", HELD = "W1-T900345";
const SHARD = `plan/tasks.d/${ID}-fixture.yaml`;
const CLAIMS = ["the first criterion holds", "the second criterion needs a design answer", "the third criterion holds"];
const yaml = (where: string, claims: readonly string[] = CLAIMS) => [`- id: ${ID}`, `  title: ${where} fixture`, "  repo: remudero",
  "  depends_on: []", "  type: implement", "  risk: high", "  verify: auto", "  status: queued", "  attempts: 0", "  acceptance:",
  ...claims.flatMap(c => [`    - claim: "${c}"`, `      proof: "grep: ${c} in src/x.ts"`]), "  rationale: |", "    WHY: a fixture.", ""].join("\n");
const subject: ParkedPrSubject = { prNumber: 15, prUrl: `https://github.com/${PUBLIC}/pull/15`, headSha: "head", taskId: ID,
  unmetCriteria: [{ claim: CLAIMS[1]!, proof: `grep: ${CLAIMS[1]} in src/x.ts`, reason: "it needs a design answer" }] };

/** `host`: plan-destination.json lists the task kind, lists only decision and feedback, or is absent. */
type HostSwitch = "task-on" | "task-off" | "absent";

function fixture(t: TestContext, catalog: "public" | "ops", host: HostSwitch) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}held-follow-up-destination-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const publicDir = join(root, "repos", "remudero"), opsDir = join(root, "repos", "ops");
  // Both checkouts hold a file for the id, so a landing in the wrong repository is seen by its title.
  const publicText = catalog === "public" ? yaml("public") : yaml("public", [CLAIMS[1]!]);
  mkdirSync(join(root, "repos"));
  originWithClone(publicDir, { scope: t, seed: { [SHARD]: publicText } });
  originWithClone(opsDir, { scope: t, seed: { [SHARD]: yaml("ops") } });
  mkdirSync(join(root, "state"));
  const hostFile = join(root, "state", "plan-destination.json");
  if (host !== "absent") {
    writeFileSync(hostFile, JSON.stringify({ repository: OPS, kinds: host === "task-on" ? ["decision", "feedback", "task"] : ["decision", "feedback"] }));
  }
  const text = yaml("ops"), hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(text), tree = hash(commit + "tree"), planTree = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(text)}\0${text}`);
  const gh: string[][] = [], git: string[][] = [], preflights: string[] = [];
  const reserved: { cwd: string; branch: string }[] = [], rows: Record<string, unknown>[] = [];
  const opened = new Map<string, string>();
  const publicPlan = mergePlanBlobs([{ label: "fixture.yaml", text: catalog === "public" ? yaml("public") : "[]" }]);
  const deps: BuildSweepEffectsDeps = {
    owner: "fixture", repo: "remudero", repoRoot: publicDir, config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"), runId: "fixture-sweep", plan: publicPlan, reloadPlanForFixImpl: () => publicPlan,
    log: () => {},
    // The ops catalog, read through the API when the task is not in the public plan (W1-T13048).
    readJsonImpl: async args => {
      const path = args[1]!, base = `repos/${OPS}`;
      if (path === base) return { id: 48, full_name: OPS, default_branch: "main" };
      if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
      if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
      if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false,
        tree: [{ path: "plan", sha: planTree, type: "tree", mode: "040000" }] };
      if (path === `${base}/git/trees/${planTree}`) return { sha: planTree, truncated: false,
        tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
      assert.equal(path, `${base}/git/blobs/${blob}`);
      return { sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
    },
    planRepairGitImpl: (file, args) => {
      git.push([...args]);
      // W1-T14617: the ops task file is read at the ops checkout's origin/main, with real git against the seeded clone.
      if (args[1] === opsDir && (args.includes("+refs/heads/main:refs/remotes/origin/main") || args.at(-1) === "refs/remotes/origin/main"
        || (args.includes("ls-tree") && args.includes("-z")) || (args.includes("show") && args.some(a => a.includes(":plan/tasks.d/"))))) {
        return execFileSync(file, [...args], { encoding: "utf8", stdio: "pipe" });
      }
      if (args.includes("rev-parse")) return args.at(-1) === "origin/main" ? "mainsha" : "fixture-sha";
      if (args.includes("hash-object")) return "fixture-blob";
      if (args.includes("write-tree")) return `tree-${args[1]}`;
      if (args.includes("commit-tree")) return "fixture-sha";
      return "";
    },
    ghJsonImpl: args => {
      gh.push([...args]);
      assert.equal(args[0], "pr", `the remedy makes no other GitHub call: ${args.join(" ")}`);
      const repository = args[args.indexOf("--repo") + 1]!;
      if (args[1] === "list") return opened.has(repository) ? [{ url: opened.get(repository) }] : [];
      assert.equal(args[1], "create");
      const url = `https://github.com/${repository}/pull/48`; opened.set(repository, url); return url;
    },
    planRepairReserveIdImpl: (cwd, branch) => { reserved.push({ cwd, branch }); return HELD; },
    buildPlanPrBodyImpl: buildFixturePlanPrBody,
    planPrPreflightImpl: (dir) => { preflights.push(dir); return { ok: true, failures: [], unreadable: [] }; },
  };
  const parked = buildSweepEffects(deps).parkedPr;
  assert.ok(parked, "the production sweep effects wire the remedy");
  const remedy = () => withLiveWritesAllowed(async () => {
    const facts = await parkedPrFacts(subject, { redChecks: [], designQuestion: "which store?", fixModelOrder: ["fix"] }, [], parked);
    return actOnParkedPr(subject, parkedPrRemedy(facts), facts, [], parked,
      { runId: "fixture-sweep", ledgerTaskId: ID, nowIso: "2026-11-22T12:00:00.000Z", cause: "needs-design", text: "which store?",
        append: (row: Record<string, unknown>) => { rows.push(row); } });
  });
  const pending = join(root, "state", "task-files-landing-pending");
  /** Each staged task file, by its path in the catalog, with the `<owner>/<name>` its landing was staged for. */
  const staged = (): Record<string, string> => !existsSync(pending) ? {} : Object.fromEntries(
    readdirSync(pending, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith(".meta.json"))
      .map(e => {
        const abs = join(e.parentPath, e.name);
        return [relative(pending, abs).slice(0, -".meta.json".length), String((JSON.parse(readFileSync(abs, "utf8")) as { repository?: unknown }).repository)];
      }));
  const stagedText = (rel: string) => readFileSync(join(pending, rel), "utf8");
  /** The landing pull requests opened, by repository: the head branch and the body that names each file it carries. */
  const creates = () => gh.filter(args => args[1] === "create").map(args => ({
    repository: args[args.indexOf("--repo") + 1]!, head: args[args.indexOf("--head") + 1]!, text: args.join("\n") }));
  const split = (repository: string) => {
    const [owner, repo] = repository.split("/") as [string, string];
    return { owner, repo };
  };
  /** The landing branch the sweep reserves a new task's id for, in the repository the file is filed in. */
  const branchFor = (repository: string) =>
    landingIdentity({ family: "task-files", targetRepository: split(repository), sourceRepository: { owner: "fixture", repo: "remudero" } }).branch;
  /** The branch the landing pushes and opens its pull request from, for that repository. */
  const headFor = (repository: string) => taskFilesLandingBranchAsync(split(repository));
  return { publicDir, publicText, opsDir, gh, git, preflights, reserved, rows, remedy, staged, stagedText, creates, branchFor, headFor };
}

const remedyRows = (rows: readonly Record<string, unknown>[]) => rows.filter(r => r.step === PARKED_PR_REMEDY_STEP);
const heldRel = (where: string) => `plan/tasks.d/${HELD}-${where}-fixture.yaml`;

test("W1-T14344 criterion 1: with the task kind switched to the plan destination, a public task's held follow-up is queued for and landed in the destination's catalog, and the public task-files landing carries none", async t => {
  const f = fixture(t, "public", "task-on");
  const out = await f.remedy();
  assert.equal(out.remedy, "split-follow-up", out.reason);
  assert.equal(out.heldTaskId, HELD);
  const held = heldRel("public");
  assert.equal(f.staged()[held], OPS, "the new held follow-up is queued for the destination's landing");
  assert.deepEqual(f.reserved.map(r => r.branch), [f.branchFor(OPS)], "the id is held by the destination's landing branch");
  const ops = f.creates().filter(c => c.repository === OPS);
  assert.equal(ops.length, 1, "one landing pull request opens in the destination");
  assert.equal(ops[0]!.head, await f.headFor(OPS));
  assert.ok(ops[0]!.text.includes(held), "the destination's landing pull request carries the held follow-up");
  const publicLanding = f.creates().filter(c => c.repository === PUBLIC);
  // The public landing carries the parent's edit, which names the held id in its MOVED line, but never the held file.
  assert.ok(publicLanding.every(c => !c.text.includes(held)), "the public task-files landing carries no held follow-up");
  assert.ok(!Object.entries(f.staged()).some(([rel, repository]) => repository === PUBLIC && rel.includes(HELD)), "no new task file is queued for the public landing");
  const doc = (parse(f.stagedText(held)) as Record<string, unknown>[])[0]!;
  assert.equal(doc.id, HELD);
  assert.match(String(doc.title), /^public fixture .*\(held follow-up\)$/, "the held follow-up is built from the public parent");
  assert.deepEqual((doc.acceptance as { claim: string }[]).map(c => c.claim), [CLAIMS[1]]);
  assert.ok(f.preflights.includes(f.opsDir), "the held follow-up is preflighted in the destination checkout");
  const row = remedyRows(f.rows)[0]!;
  assert.deepEqual([row.outcome, row.held_task_id, row.landing_pr_url], ["taken", HELD, `https://github.com/${OPS}/pull/48`]);
});

test("W1-T14344 criterion 2: an edit of a task file that already exists lands in the catalog that holds it, public or destination, exactly as W1-T13048 does", async t => {
  await t.test("a public parent's edit lands in the public catalog while its held follow-up goes to the destination", async t => {
    const f = fixture(t, "public", "task-on");
    await f.remedy();
    assert.equal(f.staged()[SHARD], PUBLIC, "the parent's edit is queued for the public landing");
    assert.match(f.stagedText(SHARD), /title: public fixture/);
    assert.match(f.stagedText(SHARD), new RegExp(`MOVED to ${HELD}`));
    const publicLanding = f.creates().filter(c => c.repository === PUBLIC);
    assert.equal(publicLanding.length, 1, "the edit opens the public landing pull request");
    assert.equal(publicLanding[0]!.head, await f.headFor(PUBLIC));
    assert.ok(publicLanding[0]!.text.includes(SHARD));
    assert.ok(f.creates().filter(c => c.repository === OPS).every(c => !c.text.includes(SHARD)), "the destination never carries the public edit");
    assert.equal(readFileSync(join(f.opsDir, SHARD), "utf8"), yaml("ops"), "the ops task file is untouched");
  });
  await t.test("a destination parent's edit and its held follow-up both land in the destination", async t => {
    const f = fixture(t, "ops", "task-on");
    const out = await f.remedy();
    assert.equal(out.remedy, "split-follow-up", out.reason);
    assert.deepEqual(f.staged(), { [heldRel("ops")]: OPS, [SHARD]: OPS });
    assert.match(f.stagedText(SHARD), /title: ops fixture/);
    assert.deepEqual(f.reserved.map(r => r.branch), [f.branchFor(OPS)]);
    assert.deepEqual(f.creates().map(c => c.repository), [OPS], "no landing opens in the public repository");
    assert.equal(readFileSync(join(f.publicDir, SHARD), "utf8"), f.publicText, "the public task file is untouched");
  });
});

for (const host of ["absent", "task-off"] as const) {
  test(`W1-T14344 criterion 3: invariant:with-the-switch-off-the-landing-is-unchanged, with plan-destination.json ${host === "absent" ? "absent" : "not listing the task kind"} the remedy and the task-files landing write origin/main's files, branch and pull request`, async t => {
    await t.test("a public parent: one public landing carries the held follow-up and the edit", async t => {
      const f = fixture(t, "public", host);
      const out = await f.remedy();
      assert.equal(out.remedy, "split-follow-up", out.reason);
      assert.deepEqual(f.staged(), { [heldRel("public")]: PUBLIC, [SHARD]: PUBLIC });
      assert.deepEqual(f.reserved.map(r => r.branch), [f.branchFor(PUBLIC)]);
      const creates = f.creates();
      assert.deepEqual(creates.map(c => [c.repository, c.head]), [[PUBLIC, await f.headFor(PUBLIC)]], "one landing pull request, the public one");
      assert.ok(creates[0]!.text.includes(heldRel("public")) && creates[0]!.text.includes(SHARD));
      assert.ok(f.gh.every(args => args[args.indexOf("--repo") + 1] === PUBLIC), "no GitHub call names the destination");
      assert.ok(f.git.every(args => args[0] === "-C" && args[1] === f.publicDir), "every landing git call runs in the public checkout");
      assert.deepEqual([...new Set(f.preflights)], [f.publicDir]);
      assert.equal(remedyRows(f.rows)[0]!.landing_pr_url, `https://github.com/${PUBLIC}/pull/48`);
    });
    if (host === "task-off") {
      await t.test("a destination parent: its held follow-up and edit stay in the catalog that holds it (W1-T13048)", async t => {
        const f = fixture(t, "ops", host);
        await f.remedy();
        assert.deepEqual(f.staged(), { [heldRel("ops")]: OPS, [SHARD]: OPS });
        assert.deepEqual(f.creates().map(c => [c.repository, c.head]), [[OPS, await f.headFor(OPS)]]);
      });
    }
  });
}

// The remedy's own host seam, with fake landings: what each landing is handed, in which repository, and in which order.
function seamHost(destination: PlanDestination, landings: { held?: LandResult; edit?: LandResult } = {}) {
  const publicTarget = { owner: "fixture", repo: "remudero", checkoutDir: "/fixture/public" };
  const calls: { repository: string; paths: string[] }[] = [], reservedFor: string[] = [], rows: Record<string, unknown>[] = [];
  const host: ParkedPrHost = {
    readTaskShard: async () => ({ outcome: "read", shard: { relPath: SHARD, text: yaml("public") }, target: publicTarget }),
    resolveTaskDestination: () => destination,
    reserveTaskId: (target) => { reservedFor.push(`${target.owner}/${target.repo}`); return HELD; },
    landTaskFiles: async (files, target) => {
      const repository = `${target.owner}/${target.repo}`, paths = files.map(file => file.relPath);
      calls.push({ repository, paths });
      const answer = files.some(file => file.newFile === true) ? landings.held : landings.edit;
      return answer ?? { prUrl: `https://github.com/${repository}/pull/48`, staged: paths, refused: [] };
    },
    closePr: async () => { throw new Error("a split closes no pull request"); },
  };
  const decision = { remedy: "split-follow-up" as const, reason: "a split",
    inputCriteria: [{ claim: CLAIMS[1]!, needsInput: true, ladderSpent: true }] };
  const run = () => withLiveWritesAllowed(() => takeParkedPrRemedy(subject, decision, [], host,
    { runId: "fixture-sweep", ledgerTaskId: ID, nowIso: "2026-11-22T12:00:00.000Z", cause: "needs-design", text: "which store?",
      append: (row) => { rows.push(row); } }));
  return { calls, reservedFor, rows, run };
}
type LandResult = Awaited<ReturnType<ParkedPrHost["landTaskFiles"]>>;
const destination: PlanDestination = { outcome: "destination", owner: "fixture-private", repo: "ops", checkoutDir: "/fixture/ops" };

test("W1-T14344 criterion 1: an unreadable plan-destination switch refuses the new held file before an id is reserved, and nothing lands", async () => {
  const f = seamHost({ outcome: "unreadable", reason: "state/plan-destination.json: not valid JSON" });
  const out = await f.run();
  assert.match(out.error ?? "", /a new task file cannot be resolved \(W1-T14344\): state\/plan-destination\.json: not valid JSON/);
  assert.deepEqual([f.reservedFor, f.calls], [[], []], "no id is reserved and no landing runs");
  assert.deepEqual(remedyRows(f.rows).map(r => r.outcome), ["refused"]);
});

test("W1-T14344 criterion 2: the parent's edit lands in its own catalog only after the held follow-up it moves criteria to is staged", async t => {
  await t.test("the held file lands first, in the destination, then the edit in the public catalog", async () => {
    const f = seamHost(destination);
    const out = await f.run();
    assert.equal(out.error, undefined, out.reason);
    assert.deepEqual(f.calls, [{ repository: OPS, paths: [heldRel("public")] }, { repository: PUBLIC, paths: [SHARD] }]);
    assert.deepEqual(f.reservedFor, [OPS]);
    assert.equal(remedyRows(f.rows)[0]!.landing_pr_url, `https://github.com/${OPS}/pull/48`);
  });
  await t.test("a held file the destination's landing refuses leaves the parent's file unedited", async () => {
    const f = seamHost(destination, { held: { staged: [], refused: [{ relPath: heldRel("public"), reason: "fixture refusal" }] } });
    const out = await f.run();
    assert.match(out.error ?? "", /the task files did not land: fixture refusal/);
    assert.deepEqual(f.calls.map(c => c.repository), [OPS], "the edit is never handed to the public landing");
  });
  await t.test("an edit the public landing cannot stage is a partial refusal of that edit, and the held follow-up stays filed", async () => {
    const f = seamHost(destination, { edit: { error: "fixture public landing error", refusalChecks: ["proof-discrimination"] } });
    const out = await f.run();
    assert.equal(out.heldTaskId, HELD, out.reason);
    assert.deepEqual(f.calls.map(c => c.repository), [OPS, PUBLIC]);
    const row = remedyRows(f.rows)[0]!;
    assert.deepEqual([row.outcome, row.partial_refusal, row.refusal_checks, row.landing_pr_url],
      ["taken", "fixture public landing error", ["proof-discrimination"], `https://github.com/${OPS}/pull/48`]);
  });
});
