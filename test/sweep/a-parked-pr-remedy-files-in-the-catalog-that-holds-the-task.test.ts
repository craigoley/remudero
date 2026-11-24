import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";

import type { Config } from "#src/lib/config.js";
import { landingIdentity } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { actOnParkedPr, PARKED_PR_REMEDY_STEP, parkedPrFacts, parkedPrRemedy, remedyStalledCriterion, taskCriteriaCount,
  type ParkedPrSubject } from "#src/lib/parked-pr-remedy.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { buildSweepEffects, type BuildSweepEffectsDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { originWithClone } from "#test/helpers/git-repo.js";
import { buildFixturePlanPrBody } from "#test/helpers/plan-pr-body-fixture.js";

// W1-T13048: the parked-PR remedy (W1-T12709) read and landed task files in the public plan only. A pull request whose task
// is in the private ops catalog could not be split or rebuilt, and a fallback to the public repository would leak a private
// task. invariant:no-wrong-catalog: a task file is edited in the repository that holds it.

const ID = "W1-T900048", PUBLIC = "fixture/remudero", OPS = "fixture-private/ops", HELD = "W1-T900099";
const SHARD = `plan/tasks.d/${ID}-fixture.yaml`;
const CLAIMS = ["the first criterion holds", "the second criterion needs a design answer", "the third criterion holds"];
const yaml = (where: string, claims: readonly string[] = CLAIMS) => [`- id: ${ID}`, `  title: ${where} fixture`, "  repo: remudero", "  depends_on: []",
  "  type: implement", "  risk: high", "  verify: auto", "  status: queued", "  attempts: 0", "  acceptance:",
  ...claims.flatMap(c => [`    - claim: "${c}"`, `      proof: "grep: ${c} in src/x.ts"`]), "  rationale: |", "    WHY: a fixture.", ""].join("\n");
const PR_URL = `https://github.com/${PUBLIC}/pull/15`;
const subject: ParkedPrSubject = { prNumber: 15, prUrl: PR_URL, headSha: "head", taskId: ID,
  unmetCriteria: [{ claim: CLAIMS[1]!, proof: `grep: ${CLAIMS[1]} in src/x.ts`, reason: "it needs a design answer" }] };

