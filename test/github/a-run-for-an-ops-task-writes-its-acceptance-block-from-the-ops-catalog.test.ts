import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runTask, runTaskBody, ghPrCreateFillCommand } from "#test/helpers/run-task-test.js";
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
import type { AcceptanceCriterion } from "#src/lib/plan.js";
import { bindCanonicalOpsCriteria, openPullRequestCheckedAsync, PrOpenRefusedError, type CanonicalOpsCriteriaAtOpen, type AsyncOpenPullRequestProofRunner } from "#src/lib/pr-open.js";

const ID = "W1-T900008", TITLE = "Publish the approved fixture contract", PRIVATE = [
  "PRIVATE_RATIONALE_12208", "PRIVATE_DESIGN_12208", "PRIVATE_FALSIFIER_12208",
  "PRIVATE_NOTE_12208", "PRIVATE_ORIGIN_12208",
];
const criteria = [{ claim: "the fixture exports its public value", proof: "grep: publicValue in src/fixture.ts" }];
function yaml(acceptance: readonly AcceptanceCriterion[] = criteria) {
  const records = acceptance.map(c => `    - claim: ${JSON.stringify(c.claim)}\n      proof: ${JSON.stringify(c.proof)}${c.satisfied_by ? `\n      satisfied_by: ${JSON.stringify(c.satisfied_by)}` : ""}`).join("\n");
  return `- id: ${ID}\n  title: ${TITLE}\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  risk: medium\n  origin: test#${PRIVATE[4]}\n  files: [src/fixture.ts]\n  rationale: ${PRIVATE[0]}\n  design: ${PRIVATE[1]}\n  falsifier: ${PRIVATE[2]}\n  note: ${PRIVATE[3]}\n  acceptance:\n${records}\n`;
}
const result = (text: string): WorkerResult => ({
  sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
  isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "fixture", effort: "fixture",
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
});

