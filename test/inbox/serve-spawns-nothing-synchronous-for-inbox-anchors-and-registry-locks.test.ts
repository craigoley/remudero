// W1-T11128: serve's inbox reads spawned synchronously — `execFileSync git grep` per evidence anchor and
// `execFileSync sleep` per 20 ms registry-lock poll — and stalled the main thread 199 s in 5 minutes. These tests
// record EVERY synchronous child_process call while the served paths run and expect none.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { DraftedCandidate, Proposal } from "#src/lib/inbox.js";
import type { PanelGraphDeps } from "#src/lib/panel-graph.js";
import type { StatusBoardDeps } from "#src/lib/status-board.js";
import type { Config } from "#src/lib/config.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type SpawnRecord = { calls: string[]; asyncCalls: string[] };
const recording = globalThis as typeof globalThis & { inboxSpawnRecord?: SpawnRecord; inboxPsProbe?: (pid: number) => string | Error };

if (!process.argv.includes("--inbox-preimport-probe")) {
  test("the inbox spawn proofs run in a fresh process instrumented before all dependency imports", async (t) => {
    // tmp-hygiene itself imports fs-race-safe. Instrument BEFORE even that preload so a captured
    // defaultProcessStartTimeSyscalls.execFileSync cannot escape the recorder.
    const preload = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      for (const name of ['execFileSync', 'execSync', 'spawnSync', 'execFile']) {
        const real = cp[name];
        cp[name] = function (...args) {
          const record = globalThis.inboxSpawnRecord;
          if (record) (name === 'execFile' ? record.asyncCalls : record.calls)
            .push(name + ':' + String(args[0]) + ' ' + JSON.stringify(args[1]));
          if (args[0] === 'ps' && globalThis.inboxPsProbe) {
            const answer = globalThis.inboxPsProbe(Number(args[1].at(-1)));
            if (name === 'execFile') {
              queueMicrotask(() => args.at(-1)(answer instanceof Error ? answer : null,
                answer instanceof Error ? '' : answer));
              return {};
            }
            if (answer instanceof Error) throw answer;
            return answer;
          }
          return real.apply(this, args);
        };
      }
      syncBuiltinESMExports();
    `;
    const child = spawn(process.execPath, [
      "--test-reporter=tap",
      "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
      "--import", "tsx", "--import", join(REPO_ROOT, "test/setup/tmp-hygiene.ts"),
      join(REPO_ROOT, "test/inbox/serve-spawns-nothing-synchronous-for-inbox-anchors-and-registry-locks.test.ts"),
      "--inbox-preimport-probe",
    ], {
      cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"],
      // Inheriting child-v8 would serialize test events to our stdout pipe instead of TAP.
      env: { ...process.env, NODE_TEST_CONTEXT: "test-setup" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    t.diagnostic(stdout.split("\n").filter((line) => /^# (tests|pass|fail) /.test(line)).join("; "));
    assert.equal(code, 0, `fresh-process proofs failed:\n${stdout}\n${stderr}`);
    assert.match(stdout, /# tests [1-9][0-9]*/);
    assert.match(stdout, /# fail 0/);
  });
} else {
const { refreshInboxClassification } = await import("#src/lib/inbox-view.js");
const { anchorFingerprint, updateProposalRegistry, updateProposalRegistryAsync } = await import("#src/lib/inbox.js");
const { buildStatusBoard, buildStatusBoardAsync } = await import("#src/lib/status-board.js");
const { statusCommand } = await import("#src/lib/report-commands.js");
const { loadPlanFromYaml } = await import("#src/lib/plan.js");
const { makeTempDir } = await import("#src/lib/tmp.js");
const { gitRepo } = await import("#test/helpers/git-repo.js");
const { fakeGitHub } = await import("#test/helpers/fake-github.js");
const { ghShim } = await import("#test/helpers/gh-shim.js");
const { allowGhRefusals } = await import("#test/setup/tmp-hygiene.js");
const { defaultGetProcessStartTime } = await import("#src/lib/fs-race-safe.js");

allowGhRefusals("the slow-lane board read lists PRs through gh; this file's shim answers it offline");

/** Activate the already-installed recorder only for the operation under test, excluding fixture setup. */
function recordSyncSpawns(t: TestContext): SpawnRecord {
  const record: SpawnRecord = { calls: [], asyncCalls: [] };
  recording.inboxSpawnRecord = record;
  t.after(() => { delete recording.inboxSpawnRecord; });
  return record;
}

test("the pre-import recorder catches fs-race-safe's captured synchronous ps syscall", (t) => {
  const spawns = recordSyncSpawns(t);
  defaultGetProcessStartTime(process.pid);
  assert.ok(spawns.calls.some((call) => call.startsWith("execFileSync:ps ")), spawns.calls.join("\n"));
});

const isGitGrep = (call: string): boolean => call.startsWith("execFile:git ") && call.includes('"grep"');

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

for (const resolvedMain of [true, false]) {
test(`a served inbox render reaches no synchronous child_process call: the registry prune awaits updateProposalRegistryAsync (${resolvedMain ? "resolved" : "unresolved"} main sha)`, async (t) => {
  const shim = ghShim([{ when: "pulls?state=", stdout: "[]" }, { when: "issues?", stdout: "[]" }]);
  const path = process.env.PATH;
  process.env.PATH = `${shim.dir}:${path}`;
  t.after(() => void (process.env.PATH = path));
  // The root is a REAL git repo and `inboxGrepAnchor` is NOT stubbed: the production anchor reader runs, so the
  // test fails if the served classifier still greps its anchors with the sync `git grep`.
  const repo = gitRepo({ kind: "serve-render" });
  t.after(() => repo.cleanup());
  writeFileSync(join(repo.dir, "anchor.txt"), "the-present-anchor\n");
  repo.git("add", "anchor.txt");
  repo.git("commit", "--quiet", "-m", "anchor");
  const mainSha = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const root = repo.dir;
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify({ ts: "2026-10-01T01:00:00.000Z", step: "ratify.approved", task_id: "ruling:done" })}\n`);
  const registry = join(root, "state", "inbox-proposals.json");
  const evidenceAnchors = [{ description: "present", pattern: "the-present-anchor", path: "anchor.txt" }];
  writeFileSync(registry, JSON.stringify({ proposals: ["ruling:done", "ruling:open"].map((id) => ({ id, summary: `about ${id}`, evidenceAnchors })) }));
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath,
    github: { prView: () => null },
    statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => resolvedMain ? mainSha : undefined,
  };
  // A live foreign holder of the registry lock. The release is driven by the loop itself, not a wall clock: the lock
  // lets go only once the prune has been REFUSED the lock at least once and the loop has then ticked 3 times. A
  // blocked loop never ticks, never releases, and the prune's 2000 ms deadline rejects the render — so the assertion
  // cannot be raced by a loaded host the way a fixed-delay release could (it flaked at ticks: 2).
  const lockPath = `${registry}.lock`;
  holdLock(lockPath, liveForeignHolder(t));
  let refusals = 0;
  const realOpen = fs.promises.open.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
  t.mock.method(fs.promises, "open", async (...args: unknown[]) => {
    try {
      return await realOpen(...args);
    } catch (err) {
      if (args[0] === lockPath && (err as NodeJS.ErrnoException).code === "EEXIST") refusals += 1;
      throw err;
    }
  });

  const spawns = recordSyncSpawns(t);
  let ticks = 0;
  const heartbeat = setInterval(() => {
    if (refusals === 0) return;
    ticks += 1;
    if (ticks === 3) unlinkSync(lockPath);
  }, 10);
  t.after(() => clearInterval(heartbeat));
  const refreshed = await refreshInboxClassification(deps, {});
  clearInterval(heartbeat);

  assert.equal(refreshed.pruned, 1, "the ratified proposal is pruned");
  assert.deepEqual((JSON.parse(readFileSync(registry, "utf8")) as { proposals: Proposal[] }).proposals.map((p) => p.id), ["ruling:open"]);
  assert.deepEqual(spawns.calls, [], "no synchronous child_process call during the served render");
  assert.ok(spawns.asyncCalls.some(isGitGrep), `the evidence anchor was read through the async git grep (async calls: ${spawns.asyncCalls.join(" | ")})`);
  assert.ok(refusals >= 1, "the prune met the held lock and waited rather than finding it free");
  assert.ok(ticks >= 3, `the event loop kept turning while the lock was held (ticks: ${ticks})`);
});
}

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
    readSharedPauseState: () => "absent",
    readDispatchClaims: () => ({ status: "clear" }),
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

  assert.deepEqual(spawns.calls, [], "no synchronous child_process call while the board reads its anchors");
  assert.ok(spawns.asyncCalls.some(isGitGrep), "the board really read its anchors asynchronously");
  assert.deepEqual(actual, expected, "the same INBOX sections the sync board answers");
  assert.match(actual[1]!.headNotReadyReason ?? "", /evidence-drifted/, "an absent anchor still reads as drifted");
  assert.doesNotMatch(actual[0]!.headNotReadyReason ?? "", /evidence-drifted/, "a present anchor does not");
});

