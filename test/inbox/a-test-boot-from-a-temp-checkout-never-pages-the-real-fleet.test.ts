import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { daemonSreLaneEnabled } from "#src/cli/commands/daemon.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import { escalateSreLaneUnresolved, escalateSreLaneUnresolvedCleared, SRE_LANE_UNRESOLVED_ESCALATED_STEP } from "#src/lib/escalation-catalogue.js";
import { withInstanceRegistryRuntime } from "#src/lib/instance-registry-selection.js";

/**
 * A checkout copied under the temp dir (as the workflow guard mutation ratchet copies one) carries the fleet's own
 * .remudero/daemon-instances.yaml. Under the test runner a boot from it pages nothing; only a registry an env override
 * names under the temp dir is a fixture. Outside the test runner the page is as on origin/main.
 */
const ENV = ["RMD_INSTANCE_NAME", "RMD_INSTANCE_REGISTRY", "RMD_SELECTED_INSTANCE_REGISTRY", "RMD_INSTANCE_REGISTRY_DIGEST",
  "RMD_INSTANCE_REGISTRY_FILE_BINDING", "RMD_SRE_LANE", "TMPDIR", "NODE_TEST_CONTEXT"] as const;
const REGISTRY = ["instances:", "  core:", "    github_repo: craigoley/remudero", "    primary: true", "    state_dir: /srv/host-core-state",
  "  site:", "    github_repo: craigoley/remudero-site", "    state_dir: /srv/host-site-state", ""].join("\n");
const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, stdio: "ignore" });
};

interface Fleet { home: string; ledgerPath: string; issues: IssueGateway; created: string[]; closed: string[] }

