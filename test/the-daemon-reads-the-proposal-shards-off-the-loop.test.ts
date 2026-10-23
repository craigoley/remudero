/**
 * W1-T9443: the daemon reads the proposal shards off the loop, and only the ones that changed. On 2026-10-14 the
 * draft rung's orphan prune read all 1,357 `inbox-proposals.d/` files with `readFileSync` once per full sweep, and
 * every registry write rewrote every shard, so the read sat inside two loop stalls of 273 s and 434 s. The rung now
 * reads through a per-daemon-start shard memo whose `refresh()` is async and re-reads only shards whose
 * (inode, size, mtime ns) digest moved, and a registry write touches only the shards whose content changed.
 */
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { writeAtomic } from "../src/lib/fs-race-safe.js";
import {
  createProposalShardReader,
  loadProposalRegistry,
  proposalShardDir,
  pruneOrphanedDraftsAsync,
  updateProposalRegistry,
  type DraftedCandidate,
  type Proposal,
  type ProposalShardReaderFs,
} from "../src/lib/inbox.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildInboxDraftHook } from "../src/run-task.js";

const proposal = (id: string, summary = "s"): Proposal => ({ id, summary, evidenceAnchors: [] }) as unknown as Proposal;
const cand = (id: string): DraftedCandidate => ({ proposalId: id, fragmentYaml: `- id: ${id}\n`, stampLine: "stamp", anchorFingerprint: "" });

function seedRegistry(ids: string[]): { root: string; registryPath: string; shardDir: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t9443-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const registryPath = join(root, "state", "inbox-proposals.json");
  // Every id is NEW to an empty registry, so each one lands in its own shard file.
  updateProposalRegistry(registryPath, () => ids.map((id) => proposal(id)));
  return { root, registryPath, shardDir: proposalShardDir(registryPath) };
}

/** The real async fs, with every shard read counted by path. */
function countingFs(): { fs: ProposalShardReaderFs; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    fs: {
      readdir: (dir) => fs.promises.readdir(dir),
      stat: async (path) => {
        const s = await fs.promises.stat(path, { bigint: true });
        return { ino: s.ino, size: s.size, mtimeNs: s.mtimeNs };
      },
      readFile: (path) => {
        reads.push(path);
        return fs.promises.readFile(path, "utf8");
      },
    },
  };
}

const inodes = (shardDir: string): Map<string, bigint> =>
  new Map(readdirSync(shardDir).map((f) => [f, statSync(join(shardDir, f), { bigint: true }).ino] as const));

test("W1-T9443: a synchronous shard read failure reports the path and cause", (t) => {
  const { registryPath, shardDir } = seedRegistry(["A"]);
  const shardPath = join(shardDir, readdirSync(shardDir)[0]!);
  const cause = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const originalReadFileSync = fs.readFileSync;
  const readSpy = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === shardPath) throw cause;
    return originalReadFileSync(...args);
  });

  assert.throws(() => loadProposalRegistry(registryPath), {
    name: "Error",
    message: `cannot read proposal shard (${shardPath}): ${String(cause)}`,
  });
  assert.equal(readSpy.mock.calls.filter((call) => call.arguments[0] === shardPath).length, 1);
  readSpy.mock.restore();
  assert.deepEqual(loadProposalRegistry(registryPath), [proposal("A")]);
});

test("W1-T9443: a slow shard read does not block a concurrent timer", async (t) => {
  // A read that has not resolved yet: the loop must stay free to run a timer while it is pending.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reads: string[] = [];
  const slow: ProposalShardReaderFs = {
    readdir: async () => ["a-1.json"],
    stat: async () => ({ ino: 7n, size: 20n, mtimeNs: 1n }),
    readFile: async (path) => {
      reads.push(path);
      await gate;
      return JSON.stringify(proposal("A"));
    },
  };
  const reader = createProposalShardReader("/virtual/inbox-proposals.d", { fs: slow });
  let settled = false;
  const pending = reader.refresh().then((m) => {
    settled = true;
    return m;
  });
  const timerSawPending = await new Promise<boolean>((resolve) => setTimeout(() => resolve(!settled), 0));
  assert.equal(timerSawPending, true, "the timer ran while the shard read was still pending");
  assert.deepEqual(reads, ["/virtual/inbox-proposals.d/a-1.json"]);
  release();
  assert.deepEqual([...(await pending).keys()], ["A"]);

  // The DEFAULT seam is the real async fs: a refresh over a real directory makes no synchronous fs call on it.
  const { shardDir } = seedRegistry(["P-1", "P-2"]);
  const spies = (["readFileSync", "readdirSync", "statSync", "lstatSync", "openSync", "existsSync"] as const).map((name) =>
    t.mock.method(fs, name),
  );
  const population = await createProposalShardReader(shardDir).refresh();
  const syncCalls = spies.flatMap((s) => s.mock.calls).filter((c) => String(c.arguments[0]).startsWith(shardDir));
  t.mock.restoreAll();
  assert.deepEqual([...population.keys()].sort(), ["P-1", "P-2"]);
  assert.equal(syncCalls.length, 0, "no synchronous fs call touched the shard directory");
});