test("the production statusCommand reads INBOX's evidence anchors through the async grep, not the sync one", async (t) => {
  const repo = gitRepo({ kind: "status-command-anchor" });
  t.after(() => repo.cleanup());
  writeFileSync(join(repo.dir, "anchor.txt"), "the-present-anchor\n");
  repo.git("add", "anchor.txt");
  repo.git("commit", "--quiet", "-m", "anchor");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const root = tempRoot(t);
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [
    { id: "P1", summary: "first", evidenceAnchors: [{ description: "present", pattern: "the-present-anchor", path: "anchor.txt" }] },
  ] }));

  const spawns = recordSyncSpawns(t);
  const lines: string[] = [];
  const rc = await statusCommand([], {
    loadConfig: () => ({ claudeBin: "/nonexistent/claude", root }) as Config,
    queryService: () => ({ running: false, pid: null }),
    ledgerPathFor: () => join(root, "none.ndjson"),
    repoRoot: repo.dir,
    github: null,
    out: (l) => lines.push(l),
  });

  assert.equal(rc, 0);
  assert.equal(lines.length, 1);
  // The command's other reads (origin/main resolution, pushed-branch sweep, pause state) are sync git reads of their
  // own and not INBOX's anchor check, so the record is narrowed to the anchor grep.
  assert.deepEqual(spawns.calls.filter((call) => call.includes('"grep"')), [], "no synchronous `git grep` in the status command");
  assert.ok(spawns.asyncCalls.some(isGitGrep), `the anchor was read through the async git grep (async calls: ${spawns.asyncCalls.join(" | ")})`);
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

