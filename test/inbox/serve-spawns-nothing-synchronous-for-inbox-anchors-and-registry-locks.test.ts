// W1-T11128: serve's inbox reads spawned synchronously — `execFileSync git grep` per evidence anchor and
// `execFileSync sleep` per 20 ms registry-lock poll — and stalled the main thread 199 s in 5 minutes. These tests
// record EVERY synchronous child_process call while the served paths run and expect none.
import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { refreshInboxClassification } from "#src/lib/inbox-view.js";
import { anchorFingerprint, updateProposalRegistry, type DraftedCandidate, type Proposal } from "#src/lib/inbox.js";
import type { PanelGraphDeps } from "#src/lib/panel-graph.js";
import { buildStatusBoard, buildStatusBoardAsync, type StatusBoardDeps } from "#src/lib/status-board.js";
import { loadPlanFromYaml } from "#src/lib/plan.js";
import { makeTempDir } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { allowGhRefusals } from "#test/setup/tmp-hygiene.js";

allowGhRefusals("the slow-lane board read lists PRs through gh; this file's shim answers it offline");

/** Record every synchronous child_process entry point (passing through to the real one), and republish the mocked
 *  builtin so inbox.ts's named imports see it. Returns the calls recorded so far. */
function recordSyncSpawns(t: TestContext): { calls: string[] } {
  const calls: string[] = [];
  for (const name of ["execFileSync", "execSync", "spawnSync"] as const) {
    const real = childProcess[name] as (...args: unknown[]) => unknown;
    t.mock.method(childProcess, name, (...args: unknown[]) => {
      calls.push(`${name}:${String(args[0])} ${JSON.stringify(args[1])}`);
      return real(...args);
    });
  }
  syncBuiltinESMExports();
  t.after(() => syncBuiltinESMExports());
  return { calls };
}

function tempRoot(t: TestContext): string {
  const root = makeTempDir("rmd-serve-no-sync-spawn");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  return root;
}

/** A live process that is not this one, standing in for another holder of the registry lock. */
function liveForeignHolder(t: TestContext): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => void child.kill("SIGKILL"));
  return child.pid!;
}

function holdLock(lockPath: string, pid: number): void {
  writeFileSync(lockPath, JSON.stringify({ pid, host: hostname(), startedAt: new Date().toISOString() }));
}