test("W1-T9443: a refresh re-reads only the shards that changed", async () => {
  const { registryPath, shardDir } = seedRegistry(["A", "B", "C"]);
  const counting = countingFs();
  const rows: Array<Record<string, unknown>> = [];
  const reader = createProposalShardReader(shardDir, { fs: counting.fs, log: (step, extra = {}) => void rows.push({ step, ...extra }) });

  const first = await reader.refresh();
  assert.deepEqual([...first.keys()].sort(), ["A", "B", "C"]);
  assert.equal(counting.reads.length, 3, "a cold reader reads every shard once");
  assert.deepEqual(rows.at(-1), { step: "proposal_shards.refreshed", files: 3, read: 3, unchanged: 0, removed: 0, ms: rows.at(-1)?.ms });
  assert.equal(typeof rows.at(-1)?.ms, "number");

  counting.reads.length = 0;
  await reader.refresh();
  assert.equal(counting.reads.length, 0, "an unchanged population re-reads nothing");
  assert.equal(rows.at(-1)?.unchanged, 3);

  // One shard rewritten, by temp plus rename as every writer does: exactly that file is read again.
  const bFile = [...first.values()].find((e) => e.proposal.id === "B")!.path;
  writeAtomic(bFile, JSON.stringify(proposal("B", "changed"), null, 2));
  const third = await reader.refresh();
  assert.deepEqual(counting.reads, [bFile]);
  assert.equal(rows.at(-1)?.read, 1);
  assert.equal(rows.at(-1)?.unchanged, 2);
  assert.equal((third.get("B")?.proposal as unknown as { summary: string }).summary, "changed");
  // The same population a full read gives.
  const full = new Map(loadProposalRegistry(registryPath).map((p) => [p.id, p]));
  assert.deepEqual(new Map([...third.values()].map((e) => [e.proposal.id, e.proposal])), full);

  // A removed shard drops out, with nothing read.
  counting.reads.length = 0;
  const cFile = third.get("C")!.path;
  fs.unlinkSync(cFile);
  const fourth = await reader.refresh();
  assert.deepEqual([...fourth.keys()].sort(), ["A", "B"]);
  assert.equal(counting.reads.length, 0);
  assert.equal(rows.at(-1)?.removed, 1);

  // A second file claiming an id already held is refused, as the full read refuses it; so is a shard with no id.
  writeFileSync(join(shardDir, "zz-duplicate.json"), JSON.stringify(proposal("A")));
  await assert.rejects(reader.refresh(), /duplicate proposal id 'A'/);
  fs.unlinkSync(join(shardDir, "zz-duplicate.json"));
  writeFileSync(join(shardDir, "zz-no-id.json"), JSON.stringify({ summary: "s" }));
  await assert.rejects(reader.refresh(), /has no valid 'id' field/);
  fs.unlinkSync(join(shardDir, "zz-no-id.json"));
  assert.deepEqual([...(await reader.refresh()).keys()].sort(), ["A", "B"], "a refused refresh leaves the memo usable");

  // An unreadable directory is a throw, never an empty population; an absent one is the unmigrated empty case.
  const broken = createProposalShardReader(join(shardDir, "zz-not-a-dir.json"), {
    fs: { ...counting.fs, readdir: async () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })) },
  });
  await assert.rejects(broken.refresh(), /cannot read proposal shard directory/);
  assert.equal((await createProposalShardReader(join(shardDir, "absent.d")).refresh()).size, 0);
});

