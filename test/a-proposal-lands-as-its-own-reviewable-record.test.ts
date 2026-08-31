import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadProposalRegistry, parseProposalRegistry, proposalShardDir, updateProposalRegistry, type Proposal } from "../src/lib/inbox.js";

/**
 * test/a-proposal-lands-as-its-own-reviewable-record.test.ts — W1-T2490: PROPOSAL SHARDING.
 *
 * `plan/tasks.d/` gave tasks a sharded home and `plan/decisions.d/` gave decisions one;
 * `state/inbox-proposals.json` was the last plan artifact still a single blob, so an arriving
 * proposal was a whole-file rewrite and a reviewer inspecting one had to read the entire
 * population to find it. `loadProposalRegistry` (src/lib/inbox.ts) merges the legacy blob
 * with a sibling `inbox-proposals.d/` shard directory exactly as plan.ts's `loadPlan` merges
 * `tasks.yaml` with `tasks.d/`, including its duplicate-id refusal; `updateProposalRegistry`
 * (the W1-T240 single writer every one of the eight existing write sites already goes
 * through, unmodified) now ALSO mirrors a new or actively-rewritten proposal out to its own
 * shard file, alongside — never instead of — its existing, byte-for-byte-unchanged full write
 * of the legacy blob, so no existing reader needs to learn sharding exists.
 */

function tmpRegistry(): { dir: string; registryPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-proposal-shard-"));
  return { dir, registryPath: join(dir, "state", "inbox-proposals.json") };
}

function proposal(id: string, summary = `proposal ${id}`): Proposal {
  return { id, summary, evidenceAnchors: [] };
}

function writeBlob(registryPath: string, proposals: Proposal[]): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({ proposals }, null, 2), "utf8");
}

function writeShard(registryPath: string, filename: string, proposalRecord: Proposal): string {
  const dir = proposalShardDir(registryPath);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(proposalRecord, null, 2), "utf8");
  return path;
}

// ── claim: "a newly minted proposal lands as its own file under the shard directory" ─────