test("W1-T11128 criterion 2: the synchronous registry lock polls without a sleep process and keeps its deadline", (t) => {
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

  assert.deepEqual(spawns.calls.filter((call) => !call.startsWith("execFileSync:ps ")), [],
    "polling starts no child except the preserved portable identity probe");
  assert.ok(spawns.calls.some((call) => call.startsWith("execFileSync:ps ")), "the CLI retains its portable probe");
  assert.ok(elapsed >= 140, `the bounded wait still waits (elapsed ${elapsed}ms)`);
});

test("W1-T11128 criterion 2: the synchronous writer still updates an uncontended registry", (t) => {
  const root = tempRoot(t);
  const registry = join(root, "state", "inbox-proposals.json");
  writeFileSync(registry, JSON.stringify({ proposals: [{ id: "A", summary: "a", evidenceAnchors: [] }] }));
  const result = updateProposalRegistry(registry, (current) => [...current, { id: "B", summary: "b", evidenceAnchors: [] }]);
  assert.deepEqual(result?.map((p) => p.id), ["A", "B"]);
});

test("both registry writers reclaim stale locks with /proc absent through the portable identity probe", async (t) => {
  for (const writer of [updateProposalRegistry, updateProposalRegistryAsync]) {
    for (const cause of ["reused-pid", "previous-boot", "dead-pid"] as const) {
      await t.test(`${writer.name}: ${cause}`, async (t) => {
        const root = tempRoot(t);
        const registry = join(root, "state", "inbox-proposals.json");
        const pid = 123456;
        const now = Date.now();
        writeFileSync(`${registry}.lock`, JSON.stringify({ pid, host: hostname(), startedAt: new Date(now - 60_000).toISOString() }));
        const read = fs.readFileSync.bind(fs) as (...args: unknown[]) => unknown;
        t.mock.method(fs, "readFileSync", (...args: unknown[]) => {
          if (typeof args[0] === "string" && args[0].startsWith("/proc/")) {
            throw Object.assign(new Error("proc absent"), { code: "ENOENT" });
          }
          return read(...args);
        });
        assert.throws(() => fs.readFileSync("/proc/stat"), { code: "ENOENT" });
        recording.inboxPsProbe = (p) => p === 1 ? (cause === "previous-boot" ? "00:10" : "10:00") : "00:10";
        t.after(() => { delete recording.inboxPsProbe; });
        const spawns = recordSyncSpawns(t);
        const result = await writer(registry, () => [{ id: "landed", summary: "landed", evidenceAnchors: [] }], {
          maxWaitMs: 2000, isPidAlive: () => cause !== "dead-pid",
        });
        assert.deepEqual(result?.map((p) => p.id), ["landed"]);
        assert.deepEqual(JSON.parse(readFileSync(registry, "utf8")).proposals.map((p: Proposal) => p.id), ["landed"]);
        assert.equal(fs.existsSync(`${registry}.lock`), false, "the reclaimed lock is released after the update");
        if (writer === updateProposalRegistryAsync) assert.deepEqual(spawns.calls, [], "the served writer never probes synchronously");
        const probes = writer === updateProposalRegistryAsync ? spawns.asyncCalls : spawns.calls;
        assert.ok(probes.some((call) => call.includes(":ps ")), "portable identity was actually probed");
      });
    }
  }
});

