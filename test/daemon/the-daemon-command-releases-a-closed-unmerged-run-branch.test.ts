// W1-T14233: the production daemon supplies the closed-PR reader. These build the REAL daemonCommand's deps and
// drive the REAL runDaemon selection with them; only the GitHub transport, the branch listing and runOne are faked.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { readClosedRunBranchPrsOutputAsync } from "#src/cli/commands/daemon.js";
import { aCandidateHoldsARunBranch, runDaemon, type DaemonDeps, type DaemonSummary } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import type { RunResult } from "#src/lib/run-result.js";
import { daemonCommand } from "#src/run-task.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const A = "W1-T9001";
const B = "W1-T9002";
const C = "W1-T9003";
const BRANCH = `run-${A}-1795084765220`;
const listing = (...refs: string[]): string => refs.map((ref) => `469ea88e\trefs/heads/${ref}\n`).join("");
const closed = (ref: string, merged = false) =>
  ({ head: { ref }, merged_at: merged ? "2026-11-21T23:06:43Z" : null });

type Transport = (args: string[]) => Promise<unknown>;

/** The reader exactly as daemonCommand hands it to runDaemon, over a fake transport. */
async function wiredReader(t: TestContext, transport: Transport): Promise<DaemonDeps["readClosedRunBranchPrs"]> {
  const home = ownedFixtureDir(t, "closed-branch-daemon").dir;
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      closedRunBranchPrFetch: transport,
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured, "daemonCommand reached runDaemon");
    return captured.readClosedRunBranchPrs;
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
}

const result = (id: string): RunResult =>
  ({ taskId: id, merged: true, verdict: "merged", costUsd: 0, prUrl: `https://x/${id}` }) as RunResult;

function planOf(t: TestContext, ids: string[]) {
  const path = join(ownedFixtureDir(t, "closed-branch-plan").dir, "tasks.yaml");
  writeFileSync(path, ids.map((id) =>
    `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/${id}.ts]\n`).join(""));
  return loadPlan(path);
}

/** One selection pass: the loop stops at its first idle sleep or after one dispatch. */
async function selectOnce(t: TestContext, ids: string[], extra: Partial<DaemonDeps>) {
  const started: string[] = [];
  const rows: { step: string; extra?: Record<string, unknown> }[] = [];
  const merged = new Set<string>();
  let stop = false;
  await runDaemon(planOf(t, ids), {
    refreshMerged: () => (id: string) => merged.has(id),
    checkStop: () => (stop ? "test done" : undefined),
    log: (step, fields) => { rows.push({ step, extra: fields }); },
    runOne: async (id) => { started.push(id); merged.add(id); stop = true; return result(id); },
    sleep: async () => { stop = true; },
    ...extra,
  } as DaemonDeps, { laneCount: 1, max: 1 });
  return { started, rows };
}

test("W1-T14233 criterion 1: the real daemon command's deps dispatch a task whose only run branch is a closed unmerged PR's", async (t) => {
  const calls: string[][] = [];
  const read = await wiredReader(t, async (args) => { calls.push(args); return [closed(BRANCH)]; });
  assert.ok(read, "daemonCommand wires readClosedRunBranchPrs");
  // The branch moved after the close: the exemption is by ref name, whatever sha the ref holds now.
  for (const sha of ["469ea88e", "97c7650b"]) {
    const { started } = await selectOnce(t, [A], {
      readPushedRunBranches: async () => `${sha}\trefs/heads/${BRANCH}\n`,
      readClosedRunBranchPrs: read,
    });
    assert.deepEqual(started, [A]);
  }
  assert.match(calls[0]![1]!, /^repos\/[^/]+\/remudero\/pulls\?state=closed&/, "the target repo's closed listing");
});

test("W1-T14233 criterion 2: invariant:unreadable-keeps-blocking — an open PR's branch, a newer sibling or a failed read still holds the task", async (t) => {
  const full = Array.from({ length: 100 }, (_, i) => closed(i === 0 ? BRANCH : `run-W1-T${100 + i}-1795000000000`));
  let page = 0;
  const cases: [string, string, Transport][] = [
    ["open PR", listing(BRANCH), async () => []],
    ["merged PR", listing(BRANCH), async () => [closed(BRANCH, true)]],
    ["newer sibling", listing(BRANCH, `run-${A}-1795322590551`), async () => [closed(BRANCH)]],
    ["rejected read", listing(BRANCH), async () => { throw new Error("rate limited"); }],
    ["malformed read", listing(BRANCH), async () => ({ message: "Not Found" })],
    ["failed later page", listing(BRANCH), async () => { if (page++ === 0) return full; throw new Error("page 2 failed"); }],
  ];
  for (const [name, branches, transport] of cases) {
    const read = await wiredReader(t, transport);
    assert.ok(read, "daemonCommand wires readClosedRunBranchPrs");
    const { started, rows } = await selectOnce(t, [A], {
      readPushedRunBranches: async () => branches,
      readClosedRunBranchPrs: read,
    });
    assert.deepEqual(started, [], name);
    assert.ok(rows.some((r) => r.step === "dispatch.skipped" && r.extra?.reason === "run-branch-already-pushed"), name);
    if (/read|page/.test(name)) {
      assert.ok(rows.some((r) => r.step === "dispatch.run_branch_read_failed" && r.extra?.site === "tick:closed-prs"), name);
    }
  }
});