async function runFixture(t: TestContext, catalog: "ops" | "public", mode: "reported" | "created" = "reported", acceptance: readonly AcceptanceCriterion[] = criteria, refusal?: "ownership" | "normalization") {
  const root = gitRepo({ scope: t }), origin = gitRepo({ bare: true, scope: t }), seed = gitRepo({ scope: t });
  mkdirSync(join(seed.dir, "plan")); writeFileSync(join(seed.dir, "plan", "tasks.yaml"), catalog === "public" ? yaml(acceptance) : "[]\n");
  seed.git("add", "plan"); seed.git("commit", "--quiet", "-m", "test: seed the actual public plan");
  seed.addRemote("origin", origin.dir); seed.git("push", "--quiet", "origin", "main");
  const repo = gitRepo({ cloneFrom: origin.dir, scope: t });
  repo.git("config", "user.name", "fixture"); repo.git("config", "user.email", "fixture@remudero.invalid");
  mkdirSync(join(root.dir, "repos")); const checkout = join(root.dir, "repos", "remudero"); renameSync(repo.dir, checkout);
  const planPath = join(root.dir, "tasks.yaml"); writeFileSync(planPath, catalog === "public" ? yaml(acceptance) : "[]\n");
  mkdirSync(join(root.dir, "state"), { recursive: true });
  if (catalog === "ops") writeFileSync(join(root.dir, "state", "plan-destination.json"), JSON.stringify({ repository: "fixture-private/ops", kinds: [] }));
  const now = Date.now(); t.mock.method(Date, "now", () => now);
  const branch = `run-${ID}-${now}`, url = "https://github.com/craigoley/remudero/pull/7";
  const body = `Worker prose to preserve for a public task. ${PRIVATE.join(" ")}\n\nAcceptance:\n- old criterion | grep: old in src/fixture.ts\n\nRemudero-Task: ${ID}`;
  const text = yaml(acceptance), hash = (s: string) => createHash("sha1").update(s).digest("hex");
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
    { when: "PATCH repos/", stdout: "{}", exit: refusal === "normalization" ? 1 : 0, stderr: refusal === "normalization" ? "fixture normalization refused" : "" },
    { when: "--json body", stdout: JSON.stringify({ body }) },
    { when: "pr view", stdout: JSON.stringify({ headRefName: refusal === "ownership" ? "run-W1-T900009-other" : branch, body, number: 7 }) },
    { when: "/pulls/7", stdout: JSON.stringify({ number: 7, state: "open", merged: false, head: { sha: "c".repeat(40) } }) },
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "queued" }] }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
    { when: "pr edit", stdout: "" },
  ]);
  const priorPath = process.env.PATH, priorHooks = process.env.RMD_HARNESS_HOOKS_DIR;
  process.env.PATH = `${gh.dir}:${priorPath}`; mkdirSync(join(root.dir, "hooks")); process.env.RMD_HARNESS_HOOKS_DIR = join(root.dir, "hooks");
  t.after(() => {
    try {
      if (refusal !== undefined) {
        const writes = gh.events().filter(event => event.phase === "start" && event.args[0] === "api"
          && event.args.some(arg => ["POST", "PATCH", "PUT", "DELETE"].includes(arg)));
        assert.equal(writes.some(event => event.args.includes("POST") || event.args.includes("DELETE")), false);
        assert.equal(writes.length, refusal === "ownership" ? 0 : 1);
      }
    } finally {
      process.env.PATH = priorPath;
      if (priorHooks === undefined) delete process.env.RMD_HARNESS_HOOKS_DIR; else process.env.RMD_HARNESS_HOOKS_DIR = priorHooks;
      rmSync(gh.dir, { recursive: true, force: true });
    }
  });
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
  return { outcome, bodies, titles, prompts, calls, rows, workerRoot, branch, originDir: origin.dir, publicWrites,
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

test("an ops run retains prior credit as context and proves only the remaining criterion", async t => {
  const acceptance = [{ claim: "already credited fixture behavior", proof: "grep: neverRunThisProof in src/missing.ts", satisfied_by: "PR-1" }, ...criteria];
  const f = await runFixture(t, "ops", "created", acceptance);
  assert.deepEqual(parseAcceptanceBlock(f.bodies.at(-1)!), criteria);
  assert.match(f.bodies.at(-1)!, /Prior acceptance credit/); assert.match(f.bodies.at(-1)!, /already credited fixture behavior/);
});

function openerFixture(t: TestContext, publicTask = false) {
  const repo = gitRepo({ scope: t }); mkdirSync(join(repo.dir, "plan"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), publicTask ? yaml() : "[]\n");
  repo.git("add", "plan"); repo.git("commit", "--quiet", "-m", "test: bind the canonical opener base");
  const base = repo.git("rev-parse", "HEAD").trim(); repo.git("update-ref", "refs/remotes/origin/main", base);
  mkdirSync(join(repo.dir, "src"), { recursive: true }); writeFileSync(join(repo.dir, "src", "fixture.ts"), "export const publicValue = true;\n");
  repo.git("add", "src"); repo.git("commit", "--quiet", "-m", "feat(test): satisfy the fixture proof");
  const target = { owner: "craigoley", repo: "remudero" }, branch = `run-${ID}-123456`;
  const body = `${TITLE}\n\nAcceptance:\n- ${criteria[0]!.claim} | ${criteria[0]!.proof}\n\nRemudero-Task: ${ID}`;
  const canonical: CanonicalOpsCriteriaAtOpen = { catalog: "ops", taskId: ID, title: TITLE,
    targetRepository: "craigoley/remudero", sourceCommit: base, criteria: criteria.map(c => ({ ...c })) };
  const open = (contract: CanonicalOpsCriteriaAtOpen | undefined, runner: AsyncOpenPullRequestProofRunner,
    input = body) => openPullRequestCheckedAsync(input, branch, repo.dir, "origin/main", runner, target, contract);
  return { repo, base, branch, target, body, canonical, open };
}

test("the canonical ops opener runs the same merge-base proof before accepting a private task", async t => {
  const f = openerFixture(t); const runs: string[] = [];
  const body = await f.open(f.canonical, async (proof, base, root, target) => {
    runs.push(proof); assert.equal(base, f.base); assert.equal(root, f.repo.dir); assert.deepEqual(target, f.target); return { status: 0 };
  });
  assert.equal(body, f.body); assert.deepEqual(runs, [criteria[0]!.proof]);
});
test("missing or wrongly bound canonical ops evidence cannot authorize the opener", async t => {
  const f = openerFixture(t); let calls = 0; const runner: AsyncOpenPullRequestProofRunner = async () => { calls++; return { status: 0 }; };
  for (const contract of [undefined, { ...f.canonical, taskId: "W1-T900009" }, { ...f.canonical, sourceCommit: "not-a-pin" },
    { ...f.canonical, targetRepository: "different/public" }, { ...f.canonical, criteria: [] },
    { ...f.canonical, catalog: "public" as "ops" }]) await assert.rejects(f.open(contract, runner), PrOpenRefusedError);
  await assert.rejects(openPullRequestCheckedAsync(f.body, f.branch, f.repo.dir, "origin/main", runner, undefined, f.canonical), PrOpenRefusedError);
  assert.equal(calls, 0, "unbound criteria never reach proof execution or a publication transport");
});
test("a body cannot replace canonical ops criteria or the run-branch trailer", async t => {
  const f = openerFixture(t); let calls = 0; const runner: AsyncOpenPullRequestProofRunner = async (proof, base) => { calls++; assert.equal(proof, criteria[0]!.proof); assert.equal(base, f.base); return { status: 0 }; };
  await assert.rejects(f.open(f.canonical, runner, f.body.replace(criteria[0]!.claim, "body-authored contract")), /does not match/);
  await assert.rejects(f.open(f.canonical, runner, f.body.replace(`Remudero-Task: ${ID}`, "Remudero-Task: W1-T900009")), /trailer names/);
  assert.equal(calls, 2, "the unchanged async API pre-runs canonical proofs before synchronous body validation");
});
test("failed and stale ops proofs keep their normal pre-open refusals", async t => {
  const f = openerFixture(t);
  for (const status of [1, 5]) await assert.rejects(f.open(f.canonical, async () => ({ status })), error => {
    assert.ok(error instanceof PrOpenRefusedError); assert.equal(error.refusalClass, status === 5 ? "stale-proof" : "branch-gap"); return true;
  });
});
test("inconclusive ops proofs remain inconclusive after only the maintained retry", async t => {
  const f = openerFixture(t); let calls = 0;
  await assert.rejects(f.open(f.canonical, async () => { calls++; return { status: 4 }; }), error => {
    assert.ok(error instanceof PrOpenRefusedError); assert.equal(error.inconclusiveProof?.attempts, 2); return true;
  });
  assert.equal(calls, 2);
});
test("the private criteria snapshot survives mutation while a proof is awaited", async t => {
  const f = openerFixture(t), mutable = criteria.map(c => ({ ...c }));
  const input = { ...f.canonical, criteria: mutable };
  const body = await f.open(input, async () => {
    mutable[0]!.claim = "changed during the proof"; mutable.push({ claim: "new late criterion", proof: "grep: late in src/fixture.ts" });
    input.taskId = "W1-T900009"; input.sourceCommit = "changed-after-start"; input.targetRepository = "changed/public";
    await Promise.resolve(); return { status: 0 };
  });
  assert.equal(body, f.body); assert.deepEqual(parseAcceptanceBlock(body), criteria);
});
test("a real public filed task keeps precedence over an ops criteria argument", async t => {
  const f = openerFixture(t, true);
  const body = await f.open({ ...f.canonical, sourceCommit: "not-a-pin", criteria: [{ claim: "ops must not replace public", proof: "grep: other in src/fixture.ts" }] },
    async proof => { assert.equal(proof, criteria[0]!.proof); return { status: 0 }; });
  assert.equal(body, f.body);
});
test("canonical ops criteria carrying prior credit retain the existing all-credited refusal", async t => {
  const f = openerFixture(t); let calls = 0;
  await assert.rejects(f.open({ ...f.canonical, criteria: [{ ...criteria[0]!, satisfied_by: "PR-1" }] }, async () => { calls++; return { status: 0 }; }), error => {
    assert.ok(error instanceof PrOpenRefusedError); assert.equal(error.refusalClass, "all-credited"); return true;
  });
  assert.equal(calls, 0);
});

test("the public opener retains the same proof pre-run before body and trailer refusals", async t => {
  const f = openerFixture(t, true); let calls = 0;
  const proof: AsyncOpenPullRequestProofRunner = async (given, base) => { calls++; assert.equal(given, criteria[0]!.proof); assert.equal(base, f.base); return { status: 0 }; };
  await assert.rejects(f.open(undefined, proof, f.body.replace(criteria[0]!.claim, "body-authored contract")), /does not match/);
  await assert.rejects(f.open(undefined, proof, f.body.replace(`Remudero-Task: ${ID}`, "Remudero-Task: W1-T900009")), /trailer names/);
  assert.equal(calls, 2);
});

test("a harness-created public task keeps the existing checked builder's exact body", async t => {
  const f = await runFixture(t, "public", "created"); assert.equal(f.sourceReads.length, 0);
  assert.equal(f.publicWrites.filter(write => /^api (?:-X|--method) POST /.test(write)).length, 1);
  const clone = gitRepo({ cloneFrom: f.originDir, scope: t }); clone.git("checkout", "--quiet", f.branch);
  let proofs = 0;
  const command = withLiveWritesAllowed(() => ghPrCreateFillCommand(clone.dir, "craigoley", "remudero", f.branch,
    f.titles[0], undefined, proof => { proofs++; assert.equal(proof, criteria[0]!.proof); return { status: 0 }; }));
  const index = command.args.findIndex(arg => arg.startsWith("body=")); assert.ok(index >= 0); assert.equal(proofs, 1);
  const raw = f.publicWrites.find(write => /^api (?:-X|--method) POST /.test(write)); assert.ok(raw);
  assert.equal(raw, command.args.join(" "), "the complete actual create invocation matches the unchanged checked builder");
  // This is the controlled command's known field position, not an arbitrary joined-argv decoder.
  const prefix = command.args.slice(0, index).join(" ") + " body=";
  const suffix = index + 1 < command.args.length ? " " + command.args.slice(index + 1).join(" ") : "";
  assert.ok(raw.startsWith(prefix) && raw.endsWith(suffix));
  assert.equal(raw.slice(prefix.length, suffix ? raw.length - suffix.length : raw.length), command.args[index]!.slice("body=".length));
  assert.equal(f.sourceReadCount(), 0, "the public create and comparison read no private catalog");
});

test("the canonical ops constructor refuses missing provenance and malformed criteria", () => {
  for (const pin of [undefined, "not-a-pin"]) assert.throws(() => bindCanonicalOpsCriteria(ID, TITLE, "craigoley/remudero", pin, criteria), PrOpenRefusedError);
  assert.throws(() => bindCanonicalOpsCriteria(ID, TITLE, "craigoley/remudero", "b".repeat(40), undefined as unknown as readonly AcceptanceCriterion[]), PrOpenRefusedError);
  const mutable = criteria.map(criterion => ({ ...criterion }));
  const pinned = bindCanonicalOpsCriteria(ID, TITLE, "craigoley/remudero", "b".repeat(40), mutable);
  mutable[0]!.claim = "changed later";
  assert.ok(Object.isFrozen(pinned) && Object.isFrozen(pinned.criteria) && Object.isFrozen(pinned.criteria[0]));
  assert.deepEqual(pinned.criteria, criteria);
});

test("a direct ops run body without a canonical publication binding refuses before effects", async () => {
  await assert.rejects(runTaskBody({ task: { catalog: "ops" } } as unknown as Parameters<typeof runTaskBody>[0]),
    /ops run has no canonical publication binding/);
});

test("a reported ops PR with a different owning branch refuses before a public write", async t => {
  await assert.rejects(runFixture(t, "ops", "reported", criteria, "ownership"), /ops public PR ownership refused/);
});
test("a refused ops body normalization ends the real run before another public publication", async t => {
  await assert.rejects(runFixture(t, "ops", "reported", criteria, "normalization"), /ops public PR normalization refused/);
});