/** `host`: plan-destination.json names the ops repository, is absent, or cannot be parsed. */
function fixture(t: TestContext, catalog: "public" | "ops", host: "named" | "absent" | "unreadable") {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}parked-pr-catalog-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const publicDir = join(root, "repos", "remudero"), opsDir = join(root, "repos", "ops");
  // Both checkouts hold a file for the id, so a read or a landing in the wrong repository is seen by its title. The public
  // decoy of an ops task has one criterion, so a count read from the wrong checkout chooses a different remedy.
  const publicText = catalog === "public" ? yaml("public") : yaml("public", [CLAIMS[1]!]);
  // The held follow-up lookup fetches origin/main in the selected checkout before the faked landing runs.
  mkdirSync(join(root, "repos"));
  originWithClone(publicDir, { scope: t, seed: { [SHARD]: publicText } });
  originWithClone(opsDir, { scope: t, seed: { [SHARD]: yaml("ops") } });
  mkdirSync(join(root, "state"));
  const hostFile = join(root, "state", "plan-destination.json");
  if (host === "named") writeFileSync(hostFile, JSON.stringify({ repository: OPS, kinds: ["decision", "feedback"] }));
  if (host === "unreadable") writeFileSync(hostFile, "{");
  const text = yaml("ops"), hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(text), tree = hash(commit + "tree"), planTree = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(text)}\0${text}`);
  const reads: string[] = [], gh: string[][] = [], git: string[][] = [], preflights: string[] = [];
  const reserved: { cwd: string; branch: string }[] = [], rows: Record<string, unknown>[] = [];
  const opened = new Map<string, string>();
  let red: string | undefined;
  const publicPlan = mergePlanBlobs([{ label: "fixture.yaml", text: catalog === "public" ? yaml("public") : "[]" }]);
  const deps: BuildSweepEffectsDeps = {
    owner: "fixture", repo: "remudero", repoRoot: publicDir, config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"), runId: "fixture-sweep", plan: publicPlan, reloadPlanForFixImpl: () => publicPlan,
    log: () => {},
    readJsonImpl: async args => {
      const path = args[1]!; reads.push(path);
      const base = `repos/${OPS}`;
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
      // The new task file a refused landing sets aside: main holds no file at its path.
      if (red !== undefined && args.includes("rev-parse") && args.at(-1)!.includes(`:plan/tasks.d/${red}-`)) throw new Error("fatal: path not in main");
      if (args.includes("rev-parse")) return args.at(-1) === "origin/main" ? "mainsha" : "fixture-sha";
      if (args.includes("hash-object")) return "fixture-blob";
      // A refusing world names each tree apart, so the landing's green-tree cache never hides the refused batch.
      if (args.includes("write-tree")) return red === undefined ? `tree-${args[1]}` : `tree-${args[1]}-${red}-${git.length}`;
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
    planPrPreflightImpl: (dir, _sha, pr) => {
      preflights.push(dir);
      return red !== undefined && pr.body.includes(`id: ${red} in`) ? { ok: false, failures: [{ check: "proof-discrimination", firstLine: "fixture refusal" }], unreadable: [] }
        : { ok: true, failures: [], unreadable: [] };
    },
  };
  const effects = buildSweepEffects(deps);
  assert.ok(effects.parkedPr, "the production sweep effects wire the remedy");
  const parked = effects.parkedPr;
  const ctx = { runId: "fixture-sweep", ledgerTaskId: ID, nowIso: "2026-11-16T12:00:00.000Z",
    append: (row: Record<string, unknown>) => { rows.push(row); } };
  /** The sweep's call where it would set refused-escalate on a design question. */
  const remedy = () => withLiveWritesAllowed(async () => {
    const facts = await parkedPrFacts(subject, { redChecks: [], designQuestion: "which store?", fixModelOrder: ["fix"] }, [], parked);
    return actOnParkedPr(subject, parkedPrRemedy(facts), facts, [], parked, { ...ctx, cause: "needs-design", text: "which store?" });
  });
  /** The stall ladder's operator-input step, which reads the criteria count to choose a split or a rebuild. */
  const stalled = () => withLiveWritesAllowed(() =>
    remedyStalledCriterion(subject, `review:${CLAIMS[1]}`, "fix stall", [], parked, ctx));
  const creates = () => gh.filter(args => args[1] === "create");
  const pending = join(root, "state", "task-files-landing-pending");
  const staged = (rel: string) => readFileSync(join(pending, rel), "utf8");
  const stagedFiles = (): string[] => existsSync(pending)
    ? readdirSync(pending, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name))
    : [];
  const branchFor = (repository: string) => {
    const [owner, repo] = repository.split("/") as [string, string];
    return landingIdentity({ family: "task-files", targetRepository: { owner, repo },
      sourceRepository: { owner: "fixture", repo: "remudero" } }).branch;
  };
  return { root, publicDir, publicText, opsDir, parked, reads, gh, git, preflights, reserved, rows, remedy, stalled, creates, staged,
    stagedFiles, branchFor, refuse: (id: string) => { red = id; } };
}

const remedyRows = (rows: readonly Record<string, unknown>[]) => rows.filter(r => r.step === PARKED_PR_REMEDY_STEP);
const heldRel = `plan/tasks.d/${HELD}-ops-fixture.yaml`;

test("W1-T13048 criterion 1: an ops-catalog task is read from the destination checkout and its held task and amendment land in that repository", async t => {
  const f = fixture(t, "ops", "named");
  const out = await f.remedy();
  assert.equal(out.remedy, "split-follow-up", out.reason);
  assert.equal(out.heldTaskId, HELD);
  assert.ok(f.reads.includes(`repos/${OPS}/git/ref/heads/main`), "the task is found in the ops catalog");
  assert.deepEqual(f.reserved.map(r => r.branch), [f.branchFor(OPS)], "the id is reserved for the ops landing branch");
  assert.notEqual(f.branchFor(OPS), f.branchFor(PUBLIC));
  assert.equal(f.creates().length, 1);
  assert.equal(f.creates()[0]![f.creates()[0]!.indexOf("--repo") + 1], OPS, "landTaskFilesAsync targets the ops repository");
  assert.ok(f.gh.every(args => args[args.indexOf("--repo") + 1] === OPS), "no GitHub call names the public repository");
  assert.deepEqual([...new Set(f.preflights)], [f.opsDir], "the landing preflight runs in the ops checkout");
  assert.ok(f.git.every(args => args[0] === "-C" && args[1] === f.opsDir), "every landing git call runs in the ops checkout");
  const held = (parse(f.staged(heldRel)) as Record<string, unknown>[])[0]!;
  assert.equal(held.id, HELD);
  assert.match(String(held.title), /^ops fixture/, "the held task is built from the ops task file");
  assert.deepEqual((held.acceptance as { claim: string }[]).map(c => c.claim), [CLAIMS[1]]);
  const amended = f.staged(SHARD);
  assert.match(amended, /title: ops fixture/, "the amendment edits the ops task file");
  assert.match(amended, new RegExp(`MOVED to ${HELD}`));
  assert.equal(readFileSync(join(f.publicDir, SHARD), "utf8"), f.publicText, "the public task file is untouched");
  const row = remedyRows(f.rows)[0]!;
  assert.deepEqual([row.remedy, row.outcome, row.landing_pr_url], ["split-follow-up", "taken", `https://github.com/${OPS}/pull/48`]);
});

