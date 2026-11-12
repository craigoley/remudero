import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { triageCommand } from "#src/run-task.js";
import { diffCitesFeedback, triageCommitMessage } from "#src/lib/triage.js";
import { feedbackStatusOnMain } from "#src/lib/auto-triage.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { LANDING_BRANCH } from "#src/lib/feedback-landing.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ID = "fb-triage-private-entry";
const REL = `plan/feedback/${ID}.yaml`;
const PRIVATE = "private feedback bytes never belong in a public lane";
const TASK_PATH = "plan/tasks.d/W1-T5-private-request.yaml";

function fixture(t: TestContext, privateEntry = true) {
  const root = ownedFixtureDir(t, "triage-record-home").dir;
  const home = join(root, "home");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ root, installRoot: REPO_ROOT, claudeBin: "/usr/bin/true" }));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify({ repository: "fixture/private-ops", kinds: ["feedback"] }));
  const publicOrigin = gitRepo({ bare: true, scope: t });
  const privateOrigin = gitRepo({ bare: true, scope: t });
  const seed = gitRepo({ scope: t });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), "- id: W1-T4\n  title: seed\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n");
  writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# fixture\n");
  const entry = `id: ${ID}\nts: '${new Date().toISOString()}'\nraw: ${PRIVATE}\nattachments: []\norigin: human\nstatus: new\nproposal_pr: null\n`;
  const addEntry = (dir: string) => { mkdirSync(join(dir, "plan", "feedback"), { recursive: true }); writeFileSync(join(dir, REL), entry); };
  if (!privateEntry) addEntry(seed.dir);
  seed.git("add", "-A"); seed.git("commit", "--quiet", "-m", "chore: seed triage");
  seed.addRemote("origin", publicOrigin.dir); seed.git("push", "--quiet", "origin", "main");
  const privateSeed = gitRepo({ scope: t });
  mkdirSync(join(privateSeed.dir, "plan"), { recursive: true });
  writeFileSync(join(privateSeed.dir, "plan", "tasks.yaml"), "[]\n");
  if (privateEntry) addEntry(privateSeed.dir);
  privateSeed.git("add", "-A"); privateSeed.git("commit", "--quiet", "--allow-empty", "-m", "chore: seed private feedback");
  privateSeed.addRemote("origin", privateOrigin.dir); privateSeed.git("push", "--quiet", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const publicClone = gitRepo({ cloneFrom: publicOrigin.dir, scope: t });
  const privateClone = gitRepo({ cloneFrom: privateOrigin.dir, scope: t });
  for (const clone of [publicClone, privateClone]) {
    clone.git("config", "user.name", "remudero fixture");
    clone.git("config", "user.email", "fixture@remudero.invalid");
  }
  publicClone.git("worktree", "add", "--detach", join(root, "repos", "remudero"), "main");
  privateClone.git("worktree", "add", "--detach", join(root, "repos", "private-ops"), "main");
  const shim = ghShim([{ when: "pr list", stdout: "[]" }, { when: "pulls?", stdout: "[]" }, { when: "pr create", stdout: "https://github.com/fixture/private-ops/pull/1" }, { when: "issue list", stdout: "[]" }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const branchView = join(root, "branch-view.json");
  const publicDiff = join(root, "public-diff.txt");
  shim.addRoute({ when: "--json headRefName", stdoutFile: branchView });
  shim.addRoute({ when: "pr diff", stdoutFile: publicDiff });
  shim.addRoute({ when: "api --method POST repos/craigoley/remudero/pulls", stdout: JSON.stringify({ html_url: "https://github.com/craigoley/remudero/pull/99", number: 99 }) });
  // A real terminal-red CI response stops the command before any review/merge effect.
  shim.addRoute({ when: "repos/craigoley/remudero/pulls/99", stdout: JSON.stringify({ number: 99, head: { sha: "a".repeat(40), ref: "fixture" }, base: { ref: "main" }, state: "open" }) });
  shim.addRoute({ when: "/check-runs", stdout: JSON.stringify({ total_count: 1, check_runs: [{ id: 1, name: "ci-gate", status: "completed", conclusion: "failure" }] }) });
  shim.addRoute({ when: "/statuses", stdout: "[]" });
  shim.addRoute({ when: "/status", stdout: '{"statuses":[]}' });
  shim.addRoute({ when: "/actions/runs", stdout: '{"workflow_runs":[]}' });
  shim.addRoute({ when: "required_status_checks", stdout: '{"contexts":["ci-gate"],"checks":[]}' });
  const saved = { home: process.env.HOME, path: process.env.PATH };
  process.env.HOME = home; process.env.PATH = `${shim.dir}:${saved.path}`;
  t.after(() => { if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home; process.env.PATH = saved.path; });
  let spawns = 0;
  const run = async (propose = false) => {
    try {
      const code = await withLiveWritesAllowed(() => triageCommand([ID], {
        config: { root, installRoot: REPO_ROOT, claudeBin: "/usr/bin/true" },
        lintPlanForReviewFn: async () => ({ ran: true, label: "fixture", checked: 1, violations: [] }),
        spawn: async (args) => {
          let text = "ALREADY_DECIDED: W1-T4 already covers this request";
          if ((args.tools ?? []).length === 0) text = "{}";
          else {
            spawns++;
            assert.ok(args.prompt.includes(PRIVATE), "the original untrusted feedback reaches the worker prompt");
            if (propose) {
              const id = /USE EXACTLY `(W\d+-T\d+)`/.exec(args.prompt)?.[1];
              assert.equal(id, "W1-T5");
              mkdirSync(join(args.cwd, "plan", "tasks.d"), { recursive: true });
              writeFileSync(join(args.cwd, TASK_PATH), `- id: ${id}\n  title: an explicit public task\n  repo: remudero\n  origin: feedback#${ID}\n  depends_on: []\n  type: implement\n  verify: auto\n  status: queued\n  attempts: 0\n  files: [src/lib/triage.ts]\n  acceptance:\n    - claim: the task is present\n      proof: "grep: triage in src/lib/triage.ts"\n`);
              const branch = publicClone.git("-C", args.cwd, "branch", "--show-current").trim();
              writeFileSync(branchView, JSON.stringify({ headRefName: branch }));
              writeFileSync(publicDiff, `diff --git a/${TASK_PATH} b/${TASK_PATH}\nnew file mode 100644\n--- /dev/null\n+++ b/${TASK_PATH}\n@@ -0,0 +1,3 @@\n+- id: W1-T5\n+  origin: feedback#${ID}\n`);
              text = "PROPOSED: file the explicit public task";
            }
          }
          return { sessionId: "fixture", costUsd: 0, text, blocks: [], stderr: "", subtype: "success", isError: false, apiError: false, model: "fixture", effort: "high", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, totalCostUsd: 0, billingMode: "subscription", verdict: "success", qualitySuspect: false, compactionEvents: [], childEnvKeys: [] } as never;
        },
      }));
      return { code, error: undefined };
    } catch (error) { return { code: undefined, error }; }
  };
  return { root, publicOrigin, privateOrigin, privateClone, publicClone, run, spawns: () => spawns, calls: () => shim.calls() };
}

test("W1-T12204 criterion 1 and criterion 7: real rmd triage lands an ops status without a public feedback file", async (t) => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.error, undefined);
  assert.equal(result.code, 0);
  assert.match(f.privateOrigin.git("show", `${LANDING_BRANCH}:${REL}`), /status: rejected/);
  assert.equal(f.publicOrigin.git("for-each-ref", "--format=%(refname)", "refs/heads/feedback-landing").trim(), "");
  assert.equal(existsSync(join(f.root, "repos", "remudero", REL)), false);
  assert.equal(f.privateClone.git("status", "--porcelain").trim(), "", "the shared private checkout is not dirtied");
  assert.equal(f.spawns(), 1);
  assert.equal(f.calls().filter((x) => x.includes("pr create")).length, 1);
});

