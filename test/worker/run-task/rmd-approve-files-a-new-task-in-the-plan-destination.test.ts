import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { approveRunBranch } from "#src/lib/inbox.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { approveCommand } from "#test/helpers/run-task-test.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const OPS = "fixture/remudero-ops";
const PUBLIC = "craigoley/remudero";
const PUBLIC_TASK = "plan/tasks.d/W1-T3-fixture-public-task-for-the-approval-route.yaml";
const RESUME_RUN = "APPROVE-P-RESUME-1791000000000";
type Row = Record<string, unknown>;

function task(id: string, title: string, extra = ""): string {
  return `- id: ${id}\n  title: ${title}\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: human\n  status: queued\n  attempts: 0\n${extra}`;
}

function draft(id: string, fragmentYaml: string, stampLine = `- ${id} (plan) — RATIFIED -> NEW-1.`) {
  return { proposalId: id, fragmentYaml, stampLine, anchorFingerprint: "" };
}

// Titles far apart, so the duplicate check of a batch never folds two of them together.
const TITLES: Record<string, string> = {
  "P-NEW": "rotate the nightly backup key", "P-A": "rename the cache sweep timer", "P-B": "count stale lane leases hourly",
  "P-ONE": "measure disk headroom on boot", "P-TWO": "trim the ledger archive weekly", "P-THREE": "alert when the queue stalls",
  "P-OFF": "probe the broker socket", "P-OFF-A": "drain idle runners at night", "P-OFF-B": "report the slowest reviewer",
  "P-RESUME": "resume a stranded filing",
};
const DESIGN = '  design: "NO-INVARIANTS: a fixture task."\n';
const newDraft = (id: string) => draft(id,
  `- id: NEW-1\n  title: ${TITLES[id]}\n  repo: remudero\n  type: implement\n  verify: auto\n  origin: architect\n  files: [src/lib/plan.ts]\n${DESIGN}`);

interface World {
  root: string; publicOrigin: GitRepo; opsOrigin: GitRepo;
  approve(ids: string[]): Promise<number | string>;
  runBranches(origin: GitRepo): string[];
  changed(origin: GitRepo, branch: string): string[];
  calls(): string[];
  rows(): Row[];
}

