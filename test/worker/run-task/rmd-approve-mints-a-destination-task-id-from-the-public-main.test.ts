import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { approveCommand } from "#test/helpers/run-task-test.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T13050: a destination approve mints its task ids from the public origin/main it fetched, never from the
// long-lived public clone's checked-out main, which no lane keeps current.
const OPS = "fixture/remudero-ops";
const PUBLIC = "craigoley/remudero";
// Merged on the public origin after the clone's main was last moved: the newest id is W1-T40.
const LATE_SHARD = "plan/tasks.d/W1-T40-a-task-merged-after-the-clone-was-last-moved.yaml";
type Row = Record<string, unknown>;

function task(id: string, title: string): string {
  return `- id: ${id}\n  title: ${title}\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: human\n  status: queued\n  attempts: 0\n`;
}

const TITLES: Record<string, string> = {
  "P-NEW": "rotate the nightly backup key", "P-A": "rename the cache sweep timer", "P-B": "count stale lane leases hourly",
  "P-SAME": "measure disk headroom on boot", "P-DOWN": "trim the ledger archive weekly", "P-OFF": "probe the broker socket",
};
const newDraft = (id: string) => ({
  proposalId: id, anchorFingerprint: "", stampLine: `- ${id} (plan) — RATIFIED -> NEW-1.`,
  fragmentYaml: `- id: NEW-1\n  title: ${TITLES[id]}\n  repo: remudero\n  type: implement\n  verify: auto\n  origin: architect\n` +
    `  files: [src/lib/plan.ts]\n  design: "NO-INVARIANTS: a fixture task."\n` +
    // A new `verify: auto` implement task needs one criterion (shard-shape, promoted to block on a draft).
    `  acceptance:\n    - claim: the approval files its task\n      proof: 'unit test: the approval files its task'\n`,
});

interface World {
  root: string; publicOrigin: GitRepo; opsOrigin: GitRepo; publicClone: GitRepo; publicCheckout: string;
  approve(ids: string[]): Promise<number | string>;
  rows(): Row[];
  runBranches(origin: GitRepo): string[];
}

