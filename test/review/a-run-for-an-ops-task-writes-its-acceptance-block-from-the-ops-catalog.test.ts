import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runTask } from "#test/helpers/run-task-test.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { parseAcceptanceBlock } from "#src/lib/review.js";
import { prTitleForTask } from "#src/lib/unfinished-checkpoint.js";
// Match the maintained gate tests: scripts are outside tsconfig's typed include.
// The package alias still loads the real public gate, with no copied implementation.
const gateSpecifier = "#scripts/acceptance-author-gate.mjs";
const { evaluateGate } = await import(gateSpecifier) as {
  evaluateGate: (input: { body: string; authorLogin: string; headRefName: string;
    trailerResolves: (taskId: string) => boolean; root: string }) => { ok: boolean; message?: string };
};
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import type { WorkerResult } from "#src/lib/worker.js";

const ID = "W1-T900008", TITLE = "Publish the approved fixture contract", PRIVATE = [
  "PRIVATE_RATIONALE_12208", "PRIVATE_DESIGN_12208", "PRIVATE_FALSIFIER_12208",
  "PRIVATE_NOTE_12208", "PRIVATE_ORIGIN_12208",
];
const criteria = [{ claim: "the fixture exports its public value", proof: "grep: publicValue in src/fixture.ts" }];
function yaml() {
  return `- id: ${ID}\n  title: ${TITLE}\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: medium\n  origin: test#${PRIVATE[4]}\n  files: [src/fixture.ts]\n  rationale: ${PRIVATE[0]}\n  design: ${PRIVATE[1]}\n  falsifier: ${PRIVATE[2]}\n  note: ${PRIVATE[3]}\n  acceptance:\n    - claim: ${criteria[0]!.claim}\n      proof: "${criteria[0]!.proof}"\n`;
}
const result = (text: string): WorkerResult => ({
  sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
  isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "fixture", effort: "fixture",
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
});