function world(t: TestContext, opts: { kinds?: string[]; drafts: Array<ReturnType<typeof draft>>; resume?: boolean }): World {
  const root = ownedFixtureDir(t, "approve-destination").dir;
  const home = join(root, "home");
  const publicOrigin = gitRepo({ bare: true, scope: t });
  const opsOrigin = gitRepo({ bare: true, scope: t });
  const seed = gitRepo({ scope: t });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed.dir, "src", "lib"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), task("W1-T4", "a seed task the plan loader accepts"));
  writeFileSync(join(seed.dir, PUBLIC_TASK), task("W1-T3", "fixture public task for the approval route"));
  writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# MASTER PLAN\n\nfixture\n");
  writeFileSync(join(seed.dir, "src", "lib", "plan.ts"), "");
  seed.git("add", "-A"); seed.git("commit", "--quiet", "-m", "chore: seed the public plan");
  seed.addRemote("origin", publicOrigin.dir); seed.git("push", "--quiet", "origin", "main");
  const opsSeed = gitRepo({ scope: t });
  mkdirSync(join(opsSeed.dir, "plan"), { recursive: true });
  writeFileSync(join(opsSeed.dir, "plan", "tasks.yaml"), "[]\n");
  opsSeed.git("add", "-A"); opsSeed.git("commit", "--quiet", "-m", "chore: seed the ops plan");
  opsSeed.addRemote("origin", opsOrigin.dir); opsSeed.git("push", "--quiet", "origin", "main");
  if (opts.resume) {
    // A prior run of this approval pushed its branch to the destination and died before it recorded the PR.
    opsSeed.git("checkout", "--quiet", "-b", approveRunBranch(RESUME_RUN));
    mkdirSync(join(opsSeed.dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(opsSeed.dir, "plan", "tasks.d", "W1-T60-a-resumed-filing.yaml"), task("W1-T60", "a resumed filing"));
    opsSeed.git("add", "-A"); opsSeed.git("commit", "--quiet", "-m", "chore(plan): ratify P-RESUME via rmd approve");
    opsSeed.git("push", "--quiet", "origin", approveRunBranch(RESUME_RUN));
  }
  for (const [origin, name] of [[publicOrigin, "remudero"], [opsOrigin, "remudero-ops"]] as const) {
    const clone = gitRepo({ cloneFrom: origin.dir, scope: t });
    clone.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
    clone.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
    mkdirSync(join(root, "repos"), { recursive: true });
    clone.git("worktree", "add", "--quiet", "--detach", join(root, "repos", name), "main");
  }
  const config = { claudeBin: "/usr/bin/true", root, installRoot: REPO_ROOT };
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify(config));
  mkdirSync(join(root, "state"), { recursive: true });
  if (opts.kinds) writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify({ repository: OPS, kinds: opts.kinds }));
  writeFileSync(join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: opts.drafts.map((d) => ({ id: d.proposalId, summary: `approve ${d.proposalId}`, evidenceAnchors: [] })) }));
  writeFileSync(join(root, "state", "inbox-drafts.json"), JSON.stringify(Object.fromEntries(opts.drafts.map((d) => [d.proposalId, d]))));
  const ledger = join(root, "state", "ledger.ndjson");
  writeFileSync(ledger, opts.resume ? JSON.stringify({ run_id: RESUME_RUN, task_id: "P-RESUME", step: "approve.error", error: "fixture: died after push" }) + "\n" : "");

  // The create call's argv carries the whole PR body, so the POST routes come first.
  const routes: GhShimRoute[] = [
    { when: `api --method POST repos/${OPS}/pulls`, stdout: JSON.stringify({ html_url: `https://github.com/${OPS}/pull/1`, number: 1 }) },
    { when: `api --method POST repos/${PUBLIC}/pulls`, stdout: JSON.stringify({ html_url: `https://github.com/${PUBLIC}/pull/2`, number: 2 }) },
  ];
  if (opts.resume) routes.push({ when: `repos/${OPS}/pulls?head=`, stdout: JSON.stringify([{ html_url: `https://github.com/${OPS}/pull/3`, number: 3 }]) });
  const sides = [{ origin: publicOrigin, repository: PUBLIC, numbers: [2] }, { origin: opsOrigin, repository: OPS, numbers: [1, 3] }];
  for (const side of sides) {
    const info = join(root, `${side.repository.replace("/", "-")}-pr.json`);
    const view = join(root, `${side.repository.replace("/", "-")}-head.json`);
    const q = (path: string) => "'" + path.replaceAll("'", "'\"'\"'") + "'";
    writeFileSync(join(side.origin.dir, "hooks", "post-receive"), ["#!/bin/sh", "while read old new ref; do",
      'case "$ref" in refs/heads/run-*)', 'b="${ref#refs/heads/}"',
      `printf '{"number":1,"state":"open","merged_at":null,"head":{"sha":"%s","ref":"%s"},"base":{"ref":"main"}}\\n' "$new" "$b" > ${q(info)}`,
      `printf '{"headRefName":"%s"}\\n' "$b" > ${q(view)} ;;`, "esac", "done", ""].join("\n"), { mode: 0o700 });
    if (opts.resume && side.origin === opsOrigin) {
      const sha = opsOrigin.git("rev-parse", approveRunBranch(RESUME_RUN));
      writeFileSync(info, JSON.stringify({ number: 3, state: "open", merged_at: null, head: { sha, ref: approveRunBranch(RESUME_RUN) }, base: { ref: "main" } }));
      writeFileSync(view, JSON.stringify({ headRefName: approveRunBranch(RESUME_RUN) }));
    }
    for (const n of side.numbers) {
      routes.push({ when: `${side.repository}/pull/${n} --json headRefName`, stdoutFile: view });
      routes.push({ when: `repos/${side.repository}/pulls/${n}`, stdoutFile: info });
    }
  }
  routes.push({ when: "pulls?state=open", stdout: "[]" }, { when: "pulls?head=", stdout: "[]" },
    // A terminal-red CI answer stops the command before any review or merge.
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) });
  const shim = ghShim(routes, { kind: "approve-destination-gh" });
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  return {
    root, publicOrigin, opsOrigin,
    async approve(ids) {
      process.env.HOME = home;
      process.env.PATH = `${shim.dir}:${saved.PATH}`;
      try {
        return await withLiveWritesAllowed(() => approveCommand(ids, { config: config as never, planPath: join(root, "repos", "remudero", "plan", "tasks.yaml") }))
          .catch((error: unknown) => String(error));
      } finally {
        process.env.HOME = saved.HOME;
        process.env.PATH = saved.PATH;
      }
    },
    runBranches: (origin) => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads/run-*").split("\n").filter(Boolean),
    changed: (origin, branch) => origin.git("diff", "--name-only", "main", branch).split("\n").filter(Boolean),
    calls: () => shim.calls(),
    rows: () => readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row),
  };
}