test("W1-T14233 criterion 2: a reader that throws before it answers holds the task too", async (t) => {
  const { started, rows } = await selectOnce(t, [A], {
    readPushedRunBranches: () => listing(BRANCH),
    readClosedRunBranchPrs: () => { throw new Error("no transport"); },
  });
  assert.deepEqual(started, []);
  assert.ok(rows.some((r) => r.extra?.error === "no transport"));
});

test("W1-T14233 criterion 3: the read is asynchronous, once per pass, and absent when no candidate holds a branch", async (t) => {
  let reads = 0;
  let answered = false;
  const read = await wiredReader(t, async () => {
    reads++;
    await drainMicrotasks();
    answered = true;
    return [];
  });
  assert.ok(read, "daemonCommand wires readClosedRunBranchPrs");
  const pending = read();
  assert.ok(pending instanceof Promise);
  assert.equal(answered, false, "the caller gets the loop back before GitHub answers");
  await pending;

  reads = 0;
  await selectOnce(t, [A, B], {
    readPushedRunBranches: async () => listing(BRANCH, `run-${B}-1795084765221`),
    readClosedRunBranchPrs: read,
  });
  assert.equal(reads, 1, "two held candidates share one read");

  const none: [string, Partial<DaemonDeps>][] = [
    ["nothing pushed", { readPushedRunBranches: () => "" }],
    ["not in this plan", { readPushedRunBranches: () => listing("run-W1-T7777-1795084765220") }],
    ["already merged", { readPushedRunBranches: () => listing(BRANCH), refreshMerged: () => (id: string) => id === A }],
    ["already in flight", { readPushedRunBranches: () => listing(BRANCH), isOpenPr: (id) => (id === A ? 19651 : undefined) }],
  ];
  for (const [name, deps] of none) {
    reads = 0;
    await selectOnce(t, [A], { readClosedRunBranchPrs: read, ...deps });
    assert.equal(reads, 0, name);
  }
});

const refillPaths: [string, (merged: Set<string>) => Partial<DaemonDeps>][] = [
  ["sync merged read", () => ({})],
  ["async merged read", (merged) => ({ refreshMergedAsync: async () => (id: string) => merged.has(id) })],
  ["live-state prefetch", () => ({ readLiveState: () => undefined })],
];
for (const [name, extra] of refillPaths) {
  test(`W1-T14233 criterion 1: a lane refill resolves the promised closed-PR read (${name})`, async (t) => {
    const held = `run-${C}-1795084765220`;
    let isClosed = false;
    const read = await wiredReader(t, async () => (isClosed ? [closed(held)] : []));
    assert.ok(read, "daemonCommand wires readClosedRunBranchPrs");
    const started: string[] = [];
    const merged = new Set<string>();
    const releases = new Map<string, (value: RunResult) => void>();
    let cleanup = false;
    const run = runDaemon(planOf(t, [A, B, C]), {
      refreshMerged: () => (id: string) => merged.has(id),
      readPushedRunBranches: () => listing(held),
      readClosedRunBranchPrs: read,
      checkStop: () => (cleanup ? "test cleanup" : undefined),
      log: () => {},
      sleep: async () => {},
      runOne: (id) => {
        started.push(id);
        return cleanup ? Promise.resolve(result(id)) : new Promise<RunResult>((resolve) => releases.set(id, resolve));
      },
      ...extra(merged),
    } as DaemonDeps, { laneCount: 2, max: 10 });
    try {
      for (let i = 0; i < 20 && started.length < 2; i++) await drainMicrotasks();
      assert.deepEqual(started, [A, B]);
      isClosed = true;
      merged.add(A);
      releases.get(A)!(result(A));
      for (let i = 0; i < 20 && started.length < 3; i++) await drainMicrotasks();
      assert.deepEqual(started, [A, B, C]);
    } finally {
      cleanup = true;
      for (const [id, release] of releases) { merged.add(id); release(result(id)); }
      await run;
    }
  });
}

test("W1-T14233: the reader keeps the drain reader's eight-page bound and stops at a short page", async () => {
  const urls: string[] = [];
  const full = Array.from({ length: 100 }, (_, i) => closed(`run-W1-T${i + 1}-1795000000000`));
  await readClosedRunBranchPrsOutputAsync("o", "r", async (args) => { urls.push(args[1]!); return full; });
  assert.equal(urls.length, 8);
  assert.match(urls[7]!, /&page=8$/);
  const short = await readClosedRunBranchPrsOutputAsync("o", "r", async () => [closed(BRANCH), { head: {} }]);
  assert.equal(short, `${BRANCH}\ttrue`);
});

test("W1-T14233: an unreadable board asks no closed-PR read, so selection reports the board failure itself", (t) => {
  const unreadable = (): number | undefined => { throw new Error("board unreadable"); };
  assert.equal(aCandidateHoldsARunBranch(listing(BRANCH), planOf(t, [A]), () => false, unreadable), false);
});
