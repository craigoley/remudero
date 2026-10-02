import assert from "node:assert/strict";
import { test } from "node:test";
import { type DeployRestartPressureState } from "../src/lib/deploy-judge.js";
import { runDeployCycle, type DeployDeps } from "../src/lib/deployer.js";
import {
  formatReleaseManifest,
  latestReleaseTag,
  mintReleaseTag,
  nextReleaseNumber,
  parseReleaseManifest,
  type ReleaseManifest,
  type ReleaseTagIo,
} from "../src/lib/release-tags.js";

const SHA = "a".repeat(40);

const manifest: ReleaseManifest = {
  sourceSha: SHA,
  imageRef: "reg.azurecr.io/remudero:" + "b".repeat(40),
  prevRelease: "release/20261001-2",
  total: 21,
  threshold: 18,
  decidedAt: "2026-10-02T09:30:00.000Z",
  changes: [
    { sha: "c".repeat(40), score: 18, reason: "daemon loop change: worth a drain" },
    { sha: "d".repeat(40), score: 3, reason: "" },
  ],
};

interface Harness {
  tags: Map<string, { sha: string; message: string }>;
  logs: Array<{ step: string; data?: Record<string, unknown> }>;
  io: ReleaseTagIo;
}

function harness(opts: { existing?: string[]; createFails?: Error } = {}): Harness {
  const tags = new Map<string, { sha: string; message: string }>();
  for (const name of opts.existing ?? []) tags.set(name, { sha: "0".repeat(40), message: "" });
  return {
    tags,
    logs: [],
    io: {
      listTags: () => [...tags.keys()],
      createTag: (name, sha, message) => {
        if (opts.createFails) throw opts.createFails;
        if (tags.has(name)) throw new Error("Reference already exists");
        tags.set(name, { sha, message });
      },
      isCollision: (err) => /already exists/.test(String((err as Error).message)),
    },
  };
}

test("W1-T4528: a release manifest round-trips", () => {
  const text = formatReleaseManifest(manifest);
  assert.deepEqual(parseReleaseManifest(text), manifest);
  assert.equal(formatReleaseManifest(parseReleaseManifest(text)!), text);
  assert.match(text, /^remudero release\nsource_sha: a{40}\nimage_ref: /);
  // a first release has no predecessor and an unbuilt image: both are absent, and stay absent
  const first: ReleaseManifest = { ...manifest, imageRef: undefined, prevRelease: undefined, changes: [] };
  delete first.imageRef;
  delete first.prevRelease;
  assert.deepEqual(parseReleaseManifest(formatReleaseManifest(first)), first);
  assert.equal(parseReleaseManifest("not a manifest\n"), undefined);
  // naming: n is 1 + today's highest, and other days do not count
  assert.equal(nextReleaseNumber("20261002", ["release/20261002-1", "release/20261002-4", "release/20261001-9"]), 5);
  assert.equal(nextReleaseNumber("20261002", []), 1);
  assert.equal(latestReleaseTag(["release/20261001-9", "release/20261002-2", "release/20261002-10"]), "release/20261002-10");
});

test("W1-T4528: only the primary mints a release tag", () => {
  const input = { ...manifest, prevRelease: undefined };
  delete (input as { prevRelease?: string }).prevRelease;

  for (const isPrimary of [false, undefined]) {
    const h = harness();
    const out = mintReleaseTag({ ...input, isPrimary }, h.io, (step, data) => h.logs.push({ step, data }));
    assert.equal(out.minted, false);
    assert.equal(h.tags.size, 0, `isPrimary=${String(isPrimary)} must mint nothing`);
  }

  const h = harness({ existing: ["release/20261002-1", "release/20261001-7"] });
  const out = mintReleaseTag({ ...input, isPrimary: true }, h.io, (step, data) => h.logs.push({ step, data }));
  assert.deepEqual(out, { minted: true, tag: "release/20261002-2", attempts: 1 });
  assert.equal(h.tags.size, 3, "exactly one new tag");
  const minted = h.tags.get("release/20261002-2")!;
  assert.equal(minted.sha, SHA);
  const parsed = parseReleaseManifest(minted.message)!;
  assert.equal(parsed.prevRelease, "release/20261002-1");
  assert.equal(parsed.total, 21);
  assert.equal(h.logs.at(-1)?.step, "release.minted");

  // append-only: a name taken between list and create moves on to n+1, never overwrites
  const racing = harness({ existing: ["release/20261002-1"] });
  const listed = racing.io.listTags;
  let first = true;
  racing.io.listTags = () => {
    if (first) { first = false; return []; } // stale read: believes nothing exists today
    return listed();
  };
  const retried = mintReleaseTag({ ...input, isPrimary: true }, racing.io, () => {});
  assert.deepEqual(retried, { minted: true, tag: "release/20261002-2", attempts: 2 });
  assert.equal(racing.tags.get("release/20261002-1")?.sha, "0".repeat(40), "the existing tag is untouched");
});