const posts = (w: World, repository: string) => w.calls().filter((call) => call.includes(`api --method POST repos/${repository}/pulls`)).length;
const errors = (w: World) => JSON.stringify(w.rows().filter((row) => row.step === "approve.error"));

test("W1-T12214 criterion 1: with `task` on, rmd approve cuts its worktree in the destination and opens its pull request there", async (t) => {
  const w = world(t, { kinds: ["task"], drafts: [newDraft("P-NEW")] });
  const code = await w.approve(["P-NEW"]);
  assert.equal(code, 1, `the fixture's red CI stops the command; errors=${errors(w)}`);
  const [branch] = w.runBranches(w.opsOrigin);
  assert.ok(branch, errors(w));
  const paths = w.changed(w.opsOrigin, branch);
  assert.equal(paths.length, 1);
  assert.equal(paths[0], "plan/tasks.d/W1-T5-rotate-the-nightly-backup-key.yaml");
  const added = w.rows().find((row) => row.step === "worktree.add" && row.task_id === "P-NEW");
  assert.ok(String(added?.worktreePath).startsWith(join(w.root, "worktrees")));
  assert.equal(posts(w, OPS), 1);
  assert.equal(posts(w, PUBLIC), 0);
  assert.deepEqual(w.runBranches(w.publicOrigin), [], "nothing is pushed to the public repository");
  assert.equal(w.publicOrigin.git("for-each-ref", "--format=%(refname)", "refs/rmd-id/W1-T5"), "refs/rmd-id/W1-T5", "the id reservation stays public");
  assert.equal(w.opsOrigin.git("for-each-ref", "--format=%(refname)", "refs/rmd-id/"), "");
});

test("W1-T12214 criterion 2: with `task` on, rmd approve --batch files every task file of the batch in the destination", async (t) => {
  const w = world(t, { kinds: ["task"], drafts: [newDraft("P-A"), newDraft("P-B")] });
  const code = await w.approve(["P-A", "P-B"]);
  assert.equal(code, 1, `the fixture's red CI stops the command; errors=${errors(w)}`);
  const [branch] = w.runBranches(w.opsOrigin);
  assert.ok(branch, errors(w));
  assert.equal(w.changed(w.opsOrigin, branch).length, 2, "both task files are in the destination branch");
  assert.equal(posts(w, OPS), 1);
  assert.equal(posts(w, PUBLIC), 0);
  assert.deepEqual(w.runBranches(w.publicOrigin), []);
});