test("W1-T12204 criterion 2: an ops proposal proof searches its new public task rather than the private status", () => {
  const message = triageCommitMessage({ decision: { action: "propose", status: "proposed", detail: "file task", files: [TASK_PATH] }, feedbackId: ID, taskId: "W1-T5", proposalTaskPath: TASK_PATH } as Parameters<typeof triageCommitMessage>[0]);
  assert.ok(message.includes(`grep: ^- id: W1-T5 in ${TASK_PATH}`));
  assert.ok(!message.includes(REL));
});

test("W1-T12204 criterion 3: proposal provenance is the new task origin, not another diff field", () => {
  const patch = (origin: string) => `diff --git a/${TASK_PATH} b/${TASK_PATH}\nnew file mode 100644\n--- /dev/null\n+++ b/${TASK_PATH}\n@@ -0,0 +1,3 @@\n+- id: W1-T5\n+  origin: ${origin}\n+  title: feedback#${ID}\n`;
  assert.equal(diffCitesFeedback(patch(`feedback#${ID}`), ID, TASK_PATH), true);
  assert.equal(diffCitesFeedback(patch("architect"), ID, TASK_PATH), false);
  const nested = patch("architect").replace(`+  title: feedback#${ID}`, `+  description: |\n+    origin: feedback#${ID}`);
  assert.equal(diffCitesFeedback(nested, ID, TASK_PATH), false, "an origin-shaped line inside prose is not the task origin");
});

test("W1-T12204 criterion 4: claim evidence reads the origin status in the repository holding the entry", (t) => {
  const f = fixture(t);
  assert.equal(feedbackStatusOnMain(join(f.root, "repos", "remudero"), ID), "new");
});