test("W1-T9443: an update rewrites only the shard that changed", () => {
  const { registryPath, shardDir } = seedRegistry(["A", "B", "C"]);
  const before = inodes(shardDir);
  assert.equal(before.size, 3);

  updateProposalRegistry(registryPath, (current) => current.map((p) => (p.id === "B" ? proposal("B", "changed") : p)));
  const after = inodes(shardDir);
  const moved = [...after].filter(([f, ino]) => before.get(f) !== ino).map(([f]) => f);
  assert.equal(moved.length, 1, `exactly one shard was rewritten, saw ${moved.join(", ")}`);
  assert.match(readFileSync(join(shardDir, moved[0]!), "utf8"), /"changed"/);

  // A non-null update that changes nothing rewrites no shard at all.
  updateProposalRegistry(registryPath, (current) => [...current]);
  assert.deepEqual(inodes(shardDir), after);

  // A new proposal still gets its own file, and a dispositioned one is still unlinked; the rest keep their inode.
  updateProposalRegistry(registryPath, (current) => [...current.filter((p) => p.id !== "C"), proposal("D")]);
  const last = inodes(shardDir);
  assert.equal(last.size, 3);
  for (const [f, ino] of last) if (after.has(f)) assert.equal(ino, after.get(f), `${f} kept its inode`);
  assert.deepEqual(loadProposalRegistry(registryPath).map((p) => p.id).sort(), ["A", "B", "D"]);
});

test("W1-T9443: the draft rung prunes through the off-loop reader", async (t) => {
  const { root, registryPath, shardDir } = seedRegistry(["LIVE", "SHARDED"]);
  // The blob keeps LIVE only; SHARDED lives in its shard alone, so only a read of the shards keeps its draft.
  writeFileSync(registryPath, JSON.stringify({ proposals: [proposal("LIVE")] }));
  fs.unlinkSync(join(shardDir, readdirSync(shardDir).find((f) => f.startsWith("live-"))!));
  const draftsPath = join(root, "state", "inbox-drafts.json");
  writeFileSync(draftsPath, JSON.stringify(Object.fromEntries(["LIVE", "SHARDED", "GONE"].map((id) => [id, cand(id)])), null, 2));

  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const hook = buildInboxDraftHook("o", "r", { root } as Config, "RUN-1", (step, extra = {}) => void logs.push({ step, extra }), async () => []);
  const readFileSyncSpy = t.mock.method(fs, "readFileSync");
  await hook();
  const shardSyncReads = readFileSyncSpy.mock.calls.filter((c) => String(c.arguments[0]).startsWith(shardDir));
  t.mock.restoreAll();

  assert.deepEqual(Object.keys(JSON.parse(readFileSync(draftsPath, "utf8")) as object).sort(), ["LIVE", "SHARDED"]);
  assert.equal(logs.find((l) => l.step === "inbox.drafts_pruned")?.extra.count, 1);
  assert.equal(shardSyncReads.length, 0, "the rung read no shard synchronously");
  const refreshed = logs.filter((l) => l.step === "proposal_shards.refreshed");
  assert.ok(refreshed.length >= 1, "the rung's reader ledgered its refresh");
  assert.equal(refreshed[0]?.extra.files, 1);

  // The next pass reads no shard again: the reader is held for the hook's life, and nothing moved.
  logs.length = 0;
  writeFileSync(join(root, "state", "inbox-draft-completions.json"), "{}");
  const nextReadFileSyncSpy = t.mock.method(fs, "readFileSync");
  await hook();
  const nextShardSyncReads = nextReadFileSyncSpy.mock.calls.filter((c) => String(c.arguments[0]).startsWith(shardDir));
  t.mock.restoreAll();
  assert.equal(nextShardSyncReads.length, 0, "an empty completion outbox also avoids synchronous shard reads");
  const again = logs.filter((l) => l.step === "proposal_shards.refreshed");
  assert.ok(again.length >= 1);
  assert.ok(again.every((l) => l.extra.read === 0 && l.extra.unchanged === 1), JSON.stringify(again));
  assert.equal(logs.filter((l) => l.step === "inbox.drafts_pruned").length, 0);
});

