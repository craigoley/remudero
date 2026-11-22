import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { planDestinationPath, resolvePlanDestinationForTarget } from "#src/lib/plan-destination.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14320. The host file names a plan destination with the `task` kind on. The instance's own repository is
// the one this checkout's origin names (craigoley/remudero); the product is another repository on the host.
const ID = "fb-product-target";
const REL = `plan/feedback/${ID}.yaml`;
const NEW_TASK = "plan/tasks.d/W1-T5-a-new-filing.yaml";
const OPS = "fixture/remudero-ops";
const OWN = "craigoley/remudero";
const PRODUCT_OWNER = "fixture-owner";
const PRODUCT_NAME = "fixture-product";
const PRODUCT = `${PRODUCT_OWNER}/${PRODUCT_NAME}`;

type Repository = "own" | "ops" | "product";
interface Observed { cwdOrigin?: string; prompt?: string }

function fixture(t: TestContext) {
  const root = ownedFixtureDir(t, "product-plan-target").dir;
  const home = join(root, "home");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, installRoot: REPO_ROOT, claudeBin: "/usr/bin/true" }));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(planDestinationPath(join(root, "state")), JSON.stringify({ repository: OPS, kinds: ["task"] }));
  // Each repository is a bare origin seeded with a plan. The ops repository holds no feedback entry.
  const origins = {} as Record<Repository, GitRepo>;
  for (const name of ["own", "ops", "product"] as const) {
    const origin = gitRepo({ bare: true, scope: t });
    const seed = gitRepo({ scope: t });
    mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "- id: W1-T4\n  title: seed\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n");
    if (name !== "ops") {
      mkdirSync(join(seed.dir, "plan", "feedback"), { recursive: true });
      writeFileSync(join(seed.dir, REL), `id: ${ID}\nts: '2026-11-14T00:00:00.000Z'\nraw: file a task for the fixture\nattachments: []\norigin: human\nstatus: new\nproposal_pr: null\n`);
    }
    writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# fixture\n");
    seed.git("add", "-A"); seed.git("commit", "--quiet", "-m", "chore: seed the repository");
    seed.addRemote("origin", origin.dir); seed.git("push", "--quiet", "origin", "main");
    origins[name] = origin;
  }
  mkdirSync(join(root, "repos"), { recursive: true });
  const checkouts: Array<[Repository, string]> = [["own", "remudero"], ["ops", "remudero-ops"], ["product", PRODUCT_NAME]];
  for (const [name, dir] of checkouts) {
    const clone = gitRepo({ cloneFrom: origins[name].dir, scope: t });
    clone.git("config", "user.name", "remudero fixture");
    clone.git("config", "user.email", "fixture@remudero.invalid");
    clone.git("worktree", "add", "--detach", join(root, "repos", dir), "main");
  }
  // The product's root, as the product hand-off passes it with --repo-root: its origin names the product.
  const product = gitRepo({ scope: t });
  const productRoot = product.dir;
  mkdirSync(join(productRoot, ".remudero"), { recursive: true });
  copyFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), join(productRoot, ".remudero", "mounts.yaml"));
  product.addRemote("origin", `https://github.com/${PRODUCT}.git`);

  const shim = ghShim([{ when: "pr list", stdout: "[]" }, { when: "pulls?", stdout: "[]" }, { when: "issue list", stdout: "[]" },
    { when: "pr create", stdout: `https://github.com/${OWN}/pull/7` }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const sides: Array<{ name: Repository; repository: string; number: number }> =
    [{ name: "own", repository: OWN, number: 2 }, { name: "ops", repository: OPS, number: 1 }, { name: "product", repository: PRODUCT, number: 3 }];
  for (const side of sides) {
    const info = join(root, `pr-${side.number}.json`);
    const view = join(root, `head-${side.number}.json`);
    const q = (path: string) => "'" + path.replaceAll("'", "'\"'\"'") + "'";
    writeFileSync(join(origins[side.name].dir, "hooks", "post-receive"), ["#!/bin/sh", "while read old new ref; do",
      'case "$ref" in refs/heads/run-*)', 'b="${ref#refs/heads/}"',
      `printf '{"number":${side.number},"head":{"sha":"%s","ref":"%s"},"base":{"ref":"main"},"state":"open"}\\n' "$new" "$b" > ${q(info)}`,
      `printf '{"headRefName":"%s"}\\n' "$b" > ${q(view)} ;;`, "esac", "done", ""].join("\n"), { mode: 0o700 });
    const url = `https://github.com/${side.repository}/pull/${side.number}`;
    shim.addRoute({ when: `api --method POST repos/${side.repository}/pulls`, stdout: JSON.stringify({ html_url: url, number: side.number }) });
    shim.addRoute({ when: `${side.repository}/pull/${side.number} --json headRefName`, stdoutFile: view });
    shim.addRoute({ when: `repos/${side.repository}/pulls/${side.number}`, stdoutFile: info });
  }
  const diffFile = join(root, "pr-diff.txt");
  shim.addRoute({ when: "pr diff", stdoutFile: diffFile });
  // A terminal-red CI answer stops each command before any review or merge.
  shim.addRoute({ when: "/check-runs", stdout: JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: "ci-gate", status: "completed", conclusion: "failure" }] }) });
  shim.addRoute({ when: "/statuses", stdout: "[]" });
  shim.addRoute({ when: "/status", stdout: '{"statuses":[]}' });
  shim.addRoute({ when: "/actions/runs", stdout: '{"workflow_runs":[]}' });
  shim.addRoute({ when: "required_status_checks", stdout: '{"contexts":["ci-gate"],"checks":[]}' });

  const observedPath = join(root, "observed.json");
  const outcomePath = join(root, "outcome.json");
  const loader = join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
  assert.ok(existsSync(loader), "the installed child loader is present");
  // The commands read the process-global HOME config and the import-time --repo-root, so each one runs in its own
  // Node process. Git and the id reservations are real. Only the paid worker and gh are fixtures.
  const child = String.raw`
    import {writeFileSync,mkdirSync} from "node:fs";
    import {join} from "node:path";
    import {execFileSync} from "node:child_process";
    import {planCommand,triageCommand} from "#test/helpers/run-task-test.js";
    import {withLiveWritesAllowed} from "#src/lib/live-write-guard.js";
    const {root,REPO_ROOT,ID,NEW_TASK,diffFile,observedPath,outcomePath,command}=JSON.parse(process.env.PRODUCT_CASE);
    const observed={};
    const task=(origin)=>["- id: W1-T5","  title: a new filing","  repo: remudero","  origin: "+origin,"  depends_on: []","  type: implement",
      "  verify: auto","  status: queued","  attempts: 0","  files: [test/fixture.test.ts]","  acceptance:","    - claim: fixture",
      "      proof: 'unit test: fixture'",""].join("\n");
    const result=(text)=>({sessionId:"fixture",costUsd:0,text,blocks:[text],stderr:"",subtype:"success",isError:false,apiError:false,
      numTurns:1,model:"fixture",effort:"high",tokens:{input:0,output:0,cacheRead:0,cacheCreation:0},totalCostUsd:0,
      billingMode:"subscription",verdict:"success",qualitySuspect:false,compactionEvents:[],childEnvKeys:[]});
    const spawn=async(args)=>{
      if((args.tools??[]).length===0)return result("{}");
      observed.prompt=args.prompt;
      observed.cwdOrigin=execFileSync("git",["remote","get-url","origin"],{cwd:args.cwd,encoding:"utf8"}).trim();
      mkdirSync(join(args.cwd,"plan","tasks.d"),{recursive:true});
      writeFileSync(join(args.cwd,NEW_TASK),task(command==="triage"?"feedback#"+ID:"architect"));
      writeFileSync(diffFile,["diff --git a/"+NEW_TASK+" b/"+NEW_TASK,"new file mode 100644","--- /dev/null","+++ b/"+NEW_TASK,
        "@@ -0,0 +1,2 @@","+- id: W1-T5","+  origin: feedback#"+ID,""].join("\n"));
      return result(command==="triage"?"PROPOSED: file W1-T5 for the feedback":"PROPOSED: file W1-T5 for the fixture");
    };
    let outcome;
    try{
      const config={root,installRoot:REPO_ROOT,claudeBin:"/usr/bin/true"};
      const lintPlanForReviewFn=async()=>({ran:true,label:"fixture",checked:1,violations:[]});
      const code=await withLiveWritesAllowed(()=>command==="triage"
        ?triageCommand([ID],{config,lintPlanForReviewFn,spawn})
        :planCommand(["--mode=create","a fixture task"],{config,lintPlanForReviewFn,spawn,
          plannerHostGitCredential:async()=>({kind:"ambient",registryPath:join(root,"absent.yaml")}),
          openPlannerGitCredential:async()=>({ok:true,lane:{wire:()=>undefined,retire:()=>{},close:async()=>{}}})}));
      outcome={code};
    }catch(error){outcome={error:String(error?.stack??error)};}
    writeFileSync(observedPath,JSON.stringify(observed));
    writeFileSync(outcomePath,JSON.stringify(outcome));
  `;
  const saved = process.env.PATH;
  /** Run one command. `target: "product"` passes the product's root with --repo-root, as the product hand-off does. */
  const run = (command: "plan" | "triage", target: "own" | "product"): { code?: number; error?: string; observed: Observed } => {
    const repoRootArgs = target === "product" ? ["--repo-root", productRoot] : [];
    try {
      execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", child, command, ...repoRootArgs], {
        cwd: REPO_ROOT, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: home, PATH: `${shim.dir}:${saved}`, PRODUCT_CASE: JSON.stringify({ root, REPO_ROOT, ID, NEW_TASK,
          diffFile, observedPath, outcomePath, command }) },
      });
    } catch (error) { return { error: String(error), observed: {} }; }
    return { ...JSON.parse(readFileSync(outcomePath, "utf8")), observed: JSON.parse(readFileSync(observedPath, "utf8")) };
  };
  const runBranches = (name: Repository, lane: string) =>
    origins[name].git("for-each-ref", "--format=%(refname:short)", `refs/heads/run-${lane}-*`).trim().split("\n").filter(Boolean);
  const changed = (name: Repository, branch: string) => origins[name].git("diff", "--name-only", "main", branch).trim().split("\n").filter(Boolean);
  const idRefs = (name: Repository) => origins[name].git("for-each-ref", "--format=%(refname)", "refs/rmd-id/").trim();
  const posts = (repository: string) => shim.calls().filter((call) => call.includes(`api --method POST repos/${repository}/pulls`)).length;
  const ledger = () => existsSync(join(root, "state", "ledger.ndjson")) ? readFileSync(join(root, "state", "ledger.ndjson"), "utf8") : "";
  return { root, origins, run, runBranches, changed, idRefs, posts, ledger };
}