test("W1-T12204 criterion 6: the legacy public proposal still uses its feedback status proof", () => {
  const message = triageCommitMessage({ decision: { action: "propose", status: "proposed", detail: "file task", files: [TASK_PATH] }, feedbackId: ID, taskId: "W1-T5" });
  assert.ok(message.includes(`grep: status: proposed in ${REL}`));
});


test("W1-T12204 criterion 2 and criterion 7: real ops PROPOSE publishes only the new task with a public task proof", async (t) => {
  const f = fixture(t);
  const result = await f.run(true);
  const branch = f.publicOrigin.git("for-each-ref", "--format=%(refname)", "refs/heads/run-TRIAGE-*").trim();
  assert.ok(branch, `the public task branch was pushed: ${String(result.error)}\n${readFileSync(join(f.root, "state", "ledger.ndjson"), "utf8")}`);
  const paths = f.publicOrigin.git("diff", "--name-only", "main", branch).trim().split("\n");
  assert.deepEqual(paths, [TASK_PATH]);
  const message = f.publicOrigin.git("log", "--format=%B", "main.." + branch);
  assert.ok(message.includes(`grep: ^- id: W1-T5 in ${TASK_PATH}`));
  assert.ok(!message.includes(REL));
  assert.ok(!f.publicOrigin.git("show", `${branch}:${TASK_PATH}`).includes(PRIVATE));
  assert.match(f.privateOrigin.git("show", `${LANDING_BRANCH}:${REL}`), /proposal_pr: .*pull\/99/);
});


test("W1-T12204 criterion 5: a failed private status write resumes without minting or filing a second task", async (t) => {
  const f = fixture(t);
  const hook = join(f.privateOrigin.dir, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho fixture-private-write-refused >&2\nexit 1\n", { mode: 0o700 });
  const first = await f.run(true);
  assert.match(String(first.error), /private feedback status write failed/);
  assert.ok(readFileSync(join(f.root, "state", "ledger.ndjson"), "utf8").includes('"write":"private_feedback_status"'));
  const before = f.publicOrigin.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/run-TRIAGE-*");
  assert.ok(before.trim());
  rmSync(hook);
  const next = await f.run(true);
  assert.equal(next.error, undefined);
  assert.equal(next.code, 1, "fixture terminal-red CI prevents review/merge");
  assert.equal(f.spawns(), 1, "recovery invokes neither another architect nor another mint");
  assert.equal(f.publicOrigin.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/run-TRIAGE-*"), before);
  assert.equal(f.calls().filter(x => x.includes("api --method POST repos/craigoley/remudero/pulls")).length, 1);
  assert.match(f.privateOrigin.git("show", `${LANDING_BRANCH}:${REL}`), /status: proposed/);
});

test("W1-T12204 criterion 5: a refused public task push retries its same committed task before any status write", async (t) => {
  const f = fixture(t);
  const hook = join(f.publicOrigin.dir, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do\ncase \"$ref\" in refs/heads/run-TRIAGE-*) echo fixture-public-write-refused >&2; exit 1 ;; esac\ndone\n", { mode: 0o700 });
  const first = await f.run(true);
  assert.match(String(first.error), /public task write failed or is unknown/);
  assert.equal(f.calls().filter(x => x.includes("api --method POST repos/craigoley/remudero/pulls")).length, 0);
  assert.equal(f.privateOrigin.git("for-each-ref", "--format=%(refname)", "refs/heads/feedback-landing*").trim(), "");
  rmSync(hook);
  const next = await f.run(true);
  assert.equal(next.error, undefined);
  assert.equal(f.spawns(), 1);
  assert.equal(f.publicOrigin.git("for-each-ref", "--format=%(refname)", "refs/heads/run-TRIAGE-*").trim().split("\n").length, 1);
  assert.equal(f.calls().filter(x => x.includes("api --method POST repos/craigoley/remudero/pulls")).length, 1);
});

test("W1-T12204 criterion 6 and criterion 7: real legacy PROPOSE commits its feedback edit and task together", async (t) => {
  const f = fixture(t, false);
  const result = await f.run(true);
  assert.equal(result.error, undefined);
  assert.equal(result.code, 1);
  const branch = f.publicOrigin.git("for-each-ref", "--format=%(refname)", "refs/heads/run-TRIAGE-*").trim();
  const first = f.publicOrigin.git("rev-list", "--reverse", `main..${branch}`).trim().split("\n")[0];
  assert.deepEqual(f.publicOrigin.git("diff-tree", "--no-commit-id", "--name-only", "-r", first).trim().split("\n").sort(), [REL, TASK_PATH].sort());
  assert.ok(f.publicOrigin.git("log", "-1", "--format=%B", first).includes(`grep: status: proposed in ${REL}`));
  assert.equal(f.privateOrigin.git("for-each-ref", "--format=%(refname)", "refs/heads/feedback-landing*").trim(), "");
});