test("W1-T9443: a shard that vanishes mid-refresh drops out, and an unreadable one is refused", async () => {
  const entry = { ino: 1n, size: 2n, mtimeNs: 3n };
  const vanishing: ProposalShardReaderFs = {
    readdir: async () => ["a.json", "b.json", "c.json", "notes.txt"],
    stat: async (path) => (path.endsWith("b.json") ? Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })) : entry),
    readFile: async (path) =>
      path.endsWith("c.json") ? Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })) : JSON.stringify(proposal("A")),
  };
  const rows: Array<Record<string, unknown>> = [];
  const population = await createProposalShardReader("/v", { fs: vanishing, log: (step, extra = {}) => void rows.push({ step, ...extra }) }).refresh();
  assert.deepEqual([...population.keys()], ["A"], "a file unlinked between the listing and its read is gone, not a refusal");
  assert.deepEqual({ ...rows[0], ms: 0 }, { step: "proposal_shards.refreshed", files: 1, read: 1, unchanged: 0, removed: 0, ms: 0 });

  const unreadable: ProposalShardReaderFs = {
    ...vanishing,
    stat: async () => entry,
    readFile: async () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })),
  };
  await assert.rejects(createProposalShardReader("/v", { fs: unreadable }).refresh(), /cannot read proposal shard \(\/v\/a\.json\)/);
});

test("W1-T9443: the off-loop prune waits out a live registry lock and looks again under it", async () => {
  const { root, registryPath, shardDir } = seedRegistry(["LIVE"]);
  const draftsPath = join(root, "state", "inbox-drafts.json");
  const writeDrafts = (ids: string[]) => writeFileSync(draftsPath, JSON.stringify(Object.fromEntries(ids.map((id) => [id, cand(id)])), null, 2));
  const lockPath = `${registryPath}.lock`;
  const holdLock = () => writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));

  // Nothing to look at: a torn registry or an absent drafts file is undefined, never "every draft is an orphan".
  writeDrafts(["LIVE", "GONE"]);
  const reader = createProposalShardReader(shardDir);
  const torn = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t9443-torn-`));
  writeFileSync(join(torn, "inbox-proposals.json"), "{ torn");
  assert.equal(await pruneOrphanedDraftsAsync(draftsPath, join(torn, "inbox-proposals.json"), reader), undefined);
  assert.equal(await pruneOrphanedDraftsAsync(join(root, "state", "absent.json"), registryPath, reader), undefined);
  await assert.rejects(pruneOrphanedDraftsAsync(draftsPath, join(root, "state"), reader), /EISDIR/, "a registry that is not a file is a throw");

  // A live holder that never lets go: the prune gives up at the same bound the sync writer uses, and writes nothing.
  holdLock();
  await assert.rejects(pruneOrphanedDraftsAsync(draftsPath, registryPath, reader, { maxWaitMs: 30, pollIntervalMs: 5 }), /timed out after 30ms/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(draftsPath, "utf8")) as object).sort(), ["GONE", "LIVE"]);

  // A holder that lets go while the prune waits: the prune takes the lock, prunes, and releases it.
  setTimeout(() => fs.unlinkSync(lockPath), 20);
  const pruned = await pruneOrphanedDraftsAsync(draftsPath, registryPath, reader, { maxWaitMs: 5000, pollIntervalMs: 5 });
  assert.equal(pruned?.count, 1);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(draftsPath, "utf8")) as object), ["LIVE"]);
  assert.equal(fs.existsSync(lockPath), false, "the lock is released");

  // A holder that is dead is reclaimed, exactly as the sync writer reclaims it.
  writeDrafts(["LIVE", "GONE"]);
  writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22 + 7, host: hostname(), startedAt: new Date().toISOString() }));
  assert.equal((await pruneOrphanedDraftsAsync(draftsPath, registryPath, reader, { isPidAlive: () => false }))?.count, 1);

  // The second look, under the lock, wins: an orphan that became live, or a drafts file that went, writes nothing.
  writeDrafts(["LIVE", "LATE"]);
  let calls = 0;
  const lateLive = { refresh: async () => new Map(calls++ === 0 ? [] : [["LATE", { proposal: proposal("LATE"), path: "/x", text: "" }]]) };
  const before = readFileSync(draftsPath, "utf8");
  assert.deepEqual(await pruneOrphanedDraftsAsync(draftsPath, registryPath, lateLive), { count: 0, bytesBefore: Buffer.byteLength(before), bytesAfter: Buffer.byteLength(before) });
  assert.equal(readFileSync(draftsPath, "utf8"), before);
  // The drafts file goes after the first look has read it: the look under the lock finds nothing to prune.
  const draftsGone = { refresh: async () => (fs.existsSync(draftsPath) ? fs.unlinkSync(draftsPath) : undefined, new Map()) };
  assert.equal(await pruneOrphanedDraftsAsync(draftsPath, registryPath, draftsGone), undefined);
  assert.equal(fs.existsSync(lockPath), false);
});