function deployDeps(releaseTags: DeployDeps["releaseTags"], logs: Array<{ step: string; data?: Record<string, unknown> }>, calls: string[]): DeployDeps {
  let head = "old";
  let state: DeployRestartPressureState = { total: 0, scoredShas: [] };
  return {
    log: (step, data) => { logs.push({ step, data }); },
    now: () => Date.parse("2026-10-02T09:30:00.000Z"),
    fetch: () => {},
    installHead: () => head,
    originMain: () => SHA,
    markerPresent: () => false,
    autoMode: () => true,
    lastFailedHead: () => undefined,
    runningHead: () => head,
    dirtyFiles: () => [],
    incomingFiles: () => ["src/run-task.ts"],
    pendingChanges: () => [{ sha: "c".repeat(40), subject: "feat(core): change runtime", files: ["src/run-task.ts"] }],
    restartPressureState: () => state,
    setRestartPressureState: (next) => { state = next; },
    restartScoreThreshold: () => ({ value: 1, reason: "test threshold" }),
    restartRateCeilingMs: () => 0,
    pullFf: () => { head = SHA; },
    resetHard: () => {},
    probeIdle: () => ({ workers: 0, inflightLocks: 0, worktreeLocks: 0 }),
    kickstart: () => { calls.push("kickstart"); },
    waitBootHealth: () => ({ bootObserved: true, crashCount: 0 }),
    alert: () => {},
    clearMarker: () => {},
    kickstartConsole: () => {},
    consolePid: () => 1234,
    waitConsoleUp: () => true,
    alertConsoleOnly: () => {},
    releaseTags,
  };
}

test("W1-T4528: a failed mint never blocks the deploy", () => {
  // a restart decision on the primary mints exactly one tag through the deploy cycle
  const ok = harness();
  const okLogs: Array<{ step: string; data?: Record<string, unknown> }> = [];
  const okCalls: string[] = [];
  const done = runDeployCycle(
    deployDeps({ isPrimary: () => true, io: ok.io, imageRefFor: () => "reg/remudero:" + "b".repeat(40) }, okLogs, okCalls),
  );
  assert.equal(done.deployed, true);
  assert.equal(ok.tags.size, 1);
  const [name, tag] = [...ok.tags][0];
  assert.match(name, /^release\/20261002-1$/);
  assert.equal(tag.sha, SHA);
  const body = parseReleaseManifest(tag.message)!;
  assert.equal(body.imageRef, "reg/remudero:" + "b".repeat(40));
  assert.equal(body.changes.length, 1);
  assert.equal(body.threshold, 1);

  // a non-primary deployment decides the same restart and mints nothing
  const other = harness();
  const otherCalls: string[] = [];
  assert.equal(
    runDeployCycle(deployDeps({ isPrimary: () => false, io: other.io, imageRefFor: () => undefined }, [], otherCalls)).deployed,
    true,
  );
  assert.equal(other.tags.size, 0);

  // the mint fails (no token, API down): the deploy still completes and the failure is a ledger row
  const failing = harness({ createFails: new Error("HTTP 403: Resource not accessible") });
  const logs: Array<{ step: string; data?: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const result = runDeployCycle(deployDeps({ isPrimary: () => true, io: failing.io, imageRefFor: () => undefined }, logs, calls));
  assert.equal(result.deployed, true);
  assert.deepEqual(calls, ["kickstart"]);
  const row = logs.find((l) => l.step === "release.mint_failed");
  assert.match(String(row?.data?.reason), /Resource not accessible/);
  assert.ok(logs.some((l) => l.step === "deploy.ok"));

  // a reader that throws outright is also contained
  const throwing = runDeployCycle(
    deployDeps({ isPrimary: () => { throw new Error("registry unreadable"); }, io: failing.io, imageRefFor: () => undefined }, [], []),
  );
  assert.equal(throwing.deployed, true);
});