test("W1-T13048 criterion 2: a public-plan task is read and landed in the public repository, as W1-T12709 does", async t => {
  const f = fixture(t, "public", "named");
  const out = await f.remedy();
  assert.equal(out.remedy, "split-follow-up", out.reason);
  assert.deepEqual(f.reads, [], "a task in the public plan never opens the ops catalog");
  assert.deepEqual(f.reserved.map(r => r.branch), [f.branchFor(PUBLIC)]);
  assert.equal(f.creates().length, 1);
  assert.ok(f.gh.every(args => args[args.indexOf("--repo") + 1] === PUBLIC), "every landing call names the public repository");
  assert.deepEqual([...new Set(f.preflights)], [f.publicDir]);
  assert.ok(f.git.every(args => args[0] === "-C" && args[1] === f.publicDir));
  assert.match(f.staged(SHARD), /title: public fixture/);
  assert.match(String((parse(f.staged(`plan/tasks.d/${HELD}-public-fixture.yaml`)) as { title: string }[])[0]!.title), /^public fixture/);
  assert.equal(readFileSync(join(f.opsDir, SHARD), "utf8"), yaml("ops"), "the ops task file is untouched");
  assert.equal(remedyRows(f.rows)[0]!.landing_pr_url, `https://github.com/${PUBLIC}/pull/48`);
});

for (const host of ["absent", "unreadable"] as const) {
  test(`W1-T13048 criterion 3: invariant:no-wrong-catalog, an ops-catalog task with plan-destination.json ${host} is refused as destination-unreadable and lands nothing in the public repository`, async t => {
    const f = fixture(t, "ops", host);
    assert.deepEqual(await f.parked.readTaskShard(ID), { outcome: "refused", reason: "destination-unreadable" });
    const split = await withLiveWritesAllowed(() => actOnParkedPr(subject,
      { remedy: "split-follow-up", reason: "a split", inputCriteria: [{ claim: CLAIMS[1]!, needsInput: true, ladderSpent: true }] },
      { unmetCriteria: [], redChecks: [], isPlanFiling: false }, [], f.parked,
      { runId: "fixture-sweep", ledgerTaskId: ID, nowIso: "2026-11-16T12:00:00.000Z", cause: "needs-design", text: "which store?",
        append: (row) => { f.rows.push(row); } }));
    assert.equal(split.disposition, "wait");
    const rebuild = await f.stalled();
    assert.equal(rebuild.error, "destination-unreadable");
    assert.deepEqual(remedyRows(f.rows).map(r => [r.outcome, r.reason]),
      [["refused", "destination-unreadable"], ["refused", "destination-unreadable"]]);
    assert.deepEqual(f.reserved, [], "no id is reserved");
    assert.deepEqual(f.gh, [], "no pull request is listed or opened in any repository");
    assert.deepEqual(f.git, [], "no landing git call runs");
    assert.deepEqual(f.preflights, []);
    assert.deepEqual(f.stagedFiles(), [], "no task file is staged for a landing");
    assert.equal(readFileSync(join(f.publicDir, SHARD), "utf8"), f.publicText, "the public task file is untouched");
  });
}

