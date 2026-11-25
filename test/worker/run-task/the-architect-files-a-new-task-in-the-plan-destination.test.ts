import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LANDING_BRANCH } from "#src/lib/feedback-landing.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ID = "fb-architect-destination";
const REL = `plan/feedback/${ID}.yaml`;
const NEW_TASK = "plan/tasks.d/W1-T5-a-new-filing.yaml";
const PUBLIC_TASK = "plan/tasks.d/W1-T3-a-public-task.yaml";
const SOURCE = "src/fixture-source.ts";
const SOURCE_MARK = "the public source the worker reads";
const OPS = "fixture/remudero-ops";

type Worker = "new" | "both" | "bypass";
interface Observed { cwdOrigin?: string; viewSource?: string; viewReadOnly?: boolean; prompt?: string }

function publicTask(extra = ""): string {
  return ["- id: W1-T3", "  title: a public task", "  repo: remudero", "  depends_on: []", "  type: implement",
    "  verify: auto", "  status: queued", "  attempts: 0", extra].filter(Boolean).join("\n") + "\n";
}

function fixture(t: TestContext, kinds: string[] | undefined, privateFeedback = false) {
  const root = ownedFixtureDir(t, "architect-destination").dir;
  const home = join(root, "home");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, installRoot: REPO_ROOT, claudeBin: "/usr/bin/true" }));
  mkdirSync(join(root, "state"), { recursive: true });
  if (kinds !== undefined) writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify({ repository: OPS, kinds }));
  const publicOrigin = gitRepo({ bare: true, scope: t });
  const opsOrigin = gitRepo({ bare: true, scope: t });
  const seed = gitRepo({ scope: t });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed.dir, "plan", "feedback"), { recursive: true });
  mkdirSync(join(seed.dir, "src"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "- id: W1-T4\n  title: seed\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n");
  writeFileSync(join(seed.dir, PUBLIC_TASK), publicTask());
  const feedbackText = `id: ${ID}\nts: '2026-11-14T00:00:00.000Z'\nraw: file a task for the fixture\nattachments: []\norigin: human\nstatus: new\nproposal_pr: null\n`;
  if (!privateFeedback) writeFileSync(join(seed.dir, REL), feedbackText);
  writeFileSync(join(seed.dir, SOURCE), `export const mark = "${SOURCE_MARK}";\n`);
  writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# fixture\n");
  seed.git("add", "-A"); seed.git("commit", "--quiet", "-m", "chore: seed the public repository");
  seed.addRemote("origin", publicOrigin.dir); seed.git("push", "--quiet", "origin", "main");
  const opsSeed = gitRepo({ scope: t });
  mkdirSync(join(opsSeed.dir, "plan"), { recursive: true });
  writeFileSync(join(opsSeed.dir, "plan", "tasks.yaml"), "[]\n");
  if (privateFeedback) {
    mkdirSync(join(opsSeed.dir, "plan", "feedback"), { recursive: true });
    writeFileSync(join(opsSeed.dir, REL), feedbackText);
  }
  opsSeed.git("add", "-A"); opsSeed.git("commit", "--quiet", "-m", "chore: seed the ops repository");
  opsSeed.addRemote("origin", opsOrigin.dir); opsSeed.git("push", "--quiet", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const publicClone = gitRepo({ cloneFrom: publicOrigin.dir, scope: t });
  const opsClone = gitRepo({ cloneFrom: opsOrigin.dir, scope: t });
  for (const clone of [publicClone, opsClone]) {
    clone.git("config", "user.name", "remudero fixture");
    clone.git("config", "user.email", "fixture@remudero.invalid");
  }
  publicClone.git("worktree", "add", "--detach", join(root, "repos", "remudero"), "main");
  opsClone.git("worktree", "add", "--detach", join(root, "repos", "remudero-ops"), "main");

  const shim = ghShim([{ when: "pr list", stdout: "[]" }, { when: "pulls?", stdout: "[]" }, { when: "issue list", stdout: "[]" },
    { when: "pr create", stdout: "https://github.com/craigoley/remudero/pull/7" }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  // Each bare origin answers the API's view of its own pushed run branch: number 2 is public, number 1 is ops.
  const sides = [{ origin: publicOrigin, repository: "craigoley/remudero", number: 2 }, { origin: opsOrigin, repository: OPS, number: 1 }];
  for (const side of sides) {
    const info = join(root, `pr-${side.number}.json`);
    const view = join(root, `head-${side.number}.json`);
    const q = (path: string) => "'" + path.replaceAll("'", "'\"'\"'") + "'";
    writeFileSync(join(side.origin.dir, "hooks", "post-receive"), ["#!/bin/sh", "while read old new ref; do",
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
  // The commands read the process-global HOME config, so each one runs in its own Node process. Git, the
  // id reservations and the feedback landing are real. Only the paid worker and gh are fixtures.
  const child = String.raw`
    import {readFileSync,writeFileSync,mkdirSync,statSync} from "node:fs";
    import {join} from "node:path";
    import {execFileSync} from "node:child_process";
    import {planCommand,triageCommand} from "#test/helpers/run-task-test.js";
    import {withLiveWritesAllowed} from "#src/lib/live-write-guard.js";
    const {root,REPO_ROOT,ID,NEW_TASK,PUBLIC_TASK,SOURCE,diffFile,observedPath,outcomePath,command,worker}=JSON.parse(process.env.ARCHITECT_CASE);
    const observed={};
    const task=(origin)=>["- id: W1-T5","  title: a new filing","  repo: remudero","  origin: "+origin,"  depends_on: []","  type: implement",
      "  verify: auto","  status: queued","  attempts: 0","  design: 'NO-INVARIANTS: a fixture filing with no prior behavior'","  files: [test/fixture.test.ts]","  acceptance:","    - claim: fixture",
      "      proof: 'unit test: fixture'",""].join("\n");
    const result=(text)=>({sessionId:"fixture",costUsd:0,text,blocks:[text],stderr:"",subtype:"success",isError:false,apiError:false,
      numTurns:1,model:"fixture",effort:"high",tokens:{input:0,output:0,cacheRead:0,cacheCreation:0},totalCostUsd:0,
      billingMode:"subscription",verdict:"success",qualitySuspect:false,compactionEvents:[],childEnvKeys:[]});
    const spawn=async(args)=>{
      if((args.tools??[]).length===0)return result("{}");
      observed.prompt=args.prompt;
      observed.cwdOrigin=execFileSync("git",["remote","get-url","origin"],{cwd:args.cwd,encoding:"utf8"}).trim();
      mkdirSync(join(args.cwd,"plan","tasks.d"),{recursive:true});
      const view=/source is at (\S+), at commit ([0-9a-f]{40})/.exec(args.prompt);
      if(view){
        observed.viewSource=readFileSync(join(view[1],SOURCE),"utf8");
        // The mode bits, not a refused write: a write is refused for every uid but 0.
        observed.viewReadOnly=[SOURCE,"src","plan"].every((p)=>(statSync(join(view[1],p)).mode&0o222)===0);
        if(worker==="bypass")execFileSync("git",["-C",view[1],"commit","--allow-empty","--quiet","-m","the worker wrote here"]);
        if(worker==="both")writeFileSync(join(args.cwd,PUBLIC_TASK),readFileSync(join(view[1],PUBLIC_TASK),"utf8")+"  note: changed by the Architect\n");
      }
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
  const run = (command: "plan" | "triage", worker: Worker = "new"): { code?: number; error?: string; observed: Observed } => {
    try {
      execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", child], {
        cwd: REPO_ROOT, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: home, PATH: `${shim.dir}:${saved}`, ARCHITECT_CASE: JSON.stringify({ root, REPO_ROOT, ID, NEW_TASK,
          PUBLIC_TASK, SOURCE, diffFile, observedPath, outcomePath, command, worker }) },
      });
    } catch (error) { return { error: String(error), observed: {} }; }
    return { ...JSON.parse(readFileSync(outcomePath, "utf8")), observed: JSON.parse(readFileSync(observedPath, "utf8")) };
  };
  const runBranches = (origin: typeof publicOrigin, lane: string) =>
    origin.git("for-each-ref", "--format=%(refname:short)", `refs/heads/run-${lane}-*`).trim().split("\n").filter(Boolean);
  const changed = (origin: typeof publicOrigin, branch: string) => origin.git("diff", "--name-only", "main", branch).trim().split("\n").filter(Boolean);
  const posts = (repository: string) => shim.calls().filter((call) => call.includes(`api --method POST repos/${repository}/pulls`)).length;
  const ledger = () => existsSync(join(root, "state", "ledger.ndjson")) ? readFileSync(join(root, "state", "ledger.ndjson"), "utf8") : "";
  return { root, publicOrigin, opsOrigin, run, runBranches, changed, posts, ledger };
}

test("W1-T12213 criterion 1: with `task` on, rmd plan cuts its lane in the destination and opens its pull request there", (t) => {
  const f = fixture(t, ["task"]);
  const result = f.run("plan");
  assert.equal(result.error, undefined, f.ledger());
  assert.equal(result.code, 1, "the fixture's red CI stops the command before review");
  assert.equal(result.observed.cwdOrigin, f.opsOrigin.dir, "the worker's lane is a worktree of the destination checkout");
  const [branch] = f.runBranches(f.opsOrigin, "PLAN");
  assert.ok(branch, f.ledger());
  assert.deepEqual(f.changed(f.opsOrigin, branch), [NEW_TASK]);
  assert.equal(f.posts(OPS), 1);
  assert.equal(f.posts("craigoley/remudero"), 0);
  assert.deepEqual(f.runBranches(f.publicOrigin, "PLAN"), [], "nothing is pushed to the public repository");
  assert.equal(f.publicOrigin.git("for-each-ref", "--format=%(refname)", "refs/rmd-id/W1-T5").trim(), "refs/rmd-id/W1-T5",
    "the id reservation stays on the public repository");
  assert.equal(f.opsOrigin.git("for-each-ref", "--format=%(refname)", "refs/rmd-id/").trim(), "");
});

test("W1-T12213 criterion 2: with `task` on, a triage proposal adds its new task file in the destination", (t) => {
  const f = fixture(t, ["task"]);
  const result = f.run("triage");
  assert.equal(result.error, undefined, f.ledger());
  assert.equal(result.code, 1, "the fixture's red CI stops the command before review");
  assert.equal(result.observed.cwdOrigin, f.opsOrigin.dir);
  const [branch] = f.runBranches(f.opsOrigin, "TRIAGE");
  assert.ok(branch, f.ledger());
  assert.deepEqual(f.changed(f.opsOrigin, branch), [NEW_TASK]);
  assert.equal(f.posts(OPS), 1);
  assert.deepEqual(f.runBranches(f.publicOrigin, "TRIAGE"), [], "no task file is filed in the public repository");
  const landed = f.publicOrigin.git("show", `${LANDING_BRANCH}:${REL}`);
  assert.match(landed, /status: proposed/, "the public feedback status rides the public feedback landing");
  assert.ok(!landed.includes("remudero-ops"), "the public entry never names the destination");
});

test("W1-T12213 criterion 3: the worker reads the public source and cannot write the public checkout", (t) => {
  const f = fixture(t, ["task"]);
  const result = f.run("plan");
  assert.equal(result.observed.viewSource, `export const mark = "${SOURCE_MARK}";\n`, "the worker reads the public source at the pinned commit");
  assert.equal(result.observed.viewReadOnly, true, "the public view is read-only while the worker runs");
  assert.match(String(result.observed.prompt), /never write it/);
  const bypass = fixture(t, ["task"]);
  const refused = bypass.run("plan", "bypass");
  assert.equal(refused.error, undefined, bypass.ledger());
  assert.equal(refused.code, 1);
  assert.match(bypass.ledger(), /the worker wrote to the public checkout/);
  assert.equal(bypass.posts(OPS) + bypass.posts("craigoley/remudero"), 0, "a worker that wrote the public view opens no pull request");
  assert.deepEqual(bypass.runBranches(bypass.opsOrigin, "PLAN"), []);
});

test("W1-T12213 criterion 4: a public task edit is committed in the public repository, with one pull request in each", (t) => {
  const f = fixture(t, ["task"]);
  const result = f.run("plan", "both");
  assert.equal(result.error, undefined, f.ledger());
  const [opsBranch] = f.runBranches(f.opsOrigin, "PLAN");
  const [publicBranch] = f.runBranches(f.publicOrigin, "PLAN");
  assert.ok(opsBranch && publicBranch, f.ledger());
  assert.deepEqual(f.changed(f.opsOrigin, opsBranch), [NEW_TASK], "the new task file stays in the destination");
  assert.deepEqual(f.changed(f.publicOrigin, publicBranch), [PUBLIC_TASK], "the public task edit is committed in the public repository");
  assert.match(f.publicOrigin.git("show", `${publicBranch}:${PUBLIC_TASK}`), /note: changed by the Architect/);
  assert.equal(f.posts(OPS), 1);
  assert.equal(f.posts("craigoley/remudero"), 1);
});

test("W1-T12213 criterion 5: with no host file, rmd plan and rmd triage use today's worktree, branch and repository", (t) => {
  const f = fixture(t, undefined);
  const plan = f.run("plan");
  assert.equal(plan.error, undefined, f.ledger());
  assert.equal(plan.observed.cwdOrigin, f.publicOrigin.dir);
  assert.ok(!String(plan.observed.prompt).includes("plan destination"), "the prompt is today's prompt");
  const [planBranch] = f.runBranches(f.publicOrigin, "PLAN");
  assert.match(planBranch ?? "", /^run-PLAN-create-\d+$/);
  assert.deepEqual(f.changed(f.publicOrigin, planBranch), [NEW_TASK]);
  const triage = f.run("triage");
  assert.equal(triage.error, undefined, f.ledger());
  assert.equal(triage.observed.cwdOrigin, f.publicOrigin.dir);
  const [triageBranch] = f.runBranches(f.publicOrigin, "TRIAGE");
  assert.deepEqual(f.changed(f.publicOrigin, triageBranch).sort(), [NEW_TASK, REL].sort(), "the legacy proposal commits its task and feedback edit together");
  assert.equal(f.posts(OPS), 0);
  assert.equal(f.posts("craigoley/remudero"), 2);
  assert.equal(f.opsOrigin.git("for-each-ref", "--format=%(refname)").trim(), "refs/heads/main");
});

test("W1-T12213 criterion 6: the test drives the rmd plan and rmd triage commands, the production callers", (t) => {
  const f = fixture(t, ["task"]);
  for (const command of ["plan", "triage"] as const) {
    const result = f.run(command);
    assert.equal(result.error, undefined, f.ledger());
    assert.match(f.ledger(), new RegExp(`"step":"${command}.start"`), `the ${command} command ran its own entry`);
  }
  assert.equal(f.posts(OPS), 2);
});

test("W1-T12213 private feedback proposal awaits its home landing before settling", (t) => {
  const f = fixture(t, ["task", "feedback"], true);
  const result = f.run("triage");
  assert.equal(result.error, undefined, f.ledger());
  assert.equal(result.code, 1, "the fixture's red CI is the terminal refusal, after the private landing");
  assert.equal(f.posts(OPS), 1);
  const [branch] = f.runBranches(f.opsOrigin, "TRIAGE");
  assert.ok(branch, "the new task is filed in its selected repository");
  assert.deepEqual(f.changed(f.opsOrigin, branch), [NEW_TASK]);
  const landed = f.opsOrigin.git("show", LANDING_BRANCH + ":" + REL);
  assert.match(landed, /status: proposed/);
  assert.match(landed, /proposal_pr:.*fixture\/remudero-ops\/pull\/1/);
  assert.deepEqual(f.runBranches(f.publicOrigin, "TRIAGE"), []);
  assert.equal(f.publicOrigin.git("for-each-ref", "--format=%(refname)", "refs/heads/" + LANDING_BRANCH).trim(), "",
    "private feedback is not published to the public origin");
});