test("a newly minted proposal lands as its own file under the shard directory", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    updateProposalRegistry(registryPath, () => [proposal("P1")]);

    const shardDir = proposalShardDir(registryPath);
    const shardFiles = readdirSync(shardDir).filter((f) => f.endsWith(".json"));
    assert.equal(shardFiles.length, 1, "exactly one shard file for the one newly minted proposal");
    const onDisk = JSON.parse(readFileSync(join(shardDir, shardFiles[0]), "utf8"));
    assert.equal(onDisk.id, "P1", "the shard file's own content names the proposal it holds");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shard mirror is ADDITIVE — the legacy blob still carries the full population unchanged, so an existing blob-only reader never needs to learn sharding exists", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    updateProposalRegistry(registryPath, () => [proposal("P1"), proposal("P2")]);

    const onBlob = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.deepEqual(
      onBlob.map((p) => p.id).sort(),
      ["P1", "P2"],
      "a plain blob-only parse (what every one of the eight existing readers already does) still sees the whole population",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── claim: "the loader returns shards and the legacy blob as one population" ─────────────

test("loadProposalRegistry returns the legacy blob and the shard directory merged as one population", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    writeBlob(registryPath, [proposal("FROM-BLOB")]);
    writeShard(registryPath, "shard-1.json", proposal("FROM-SHARD"));

    const merged = loadProposalRegistry(registryPath);
    assert.deepEqual(merged.map((p) => p.id).sort(), ["FROM-BLOB", "FROM-SHARD"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProposalRegistry reads a shard whatever the file is named — it never trusts the filename, only the record's own 'id' field", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    writeShard(registryPath, "zzz-nothing-like-the-id.json", proposal("ODDLY-NAMED"));

    const merged = loadProposalRegistry(registryPath);
    assert.deepEqual(merged.map((p) => p.id), ["ODDLY-NAMED"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── claim: "a proposal present in both resolves exactly once" ────────────────────────────

test("a proposal present in both the blob and a shard resolves exactly once, taking the shard's copy", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    writeBlob(registryPath, [proposal("P1", "stale blob-side summary")]);
    writeShard(registryPath, "p1.json", proposal("P1", "fresh shard-side summary"));

    const merged = loadProposalRegistry(registryPath);
    assert.equal(merged.length, 1, "the same id in both places must resolve to ONE entry, not two");
    assert.equal(merged[0].summary, "fresh shard-side summary", "the shard's copy is the one that resolves");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the mirrored write itself never double-counts — after updateProposalRegistry mints a proposal, loadProposalRegistry sees it once even though it now lives in both the blob and a shard", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    updateProposalRegistry(registryPath, () => [proposal("P1")]);

    // Sanity: P1 really is in both places now (the mirrored-write design this task adds).
    const onBlob = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.deepEqual(onBlob.map((p) => p.id), ["P1"]);
    const shardFiles = readdirSync(proposalShardDir(registryPath)).filter((f) => f.endsWith(".json"));
    assert.equal(shardFiles.length, 1);

    assert.deepEqual(loadProposalRegistry(registryPath).map((p) => p.id), ["P1"], "present in both, resolves once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── claim: "removing the duplicate-id refusal makes the both-places case resolve twice" ──
//
// FALSIFIER, spelled out directly: the ONLY thing standing between the previous test's
// single result and a doubled one is loadProposalRegistry's id-keyed Map — a naive
// concatenation of the two sources (no override-by-id at all) manufactures exactly the
// resolves-twice failure this task's own rationale names as the falsifier worth writing.

test("FALSIFIER: without the id-keyed merge, the SAME both-places fixture naively concatenates to TWO entries, not one — this is exactly what loadProposalRegistry's Map-based override prevents", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    writeBlob(registryPath, [proposal("P1", "blob copy")]);
    writeShard(registryPath, "p1.json", proposal("P1", "shard copy"));

    const blobSide = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    const shardSide = JSON.parse(readFileSync(join(proposalShardDir(registryPath), "p1.json"), "utf8")) as Proposal;
    const naiveConcat = [...blobSide, shardSide]; // no id-keyed override at all
    assert.equal(naiveConcat.filter((p) => p.id === "P1").length, 2, "sanity: a naive concat of the two sources really does produce two P1 rows");

    assert.equal(
      loadProposalRegistry(registryPath).filter((p) => p.id === "P1").length,
      1,
      "loadProposalRegistry's guard is what collapses the same fixture back down to one",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── claim: "two proposals sharing an id are refused rather than merged silently" ──────────

test("two DIFFERENT shard files declaring the same proposal id are refused rather than silently merged", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    writeShard(registryPath, "a.json", proposal("DUP", "first shard's summary"));
    writeShard(registryPath, "b.json", proposal("DUP", "second shard's summary"));

    assert.throws(() => loadProposalRegistry(registryPath), /duplicate proposal id 'DUP'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateProposalRegistry itself refuses a corrupted shard population (two shards sharing an id) rather than silently picking one to mint against", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    writeShard(registryPath, "a.json", proposal("DUP"));
    writeShard(registryPath, "b.json", proposal("DUP"));

    assert.throws(() => updateProposalRegistry(registryPath, (current) => [...current, proposal("NEW")]), /duplicate proposal id 'DUP'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── claim: "every existing reader sees the same shape it sees today" ─────────────────────

test("with no shard directory at all, loadProposalRegistry is byte-for-byte the same population parseProposalRegistry(blob) already returns — the back-compat case for a registry that has not sharded anything yet", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    const proposals = [proposal("A"), proposal("B", "b with a reframe"), proposal("C")];
    writeBlob(registryPath, proposals);

    const viaLoader = loadProposalRegistry(registryPath);
    const viaLegacyIdiom = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.deepEqual(viaLoader, viaLegacyIdiom, "same signature (a path in), same Proposal[] shape out — a future reader can swap with no other change");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── claim: "re-running a minter reintroduces no dispositioned record" ────────────────────
//
// Every real minter's own idempotence (rule-efficacy.ts, board-review.ts, measurement-
// cadence.ts, ...) is an `existingIds.has(id)` check against `current` — unchanged by this
// task. What sharding could plausibly BREAK is that check's premise: if dispositioning a
// proposal (rmd approve's remove-on-ratify, the inbox heal) left its shard mirror behind,
// `current` on the NEXT read would still show it (the shard wins the merge), so the operator's
// disposition would be silently undone the moment anything re-reads the registry — even
// though no minter ever re-ran. The first test below is that exact non-resurrection property;
// the second is the minter-idempotence half (two mints for a STILL-OPEN id write one file).

test("dispositioning a sharded proposal deletes its shard mirror — a stale file left behind cannot resurrect it in the very next merged read", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    updateProposalRegistry(registryPath, () => [proposal("MINTED")]);
    assert.deepEqual(loadProposalRegistry(registryPath).map((p) => p.id), ["MINTED"]);
    const shardFilesBefore = readdirSync(proposalShardDir(registryPath)).filter((f) => f.endsWith(".json"));
    assert.equal(shardFilesBefore.length, 1, "sanity: MINTED really did land as its own shard file");

    // The operator dispositions it — same shape as rmd approve's remove-on-ratify.
    updateProposalRegistry(registryPath, (current) => current.filter((p) => p.id !== "MINTED"));

    const shardFilesAfter = readdirSync(proposalShardDir(registryPath)).filter((f) => f.endsWith(".json"));
    assert.deepEqual(shardFilesAfter, [], "the shard mirror must be deleted, not left behind to resurrect the record");
    assert.deepEqual(loadProposalRegistry(registryPath), [], "dispositioned — gone from the merged view a subsequent read (or minter) would see");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an idempotent minter calling updateProposalRegistry twice for the SAME still-open id writes only ONE shard file, never a second one for the same proposal", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    const mint = () => updateProposalRegistry(registryPath, (current) => (current.some((p) => p.id === "MINTED") ? null : [...current, proposal("MINTED")]));

    mint();
    mint(); // same fact, still open — every real minter's own existingIds check must short-circuit this to a no-op

    assert.deepEqual(loadProposalRegistry(registryPath).map((p) => p.id), ["MINTED"], "still exactly one MINTED, not duplicated");
    const shardFiles = readdirSync(proposalShardDir(registryPath)).filter((f) => f.endsWith(".json"));
    assert.equal(shardFiles.length, 1, "still exactly one shard file for it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── claim: "an unreadable shard directory refuses rather than reporting an empty population" ─

test("an unreadable shard directory (the slot is occupied by a FILE, not a directory) refuses rather than silently reporting an empty population", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    mkdirSync(join(registryPath, ".."), { recursive: true });
    writeBlob(registryPath, [proposal("SOMETHING")]);
    // A FILE where the shard directory should be — deterministic, non-root-bypassable
    // (unlike chmod-based permission games): readdirSync on it throws ENOTDIR, never ENOENT.
    writeFileSync(proposalShardDir(registryPath), "not a directory");

    assert.throws(() => loadProposalRegistry(registryPath), /cannot read proposal shard directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER: an ABSENT shard directory (the ordinary not-sharded-yet case) is NOT an error — only a directory slot that exists but cannot be read is", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    writeBlob(registryPath, [proposal("SOMETHING")]);
    // No shard directory created at all.
    assert.deepEqual(loadProposalRegistry(registryPath).map((p) => p.id), ["SOMETHING"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateProposalRegistry itself refuses when the shard directory is unreadable, rather than proceeding as if it were empty", () => {
  const { dir, registryPath } = tmpRegistry();
  try {
    mkdirSync(join(registryPath, ".."), { recursive: true });
    writeFileSync(proposalShardDir(registryPath), "not a directory");

    assert.throws(() => updateProposalRegistry(registryPath, (current) => [...current, proposal("X")]), /cannot read proposal shard directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
