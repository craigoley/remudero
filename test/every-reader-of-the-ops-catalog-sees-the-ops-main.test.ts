// @source-text-subject: src/**/*.ts — criterion 5 is a property of every tracked source file: no read of the ops
// checkout's working tree for catalog content outside the read-at-main module.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { deflateSync } from "node:zlib";
import type { Config } from "#src/lib/config.js";
import { feedbackCaptured, listFeedback, readFeedbackEntry, readLandedFeedbackEntry, setFeedbackStatus } from "#src/lib/feedback.js";
import { feedbackLandingSweepRungs, landingIdentity, queueFeedbackRecord, readStandingDecisions } from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { readOpsCheckoutAtMain, readOpsCheckoutAtMainSync } from "#src/lib/ops-checkout-at-main.js";
import { planDestinationPath } from "#src/lib/plan-destination.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { buildSweepEffects, type BuildSweepEffectsDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { triageFeedbackHome } from "#src/lib/triage.js";
import { gitRepo, originWithClone, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const OPS_NAME = "zz-ops-plan", OPS = `zz-private-owner/${OPS_NAME}`, ID = "W1-T900617";
const SHARD = `plan/tasks.d/${ID}-fixture.yaml`;
const rel = (id: string) => `plan/feedback/${id}.yaml`;
const entry = (id: string, status: string, raw = `text of ${id}`) =>
  `id: ${id}\nts: 2026-11-01T00:00:00.000Z\nraw: ${raw}\nattachments: []\norigin: cli\nstatus: ${status}\n`;
const task = (where: string) => `- id: ${ID}\n  title: ${where} fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  risk: high\n  verify: auto\n  status: queued\n  attempts: 0\n  acceptance:\n    - claim: fixture behavior\n      proof: "unit test: missing fixture"\n`;

const MAIN_ONLY = "fb-0000000000001-mainonly", STALE = "fb-0000000000002-stale000", GONE = "fb-0000000000003-gone0000";
const CAPTURE = "fb-0000000000004-capture0", PUBLIC_ID = "fb-0000000000005-public00";

function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** Commit `files` (a null text deletes the path) in a clone of `origin` and push them to its main. */
function pushToMain(t: TestContext, origin: GitRepo, files: Record<string, string | null>): void {
  const pusher = gitRepo({ scope: t, cloneFrom: origin.dir });
  for (const [path, text] of Object.entries(files)) {
    if (text === null) pusher.git("rm", "--quiet", path);
    else {
      write(pusher.dir, path, text);
      pusher.git("add", path);
    }
  }
  pusher.git("commit", "--quiet", "-m", "move main");
  pusher.git("push", "--quiet", "origin", "HEAD:main");
}

/**
 * A host with a public checkout and an ops checkout under `<config root>/repos`. The ops checkout's HEAD and working tree
 * stay at its clone commit while its origin/main moves on: main adds MAIN_ONLY and the task record, changes STALE and the
 * decisions, and deletes GONE. CAPTURE is in the ops working tree only. HOME points at the fixture config.
 */
function opsHost(t: TestContext, opts: { kinds?: string[]; hostFile?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ops-main-readers-`));
  const root = join(home, "Remudero"), stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "repos"), { recursive: true });
  const publicDir = join(root, "repos", "remudero"), opsDir = join(root, "repos", OPS_NAME);
  const pub = originWithClone(publicDir, { scope: t, seed: {
    [rel(PUBLIC_ID)]: entry(PUBLIC_ID, "new"), "DECISIONS.md": "PUBLIC-ROOT-DECISION\n", [SHARD]: task("public"),
  } });
  const ops = originWithClone(opsDir, { scope: t, seed: {
    [rel(STALE)]: entry(STALE, "new", "the old bytes"), [rel(GONE)]: entry(GONE, "new"),
    "DECISIONS.md": "OPS-OLD-ROOT-DECISION\n", "plan/decisions.d/old.md": "OPS-OLD-SHARD-DECISION\n",
    "plan/tasks.d/W1-T900001-other.yaml": task("other"),
  } });
  pushToMain(t, ops.origin, {
    [rel(MAIN_ONLY)]: entry(MAIN_ONLY, "proposed"), [rel(STALE)]: entry(STALE, "new", "the main bytes"), [rel(GONE)]: null,
    "DECISIONS.md": "OPS-MAIN-ROOT-DECISION\n", "plan/decisions.d/old.md": null, "plan/decisions.d/new.md": "OPS-MAIN-SHARD-DECISION\n",
    [SHARD]: task("ops main"),
  });
  // The daemon's fetch moves the tracking ref only; the working tree stays where the clone left it.
  ops.clone.git("fetch", "--quiet", "origin");
  write(opsDir, rel(CAPTURE), entry(CAPTURE, "new"));
  if (opts.hostFile !== false) {
    writeFileSync(planDestinationPath(stateDir), JSON.stringify({ repository: OPS, kinds: opts.kinds ?? [] }));
  }
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });
  return { home, root, stateDir, publicDir, opsDir, pub, ops };
}

/** The sweep's production effects over the host, with real git for every read and the ops catalog served by the API. */
function sweepOver(h: ReturnType<typeof opsHost>, catalog: "public" | "ops") {
  const opsText = task("ops main"), hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(opsText), tree = hash(commit + "tree"), planTree = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(opsText)}\0${opsText}`);
  const git: string[][] = [];
  const options = { failShow: false };
  const publicPlan = mergePlanBlobs([{ label: "fixture.yaml", text: catalog === "public" ? task("public") : "[]" }]);
  const deps: BuildSweepEffectsDeps = {
    owner: "fixture", repo: "remudero", repoRoot: h.publicDir,
    config: { root: h.root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(h.stateDir, "ledger.ndjson"), runId: "fixture-sweep", plan: publicPlan, reloadPlanForFixImpl: () => publicPlan,
    log: () => {},
    readJsonImpl: async args => {
      const path = args[1]!, base = `repos/${OPS}`;
      if (path === base) return { id: 17, full_name: OPS, default_branch: "main" };
      if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
      if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
      if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false,
        tree: [{ path: "plan", sha: planTree, type: "tree", mode: "040000" }] };
      if (path === `${base}/git/trees/${planTree}`) return { sha: planTree, truncated: false,
        tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
      assert.equal(path, `${base}/git/blobs/${blob}`);
      return { sha: blob, encoding: "base64", size: Buffer.byteLength(opsText), content: Buffer.from(opsText).toString("base64") };
    },
    planRepairGitImpl: (file, args) => {
      git.push([...args]);
      if (options.failShow && args.includes("show")) throw new Error("the record at main is unreadable");
      return execFileSync(file, [...args], { encoding: "utf8", stdio: "pipe" });
    },
    ghJsonImpl: () => assert.fail("reading a task file calls no GitHub write"),
    worktreeAddImpl: () => assert.fail("reading a task file cuts no worktree"),
    worktreeRemoveImpl: () => {},
    gitPushRunBranchImpl: () => {},
  };
  const parked = buildSweepEffects(deps).parkedPr;
  assert.ok(parked, "the production sweep effects wire the parked-PR remedy");
  return { parked, git, options };
}

test("W1-T14617 criterion 1: the parked-PR remedy reads an ops task record at the ops checkout's origin/main", async t => {
  const h = opsHost(t);
  assert.equal(existsSync(join(h.opsDir, SHARD)), false, "the stale ops working tree has no record for the task");
  const s = sweepOver(h, "ops");
  const read = await s.parked.readTaskShard(ID);
  assert.equal(read.outcome, "read", JSON.stringify(read));
  assert.ok(read.outcome === "read");
  assert.deepEqual(read.shard, { relPath: SHARD, text: task("ops main") });
  assert.equal(`${read.target.owner}/${read.target.repo}`, OPS);
  assert.equal(read.target.checkoutDir, h.opsDir);
  assert.ok(s.git.some(args => args.includes("+refs/heads/main:refs/remotes/origin/main") && args.includes(h.opsDir)), "main is fetched first");

  // A record whose working-tree bytes differ from main's reads main's bytes.
  write(h.opsDir, SHARD, task("stale working tree"));
  const again = await s.parked.readTaskShard(ID);
  assert.ok(again.outcome === "read");
  assert.equal(again.shard.text, task("ops main"));

  // A git failure in the read at main is a refusal that names the read; nothing falls back.
  s.options.failShow = true;
  const refused = await s.parked.readTaskShard(ID);
  assert.equal(refused.outcome, "refused");
  assert.ok(refused.outcome === "refused");
  assert.match(refused.reason, /cannot be read at origin\/main in zz-private-owner\/zz-ops-plan/);
  assert.equal(refused.target?.checkoutDir, h.opsDir, "the refusal is for the ops repository, never the public one");
});

test("W1-T14617 criterion 2: the feedback readers and write homes read the ops checkout at its origin/main", t => {
  const h = opsHost(t);
  // An entry only ops main holds is found, and its home is the destination.
  assert.equal(readFeedbackEntry(h.publicDir, MAIN_ONLY).status, "proposed");
  assert.equal(readLandedFeedbackEntry(h.publicDir, MAIN_ONLY)?.id, MAIN_ONLY);
  assert.equal(feedbackCaptured(h.publicDir, MAIN_ONLY), true);
  assert.equal(triageFeedbackHome(h.publicDir, MAIN_ONLY).root, h.opsDir);
  // An entry whose working-tree copy is older reads main's bytes.
  assert.equal(readFeedbackEntry(h.publicDir, STALE).raw, "the main bytes");
  // An entry the checkout's HEAD tracks but ops main no longer holds is absent.
  assert.equal(existsSync(join(h.opsDir, rel(GONE))), true);
  assert.throws(() => readFeedbackEntry(h.publicDir, GONE), /no feedback entry/);
  assert.equal(feedbackCaptured(h.publicDir, GONE), false);
  assert.throws(() => triageFeedbackHome(h.publicDir, GONE), /no feedback entry/);
  // A capture that neither ops main nor HEAD tracks is still read.
  assert.equal(readFeedbackEntry(h.publicDir, CAPTURE).id, CAPTURE);
  const listed = new Map(listFeedback(h.publicDir).map(e => [e.id, e]));
  assert.deepEqual([...listed.keys()].sort(), [MAIN_ONLY, STALE, CAPTURE, PUBLIC_ID].sort());
  assert.equal(listed.get(STALE)?.raw, "the main bytes");
  // setFeedbackStatus's home is the destination for the main-only entry: the local write lands in the ops checkout.
  setFeedbackStatus(h.publicDir, MAIN_ONLY, "accepted");
  assert.match(readFileSync(join(h.opsDir, rel(MAIN_ONLY)), "utf8"), /^status: accepted$/m);
  assert.equal(existsSync(join(h.publicDir, rel(MAIN_ONLY))), false);
});

/** A fake `gh`: no open landing PR, and `pr create` answers a URL in the repository it was asked for. */
function fakeGh() {
  return (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return `https://github.com/${args[args.indexOf("--repo") + 1] ?? "o/public"}/pull/17\n`;
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
}

/** The files the landing branch of `origin` changes from its main, or [] when there is none. */
function landed(origin: GitRepo): string[] {
  const branch = landingIdentity({ family: "feedback" }).branch;
  if (!origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").includes(branch)) return [];
  return origin.git("diff", "--name-only", "main", branch).split("\n").filter(Boolean).sort();
}

test("W1-T14617 criterion 3: queuedRecordHome and readStandingDecisions read the ops side at ops main", async t => {
  const h = opsHost(t);
  // GONE: only the stale ops working tree holds it, and public origin/main holds it too. MAIN_ONLY: only ops main holds it.
  pushToMain(t, h.pub.origin, { [rel(GONE)]: entry(GONE, "new") });
  h.pub.clone.git("fetch", "--quiet", "origin");
  for (const id of [GONE, MAIN_ONLY]) {
    write(h.publicDir, rel(id), entry(id, "accepted"));
    assert.deepEqual(queueFeedbackRecord(h.publicDir, rel(id), h.root).queued, [rel(id)]);
  }
  const rungs = feedbackLandingSweepRungs(h.publicDir, {
    stateRoot: h.root, planDestinationStateDir: h.stateDir, gh: fakeGh(), planPrPreflight: () => ({ ok: true, failures: [], unreadable: [] }),
  } as Parameters<typeof feedbackLandingSweepRungs>[1]);
  await withLiveWritesAllowed(() => rungs.atBoot());
  assert.deepEqual(landed(h.pub.origin), [rel(GONE)], "the record the stale working tree holds lands in the public repository");
  // The capture waiting in the ops working tree lands there too, as it does today.
  assert.deepEqual(landed(h.ops.origin), [rel(MAIN_ONLY), rel(CAPTURE)], "the record only ops main holds lands in the destination");

  const standing = readStandingDecisions(h.publicDir, h.stateDir);
  assert.match(standing, /PUBLIC-ROOT-DECISION/);
  assert.match(standing, /OPS-MAIN-ROOT-DECISION/);
  assert.match(standing, /OPS-MAIN-SHARD-DECISION/);
  assert.doesNotMatch(standing, /OPS-OLD-/, "the working tree's decisions are not read");
});

test("W1-T14617 criterion 4: invariant:public-catalog-reads-are-unchanged with no host file", async t => {
  const h = opsHost(t, { hostFile: false });
  const UNCOMMITTED = "fb-0000000000006-uncommit";
  write(h.publicDir, rel(UNCOMMITTED), entry(UNCOMMITTED, "new"));
  write(h.publicDir, "plan/decisions.d/local.md", "PUBLIC-UNCOMMITTED-DECISION\n");
  // The public reads are file reads: with the public checkout's git directory moved away, every one still answers.
  renameSync(join(h.publicDir, ".git"), join(h.publicDir, ".git-away"));
  try {
    assert.deepEqual(listFeedback(h.publicDir).map(e => e.id), [PUBLIC_ID, UNCOMMITTED]);
    assert.equal(readFeedbackEntry(h.publicDir, UNCOMMITTED).id, UNCOMMITTED);
    assert.equal(feedbackCaptured(h.publicDir, PUBLIC_ID), true);
    assert.equal(feedbackCaptured(h.publicDir, MAIN_ONLY), false);
    assert.throws(() => readFeedbackEntry(h.publicDir, MAIN_ONLY), /no feedback entry/);
    assert.deepEqual(triageFeedbackHome(h.publicDir, PUBLIC_ID), { root: h.publicDir });
    assert.equal(readStandingDecisions(h.publicDir, h.stateDir), "PUBLIC-ROOT-DECISION\n\nPUBLIC-UNCOMMITTED-DECISION\n");
  } finally {
    renameSync(join(h.publicDir, ".git-away"), join(h.publicDir, ".git"));
  }
  // A public task file is read from the public working tree, with no git call against either checkout.
  write(h.publicDir, SHARD, task("public uncommitted"));
  const s = sweepOver(h, "public");
  const read = await s.parked.readTaskShard(ID);
  assert.ok(read.outcome === "read", JSON.stringify(read));
  assert.equal(read.shard.text, task("public uncommitted"));
  assert.equal(read.target.checkoutDir, h.publicDir);
  assert.equal(s.git.filter(args => args.includes("ls-tree") || args.includes("show")).length, 0);
});

// ── Criterion 5: no read of the ops checkout's working tree for catalog content ─────────────────────────────────

const READ_CALL = /\b(readFileSync|readdirSync|existsSync|readTaskShard|decisionsUnder|feedbackEntryPath)\(/;
const OPS_CHECKOUT = /\b(named|destination|target)\.checkoutDir\b/;
const HELPER = "src/lib/ops-checkout-at-main.ts";
/** Each line the scan finds that is not a catalog read, with its reason. Every row must match a line. */
const ALLOWLIST: ReadonlyArray<{ file: string; text: string; reason: string }> = [
  { file: "src/cli/commands/daemon.ts", text: `existsSync(join(named.checkoutDir, ".git"))`, reason: "the boot clone checks that the checkout exists before it clones" },
  { file: "src/lib/feedback-landing.ts", text: `existsSync(join(named.checkoutDir, ".git"))`, reason: "the landing pass checks that the checkout is a git checkout" },
  { file: "src/lib/feedback.ts", text: `existsSync(join(named.checkoutDir, ".git"))`, reason: "the read roots check that the checkout is a git checkout" },
  { file: "src/lib/feedback.ts", text: `existsSync(join(destination.checkoutDir, ".git"))`, reason: "the capture write site checks that its checkout is a git checkout before it writes" },
  { file: "src/lib/sweep.ts", text: "isPublic ? readTaskShard(target.checkoutDir, taskId)", reason: "the public target only; an ops target is read at main" },
  { file: "src/run-task.ts", text: "existsSync(destination.checkoutDir)", reason: "the architect filing checks that the checkout exists before it writes there" },
];

function opsWorkingTreeReads(sources: ReadonlyArray<{ path: string; text: string }>): Array<{ file: string; line: string }> {
  const found: Array<{ file: string; line: string }> = [];
  for (const { path, text } of sources) {
    if (path === HELPER) continue;
    for (const line of text.split("\n")) {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
      if (READ_CALL.test(code) && OPS_CHECKOUT.test(code)) found.push({ file: path, line: code });
    }
  }
  return found;
}

function unallowed(found: ReadonlyArray<{ file: string; line: string }>): Array<{ file: string; line: string }> {
  return found.filter(f => !ALLOWLIST.some(a => a.file === f.file && f.line.includes(a.text)));
}

test("W1-T14617 criterion 5: a guard fails on any new read of the ops checkout's working tree for catalog content", () => {
  const sources = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z", "src"], { encoding: "utf8" })
    .split("\0").filter(p => p.endsWith(".ts"))
    .map(path => ({ path, text: readFileSync(join(REPO_ROOT, path), "utf8") }));
  const found = opsWorkingTreeReads(sources);
  assert.deepEqual(unallowed(found), [], "a read of the ops checkout's working tree outside the read-at-main module");
  for (const row of ALLOWLIST) {
    assert.ok(found.some(f => f.file === row.file && f.line.includes(row.text)), `allowlist row still matches a line: ${row.file}: ${row.text}`);
  }
  // The guard goes red on a fixture source line that adds such a read.
  const fixture = [{ path: "src/lib/zz-fixture.ts", text: `const t = readFileSync(join(named.checkoutDir, "plan", "tasks.yaml"), "utf8");\n` }];
  assert.equal(unallowed(opsWorkingTreeReads(fixture)).length, 1);
});

test("W1-T14617: both arms of the read-at-main helper apply the one rule, from loose objects and from packs", async t => {
  const h = opsHost(t);
  const query = { dir: "plan/feedback", match: (name: string) => name.endsWith(".yaml") };
  const runGit = async (args: string[]) => execFileSync("git", ["-C", h.opsDir, ...args], { encoding: "utf8" });
  const viaGit = await readOpsCheckoutAtMain(h.opsDir, query, runGit, { untracked: true });
  const sync = readOpsCheckoutAtMainSync(h.opsDir, query, { untracked: true });
  assert.equal(sync.sha, viaGit.sha);
  const texts = (read: typeof sync) => [...read.files].map(([path, file]) => [path, file.source, file.text]);
  assert.deepEqual(texts(sync), texts(viaGit));
  assert.equal(sync.files.get(rel(STALE))?.text, entry(STALE, "new", "the main bytes"));
  assert.equal(sync.files.has(rel(GONE)), false);
  assert.equal(sync.files.get(rel(CAPTURE))?.source, "untracked");
  assert.equal(readOpsCheckoutAtMainSync(h.opsDir, { paths: ["DECISIONS.md"] }).files.get("DECISIONS.md")?.text, "OPS-MAIN-ROOT-DECISION\n");
  // Two near-equal files no earlier read has seen, packed with deltas: the sync arm reads the bytes git shows.
  const token = createHash("sha1").update(`${process.pid}:${h.opsDir}`).digest("hex");
  const body = Array.from({ length: 400 }, (_, i) => `line ${i} of ${token}`).join("\n");
  pushToMain(t, h.ops.origin, { "plan/decisions.d/a.md": `${body}\nA\n`, "plan/decisions.d/b.md": `${body}\nB\n` });
  h.ops.clone.git("fetch", "--quiet", "origin");
  h.ops.clone.git("gc", "--quiet", "--aggressive", "--prune=now");
  const paths = ["plan/decisions.d/a.md", "plan/decisions.d/b.md"];
  const packed = readOpsCheckoutAtMainSync(h.opsDir, { paths });
  assert.deepEqual([...packed.files].map(([path, file]) => [path, file.text]),
    paths.map(path => [path, execFileSync("git", ["-C", h.opsDir, "show", `origin/main:${path}`], { encoding: "utf8" })]));
});

// ── The sync arm fails closed on a store it does not fully read, and on bytes that do not hash to their id ──────────

/** A checkout whose origin/main holds DECISIONS.md with bytes no other test reads (objects are kept by id). */
function storeFixture(t: TestContext) {
  const repo = gitRepo({ scope: t, kind: "ops-store" });
  const text = `DECISION ${createHash("sha1").update(`${process.pid}:${repo.dir}`).digest("hex")}\n`;
  write(repo.dir, "DECISIONS.md", text);
  repo.git("add", "DECISIONS.md");
  repo.git("commit", "--quiet", "-m", "decisions");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const oid = repo.git("rev-parse", "HEAD:DECISIONS.md");
  const objects = join(repo.dir, ".git", "objects");
  const read = () => readOpsCheckoutAtMainSync(repo.dir, { paths: ["DECISIONS.md"] });
  /** Remove the blob's loose object, so the read must find it elsewhere. */
  const dropLoose = () => rmSync(join(objects, oid.slice(0, 2), oid.slice(2)));
  const loosePath = join(objects, oid.slice(0, 2), oid.slice(2));
  return { repo, text, oid, objects, read, dropLoose, loosePath };
}

/** One pack entry's header: the type code and the size, as git writes them. */
function entryHeader(type: number, size: number): Buffer {
  const bytes = [(type << 4) | (size & 15) | (size > 15 ? 0x80 : 0)];
  for (let rest = Math.floor(size / 16); rest > 0; rest = Math.floor(rest / 128)) {
    bytes.push((rest & 0x7f) | (rest >= 128 ? 0x80 : 0));
  }
  return Buffer.from(bytes);
}

/** A pack of one entry for `oid` and its version 2 index, written into the object store. */
function installPack(objects: string, oid: string, entry: Buffer, opts: { idxVersion?: number; packMagic?: string; offset?: number } = {}): void {
  const pack = Buffer.concat([Buffer.from(opts.packMagic ?? "PACK", "latin1"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 1]), entry, Buffer.alloc(20)]);
  const fanout = Buffer.alloc(1024);
  const first = Buffer.from(oid, "hex")[0]!;
  for (let i = first; i < 256; i += 1) fanout.writeUInt32BE(1, i * 4);
  const offset = Buffer.alloc(4);
  offset.writeUInt32BE(opts.offset ?? 12);
  const head = Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, opts.idxVersion ?? 2]);
  const idx = Buffer.concat([head, fanout, Buffer.from(oid, "hex"), Buffer.alloc(4), offset, Buffer.alloc(40)]);
  mkdirSync(join(objects, "pack"), { recursive: true });
  writeFileSync(join(objects, "pack", "pack-fixture.pack"), pack);
  writeFileSync(join(objects, "pack", "pack-fixture.idx"), idx);
}

const deflated = (bytes: string | Buffer) => deflateSync(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));

test("W1-T14617: the sync arm reads a hand-made pack and checks each object's id", t => {
  const f = storeFixture(t);
  f.dropLoose();
  installPack(f.objects, f.oid, Buffer.concat([entryHeader(3, Buffer.byteLength(f.text)), deflated(f.text)]));
  assert.equal(f.read().files.get("DECISIONS.md")?.text, f.text);
});

test("W1-T14617: the sync arm reads past a multi-pack index while every pack keeps its own index", t => {
  const f = storeFixture(t);
  f.dropLoose();
  installPack(f.objects, f.oid, Buffer.concat([entryHeader(3, Buffer.byteLength(f.text)), deflated(f.text)]));
  writeFileSync(join(f.objects, "pack", "multi-pack-index"), "MIDX");
  assert.equal(f.read().files.get("DECISIONS.md")?.text, f.text);
});

const STORE_CASES: ReadonlyArray<{ name: string; arrange: (f: ReturnType<typeof storeFixture>) => void; refusal: RegExp }> = [
  { name: "an object format other than sha1", refusal: /object format is sha256/,
    arrange: f => writeFileSync(join(f.repo.dir, ".git", "config"), `${readFileSync(join(f.repo.dir, ".git", "config"), "utf8")}[extensions]\n\tobjectFormat = sha256\n`) },
  { name: "a reftable ref store", refusal: /reftable/, arrange: f => mkdirSync(join(f.repo.dir, ".git", "reftable")) },
  { name: "a reftable named in the config", refusal: /reftable/,
    arrange: f => writeFileSync(join(f.repo.dir, ".git", "config"), `${readFileSync(join(f.repo.dir, ".git", "config"), "utf8")}[extensions]\n\trefStorage = reftable\n`) },
  { name: "a pack with no index beside a multi-pack index", refusal: /has no index/, arrange: f => {
    f.dropLoose();
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(3, Buffer.byteLength(f.text)), deflated(f.text)]));
    writeFileSync(join(f.objects, "pack", "multi-pack-index"), "MIDX");
    rmSync(join(f.objects, "pack", "pack-fixture.idx"));
  } },
  { name: "a truncated pack index", refusal: /is truncated/, arrange: f => {
    f.dropLoose();
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(3, Buffer.byteLength(f.text)), deflated(f.text)]));
    const idx = join(f.objects, "pack", "pack-fixture.idx");
    writeFileSync(idx, readFileSync(idx).subarray(0, 8 + 1024 + 20));
  } },
  { name: "a pack index offset outside its pack", refusal: /outside its pack/, arrange: f => {
    f.dropLoose();
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(3, Buffer.byteLength(f.text)), deflated(f.text)]), { offset: 1 << 20 });
  } },
  { name: "an alternates chain deeper than 5", refusal: /alternates nest too deep/, arrange: f => {
    for (let i = 0; i <= 6; i += 1) {
      const from = i === 0 ? f.objects : join(f.repo.dir, `alt-${i}`);
      mkdirSync(join(from, "info"), { recursive: true });
      writeFileSync(join(from, "info", "alternates"), `${join(f.repo.dir, `alt-${i + 1}`)}\n`);
    }
  } },
  { name: "a pack index other than version 2", refusal: /not a version 2 index/, arrange: f => {
    f.dropLoose();
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(3, Buffer.byteLength(f.text)), deflated(f.text)]), { idxVersion: 3 });
  } },
  { name: "a pack whose index is missing", refusal: /has no index/, arrange: f => {
    f.dropLoose();
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(3, Buffer.byteLength(f.text)), deflated(f.text)]));
    rmSync(join(f.objects, "pack", "pack-fixture.idx"));
  } },
  { name: "a pack index whose pack is missing", refusal: /has no pack/, arrange: f => {
    f.dropLoose();
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(3, Buffer.byteLength(f.text)), deflated(f.text)]));
    rmSync(join(f.objects, "pack", "pack-fixture.pack"));
  } },
  { name: "a pack with no pack header", refusal: /no version 2 or 3 pack header/, arrange: f => {
    f.dropLoose();
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(3, Buffer.byteLength(f.text)), deflated(f.text)]), { packMagic: "PACX" });
  } },
  { name: "a pack entry of an unknown type", refusal: /unknown type 5/, arrange: f => {
    f.dropLoose();
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(5, 0), deflated("")]));
  } },
  { name: "a delta whose base cannot be found", refusal: /is not in the ops checkout's object store/, arrange: f => {
    f.dropLoose();
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(7, 4), Buffer.alloc(20, 0xab), deflated(Buffer.from([0, 0, 0, 0]))]));
  } },
  { name: "an offset delta that names itself, a chain past the bound", refusal: /delta chain is too deep/, arrange: f => {
    f.dropLoose();
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(6, 4), Buffer.from([0]), deflated(Buffer.from([0, 0, 0, 0]))]));
  } },
  { name: "a ref delta that names its own object, a chain past the bound", refusal: /delta chain is too deep/, arrange: f => {
    f.dropLoose();
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(7, 4), Buffer.from(f.oid, "hex"), deflated(Buffer.from([0, 0, 0, 0]))]));
  } },
  { name: "a corrupt packed object", refusal: /incorrect header check|invalid/i, arrange: f => {
    f.dropLoose();
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(3, Buffer.byteLength(f.text)), Buffer.from("not zlib data at all, just bytes")]));
  } },
  { name: "a packed object of another size", refusal: /inflated to/, arrange: f => {
    f.dropLoose();
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(3, Buffer.byteLength(f.text) + 1), deflated(f.text)]));
  } },
  { name: "packed bytes that do not hash to the id", refusal: /does not hash to its id/, arrange: f => {
    f.dropLoose();
    const other = f.text.replace("DECISION", "DECISIOM");
    installPack(f.objects, f.oid, Buffer.concat([entryHeader(3, Buffer.byteLength(other)), deflated(other)]));
  } },
  { name: "a truncated loose object", refusal: /unexpected end of file/, arrange: f => {
    const raw = readFileSync(f.loosePath);
    f.dropLoose();
    writeFileSync(f.loosePath, raw.subarray(0, raw.length - 6));
  } },
  { name: "a loose object whose header names another size", refusal: /is malformed/, arrange: f => {
    f.dropLoose();
    writeFileSync(f.loosePath, deflated(`blob 9999\0${f.text}`));
  } },
  { name: "loose bytes that do not hash to the id", refusal: /does not hash to its id/, arrange: f => {
    const other = f.text.replace("DECISION", "DECISIOM");
    f.dropLoose();
    writeFileSync(f.loosePath, deflated(`blob ${Buffer.byteLength(other)}\0${other}`));
  } },
];

for (const c of STORE_CASES) {
  test(`W1-T14617: the sync arm fails closed on ${c.name}`, t => {
    const f = storeFixture(t);
    c.arrange(f);
    assert.throws(() => f.read(), c.refusal);
  });
}