test("an unavailable portable identity preserves a live holder", async (t) => {
  for (const writer of [updateProposalRegistry, updateProposalRegistryAsync]) {
    for (const answer of [new Error("ps unavailable"), "unrecognized elapsed time"]) {
      await t.test(`${writer.name}: ${String(answer)}`, async (t) => {
        const root = tempRoot(t);
        const registry = join(root, "state", "inbox-proposals.json");
        holdLock(`${registry}.lock`, process.pid);
        const original = readFileSync(`${registry}.lock`, "utf8");
        recording.inboxPsProbe = () => answer;
        t.after(() => { delete recording.inboxPsProbe; });
        const spawns = recordSyncSpawns(t);
        let updates = 0;
        await assert.rejects(async () => writer(registry, () => { updates += 1; return []; }, { maxWaitMs: 40, pollIntervalMs: 5 }), /timed out after 40ms/);
        assert.equal(updates, 0, "unknown identity cannot authorize a write");
        assert.equal(readFileSync(`${registry}.lock`, "utf8"), original, "the live lock stays intact");
        if (writer === updateProposalRegistryAsync) assert.deepEqual(spawns.calls, []);
      });
    }
  }
});

test("W1-T11128 criterion 2: served INBOX anchors make no execFileSync or execFile calls at a cold and reset 20,000-entry cache", async (t) => {
  for (const count of [19_999, 20_000, 20_001]) {
    for (const present of [true, false]) {
      await t.test(`${count} distinct anchors: ${present ? "present" : "drifted"}`, async (t) => {
        const root = tempRoot(t);
        const proposals: Proposal[] = [{ id: "many", summary: "many", evidenceAnchors: Array.from({ length: count }, (_, i) => ({
          description: `anchor ${i}`, pattern: `anchor-${i}`, path: "anchors.txt",
        })) }];
        const deps = boardDeps(root, proposals);
        const expected = buildStatusBoard(root, join(root, "none.ndjson"), {
          ...deps, grepAnchorTrue: (anchor) => present || anchor !== proposals[0].evidenceAnchors.at(-1),
        }).inbox;
        const visited = new Set<string>();
        const spawns = recordSyncSpawns(t);
        const board = await buildStatusBoardAsync(root, join(root, "none.ndjson"), {
          ...deps, grepAnchorTrueAsync: async (anchor) => {
            visited.add(anchor.pattern);
            return present || anchor !== proposals[0].evidenceAnchors.at(-1);
          },
        });
        assert.equal(visited.size, count, "every distinct anchor was read asynchronously before classification");
        assert.deepEqual(board.inbox, expected, "cache reset and overflow preserve the sync board's results");
        assert.deepEqual(spawns.calls, [], "W1-T11128 criterion 2: no synchronous child_process call on the served path");
        assert.deepEqual(spawns.asyncCalls, [], "classification never falls back to an execFile call");
        if (!present) assert.match(board.inbox.headNotReadyReason ?? "", /evidence-drifted/);
      });
    }
  }
});