test("W1-T14320 criterion 1: with the task kind on, rmd plan against another repository's root cuts its lane and opens its pull request in that repository", (t) => {
  const f = fixture(t);
  const result = f.run("plan", "product");
  assert.equal(result.error, undefined, f.ledger());
  assert.equal(result.code, 1, "the fixture's red CI stops the command before review");
  assert.equal(result.observed.cwdOrigin, f.origins.product.dir, "the worker's lane is a worktree of the product's checkout");
  assert.ok(!String(result.observed.prompt).includes("plan destination"), "the worker gets no read-only public view");
  const [branch] = f.runBranches("product", "PLAN");
  assert.ok(branch, f.ledger());
  assert.deepEqual(f.changed("product", branch), [NEW_TASK]);
  assert.equal(f.posts(PRODUCT), 1, "the pull request is opened in the product's repository");
  assert.equal(f.posts(OPS), 0, "no pull request is opened in the plan destination");
  assert.deepEqual(f.runBranches("ops", "PLAN"), [], "nothing is pushed to the plan destination");
  assert.equal(f.idRefs("product"), "refs/rmd-id/W1-T5", "the id is reserved in the product's repository");
  assert.equal(f.idRefs("ops"), "", "no id is reserved in the plan destination");
  assert.equal(f.idRefs("own"), "", "no id is reserved in the instance's own repository");
});

