// W1-T14617: every reader of the ops catalog sees the ops repository's main, never the boot-time working tree. The daemon
// clones the ops checkout once at boot and a fetch moves only refs/remotes/origin/main, so each fixture here holds the
// ops checkout's HEAD and working tree at an old commit while its origin/main moves on, with real git throughout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { test, type TestContext } from "node:test";
import type { Config } from "#src/lib/config.js";
import { feedbackCaptured, listFeedback, readFeedbackEntry, readLandedFeedbackEntry, setFeedbackStatus } from "#src/lib/feedback.js";
import { queuedRecordHome, readStandingDecisions } from "#src/lib/feedback-landing.js";
import { mergePlanBlobs } from "#src/lib/plan.js";
import { planDestinationPath } from "#src/lib/plan-destination.js";
import { buildSweepEffects, type BuildSweepEffectsDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { triageFeedbackHome } from "#src/lib/triage.js";
import { gitRepo, originWithClone } from "#test/helpers/git-repo.js";
import { buildFixturePlanPrBody } from "#test/helpers/plan-pr-body-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const OPS = "fixture-private/ops";
const MAIN_ONLY_TASK = "W1-T900617", CHANGED_TASK = "W1-T900618", PUBLIC_TASK = "W1-T900619";
const shardOf = (id: string) => `plan/tasks.d/${id}-fixture.yaml`;
const task = (id: string, where: string) => `- id: ${id}\n  title: ${where} fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n` +
  `  risk: high\n  verify: auto\n  status: queued\n  attempts: 0\n  acceptance:\n    - claim: fixture behavior\n      proof: "unit test: missing fixture"\n`;
const fb = (id: string, raw: string, status = "new") =>
  `id: ${id}\nts: 2026-11-24T00:00:00.000Z\nraw: ${raw}\nattachments: []\norigin: cli\nstatus: ${status}\n`;
const FB = { mainOnly: "fb-1795000000001-aaaaaa", changed: "fb-1795000000002-bbbbbb", stale: "fb-1795000000003-cccccc",
  capture: "fb-1795000000004-dddddd", queuedStale: "fb-1795000000005-eeeeee", pub: "fb-1795000000006-ffffff" };
const fbPath = (id: string) => `plan/feedback/${id}.yaml`;

/** A host: config at HOME, a public checkout and an ops checkout whose HEAD stays at an old commit while origin/main moves. */
function opsHost(t: TestContext, opts: { hostFile?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ops-catalog-main-`));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, "Remudero");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "repos"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  if (opts.hostFile !== false) {
    writeFileSync(planDestinationPath(join(root, "state")), JSON.stringify({ repository: OPS, kinds: ["decision", "feedback"] }));
  }
  const publicDir = join(root, "repos", "remudero"), opsDir = join(root, "repos", "ops");
  const pub = originWithClone(publicDir, { scope: t, seed: { [fbPath(FB.pub)]: fb(FB.pub, "public entry") } });
  // The boot-time commit: no record for MAIN_ONLY_TASK, older bytes for the rest, and files main later drops.
  const ops = originWithClone(opsDir, { scope: t, seed: {
    [shardOf(CHANGED_TASK)]: task(CHANGED_TASK, "old ops"),
    [fbPath(FB.changed)]: fb(FB.changed, "old bytes"), [fbPath(FB.stale)]: fb(FB.stale, "dropped on main"),
    [fbPath(FB.queuedStale)]: fb(FB.queuedStale, "dropped on main"),
    "DECISIONS.md": "old ops decision\n", "plan/decisions.d/old.md": "old ops shard\n",
  } });
  const pusher = gitRepo({ scope: t, cloneFrom: ops.origin.dir });
  pusher.git("rm", "--quiet", fbPath(FB.stale), fbPath(FB.queuedStale), "plan/decisions.d/old.md");
  const put = (rel: string, text: string) => { mkdirSync(dirname(join(pusher.dir, rel)), { recursive: true }); writeFileSync(join(pusher.dir, rel), text); };
  put(shardOf(MAIN_ONLY_TASK), task(MAIN_ONLY_TASK, "ops main"));
  put(shardOf(CHANGED_TASK), task(CHANGED_TASK, "new ops main"));
  put(fbPath(FB.mainOnly), fb(FB.mainOnly, "only on ops main"));
  put(fbPath(FB.changed), fb(FB.changed, "main bytes"));
  put("DECISIONS.md", "main ops decision\n");
  put("plan/decisions.d/main.md", "main ops shard\n");
  pusher.git("add", "-A"); pusher.git("commit", "--quiet", "-m", "ops main moves on"); pusher.git("push", "--quiet", "origin", "main");
  // A fetch moves refs/remotes/origin/main only; HEAD and the working tree stay where the boot left them.
  ops.clone.git("fetch", "--quiet", "origin");
  // A capture not yet landed: neither ops main nor HEAD tracks it.
  writeFileSync(join(opsDir, fbPath(FB.capture)), fb(FB.capture, "a capture not yet landed"));
  // Public origin/main holds the record the stale ops working tree also holds; the public working tree does not.
  const publicPusher = gitRepo({ scope: t, cloneFrom: pub.origin.dir });
  mkdirSync(join(publicPusher.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(publicPusher.dir, fbPath(FB.queuedStale)), fb(FB.queuedStale, "public main"));
  publicPusher.git("add", "-A"); publicPusher.git("commit", "--quiet", "-m", "public record"); publicPusher.git("push", "--quiet", "origin", "main");
  pub.clone.git("fetch", "--quiet", "origin");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = oldHome; });
  return { home, root, stateDir: join(root, "state"), publicDir, opsDir, ops };
}

/** The sweep's production parked-PR host over the fixture: real git, recorded, with a switch that fails a read at main. */
function parkedPrHost(h: ReturnType<typeof opsHost>, publicText = "[]") {
  const catalog = task(MAIN_ONLY_TASK, "ops main") + task(CHANGED_TASK, "new ops main");
  const hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(catalog), tree = hash(commit + "tree"), planTree = hash(commit + "plan");
  const blob = hash(`blob ${Buffer.byteLength(catalog)}\0${catalog}`);
  const git: string[][] = [];
  const options = { failAtMain: false };
  const plan = mergePlanBlobs([{ label: "fixture.yaml", text: publicText }]);
  const deps: BuildSweepEffectsDeps = {
    owner: "fixture", repo: "remudero", repoRoot: h.publicDir, config: { root: h.root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(h.stateDir, "ledger.ndjson"), runId: "fixture-sweep", plan, reloadPlanForFixImpl: () => plan, log: () => {},
    // The ops catalog through the API, as findTaskInCatalogs reads it.
    readJsonImpl: async args => {
      const path = args[1]!, base = `repos/${OPS}`;
      if (path === base) return { id: 617, full_name: OPS, default_branch: "main" };
      if (path === `${base}/git/ref/heads/main`) return { object: { type: "commit", sha: commit } };
      if (path === `${base}/git/commits/${commit}`) return { sha: commit, tree: { sha: tree } };
      if (path === `${base}/git/trees/${tree}`) return { sha: tree, truncated: false, tree: [{ path: "plan", sha: planTree, type: "tree", mode: "040000" }] };
      if (path === `${base}/git/trees/${planTree}`) return { sha: planTree, truncated: false,
        tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] };
      assert.equal(path, `${base}/git/blobs/${blob}`);
      return { sha: blob, encoding: "base64", size: Buffer.byteLength(catalog), content: Buffer.from(catalog).toString("base64") };
    },
    planRepairGitImpl: (file, args) => {
      git.push([...args]);
      if (options.failAtMain && args.includes("ls-tree")) throw new Error("fatal: the fixture's ls-tree at main failed");
      return execFileSync(file, [...args], { encoding: "utf8", stdio: "pipe" });
    },
    ghJsonImpl: args => assert.fail(`reading a task file makes no GitHub call: ${args.join(" ")}`),
    buildPlanPrBodyImpl: buildFixturePlanPrBody,
    planPrPreflightImpl: () => ({ ok: true, failures: [], unreadable: [] }),
  };
  const parked = buildSweepEffects(deps).parkedPr;
  assert.ok(parked, "the production sweep effects wire the remedy");
  return { parked, git, options };
}

test("W1-T14617 criterion 1: the parked-PR remedy reads an ops task record at the ops checkout's origin/main", async (t) => {
  const h = opsHost(t);
  assert.equal(existsSync(join(h.opsDir, shardOf(MAIN_ONLY_TASK))), false, "the stale ops working tree has no record");
  const { parked, git, options } = parkedPrHost(h);

  const mainOnly = await parked.readTaskShard(MAIN_ONLY_TASK);
  assert.equal(mainOnly.outcome, "read", JSON.stringify(mainOnly));
  assert.ok(mainOnly.outcome === "read");
  assert.deepEqual(mainOnly.shard, { relPath: shardOf(MAIN_ONLY_TASK), text: task(MAIN_ONLY_TASK, "ops main") });
  assert.equal(mainOnly.target.checkoutDir, h.opsDir);
  assert.equal(`${mainOnly.target.owner}/${mainOnly.target.repo}`, OPS);
  assert.ok(git.some(args => args[1] === h.opsDir && args.includes("+refs/heads/main:refs/remotes/origin/main")), "main is fetched first");

  // The working tree holds older bytes for this record: main's bytes are read.
  assert.equal(readFileSync(join(h.opsDir, shardOf(CHANGED_TASK)), "utf8"), task(CHANGED_TASK, "old ops"));
  const changed = await parked.readTaskShard(CHANGED_TASK);
  assert.ok(changed.outcome === "read", JSON.stringify(changed));
  assert.equal(changed.shard.text, task(CHANGED_TASK, "new ops main"));

  // A git failure in the read at main is a refusal that names the read; nothing falls back to the working tree.
  options.failAtMain = true;
  const refused = await parked.readTaskShard(CHANGED_TASK);
  assert.equal(refused.outcome, "refused");
  assert.ok(refused.outcome === "refused");
  assert.match(refused.reason, /cannot be read at origin\/main of fixture-private\/ops: .*ls-tree at main failed/);
  assert.equal(refused.target?.checkoutDir, h.opsDir, "the refusal names the ops repository, never the public one");
});

test("W1-T14617 criterion 2: the feedback readers and write homes read the ops checkout at its origin/main", (t) => {
  const h = opsHost(t);
  const pub = h.publicDir;
  // An entry only ops main holds is found, and its home is the destination.
  assert.equal(readFeedbackEntry(pub, FB.mainOnly).raw, "only on ops main");
  assert.equal(readLandedFeedbackEntry(pub, FB.mainOnly)?.raw, "only on ops main");
  assert.equal(feedbackCaptured(pub, FB.mainOnly), true);
  assert.equal(triageFeedbackHome(pub, FB.mainOnly).root, h.opsDir);
  assert.equal(`${triageFeedbackHome(pub, FB.mainOnly).destination?.owner}/${triageFeedbackHome(pub, FB.mainOnly).destination?.repo}`, OPS);
  // An entry whose working-tree copy is older reads main's bytes.
  assert.equal(readFileSync(join(h.opsDir, fbPath(FB.changed)), "utf8"), fb(FB.changed, "old bytes"));
  assert.equal(readFeedbackEntry(pub, FB.changed).raw, "main bytes");
  assert.equal(readLandedFeedbackEntry(pub, FB.changed)?.raw, "main bytes");
  // An entry HEAD tracks but ops main no longer holds is absent, though the stale working tree still has it.
  assert.equal(existsSync(join(h.opsDir, fbPath(FB.stale))), true);
  assert.throws(() => readFeedbackEntry(pub, FB.stale), /no feedback entry/);
  assert.equal(readLandedFeedbackEntry(pub, FB.stale), null);
  assert.equal(feedbackCaptured(pub, FB.stale), false);
  assert.throws(() => triageFeedbackHome(pub, FB.stale), /no feedback entry/);
  assert.throws(() => setFeedbackStatus(pub, FB.stale, "rejected"), /no feedback entry/);
  // A capture neither ops main nor HEAD tracks is still read from the ops working tree.
  assert.equal(readFeedbackEntry(pub, FB.capture).raw, "a capture not yet landed");
  assert.equal(feedbackCaptured(pub, FB.capture), true);
  // One list: the public entry, ops main's entries and the capture; never the dropped entries or the older bytes.
  const listed = listFeedback(pub);
  assert.deepEqual(listed.map(e => e.id), [FB.mainOnly, FB.changed, FB.capture, FB.pub]);
  assert.equal(listed.find(e => e.id === FB.changed)?.raw, "main bytes");
  // setFeedbackStatus writes where the entry is held: the destination checkout, not the public one.
  const updated = setFeedbackStatus(pub, FB.mainOnly, "rejected");
  assert.equal(updated.raw, "only on ops main");
  assert.match(readFileSync(join(h.opsDir, fbPath(FB.mainOnly)), "utf8"), /status: rejected/);
  assert.equal(existsSync(join(pub, fbPath(FB.mainOnly))), false);
});

test("W1-T14617 criterion 3: queuedRecordHome and readStandingDecisions read the ops side at ops main", async (t) => {
  const h = opsHost(t);
  // Only the stale ops working tree holds it, and public origin/main holds it: it lands in the public repository.
  assert.equal(existsSync(join(h.opsDir, fbPath(FB.queuedStale))), true);
  assert.equal(await queuedRecordHome(h.publicDir, h.opsDir, fbPath(FB.queuedStale), true), "public");
  // Only ops main holds it: it lands in the destination.
  assert.equal(await queuedRecordHome(h.publicDir, h.opsDir, fbPath(FB.mainOnly), false), "destination");
  // A capture neither ops main nor HEAD tracks stays in the destination, as before.
  assert.equal(await queuedRecordHome(h.publicDir, h.opsDir, fbPath(FB.capture), false), "destination");
  // The standing decisions are ops main's DECISIONS.md and plan/decisions.d, not the working tree's.
  assert.equal(readFileSync(join(h.opsDir, "DECISIONS.md"), "utf8"), "old ops decision\n");
  assert.equal(readStandingDecisions(h.publicDir, h.stateDir), "main ops decision\n\nmain ops shard\n");
});

/** A `git` on PATH that records every invocation, then runs the real one. */
function recordedGit(t: TestContext): () => string[] {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ops-catalog-git-`));
  const log = join(dir, "calls.log");
  const real = (process.env.PATH ?? "").split(delimiter).map(d => join(d, "git")).find(p => existsSync(p));
  assert.ok(real, "a git on PATH");
  writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(dir, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${oldPath ?? ""}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
  return () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

test("W1-T14617 criterion 4: invariant:public-catalog-reads-are-unchanged with no host file", async (t) => {
  const h = opsHost(t, { hostFile: false });
  const pub = h.publicDir;
  // Uncommitted public files: an entry, a decision record and a task record, read from the working tree as today.
  const uncommitted = "fb-1795000000007-abcdef";
  writeFileSync(join(pub, fbPath(uncommitted)), fb(uncommitted, "uncommitted public entry"));
  writeFileSync(join(pub, "DECISIONS.md"), "public decision\n");
  mkdirSync(join(pub, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(pub, shardOf(PUBLIC_TASK)), task(PUBLIC_TASK, "uncommitted public"));
  const calls = recordedGit(t);

  assert.deepEqual(listFeedback(pub).map(e => e.id), [FB.pub, uncommitted], "the public root only");
  assert.equal(readFeedbackEntry(pub, uncommitted).raw, "uncommitted public entry");
  assert.throws(() => readFeedbackEntry(pub, FB.mainOnly), /no feedback entry/, "the ops checkout is no root without a host file");
  assert.equal(feedbackCaptured(pub, uncommitted), true);
  assert.equal(feedbackCaptured(pub, FB.mainOnly), false);
  assert.deepEqual(triageFeedbackHome(pub, uncommitted), { root: pub });
  assert.equal(readStandingDecisions(pub, h.stateDir), "public decision\n");
  assert.equal(await queuedRecordHome(pub, h.opsDir, fbPath(uncommitted), true), "public");
  setFeedbackStatus(pub, uncommitted, "rejected");
  assert.match(readFileSync(join(pub, fbPath(uncommitted)), "utf8"), /status: rejected/);
  assert.deepEqual(calls(), [], "no reader makes a git call");

  const { parked, git } = parkedPrHost(h, task(PUBLIC_TASK, "public plan"));
  const read = await parked.readTaskShard(PUBLIC_TASK);
  assert.ok(read.outcome === "read", JSON.stringify(read));
  assert.deepEqual(read.shard, { relPath: shardOf(PUBLIC_TASK), text: task(PUBLIC_TASK, "uncommitted public") });
  assert.equal(read.target.checkoutDir, pub);
  assert.deepEqual(git, [], "the public task file is read with no git call");
});

// ── Criterion 5: the guard. ─────────────────────────────────────────────────────────────────────────────────────────

/** The read primitives of the criterion, and the expressions that name a plan-destination checkout. */
const READ_CALL = /\b(readFileSync|readdirSync|existsSync|readTaskShard|decisionsUnder|feedbackEntryPath)\(/g;
const DESTINATION_CHECKOUT = /\b(?:named|destination|target)\.checkoutDir\b|\brepairRepoDir\b/;
/** An existsSync of the checkout itself, or of its .git, reads no catalog content. */
const CHECKOUT_PRESENCE = /^\s*(?:join\(\s*[\w.]+\.checkoutDir\s*,\s*"\.git"\s*\)|[\w.]+\.checkoutDir)\s*$/;
const HELPER = "src/lib/ops-checkout-at-main.ts";
/** Capture write sites that read a destination path, each with its reason. None reads one today. */
const ALLOWLIST: ReadonlyArray<{ file: string; text: string; reason: string }> = [];

/** `src` with comments blanked and string contents masked, length kept, so a call's argument can be cut by its parens. */
function masked(src: string): string {
  let out = "";
  for (let i = 0; i < src.length;) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      out += " ".repeat(stop - i); i = stop; continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " "); i = stop; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === "`" || src[j] !== "\n")) j += src[j] === "\\" ? 2 : 1;
      out += c + src.slice(i + 1, j).replace(/[^\n]/g, "x") + (j < src.length ? c : "");
      i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

/** Every read primitive whose argument names a plan-destination checkout, by file and line. */
function opsWorkingTreeReads(files: ReadonlyArray<{ file: string; text: string }>): string[] {
  const found: string[] = [];
  for (const { file, text } of files) {
    if (file === HELPER) continue;
    const code = masked(text);
    for (const m of code.matchAll(READ_CALL)) {
      const open = m.index + m[0].length - 1;
      let depth = 0, close = open;
      for (; close < code.length; close++) {
        if (code[close] === "(") depth++;
        else if (code[close] === ")" && --depth === 0) break;
      }
      const arg = code.slice(open + 1, close);
      if (!DESTINATION_CHECKOUT.test(arg) || (m[1] === "existsSync" && CHECKOUT_PRESENCE.test(text.slice(open + 1, close)))) continue;
      const line = text.slice(0, m.index).split("\n").length;
      const lineText = text.split("\n")[line - 1]!.trim();
      if (ALLOWLIST.some(a => a.file === file && lineText.includes(a.text))) continue;
      found.push(`${file}:${line}: ${lineText}`);
    }
  }
  return [...new Set(found)];
}

// @source-text-subject: src/**/*.ts — the claim is that NO src file reads a plan-destination working tree, a
// property of every file including paths no single execution drives.
test("W1-T14617 criterion 5: a guard refuses any new read of the ops checkout's working tree for catalog content", () => {
  // A walk of src/: in a CI checkout, exactly the tracked src files.
  const tracked = readdirSync(join(REPO_ROOT, "src"), { recursive: true, encoding: "utf8" })
    .filter(f => f.endsWith(".ts")).map(f => `src/${f.split(sep).join("/")}`).sort();
  assert.ok(tracked.length > 100 && tracked.includes(HELPER) && tracked.includes("src/lib/feedback.ts"), "the scan sees the src files");
  const files = tracked.map(file => ({ file, text: readFileSync(join(REPO_ROOT, file), "utf8") }));
  assert.deepEqual(opsWorkingTreeReads(files), [], "every ops-catalog read goes through src/lib/ops-checkout-at-main.ts");
  for (const a of ALLOWLIST) assert.ok(files.some(f => f.file === a.file && f.text.includes(a.text)), `the allowlisted site is still there: ${a.reason}`);

  // The guard goes red on a fixture source line that adds such a read, on one line or across several.
  const fixture = (text: string) => opsWorkingTreeReads([{ file: "src/lib/fixture.ts", text }]);
  assert.equal(fixture(`const t = readFileSync(join(named.checkoutDir, "plan", "feedback", "x.yaml"), "utf8");\n`).length, 1);
  assert.equal(fixture(`if (existsSync(feedbackEntryPath(destination.checkoutDir, id))) return;\n`).length, 1);
  assert.equal(fixture(`const s = readTaskShard(\n  resolved.target.checkoutDir,\n  taskId,\n);\n`).length, 1);
  assert.equal(fixture(`const d = decisionsUnder(named.checkoutDir);\n`).length, 1);
  assert.equal(fixture(`const names = readdirSync(join(repairRepoDir, "plan", "tasks.d"));\n`).length, 1);
  // A presence check of the checkout, a comment and a string read no catalog content.
  assert.equal(fixture(`if (!existsSync(join(named.checkoutDir, ".git"))) throw e;\nif (!existsSync(destination.checkoutDir)) return;\n`).length, 0);
  assert.equal(fixture(`// readFileSync(join(named.checkoutDir, "x"))\nlog("readFileSync(named.checkoutDir)");\n`).length, 0);
  assert.equal(fixture(`const t = readFileSync(join(root, "plan", "x.yaml"), "utf8");\n`).length, 0);
  // The helper itself is the one place a working-tree read of the checkout is made (rule 2's untracked capture).
  assert.equal(opsWorkingTreeReads([{ file: HELPER, text: `readFileSync(join(named.checkoutDir, "x"));\n` }]).length, 0);
});