async function runFixture(t: TestContext, catalog: "ops" | "public", mode: "reported" | "created" = "reported") {
  const root = gitRepo({ scope: t }), origin = gitRepo({ bare: true, scope: t }), seed = gitRepo({ scope: t });
  mkdirSync(join(seed.dir, "plan")); writeFileSync(join(seed.dir, "plan", "tasks.yaml"), catalog === "public" ? yaml() : "[]\n");
  seed.git("add", "plan"); seed.git("commit", "--quiet", "-m", "test: seed the actual public plan");
  seed.addRemote("origin", origin.dir); seed.git("push", "--quiet", "origin", "main");
  const repo = gitRepo({ cloneFrom: origin.dir, scope: t });
  repo.git("config", "user.name", "fixture"); repo.git("config", "user.email", "fixture@remudero.invalid");
  mkdirSync(join(root.dir, "repos")); const checkout = join(root.dir, "repos", "remudero"); renameSync(repo.dir, checkout);
  const planPath = join(root.dir, "tasks.yaml"); writeFileSync(planPath, catalog === "public" ? yaml() : "[]\n");
  mkdirSync(join(root.dir, "state"), { recursive: true });
  if (catalog === "ops") writeFileSync(join(root.dir, "state", "plan-destination.json"), JSON.stringify({ repository: "fixture-private/ops", kinds: [] }));
  const now = Date.now(); t.mock.method(Date, "now", () => now);
  const branch = `run-${ID}-${now}`, url = "https://github.com/craigoley/remudero/pull/7";
  const body = `Worker prose to preserve for a public task. ${PRIVATE.join(" ")}\n\nAcceptance:\n- old criterion | grep: old in src/fixture.ts\n\nRemudero-Task: ${ID}`;
  const text = yaml(), hash = (s: string) => createHash("sha1").update(s).digest("hex");
  const commit = hash(text), tree = hash(commit + "root"), plan = hash(commit + "plan"), blob = hash(`blob ${Buffer.byteLength(text)}\0${text}`);
  const base = "repos/fixture-private/ops";
  const opsRoutes: GhShimRoute[] = [
    { when: `${base}/git/ref/heads/main`, stdout: JSON.stringify({ object: { type: "commit", sha: commit } }) },
    { when: `${base}/git/commits/${commit}`, stdout: JSON.stringify({ sha: commit, tree: { sha: tree } }) },
    { when: `${base}/git/trees/${tree}`, stdout: JSON.stringify({ sha: tree, truncated: false, tree: [{ path: "plan", sha: plan, type: "tree", mode: "040000" }] }) },
    { when: `${base}/git/trees/${plan}`, stdout: JSON.stringify({ sha: plan, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] }) },
    { when: `${base}/git/blobs/${blob}`, stdout: JSON.stringify({ sha: blob, encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") }) },
    { when: base, stdout: JSON.stringify({ id: 42, full_name: "fixture-private/ops", default_branch: "main" }) },
  ];
  const gh = ghShim([
    { when: "pr merge", exit: 97, stderr: "forbidden merge effect" },
    { when: "--method DELETE", exit: 97, stderr: "forbidden delete effect" },
    ...opsRoutes,
    { when: "pulls?", stdout: "[]" },
    { when: "--method POST repos/", stdout: JSON.stringify({ html_url: url, number: 7 }) },
    { when: "--method PATCH repos/", stdout: "{}" },
    { when: "--json body", stdout: JSON.stringify({ body }) },
    { when: "pr view", stdout: JSON.stringify({ headRefName: branch, body, number: 7 }) },
    { when: "/pulls/7", stdout: JSON.stringify({ number: 7, state: "open", merged: false, head: { sha: "c".repeat(40) } }) },
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "queued" }] }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
    { when: "pr edit", stdout: "" },
  ]);
  const priorPath = process.env.PATH, priorHooks = process.env.RMD_HARNESS_HOOKS_DIR;
  process.env.PATH = `${gh.dir}:${priorPath}`; mkdirSync(join(root.dir, "hooks")); process.env.RMD_HARNESS_HOOKS_DIR = join(root.dir, "hooks");
  t.after(() => { process.env.PATH = priorPath; if (priorHooks === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR; else process.env.RMD_HARNESS_HOOKS_DIR = priorHooks; rmSync(gh.dir, { recursive: true, force: true }); });
  const prompts: Array<{ prompt: string }> = []; let workers = 0, workerRoot = "";
  const outcome = await withLiveWritesAllowed(() => runTask(ID, {
    config: { claudeBin: "/bin/true", root: root.dir, installRoot: REPO_ROOT, workerProviders: { harnessCommitsImplement: true } },
    skipGitSync: true, planPath, handOffAtPrOpen: true,
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    claimReserver: { mintAnchor: () => "fixture-claim", attempt: () => "created", holder: () => undefined, drop: () => true },
    containmentExec: async token => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    readHeadShaForProvenance: () => "c".repeat(40), preopenGate: async () => ({ kind: "pass", durationMs: 1 }),
    spawn: async args => {
      if (++workers === 1) return result("RECON REPORT\nOBSERVED: fixture\n");
      workerRoot = args.cwd; prompts.push({ prompt: args.prompt });
      mkdirSync(join(args.cwd, "src"), { recursive: true }); writeFileSync(join(args.cwd, "src", "fixture.ts"), "export const publicValue = true;\n");
      return result(`REPORT\nCOMMIT_MESSAGE: feat(test): implement public fixture\n${mode === "reported" ? `PR_URL: ${url}\n` : ""}`);
    },
  }));
  const calls = gh.events().filter(e => e.phase === "start").map(e => e.args);
  assert.equal(outcome.verdict, "handed_off", JSON.stringify({ outcome, ledger: readFileSync(join(root.dir, "state", "ledger.ndjson"), "utf8") })); assert.equal(outcome.prUrl, url);
  assert.ok(prompts.length > 0, "actual run verb reached its implement worker");
  assert.equal(calls.some(a => a.includes("merge") || a.includes("DELETE")), false, "no actual merge or delete may occur");
  // The shared lifecycle helper splits joined argv at spaces/newlines; read its paired raw records for multi-line bodies.
  const trace = readFileSync(join(gh.dir, "events.log"), "utf8");
  const starts = [...trace.matchAll(/^start\t(\d+)\t([\s\S]*?)^end\t\1\t/gm)].map(m => m[2]!.replace(/\n$/, ""));
  assert.equal(starts.length, calls.length, "each physical invocation has a paired raw record");
  const publicWrites = starts.filter(a => /^api (?:-X|--method) (?:POST|PATCH) repos\/[^ ]+\/pulls(?:\/\d+)?(?: |$)/.test(a));
  const bodies = publicWrites.filter(a => a.includes(" -f body=")).map(a => a.slice(a.indexOf(" -f body=") + 9));
  const titles = publicWrites.flatMap(a => {
    const title = / -f title=([\s\S]*?)(?: -f body=|$)/.exec(a); return title ? [title[1]!] : [];
  });
  const rows = readFileSync(join(root.dir, "state", "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { outcome, bodies, titles, prompts, calls, rows, workerRoot, branch,
    sourceReads: calls.filter(a => a.some(x => x.startsWith(base))),
    sourceReadCount: () => gh.events().filter(e => e.phase === "start" && e.args.some(x => x.startsWith(base))).length };
}

test("W1-T12208 criterion 1: the real ops reader supplies the canonical acceptance to the real run verb", async t => {
  const f = await runFixture(t, "ops"); assert.ok(f.sourceReads.length >= 6, "default pinned reader actually ran");
  assert.ok(f.bodies.length > 0, "harness actually wrote a public body"); assert.deepEqual(parseAcceptanceBlock(f.bodies.at(-1)!), criteria);
});
test("W1-T12208 criterion 2: reported and harness-created public PR writes whitelist title and criteria on every write", async t => {
  for (const mode of ["reported", "created"] as const) await t.test(mode, async t => {
    const f = await runFixture(t, "ops", mode); assert.ok(f.bodies.length > 0 && f.titles.length > 0);
    for (const value of [...f.bodies, ...f.titles]) for (const marker of PRIVATE) assert.equal(value.includes(marker), false, marker);
    const expectedTitle = prTitleForTask([], { id: ID, title: TITLE });
    assert.ok(f.titles.every(x => x === expectedTitle), "the existing conventional-title contract is preserved");
    assert.ok(f.bodies.every(x => x.includes(TITLE) && parseAcceptanceBlock(x).length > 0));
  });
});
test("W1-T12208 criterion 3: the implement prompt and compaction anchor retain the ops publication restriction", async t => {
  const f = await runFixture(t, "ops"); const p = f.prompts[0]!;
  assert.match(p.prompt, /only.*title.*acceptance criteria/i); assert.match(p.prompt, /commit.*pull request.*comment/i);
  const anchor = f.rows.find(row => row.step === "anchor.built"); assert.ok(anchor, "actual host anchor was recorded");
  assert.match(String(anchor.anchor), /only.*title.*acceptance criteria/i);
});
test("W1-T12208 criterion 4: the published body parses publicly without another private catalog read", async t => {
  const f = await runFixture(t, "ops"), before = f.sourceReadCount(); assert.ok(before >= 6 && f.bodies.length);
  const body = f.bodies.at(-1)!;
  assert.deepEqual(parseAcceptanceBlock(body), criteria);
  const gate = evaluateGate({ body, authorLogin: "fixture-human", headRefName: f.branch,
    trailerResolves: () => false, root: f.workerRoot });
  assert.equal(gate.ok, true, JSON.stringify(gate));
  const malformed = evaluateGate({ body: body.replace("Acceptance:", "Missing block:"), authorLogin: "fixture-human",
    headRefName: f.branch, trailerResolves: () => false, root: f.workerRoot });
  assert.equal(malformed.ok, false, "a claimed trailer cannot hide a missing block when no public task resolves");
  assert.equal(f.sourceReadCount(), before, "fresh lifecycle query saw no additional private repository read");
});
test("W1-T12208 criterion 5: public-only runs preserve their worker prose and use no private catalog", async t => {
  const f = await runFixture(t, "public"); assert.equal(f.sourceReads.length, 0); assert.ok(f.bodies.length);
  assert.ok(f.bodies.at(-1)!.includes("Worker prose to preserve for a public task."), JSON.stringify({ bodies: f.bodies, titles: f.titles, calls: f.calls }));
  assert.deepEqual(parseAcceptanceBlock(f.bodies.at(-1)!), criteria); assert.equal(f.calls.some(a => a[0] === "pr" && a.includes("--title")), false);
});