test("a served status board whose registry changes between reads still greps no anchor synchronously (review of #16432)", async (t) => {
  const repo = gitRepo({ kind: "serve-anchor-registry-change" });
  t.after(() => repo.cleanup());
  writeFileSync(join(repo.dir, "anchor.txt"), "the-present-anchor\n");
  repo.git("add", "anchor.txt");
  repo.git("commit", "--quiet", "-m", "anchor");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const first: Proposal[] = [{ id: "P1", summary: "first", evidenceAnchors: [{ description: "present", pattern: "the-present-anchor", path: "anchor.txt" }] }];
  // The registry a second read would see: a proposal whose anchor the warm pass never read.
  const changed: Proposal[] = [...first, { id: "P2", summary: "second", evidenceAnchors: [{ description: "added", pattern: "an-anchor-added-mid-render", path: "anchor.txt" }] }];
  let reads = 0;
  const root = tempRoot(t);
  const deps: StatusBoardDeps = {
    ...boardDeps(repo.dir, first),
    readProposalRegistry: () => (reads++ === 0 ? first : changed),
    readDraftCache: () => draftsFor(changed),
  };

  const spawns = recordSyncSpawns(t);
  const board = await buildStatusBoardAsync(root, join(root, "none.ndjson"), deps);

  assert.equal(reads, 1, "one registry read serves both the warm and the board");
  assert.deepEqual(spawns.calls, [], "no synchronous child_process call for an anchor the registry gained mid-render");
  assert.ok(spawns.asyncCalls.some(isGitGrep), `the anchor was read through the async git grep (async calls: ${spawns.asyncCalls.join(" | ")})`);
  assert.deepEqual(board.inbox, buildStatusBoard(root, join(root, "none.ndjson"), boardDeps(repo.dir, first)).inbox,
    "the board answers the snapshot the warm read");
});

test("a served registry prune that misses its deadline keeps the sync prune's refusal words (review of #16432)", async (t) => {
  const shim = ghShim([{ when: "pulls?state=", stdout: "[]" }, { when: "issues?", stdout: "[]" }]);
  const path = process.env.PATH;
  process.env.PATH = `${shim.dir}:${path}`;
  t.after(() => void (process.env.PATH = path));
  const repo = gitRepo({ kind: "serve-prune-deadline" });
  t.after(() => repo.cleanup());
  writeFileSync(join(repo.dir, "anchor.txt"), "the-present-anchor\n");
  repo.git("add", "anchor.txt");
  repo.git("commit", "--quiet", "-m", "anchor");
  const mainSha = repo.git("rev-parse", "HEAD");
  const root = repo.dir;
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify({ ts: "2026-10-01T01:00:00.000Z", step: "ratify.approved", task_id: "ruling:done" })}\n`);
  const registry = join(root, "state", "inbox-proposals.json");
  const evidenceAnchors = [{ description: "present", pattern: "the-present-anchor", path: "anchor.txt" }];
  writeFileSync(registry, JSON.stringify({ proposals: ["ruling:done", "ruling:open"].map((id) => ({ id, summary: `about ${id}`, evidenceAnchors })) }));
  const deps: PanelGraphDeps = {
    root, inboxRoot: root, planPath, ledgerPath,
    github: { prView: () => null },
    statusGithub: fakeGitHub(),
    ratify: { approve: () => undefined, reframe: () => undefined },
    inboxMainSha: () => mainSha,
  };
  // A live foreign holder that never lets go: the prune's 2000 ms deadline is reached.
  holdLock(`${registry}.lock`, liveForeignHolder(t));

  await assert.rejects(refreshInboxClassification(deps, {}), (err: Error) => {
    assert.match(err.message, /^updateProposalRegistry: timed out after 2000ms waiting for .*inbox-proposals\.json\.lock \(held by pid \d+\)$/);
    return true;
  });
});
}