function fleet(t: TestContext): Fleet {
  const home = mkdtempSync(join(tmpdir(), "rmd-w1t14722-fleet-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ledgerPath = join(home, "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const created: string[] = [];
  const closed: string[] = [];
  const issues: IssueGateway = {
    create(title, body) {
      created.push(`${title}\n${body}`);
      return `https://github.com/craigoley/remudero/issues/${9200 + created.length}`;
    },
    ensureLabel: () => true,
    closeWithComment(url) { closed.push(url); },
  };
  return { home, ledgerPath, issues, created, closed };
}

/** Two install roots under the temp dir that hold the checked-in one-primary registry: a linked worktree and a copy. */
function checkouts(t: TestContext): { worktree: string; copy: string } {
  const base = mkdtempSync(join(tmpdir(), "rmd-w1t14722-checkout-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".remudero"), { recursive: true });
  writeFileSync(join(repo, ".remudero", "daemon-instances.yaml"), REGISTRY);
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "fixture");
  const worktree = join(base, "worktree");
  git(repo, "worktree", "add", "-q", "--detach", worktree, "HEAD");
  const copy = join(base, "copy");
  mkdirSync(join(copy, ".remudero"), { recursive: true });
  writeFileSync(join(copy, ".remudero", "daemon-instances.yaml"), REGISTRY);
  return { worktree, copy };
}

type Env = Partial<Record<(typeof ENV)[number], string>>;

/** One lane start with the production page bound as daemonCommand binds it; returns the steps it logged. */
async function laneStart(t: TestContext, f: Fleet, installRoot: string, env: Env, opts: { selected?: boolean } = {}): Promise<string[]> {
  const saved = Object.fromEntries(ENV.map((n) => [n, process.env[n]]));
  const restore = (): void => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  t.after(restore);
  for (const name of ENV) if (name !== "TMPDIR" && name !== "NODE_TEST_CONTEXT") delete process.env[name];
  for (const [name, value] of Object.entries(env)) {
    if (value === "") delete process.env[name];
    else process.env[name] = value;
  }
  const ctx = { owner: "craigoley", repo: "remudero", ledgerPath: f.ledgerPath, runId: "DAEMON-14722", issues: f.issues };
  const rows: string[] = [];
  const boot = () => daemonSreLaneEnabled(join(f.home, "laptop-root"), installRoot, (step) => { rows.push(step); }, {
    escalate: (info) => escalateSreLaneUnresolved(info, ctx),
    clear: (info) => escalateSreLaneUnresolvedCleared(info, ctx),
  });
  try {
    if (opts.selected === true) await withInstanceRegistryRuntime(boot);
    else await boot();
  } finally {
    restore();
  }
  return rows;
}

function escalatedRows(f: Fleet): number {
  return readFileSync(f.ledgerPath, "utf8").split("\n").filter(Boolean)
    .filter((line) => (JSON.parse(line) as { step?: string }).step === SRE_LANE_UNRESOLVED_ESCALATED_STEP).length;
}

test("W1-T14722 criterion 1: a test boot from a linked worktree or a copy under the temp dir pages nothing from its own registry", async (t) => {
  const { worktree, copy } = checkouts(t);
  for (const root of [worktree, copy]) {
    const f = fleet(t);
    const rows = await laneStart(t, f, root, {});
    assert.deepEqual(rows, ["sre_lane.disabled"], `${root}: the lane is off with no failure row`);
    assert.deepEqual([f.created.length, f.closed.length], [0, 0], `${root}: no issue opened or closed`);
    assert.equal(escalatedRows(f), 0, `${root}: no sre_lane.unresolved_escalated row`);
  }
});

test("W1-T14722 criterion 2: the same registry named by RMD_INSTANCE_REGISTRY under the temp dir pages once", async (t) => {
  const { copy } = checkouts(t);
  const registry = join(copy, ".remudero", "daemon-instances.yaml");
  const byInstance = fleet(t);
  await laneStart(t, byInstance, copy, { RMD_INSTANCE_REGISTRY: registry });
  assert.deepEqual([byInstance.created.length, escalatedRows(byInstance)], [1, 1], "RMD_INSTANCE_REGISTRY pages once");
  // A selected registry never reaches the unresolved page: the resolver refuses an unresolved target first.
  const bySelected = fleet(t);
  await assert.rejects(laneStart(t, bySelected, copy, { RMD_SELECTED_INSTANCE_REGISTRY: registry }, { selected: true }),
    /target_missing_or_mismatched/);
  assert.equal(bySelected.created.length, 0, "RMD_SELECTED_INSTANCE_REGISTRY refuses and pages nothing, as on origin/main");
  const byDefault = fleet(t);
  await laneStart(t, byDefault, copy, {});
  assert.equal(byDefault.created.length, 0, "the install root's default registry, the same file, pages nothing");
});

test("W1-T14722 criterion 2: an env override that resolves outside the temp dir pages nothing", async (t) => {
  const { copy } = checkouts(t);
  const f = fleet(t);
  const elsewhere = join(f.home, "elsewhere-tmp");
  mkdirSync(elsewhere);
  await laneStart(t, f, copy, { RMD_INSTANCE_REGISTRY: join(copy, ".remudero", "daemon-instances.yaml"), TMPDIR: elsewhere });
  assert.equal(f.created.length, 0);
});

test("W1-T14722 criterion 3: invariant:production-sre-lane-paging-unchanged outside the test runner both registry sources page", async (t) => {
  const { worktree, copy } = checkouts(t);
  const byDefault = fleet(t);
  await laneStart(t, byDefault, worktree, { NODE_TEST_CONTEXT: "" });
  assert.deepEqual([byDefault.created.length, escalatedRows(byDefault)], [1, 1], "the install root's default registry pages as on origin/main");
  const byEnv = fleet(t);
  await laneStart(t, byEnv, copy, { NODE_TEST_CONTEXT: "", RMD_INSTANCE_REGISTRY: join(copy, ".remudero", "daemon-instances.yaml") });
  assert.deepEqual([byEnv.created.length, escalatedRows(byEnv)], [1, 1], "an env-named registry pages as on origin/main");
  const off = fleet(t);
  await laneStart(t, off, worktree, { NODE_TEST_CONTEXT: "", RMD_SRE_LANE: "0" });
  assert.equal(off.created.length, 0, "RMD_SRE_LANE=0 still pages nothing");
});