test("W1-T13048 criterion 3: a task that neither catalog holds is refused as task-absent and lands nothing", async t => {
  const f = fixture(t, "public", "named");
  const absent = { ...subject, taskId: "W1-T900047" };
  assert.deepEqual(await f.parked.readTaskShard("W1-T900047"), { outcome: "refused", reason: "task-absent" });
  const out = await withLiveWritesAllowed(() => remedyStalledCriterion(absent, `review:${CLAIMS[1]}`, "fix stall", [], f.parked,
    { runId: "fixture-sweep", ledgerTaskId: "W1-T900047", nowIso: "2026-11-16T12:00:00.000Z", append: (row) => { f.rows.push(row); } }));
  assert.equal(out.error, "task-absent");
  assert.deepEqual(remedyRows(f.rows).map(r => [r.outcome, r.reason]), [["refused", "task-absent"]]);
  assert.deepEqual([f.reserved, f.gh, f.git, f.preflights, f.stagedFiles()], [[], [], [], [], []]);
});

test("W1-T13048 criterion 4: taskCriteriaCount reads the ops-catalog task file, so a pull request with some criteria that need input is split, not closed", async t => {
  const f = fixture(t, "ops", "named");
  assert.equal(await taskCriteriaCount(f.parked, ID), CLAIMS.length);
  const facts = await parkedPrFacts(subject, { redChecks: [], designQuestion: "which store?", fixModelOrder: ["fix"] }, [], f.parked);
  assert.equal(facts.taskCriteria, CLAIMS.length);
  const out = await f.stalled();
  assert.equal(out.remedy, "split-follow-up", out.reason);
  assert.equal(out.error, undefined);
  assert.equal(f.creates().length, 1);
  assert.equal(f.creates()[0]![f.creates()[0]!.indexOf("--repo") + 1], OPS);
  assert.ok(!remedyRows(f.rows).some(r => r.remedy === "close-and-rebuild" || r.closed === true), "the pull request is not closed");
});

test("W1-T13169: a sweep landing into the plan destination releases a set-aside filing's reservation in the public checkout", async t => {
  const f = fixture(t, "ops", "named");
  // A new ops task file a gardener staged earlier; the remedy's landing tests it again and the preflight refuses it.
  const aside = "W1-T900077", asideRel = `plan/tasks.d/${aside}-ops-fixture.yaml`;
  const abs = join(f.root, "state", "task-files-landing-pending", asideRel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, yaml("ops").replaceAll(ID, aside));
  writeFileSync(`${abs}.meta.json`, `${JSON.stringify({ baseBlob: null, claim: `the task ${aside} is filed`,
    proof: `grep: id: ${aside} in ${asideRel}`, repository: OPS })}\n`);
  f.refuse(aside);
  await f.remedy();
  assert.ok(!f.stagedFiles().includes(abs), "the landing sets the refused file aside");
  const reservation = f.git.filter(args => args.some(a => a.includes("refs/rmd-id")));
  assert.ok(reservation.length > 0, `the set-aside reads the reservation of ${aside}: ${JSON.stringify(f.git)}`);
  assert.ok(reservation.every(args => args[0] === "-C" && args[1] === f.publicDir), "every reservation call runs in the public checkout");
  assert.ok(f.git.filter(args => args[1] === f.opsDir).every(args => !args.some(a => a.includes("refs/rmd-id"))),
    "no reservation call runs in the ops checkout");
});