test("W1-T14320 criterion 2: invariant:destination-is-for-own-plans — with the task kind on, the instance's own plan and triage still file in the destination, and nothing for another target does", (t) => {
  // The resolver: the destination for the instance's own repository, the target itself for any other.
  const stateDir = join(ownedFixtureDir(t, "product-plan-resolver").dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(planDestinationPath(stateDir), JSON.stringify({ repository: OPS, kinds: ["task"] }));
  const own = { owner: "Craigoley", repo: "Remudero" };
  const ownTarget = { owner: "craigoley", repo: "remudero", checkoutDir: "/fixture/own" };
  const productTarget = { owner: PRODUCT_OWNER, repo: PRODUCT_NAME, checkoutDir: "/fixture/product" };
  assert.equal(resolvePlanDestinationForTarget("task", stateDir, ownTarget, () => own).outcome, "destination",
    "the instance's own repository, named in another case, still files in the destination");
  assert.deepEqual(resolvePlanDestinationForTarget("task", stateDir, productTarget, () => own), { outcome: "another_repository", ...productTarget });
  // Another repository with the switch off, or with a kind not listed, reads no own repository at all.
  const unread = () => { throw new Error("the own repository is read only when the destination would apply"); };
  assert.equal(resolvePlanDestinationForTarget("decision", stateDir, productTarget, unread).outcome, "not_listed");
  assert.equal(resolvePlanDestinationForTarget("task", undefined, productTarget, unread).outcome, "off");
  // An own repository that cannot be read is refused, never guessed into either repository.
  const refused = resolvePlanDestinationForTarget("task", stateDir, ownTarget, unread);
  assert.equal(refused.outcome, "unreadable");
  // A host file that is unreadable does not stop a plan for another repository: it is filed as with no host file.
  writeFileSync(planDestinationPath(stateDir), "{");
  assert.deepEqual(resolvePlanDestinationForTarget("task", stateDir, productTarget, () => own), { outcome: "another_repository", ...productTarget });
  assert.equal(resolvePlanDestinationForTarget("task", stateDir, ownTarget, () => own).outcome, "unreadable");

  // The commands: the instance's own plan and triage go to the destination; plan and triage for the product do not.
  const f = fixture(t);
  for (const command of ["plan", "triage"] as const) {
    const lane = command === "plan" ? "PLAN" : "TRIAGE";
    const ownRun = f.run(command, "own");
    assert.equal(ownRun.error, undefined, f.ledger());
    assert.equal(ownRun.observed.cwdOrigin, f.origins.ops.dir, `the instance's own ${command} is cut in the destination`);
    const [opsBranch] = f.runBranches("ops", lane);
    assert.ok(opsBranch, f.ledger());
    assert.deepEqual(f.changed("ops", opsBranch), [NEW_TASK]);
    assert.deepEqual(f.runBranches("own", lane), [], `the instance's own ${command} files nothing in the public repository`);

    const productRun = f.run(command, "product");
    assert.equal(productRun.error, undefined, f.ledger());
    assert.equal(productRun.observed.cwdOrigin, f.origins.product.dir, `the product's ${command} is cut in the product's repository`);
    assert.deepEqual(f.runBranches("ops", lane), [opsBranch], `the product's ${command} adds nothing to the destination`);
    const [productBranch] = f.runBranches("product", lane);
    assert.ok(productBranch, f.ledger());
    assert.ok(f.changed("product", productBranch).includes(NEW_TASK));
  }
  assert.equal(f.posts(OPS), 2, "the destination has the own plan's and the own triage's pull requests, and no other");
  assert.equal(f.posts(PRODUCT), 2);
  assert.equal(f.posts(OWN), 0);
});
