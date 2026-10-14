/**
 * W1-T9443: the daemon reads the proposal shards off the loop, and only the ones that changed. On 2026-10-14 the
 * draft rung's orphan prune read all 1,357 `inbox-proposals.d/` files with `readFileSync` once per full sweep, and
 * every registry write rewrote every shard, so the read sat inside two loop stalls of 273 s and 434 s. The rung now
 * reads through a per-daemon-start shard memo whose `refresh()` is async and re-reads only shards whose
 * (inode, size, mtime ns) digest moved, and a registry write touches only the shards whose content changed.
 */
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { writeAtomic } from "../src/lib/fs-race-safe.js";
import {
  createProposalShardReader,
  loadProposalRegistry,
  proposalShardDir,
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
  await hook();
  const again = logs.filter((l) => l.step === "proposal_shards.refreshed");
  assert.ok(again.length >= 1);
  assert.ok(again.every((l) => l.extra.read === 0 && l.extra.unchanged === 1), JSON.stringify(again));
  assert.equal(logs.filter((l) => l.step === "inbox.drafts_pruned").length, 0);
});
