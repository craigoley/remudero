import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { FIXTURE_CONFIG_PATH_SEGMENTS } from "#src/lib/config.js";
import { parseAcceptanceBlock } from "#src/lib/review.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ID = "W1-T900039";
const TITLE = "Check the hand build proof fixture";
const OPS = "fixture-private/ops";
const PRIVATE_TEXT = "PRIVATE_TASK_NARRATIVE";
const OPS_CRITERION = { claim: "ops fixture marker is present", proof: "grep: ops-marker in src/fixture.ts" };
const PUBLIC_CRITERION = { claim: "public fixture marker is present", proof: "grep: public-marker in src/fixture.ts" };
const CREDITED = { claim: "the prior milestone shipped", proof: "grep: credited-marker in src/old.ts", satisfied_by: "PR-1" };

function record(criteria: object[]) {
  return JSON.stringify([{ id: ID, title: TITLE, repo: "remudero", type: "implement", verify: "auto",
    files: ["src/PRIVATE_TASK_SCOPE.ts"], design: PRIVATE_TEXT, acceptance: criteria }]);
}

function catalogRoutes() {
  const content = record([CREDITED, OPS_CRITERION]);
  const hash = (text: string) => createHash("sha1").update(text).digest("hex");
  const commit = hash("commit"), tree = hash("root"), plan = hash("plan");
  const blob = hash(`blob ${Buffer.byteLength(content)}\0${content}`);
  const base = `repos/${OPS}`;
  return [
    [`${base}/git/ref/heads/main`, { object: { type: "commit", sha: commit } }],
    [`${base}/git/commits/${commit}`, { sha: commit, tree: { sha: tree } }],
    [`${base}/git/trees/${tree}`, { sha: tree, truncated: false, tree: [{ path: "plan", sha: plan, type: "tree", mode: "040000" }] }],
    [`${base}/git/trees/${plan}`, { sha: plan, truncated: false, tree: [{ path: "tasks.yaml", sha: blob, type: "blob", mode: "100644" }] }],
    [`${base}/git/blobs/${blob}`, { sha: blob, encoding: "base64", size: Buffer.byteLength(content), content: Buffer.from(content).toString("base64") }],
    [base, { id: 42, full_name: OPS, default_branch: "main" }],
  ].map(([path, response]) => ({ when: `api ${path}`, stdout: JSON.stringify(response) }));
}

function fixture(t: TestContext, publicPlan: string) {
  const repo = gitRepo({ scope: t });
  const instance = ownedFixtureDir(t, "hand-proof-instance").dir;
  const configPath = join(instance, ...FIXTURE_CONFIG_PATH_SEGMENTS);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ root: instance, claudeBin: process.execPath }));
  const state = join(instance, "state");
  mkdirSync(state);
  writeFileSync(join(state, "plan-destination.json"), JSON.stringify({ repository: OPS, kinds: [] }));
  const shim = ghShim([...catalogRoutes(), { when: "", exit: 97 }]);
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));

  const planPath = join(repo.dir, "plan", "tasks.yaml");
  mkdirSync(join(repo.dir, "plan"));
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(planPath, publicPlan);
  repo.git("add", "plan");
  repo.git("commit", "-m", "test: seed the public plan");
  repo.git("checkout", "-b", `run-${ID}-1790000000000`);

  function run(entry: string, args: string[]) {
    return spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(REPO_ROOT, entry), ...args], {
      cwd: repo.dir,
      env: {
        PATH: `${shim.dir}:${process.env.PATH}`, HOME: instance, LANG: "C", TMPDIR: tmpdir(), GH_HOST: "github.invalid",
        RMD_GH_COOLDOWN_S: "0",
        RMD_GH_SHARED_READ_GAP_MS: "0",
        NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE,
      },
      encoding: "utf8", timeout: 60_000,
    });
  }

  return {
    shim,
    configPath,
    planPath,
    setHeadProof(marker: string) {
      writeFileSync(join(repo.dir, "src", "fixture.ts"), `${marker}\n`);
      repo.git("add", "src");
      repo.git("commit", "-m", "test: change the proof evidence");
    },
    check: () => run("scripts/proof-resolve-precheck.mjs", ["--base", "main"]),
    render: (...args: string[]) => run("src/run-task.ts", ["plan-destination", "task", "--pr-body", ...args]),
  };
}