function world(t: TestContext, opts: { kinds?: string[]; ids: string[] }): World {
  const root = ownedFixtureDir(t, "approve-public-main").dir;
  const home = join(root, "home");
  const publicOrigin = gitRepo({ bare: true, scope: t });
  const opsOrigin = gitRepo({ bare: true, scope: t });
  const seed = gitRepo({ scope: t });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  mkdirSync(join(seed.dir, "src", "lib"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), task("W1-T4", "a seed task the plan loader accepts"));
  writeFileSync(join(seed.dir, "MASTER-PLAN.md"), "# MASTER PLAN\n\nfixture\n");
  writeFileSync(join(seed.dir, "src", "lib", "plan.ts"), "");
  seed.git("add", "-A"); seed.git("commit", "--quiet", "-m", "chore: seed the public plan");
  seed.addRemote("origin", publicOrigin.dir); seed.git("push", "--quiet", "origin", "main");
  const opsSeed = gitRepo({ scope: t });
  mkdirSync(join(opsSeed.dir, "plan"), { recursive: true });
  writeFileSync(join(opsSeed.dir, "plan", "tasks.yaml"), "[]\n");
  opsSeed.git("add", "-A"); opsSeed.git("commit", "--quiet", "-m", "chore: seed the ops plan");
  opsSeed.addRemote("origin", opsOrigin.dir); opsSeed.git("push", "--quiet", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const clones: Record<string, GitRepo> = {};
  for (const [origin, name] of [[publicOrigin, "remudero"], [opsOrigin, "remudero-ops"]] as const) {
    const clone = gitRepo({ cloneFrom: origin.dir, scope: t });
    clone.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
    clone.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
    clone.git("worktree", "add", "--quiet", "--detach", join(root, "repos", name), "main");
    clones[name] = clone;
  }
  // A plan merge lands on the public origin. The clone fetched it, but its checked-out main did not move.
  writeFileSync(join(seed.dir, LATE_SHARD), task("W1-T40", "a task merged after the clone was last moved"));
  seed.git("add", "-A"); seed.git("commit", "--quiet", "-m", "chore(plan): file W1-T40");
  seed.git("push", "--quiet", "origin", "main");
  clones.remudero.git("fetch", "--quiet", "origin");

  const config = { claudeBin: "/usr/bin/true", root, installRoot: REPO_ROOT };
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify(config));
  mkdirSync(join(root, "state"), { recursive: true });
  if (opts.kinds) writeFileSync(join(root, "state", "plan-destination.json"), JSON.stringify({ repository: OPS, kinds: opts.kinds }));
  const drafts = opts.ids.map(newDraft);
  writeFileSync(join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: drafts.map((d) => ({ id: d.proposalId, summary: `approve ${d.proposalId}`, evidenceAnchors: [] })) }));
  writeFileSync(join(root, "state", "inbox-drafts.json"), JSON.stringify(Object.fromEntries(drafts.map((d) => [d.proposalId, d]))));
  const ledger = join(root, "state", "ledger.ndjson");
  writeFileSync(ledger, "");

  const routes: GhShimRoute[] = [
    { when: `api --method POST repos/${OPS}/pulls`, stdout: JSON.stringify({ html_url: `https://github.com/${OPS}/pull/1`, number: 1 }) },
    { when: `api --method POST repos/${PUBLIC}/pulls`, stdout: JSON.stringify({ html_url: `https://github.com/${PUBLIC}/pull/2`, number: 2 }) },
  ];
  for (const side of [{ origin: publicOrigin, repository: PUBLIC, n: 2 }, { origin: opsOrigin, repository: OPS, n: 1 }]) {
    const info = join(root, `${side.repository.replace("/", "-")}-pr.json`);
    const view = join(root, `${side.repository.replace("/", "-")}-head.json`);
    const q = (path: string) => "'" + path.replaceAll("'", "'\"'\"'") + "'";
    writeFileSync(join(side.origin.dir, "hooks", "post-receive"), ["#!/bin/sh", "while read old new ref; do",
      'case "$ref" in refs/heads/run-*)', 'b="${ref#refs/heads/}"',
      `printf '{"number":1,"state":"open","merged_at":null,"head":{"sha":"%s","ref":"%s"},"base":{"ref":"main"}}\\n' "$new" "$b" > ${q(info)}`,
      `printf '{"headRefName":"%s"}\\n' "$b" > ${q(view)} ;;`, "esac", "done", ""].join("\n"), { mode: 0o700 });
    routes.push({ when: `${side.repository}/pull/${side.n} --json headRefName`, stdoutFile: view });
    routes.push({ when: `repos/${side.repository}/pulls/${side.n}`, stdoutFile: info });
  }
  routes.push({ when: "pulls?state=open", stdout: "[]" }, { when: "pulls?head=", stdout: "[]" },
    // A terminal-red CI answer stops the command before any review or merge.
    { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] }) },
    { when: "/status", stdout: JSON.stringify({ statuses: [] }) });
  const shim = ghShim(routes, { kind: "approve-public-main-gh" });
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  return {
    root, publicOrigin, opsOrigin, publicClone: clones.remudero, publicCheckout: join(root, "repos", "remudero"),
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
    rows: () => readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row),
    runBranches: (origin) => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads/run-*").split("\n").filter(Boolean),
  };
}

const errors = (w: World) => w.rows().filter((row) => row.step === "approve.error");
const minted = (w: World) => w.rows().filter((row) => row.step === "approve.id_materialized").flatMap((row) => row.ids as string[]);
const reserved = (origin: GitRepo) => origin.git("for-each-ref", "--format=%(refname)", "refs/rmd-id/").split("\n").filter(Boolean);
const idNumber = (id: string) => Number(/^W1-T(\d+)$/.exec(id)?.[1] ?? Number.NaN);

