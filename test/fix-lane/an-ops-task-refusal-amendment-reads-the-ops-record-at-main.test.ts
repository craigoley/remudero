import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { draftRefusalAmendment, extractRefusal, readTaskShard, REFUSAL_AMENDMENT_STEP } from "#src/lib/refusal-amendment.js";
import { buildSweepEffects, runSweep, type BuildSweepEffectsDeps } from "#src/lib/sweep.js";
import { gitRepo, originWithClone } from "#test/helpers/git-repo.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { buildFixturePlanPrBody } from "#test/helpers/plan-pr-body-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const ID = "W1-T900528", OPS = "fixture-private/ops", PUBLIC = "fixture/remudero";
const SHARD = `plan/tasks.d/${ID}-fixture.yaml`;
const NOW_MS = Date.parse("2026-11-23T12:00:00.000Z");
const EXCERPT = "REFUSED:\n1. [premise-rotted] fixture premise moved";
const yaml = (id: string, where: string) => `- id: ${id}\n  title: ${where} fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  risk: high\n  verify: auto\n  status: queued\n  attempts: 0\n  acceptance:\n    - claim: fixture behavior\n      proof: "unit test: missing fixture"\n`;

/** A public and an ops checkout, each a clone of its own bare origin, with real git under the sweep. */
function fixture(t: TestContext, catalog: "public" | "ops", opsMainHolds: string = ID) {
  const root = mkdtempSync(join(tmpdir(), "rmd-ops-record-at-main-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const publicDir = join(root, "repos", "remudero"), opsDir = join(root, "repos", "ops");
  mkdirSync(dirname(publicDir), { recursive: true });
  const pub = originWithClone(publicDir, { scope: t });
  const ops = originWithClone(opsDir, { scope: t });
  const record = yaml(opsMainHolds, "ops");
  // The ops main moves on; the ops checkout's working tree stays at the older commit, with no plan/tasks.d/.
  const pusher = gitRepo({ scope: t, cloneFrom: ops.origin.dir });
  mkdirSync(join(pusher.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(pusher.dir, `plan/tasks.d/${opsMainHolds}-fixture.yaml`), record);
  pusher.git("add", "-A"); pusher.git("commit", "--quiet", "-m", "add the ops record"); pusher.git("push", "--quiet", "origin", "main");
  if (catalog === "public") {
    mkdirSync(join(publicDir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(publicDir, SHARD), yaml(ID, "public"));
    pub.clone.git("add", "-A"); pub.clone.git("commit", "--quiet", "-m", "add the public record");
    pub.clone.git("push", "--quiet", "origin", "main");
  }
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify({ repository: OPS, kinds: [] }));
  const ledgerPath = writeLedger([], { dir: join(root, "state") }).path;
  const opsText = yaml(ID, "ops"), hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(opsText), tree = hash(commit + "tree"), planTree = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(opsText)}\0${opsText}`);
  const git: string[][] = [], gh: string[][] = [], rows: Array<Record<string, unknown>> = [];
  const options = { failShow: false };
  const publicPlan = mergePlanBlobs([{ label: "fixture.yaml", text: catalog === "public" ? yaml(ID, "public") : "[]" }]);
  const deps: BuildSweepEffectsDeps = {
    owner: "fixture", repo: "remudero", repoRoot: publicDir,
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath, runId: "fixture-sweep", plan: publicPlan, reloadPlanForFixImpl: () => publicPlan,
    nowMsImpl: () => NOW_MS,
    log: (step, extra) => rows.push({ step, ...extra }),
    readJsonImpl: async args => {
      const path = args[1]!, base = `repos/${OPS}`;
      if (path === base) return { id: 28, full_name: OPS, default_branch: "main" };
      if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
      if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
      if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false,
        tree: [{ path: "plan", sha: planTree, type: "tree", mode: "040000" }] };
      if (path === `${base}/git/trees/${planTree}`) return { sha: planTree, truncated: false,
        tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
      assert.equal(path, `${base}/git/blobs/${blob}`);
      return { sha: blob, encoding: "base64", size: Buffer.byteLength(opsText), content: Buffer.from(opsText).toString("base64") };
    },
    // Real git for every read; the push alone stays local to the fixture.
    planRepairGitImpl: (file, args) => {
      git.push([...args]);
      if (args.includes("push")) return "";
      if (options.failShow && args.includes("show")) throw new Error("the record at main is unreadable");
      return execFileSync(file, [...args], { encoding: "utf8", stdio: "pipe" });
    },
    ghJsonImpl: args => {
      gh.push([...args]);
      if (args[0] === "pr") {
        const repository = args[args.indexOf("--repo") + 1]!;
        if (args[1] === "list") return [];
        return `https://github.com/${repository}/pull/28`;
      }
      const route = args.find(arg => arg.startsWith("repos/"))!;
      if (route.includes("pulls?")) return [];
      return { html_url: `https://github.com/${route.split("/").slice(1, 3).join("/")}/pull/29`, number: 29 };
    },
    worktreeAddImpl: () => { assert.fail("a refusal amendment cuts no worktree"); },
    worktreeRemoveImpl: () => {},
    gitPushRunBranchImpl: () => {}, buildPlanPrBodyImpl: buildFixturePlanPrBody,
    planPrPreflightImpl: () => ({ ok: true, failures: [], unreadable: [] }),
  };
  const effects = buildSweepEffects(deps);
  const amendment = async (runId = "refused-run") => {
    writeFileSync(ledgerPath, `${JSON.stringify({ step: "verdict", run_id: runId, task_id: ID, verdict: "no_pr",
      report_excerpt: EXCERPT, ts: new Date(NOW_MS).toISOString() })}\n`, { flag: "a" });
    await withLiveWritesAllowed(() => runSweep([], {
      arm: () => {}, close: () => {}, dispatchFix: () => {}, escalate: () => {}, ledgerPath,
      runId: "fixture-sweep", draftRefusalAmendments: effects.draftRefusalAmendments, log: deps.log,
      // W1-T14969: the sweep reads its age window from the fixture's clock, the one its verdict rows are stamped by, so
      // the pass enumerates the refusal at any real date instead of only within REFUSAL_AMENDMENT_MAX_AGE_MS of NOW_MS.
      now: () => NOW_MS,
    }));
  };
  const ledger = () => readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const amendmentRows = () => ledger().filter(row => row.step === REFUSAL_AMENDMENT_STEP);
  const staged = (rel = SHARD) => join(root, "state", "task-files-landing-pending", rel);
  const creates = () => gh.filter(args => args[1] === "create" || args.includes("POST"));
  /** The git calls the read at main makes: a fetch of main into its tracking ref, a listing and a show of the record. */
  const readsAtMain = (dir: string) => git.filter(args => args[1] === dir && (
    args.includes("+refs/heads/main:refs/remotes/origin/main") ||
    (args.includes("ls-tree") && args.at(-1) === "plan/tasks.d/") ||
    (args.includes("show") && args.some(arg => arg.endsWith(`:${SHARD}`)))));
  return { root, publicDir, opsDir, pub, ops, record, git, gh, rows, options, amendment, amendmentRows, staged, creates, readsAtMain };
}