test("a served inbox render reaches no synchronous child_process call: the registry prune awaits updateProposalRegistryAsync", async (t) => {
  const shim = ghShim([{ when: "pulls?state=", stdout: "[]" }, { when: "issues?", stdout: "[]" }]);
  const path = process.env.PATH;
  process.env.PATH = `${shim.dir}:${path}`;
  t.after(() => void (process.env.PATH = path));
  const root = tempRoot(t);
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify({ ts: "2026-10-01T01:00:00.000Z", step: "ratify.approved", task_id: "ruling:done" })}\n`);
  const registry = join(root, "state", "inbox-proposals.json");
  writeFileSync(registry, JSON.stringify({ proposals: ["ruling:done", "ruling:open"].map((id) => ({ id, summary: `about ${id}`, evidenceAnchors: [] })) }));
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath,
    github: { prView: () => null },
    statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => "a".repeat(40),
    inboxGrepAnchor: () => true,
  };
  // A live foreign holder of the registry lock that lets go shortly: the prune must wait it out WITHOUT blocking.
  const lockPath = `${registry}.lock`;
  holdLock(lockPath, liveForeignHolder(t));
  const release = setTimeout(() => unlinkSync(lockPath), 120);
  t.after(() => clearTimeout(release));

  const spawns = recordSyncSpawns(t);
  let ticks = 0;
  const heartbeat = setInterval(() => void (ticks += 1), 10);
  t.after(() => clearInterval(heartbeat));
  const refreshed = await refreshInboxClassification(deps, {});
  clearInterval(heartbeat);

  assert.equal(refreshed.pruned, 1, "the ratified proposal is pruned");
  assert.deepEqual((JSON.parse(readFileSync(registry, "utf8")) as { proposals: Proposal[] }).proposals.map((p) => p.id), ["ruling:open"]);
  assert.deepEqual(spawns.calls, [], "no synchronous child_process call during the served render");
  assert.ok(ticks >= 3, `the event loop kept turning while the lock was held (ticks: ${ticks})`);
});

const PLAN_YAML = `
- id: W1-T910
  title: a queue-head candidate
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`;

/** A drafted RELEASE candidate for each proposal: the readiness pass reaches the anchor grep for it and for nothing earlier. */
function draftsFor(proposals: Proposal[]): Record<string, DraftedCandidate> {
  return Object.fromEntries(proposals.map((p) => [p.id, {
    proposalId: p.id, releaseTaskId: "W1-T910", fragmentYaml: "", stampLine: "", anchorFingerprint: anchorFingerprint(p.evidenceAnchors),
  }]));
}

function boardDeps(repoDir: string, proposals: Proposal[]): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir,
    now: () => Date.parse("2026-08-01T12:00:00.000Z"),
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    // The board's own pushed-branch sweep is another sync git read and not this task's subject; keep it out of the record.
    readPushedRunBranches: () => "",
    plan: loadPlanFromYaml(PLAN_YAML, "fixture"),
    github: fakeGitHub(),
    readProposalRegistry: () => proposals,
    readDraftCache: () => draftsFor(proposals),
  };
}

test("a served status board answers INBOX's evidence anchors off the loop with the sync board's results", async (t) => {
  const repo = gitRepo({ kind: "serve-anchor" });
  t.after(() => repo.cleanup());
  writeFileSync(join(repo.dir, "anchor.txt"), "the-present-anchor\n");
  repo.git("add", "anchor.txt");
  repo.git("commit", "--quiet", "-m", "anchor");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const present: Proposal[] = [{ id: "P1", summary: "first", evidenceAnchors: [{ description: "present", pattern: "the-present-anchor", path: "anchor.txt" }] }];
  const absent: Proposal[] = [{ id: "P2", summary: "second", evidenceAnchors: [{ description: "absent", pattern: "the-absent-anchor", path: "anchor.txt" }] }];
  const root = tempRoot(t);
  const ledger = join(root, "none.ndjson");
  const expected = [present, absent].map((proposals) => buildStatusBoard(root, ledger, boardDeps(repo.dir, proposals)).inbox);

  const spawns = recordSyncSpawns(t);
  const actual = [];
  for (const proposals of [present, absent]) actual.push((await buildStatusBoardAsync(root, ledger, boardDeps(repo.dir, proposals))).inbox);

  // The board's own dispatch-claim and pause reads shell `git ls-remote` synchronously; they are not INBOX's anchor
  // check and not this task's subject, so the record is narrowed to the anchor grep.
  assert.deepEqual(spawns.calls.filter((call) => call.includes('"grep"')), [], "no synchronous `git grep` while the board reads its anchors");
  assert.deepEqual(actual, expected, "the same INBOX sections the sync board answers");
  assert.match(actual[1]!.headNotReadyReason ?? "", /evidence-drifted/, "an absent anchor still reads as drifted");
  assert.doesNotMatch(actual[0]!.headNotReadyReason ?? "", /evidence-drifted/, "a present anchor does not");
});

test("a served status board rethrows a failed anchor grep where the sync board would have thrown", async (t) => {
  const root = tempRoot(t);
  const notARepo = makeTempDir("rmd-serve-not-a-repo");
  t.after(() => rmSync(notARepo, { recursive: true, force: true }));
  const proposals: Proposal[] = [{ id: "P1", summary: "first", evidenceAnchors: [{ description: "any", pattern: "x", path: "a.txt" }] }];
  await assert.rejects(
    buildStatusBoardAsync(root, join(root, "none.ndjson"), boardDeps(notARepo, proposals)),
    (err: Error & { code?: number }) => err.code === 128 || /git/i.test(err.message),
  );
});

test("W1-T11128 criterion 2: the synchronous registry lock's poll starts no process and keeps its deadline", (t) => {
  const root = tempRoot(t);
  const registry = join(root, "state", "inbox-proposals.json");
  writeFileSync(registry, JSON.stringify({ proposals: [] }));
  holdLock(`${registry}.lock`, liveForeignHolder(t));

  const spawns = recordSyncSpawns(t);
  const started = Date.now();
  assert.throws(
    () => updateProposalRegistry(registry, () => null, { maxWaitMs: 150, pollIntervalMs: 20 }),
    /updateProposalRegistry: timed out after 150ms waiting for .* \(held by pid \d+\)/,
  );
  const elapsed = Date.now() - started;

  assert.deepEqual(spawns.calls, [], "no `sleep` child per poll");
  assert.ok(elapsed >= 140, `the bounded wait still waits (elapsed ${elapsed}ms)`);
  assert.ok(elapsed < 2000, `and still gives up at its deadline (elapsed ${elapsed}ms)`);
});

test("W1-T11128 criterion 2: the synchronous writer still updates an uncontended registry", (t) => {
  const root = tempRoot(t);
  const registry = join(root, "state", "inbox-proposals.json");
  writeFileSync(registry, JSON.stringify({ proposals: [{ id: "A", summary: "a", evidenceAnchors: [] }] }));
  const result = updateProposalRegistry(registry, (current) => [...current, { id: "B", summary: "b", evidenceAnchors: [] }]);
  assert.deepEqual(result?.map((p) => p.id), ["A", "B"]);
});