/** What the approve must leave alone in the public clone: its HEAD commit, its branch, its working tree, its trees. */
function cloneState(w: World): string {
  const at = (args: string[]) => w.publicClone.git("-C", w.publicCheckout, ...args);
  return JSON.stringify({
    head: at(["rev-parse", "HEAD"]),
    branch: at(["rev-parse", "--abbrev-ref", "HEAD"]),
    status: at(["status", "--porcelain", "--untracked-files=all"]),
    trees: w.publicClone.git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")),
  });
}

test("W1-T13050 criterion 1: a single approve with a behind public clone mints and reserves an id above origin/main's", async (t) => {
  const w = world(t, { kinds: ["task"], ids: ["P-NEW"] });
  await w.approve(["P-NEW"]);
  assert.equal(errors(w).length, 0, JSON.stringify(errors(w)));
  const ids = minted(w);
  assert.equal(ids.length, 1);
  assert.ok(idNumber(ids[0]) > 40, `minted ${ids[0]}, origin/main already holds W1-T40`);
  assert.ok(reserved(w.publicOrigin).includes(`refs/rmd-id/${ids[0]}`), "the id is reserved in the public origin");
  assert.equal(w.runBranches(w.opsOrigin).length, 1, "the task file goes to the destination");
});

test("W1-T13050 criterion 2: the batch form mints two different ids above origin/main's and reserves both", async (t) => {
  const w = world(t, { kinds: ["task"], ids: ["P-A", "P-B"] });
  await w.approve(["P-A", "P-B"]);
  assert.equal(errors(w).length, 0, JSON.stringify(errors(w)));
  const ids = minted(w);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) {
    assert.ok(idNumber(id) > 40, `minted ${id}, origin/main already holds W1-T40`);
    assert.ok(reserved(w.publicOrigin).includes(`refs/rmd-id/${id}`), `${id} is reserved in the public origin`);
  }
});

test("W1-T13050 criterion 3: the approve leaves the public clone's HEAD, branch and working tree as it found them", async (t) => {
  const w = world(t, { kinds: ["task"], ids: ["P-SAME"] });
  const before = cloneState(w);
  await w.approve(["P-SAME"]);
  assert.equal(errors(w).length, 0, JSON.stringify(errors(w)));
  assert.equal(minted(w).length, 1);
  assert.equal(cloneState(w), before);
});

test("W1-T13050 criterion 4: an unreadable public origin/main refuses, names the public plan, writes and reserves nothing", async (t) => {
  const w = world(t, { kinds: ["task"], ids: ["P-DOWN"] });
  w.publicClone.git("remote", "set-url", "origin", join(w.root, "no-such-origin.git"));
  await w.approve(["P-DOWN"]);
  const refusals = errors(w);
  assert.equal(refusals.length, 1, JSON.stringify(w.rows().map((row) => row.step)));
  assert.match(String(refusals[0].error), /^rmd approve: refusing to mint task id\(s\)/);
  assert.match(String(refusals[0].error), /the public plan \(craigoley\/remudero origin\/main\) cannot be read/);
  assert.equal(minted(w).length, 0);
  assert.equal(w.rows().filter((row) => row.step === "approve.shards_written").length, 0, "no shard is written");
  assert.equal(reserved(w.publicOrigin).length, 0, "no id is reserved");
  assert.equal(w.runBranches(w.opsOrigin).length, 0);
});

test("W1-T13050 criterion 5: with no host file, the approve mints from its own worktree at origin/main as before", async (t) => {
  const w = world(t, { ids: ["P-OFF"] });
  await w.approve(["P-OFF"]);
  assert.equal(errors(w).length, 0, JSON.stringify(errors(w)));
  assert.deepEqual(minted(w), ["W1-T41"]);
  const [branch] = w.runBranches(w.publicOrigin);
  assert.match(branch ?? "", /^run-APPROVE-P-OFF-\d+-/);
  const added = w.rows().filter((row) => row.step === "worktree.add");
  assert.equal(added.length, 1, "one worktree, the approve's own");
  assert.equal(String(added[0].branch), branch);
  assert.equal(w.opsOrigin.git("for-each-ref", "--format=%(refname)"), "refs/heads/main");
});