test("W1-T14528 criterion 1: an ops-only task reads its record at the ops main and stages it for the ops landing", async t => {
  const f = fixture(t, "ops");
  assert.equal(readTaskShard(f.opsDir, ID), undefined, "the ops working tree holds no record");
  await f.amendment();
  const row = f.amendmentRows()[0];
  assert.ok(row?.outcome === "drafted" || row?.outcome === "waiting", JSON.stringify(row));
  assert.notEqual(row?.outcome, "no_shard");
  const text = readFileSync(f.staged(), "utf8");
  assert.ok(text.startsWith(f.record.slice(0, f.record.indexOf("  status: queued"))));
  assert.match(text, new RegExp(`# refusal-amendment \\(${ID}, run refused-run,`));
  assert.equal(text.replace(/^\s*# .*\n/gm, ""), f.record);
  assert.ok(f.readsAtMain(f.opsDir).length >= 3);
  assert.ok(f.creates().every(args => args.some(arg => arg.includes(OPS))));
  assert.equal(f.pub.clone.git("status", "--porcelain"), "");
});

/** W1-T14969: run this file's five W1-T14528 tests in a child under a clock `days` ahead of the real one (0: the real
 *  clock), with a private TMPDIR, and return its TAP. The child selects only them, so this test never runs itself. */
function runW1T14528At(days: number): string {
  const tmp = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14969-`));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, RMD_TEST_LIVE_DENY_ROOT: join(tmp, "live-deny"), FK_SHIFT_DAYS: String(days) };
    delete env.NODE_TEST_CONTEXT;
    // A nested runner must not inherit a coverage session; only an assignment blanks it (W1-T2292).
    env.NODE_V8_COVERAGE = undefined;
    const shift = days === 0 ? [] : ["--import", "./scripts/clock-shift.mjs"];
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--import", "tsx", "--import", "./test/setup/tmp-hygiene.ts",
      ...shift, "--test-name-pattern", "^W1-T14528 criterion", THIS_FILE], { cwd: REPO_ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("W1-T14969 criterion 1: the five W1-T14528 tests pass at any real date", async t => {
  // The fixture stamps its refusal at NOW_MS; before W1-T14969 the sweep read the real clock, so all five went red once it
  // passed NOW_MS + REFUSAL_AMENDMENT_MAX_AGE_MS (2026-11-26T12:00Z). Run them at the real clock and 7 and 400 days on.
  for (const days of [0, 7, 400]) {
    await t.test(`at the real clock plus ${days} days`, () => {
      const tap = runW1T14528At(days);
      assert.match(tap, /^# pass 5$/m, `all five W1-T14528 tests ran and passed at +${days} days:\n${tap.slice(-4000)}`);
      assert.match(tap, /^# fail 0$/m, `no W1-T14528 test failed at +${days} days:\n${tap.slice(-4000)}`);
    });
  }
});

test("W1-T14528 criterion 2: a public task reads its record from the public working tree with no read at main", async t => {
  const f = fixture(t, "public");
  await f.amendment();
  assert.equal(f.readsAtMain(f.publicDir).length, 0);
  assert.equal(f.readsAtMain(f.opsDir).length, 0);
  const expected: Record<string, string> = {};
  const direct = await draftRefusalAmendment(
    { taskId: ID, runId: "refused-run", reportExcerpt: EXCERPT, refusals: extractRefusal(EXCERPT) } as Parameters<typeof draftRefusalAmendment>[0],
    {
      readShard: (taskId) => readTaskShard(f.publicDir, taskId),
      probeExisting: () => undefined,
      nowIso: () => new Date(NOW_MS).toISOString(),
      openAmendmentPr: (input) => { Object.assign(expected, input); return {}; },
    },
  );
  const row = f.amendmentRows()[0];
  assert.equal(row?.outcome === "drafted" ? "waiting" : row?.outcome, direct.outcome);
  assert.equal(expected.branch, `refusal-amendment/${ID}`);
  assert.equal(expected.shardRelPath, SHARD);
  assert.equal(readFileSync(f.staged(), "utf8"), expected.amendedText);
  const meta = JSON.parse(readFileSync(`${f.staged()}.meta.json`, "utf8")) as Record<string, unknown>;
  assert.equal(meta.claim, expected.claim);
  assert.equal(meta.proof, expected.proof);
  assert.match(expected.title!, /propose an amendment for W1-T900528/);
  assert.match(expected.commitBody!, /refused instead of building/);
  assert.ok(f.creates().every(args => args.some(arg => arg.includes(PUBLIC))));
});

for (const failure of ["fetch", "show"] as const) {
  test(`W1-T14528 criterion 3: an ops record whose ${failure} at main fails is lookup_unreadable and writes nothing`, async t => {
    const f = fixture(t, "ops");
    const url = f.ops.clone.git("remote", "get-url", "origin");
    if (failure === "fetch") f.ops.clone.git("remote", "set-url", "origin", join(f.root, "missing-origin"));
    else f.options.failShow = true;
    await f.amendment();
    const row = f.rows.find(r => r.step === "sweep.refusal_amendment.error");
    assert.equal(row?.outcome, "lookup_unreadable");
    assert.equal(row?.code, "ops-shard-unreadable");
    assert.equal(f.amendmentRows().length, 0);
    assert.equal(f.creates().length, 0);
    assert.equal(existsSync(f.staged()), false);
    assert.equal(existsSync(join(f.root, "state", "dispatch-repair", `${ID}.json`)), false);
    assert.equal(f.pub.clone.git("status", "--porcelain"), "");
    // The next pass tries again and reads the record once main can be read.
    f.ops.clone.git("remote", "set-url", "origin", url);
    f.options.failShow = false;
    await f.amendment();
    assert.ok(["drafted", "waiting"].includes(String(f.amendmentRows()[0]?.outcome)));
    assert.equal(f.creates().every(args => args.some(arg => arg.includes(OPS))), true);
  });
}

test("W1-T14528 criterion 4: an ops-only task whose record is absent from the ops main is no_shard", async t => {
  const f = fixture(t, "ops", "W1-T900529");
  await f.amendment();
  assert.equal(f.amendmentRows()[0]?.outcome, "no_shard");
  assert.equal(existsSync(f.staged()), false);
  assert.equal(f.creates().length, 0);
});