test("W1-T13381 criterion 1 checks ops proofs on the hand build head", t => {
  const f = fixture(t, "[]");
  f.setHeadProof("ops-marker");
  const green = f.check();
  assert.equal(green.status, 0, green.stderr);
  assert.match(green.stdout, /OK -- 2 W1-T900039 criteria/);
  assert.ok(f.shim.calls().some(call => call.includes("/git/blobs/")));

  f.setHeadProof("marker removed");
  const red = f.check();
  assert.equal(red.status, 0, "grep misses retain the hook's report-only severity");
  assert.match(red.stderr, /WILL REFUSE 1 of W1-T900039's proofs/);
  assert.ok(red.stderr.includes(OPS_CRITERION.proof));
  assert.equal(red.stdout, "");
});

test("W1-T13381 criterion 2 prints the daemon's public body format for an ops task", t => {
  const f = fixture(t, "[]");
  const result = f.render(ID);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, [
    TITLE, "", "## Decisions", "", "- Keep private task fields host-side.", "",
    "## Prior acceptance credit", "", '- "the prior milestone shipped" (satisfied_by: "PR-1")', "",
    "Acceptance:", `- ${OPS_CRITERION.claim} | ${OPS_CRITERION.proof}`, "", `Remudero-Task: ${ID}`, "",
  ].join("\n"));
  assert.deepEqual(parseAcceptanceBlock(result.stdout), [OPS_CRITERION]);
  assert.ok(f.shim.calls().every(call => call.startsWith(`api repos/${OPS}`)));

  const absent = f.render("W1-T900040");
  assert.equal(absent.status, 1, absent.stderr);
  assert.match(absent.stderr, /no ops task/);
  assert.equal(absent.stdout, "");
  const usage = f.render(ID, "extra");
  assert.equal(usage.status, 2, usage.stderr);
});

test("W1-T13381 criterion 3 public head criteria win and an unreadable ops catalog cannot pass", t => {
  const publicTask = fixture(t, record([PUBLIC_CRITERION]));
  writeFileSync(publicTask.planPath, "[]");
  publicTask.setHeadProof("public-marker");
  const publicResult = publicTask.check();
  assert.equal(publicResult.status, 0, publicResult.stderr);
  assert.match(publicResult.stdout, /OK -- 1 W1-T900039 criteria/);
  assert.deepEqual(publicTask.shim.calls(), []);

  const privateTask = fixture(t, "[]");
  privateTask.shim.addRoute({ when: `api repos/${OPS}`, exit: 1, stderr: PRIVATE_TEXT });
  const unreadable = privateTask.check();
  assert.equal(unreadable.status, 2, unreadable.stderr);
  assert.match(unreadable.stderr, /task catalog unreadable .*NOT reporting clean/);
  assert.ok(!unreadable.stderr.includes(PRIVATE_TEXT));
  assert.equal(unreadable.stdout, "");

  const render = privateTask.render(ID);
  assert.equal(render.status, 1, render.stderr);
  assert.match(render.stderr, /task catalog unreadable/);
  assert.ok(!render.stderr.includes(PRIVATE_TEXT));
  assert.equal(render.stdout, "");

  const reads = privateTask.shim.calls().length;
  writeFileSync(privateTask.configPath, PRIVATE_TEXT);
  const invalidConfig = privateTask.check();
  assert.equal(invalidConfig.status, 2, invalidConfig.stderr);
  assert.match(invalidConfig.stderr, /task catalog unreadable \(instance configuration\)/);
  assert.ok(!invalidConfig.stderr.includes(PRIVATE_TEXT));
  const invalidRender = privateTask.render(ID);
  assert.equal(invalidRender.status, 1, invalidRender.stderr);
  assert.match(invalidRender.stderr, /task catalog unreadable \(instance configuration\)/);
  assert.ok(!invalidRender.stderr.includes(PRIVATE_TEXT));
  assert.equal(invalidRender.stdout, "");
  assert.equal(privateTask.shim.calls().length, reads);
});