test("W1-T12214 criterion 3: an approval that changes a task file edits it in the repository that holds it", async (t) => {
  const changing = draft("P-EDIT", task("W1-T3", "fixture public task for the approval route",
    `  origin: architect\n${DESIGN}  note: the operator approved this change\n`),
    "- P-EDIT (plan) — RATIFIED -> W1-T3.");
  const w = world(t, { kinds: ["task"], drafts: [changing] });
  await w.approve(["P-EDIT"]);
  const [branch] = w.runBranches(w.publicOrigin);
  assert.ok(branch, errors(w));
  assert.deepEqual(w.changed(w.publicOrigin, branch), [PUBLIC_TASK], "the public task file is edited in the public repository");
  assert.match(w.publicOrigin.git("show", `${branch}:${PUBLIC_TASK}`), /note: the operator approved this change/);
  // The body builder then refuses an edit whose only proof also passes at base. That rule is older than this task.
  assert.match(errors(w), /body emission refused/);
  assert.equal(posts(w, OPS), 0);
  assert.deepEqual(w.runBranches(w.opsOrigin), []);
});

test("W1-T12214 criterion 4: the probe for an open pull request of the same approval reads the destination", async (t) => {
  const w = world(t, { kinds: ["task"], drafts: [newDraft("P-RESUME")], resume: true });
  await w.approve(["P-RESUME"]);
  const probes = w.calls().filter((call) => call.includes("pulls?head="));
  assert.ok(probes.length > 0, errors(w));
  assert.ok(probes.every((call) => call.includes(`repos/${OPS}/pulls?head=fixture:${approveRunBranch(RESUME_RUN)}`)), probes.join("\n"));
  const adopted = w.rows().find((row) => row.step === "pr.opened" && row.task_id === "P-RESUME");
  assert.equal(adopted?.pr_url, `https://github.com/${OPS}/pull/3`, "the open destination pull request is adopted");
  assert.equal(adopted?.adopted, true);
  assert.equal(posts(w, OPS) + posts(w, PUBLIC), 0, "no second pull request is opened");
});

test("W1-T12214 criterion 5: with no host file, both forms use today's worktree, branch and repository", async (t) => {
  const single = world(t, { drafts: [newDraft("P-OFF")] });
  assert.equal(await single.approve(["P-OFF"]), 1, errors(single));
  const [branch] = single.runBranches(single.publicOrigin);
  assert.match(branch ?? "", /^run-APPROVE-P-OFF-\d+-/);
  assert.equal(posts(single, PUBLIC), 1);
  assert.equal(posts(single, OPS), 0);
  assert.equal(single.opsOrigin.git("for-each-ref", "--format=%(refname)"), "refs/heads/main");
  const batch = world(t, { drafts: [newDraft("P-OFF-A"), newDraft("P-OFF-B")] });
  assert.equal(await batch.approve(["P-OFF-A", "P-OFF-B"]), 1, errors(batch));
  const [batchBranch] = batch.runBranches(batch.publicOrigin);
  assert.equal(batch.changed(batch.publicOrigin, batchBranch!).length, 2);
  assert.equal(posts(batch, PUBLIC), 1);
  assert.equal(batch.opsOrigin.git("for-each-ref", "--format=%(refname)"), "refs/heads/main");
});

test("W1-T12214 criterion 6: the test drives approveCommand and its batch form, the production callers", async (t) => {
  const w = world(t, { kinds: ["task"], drafts: [newDraft("P-ONE"), newDraft("P-TWO"), newDraft("P-THREE")] });
  await w.approve(["P-ONE"]);
  await w.approve(["P-TWO", "P-THREE"]);
  assert.ok(w.rows().some((row) => row.run_id && String(row.run_id).startsWith("APPROVE-P-ONE-") && row.step === "pr.opened"), errors(w));
  assert.ok(w.rows().some((row) => row.run_id && String(row.run_id).startsWith("APPROVE-BATCH-") && row.step === "pr.opened"), errors(w));
  assert.equal(posts(w, OPS), 2);
});
