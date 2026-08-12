import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildExportBundle,
  loadGlobalArtifact,
  loadLayeredLearningsForTaskFiles,
  loadLearningsCorpus,
  LearningsError,
  renderExportBundle,
  selectExportableEntries,
  selectLearnings,
  verifyBundlePin,
  type ExportProvenance,
  type LearningEntry,
} from "../src/lib/learnings.js";

// W1-T425 — the §6 knowledge-commons TRANSPORT: opt-in `share: public`, a hash-pinned
// export/import pair riding the ALREADY-SHIPPED loadGlobalArtifact guard and scrubEntry
// leak-grep tripwire. These tests exercise the task's own four-direction falsifier
// verbatim: (i) an unstamped entry never leaves the tree, (ii) a tripwire match aborts
// the export naming the entry, (iii) a stamped entry round-trips export->import->real
// injection visibility, (iv) a bundle edited after export is refused by the EXISTING
// guard (proving import never bypassed or reimplemented it).

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function entry(over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: "commons-fact",
    subsystem: "knowledge",
    lifecycle: "active",
    files: ["src/lib/learnings.ts"],
    fact: "One entry shape is valid at every knowledge layer.",
    src: "W1-T425",
    ...over,
  };
}

const provenance: ExportProvenance = {
  sourceRepo: "craigoley/remudero",
  sourceSha: "deadbeef",
  exportedAt: "2026-08-12T00:00:00.000Z",
};

// ── (i) PRIVACY DIRECTION: an entry without the explicit opt-in never leaves the tree ────────

test("W1-T425: an entry with no `share` field is excluded from selectExportableEntries", () => {
  const entries = [entry({ id: "unstamped" })];
  assert.deepEqual(selectExportableEntries(entries), []);
});

test("W1-T425: a `share` value other than the literal \"public\" is rejected at PARSE time, not silently treated as private", () => {
  const dir = tmpDir("commons-bad-share-");
  writeFileSync(join(dir, "shard.yaml"), JSON.stringify([{ id: "bad-share", fact: "x", src: "y", files: [], share: "everyone" }]));
  assert.throws(() => loadLearningsCorpus(dir), LearningsError);
  let message = "";
  try {
    loadLearningsCorpus(dir);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.match(message, /'share' must be "public"/);
});

test("W1-T425: a `share: public` entry parses through the SAME loader every other layer uses", () => {
  const dir = tmpDir("commons-good-share-");
  writeFileSync(join(dir, "shard.yaml"), JSON.stringify([entry({ id: "opted-in", share: "public" })]));
  const loaded = loadLearningsCorpus(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].share, "public");
});

test("W1-T425: buildExportBundle refuses (writes nothing) when zero entries carry `share: public` — no empty-but-valid bundle", () => {
  const entries = [entry({ id: "unstamped-1" }), entry({ id: "unstamped-2", lifecycle: "superseded" })];
  const result = buildExportBundle(entries, provenance);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /zero entries carry `share: public`/);
});

test("W1-T425: a `superseded` entry stamped `share: public` STILL never exports — lifecycle gates ahead of the opt-in", () => {
  const entries = [entry({ id: "decayed", lifecycle: "superseded", supersededBy: "other", share: "public" })];
  assert.deepEqual(selectExportableEntries(entries), []);
  const result = buildExportBundle(entries, provenance);
  assert.equal(result.ok, false);
});

// ── (ii) TRIPWIRE DIRECTION: a planted leak-grep-matching fact aborts the export by name ─────

test("W1-T425: a `share: public` entry whose fact matches the leak-grep tripwire aborts the export, naming the entry", () => {
  const entries = [
    entry({ id: "safe-fact", share: "public" }),
    entry({ id: "leaky-fact", share: "public", fact: "The AWS key is AKIAABCDEFGHIJKLMNOP, do not lose it." }),
  ];
  const result = buildExportBundle(entries, provenance);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.blockedEntryId, "leaky-fact");
  assert.match(result.reason, /leak-grep tripwire/);
  assert.match(result.reason, /leaky-fact/);
});

// ── (iii) TRANSPORT DIRECTION: a stamped entry round-trips export -> import -> real injection ─

test("W1-T425: a `share: public` entry round-trips through export, pin-verified import, and real selectLearnings visibility", () => {
  const projectEntries = [
    entry({ id: "shared-fact", share: "public", fact: "This fact was earned in one tree and taught to another." }),
    entry({ id: "private-fact" }), // no share — must never appear downstream
  ];

  // export
  const built = buildExportBundle(projectEntries, provenance);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.bundle.entries.length, 1);
  assert.equal(built.bundle.entries[0].id, "shared-fact");
  const bundleText = renderExportBundle(built.bundle);

  // import: pin check against the export's own printed hash
  const pinned = verifyBundlePin(bundleText, built.bundle.hash);
  assert.equal(pinned.ok, true);
  const globalDir = tmpDir("commons-global-");
  const artifactPath = join(globalDir, "artifact.yaml");
  writeFileSync(artifactPath, bundleText, "utf8");

  // the EXISTING guard reads it back and verifies
  const loaded = loadGlobalArtifact(artifactPath);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0].id, "shared-fact");

  // real injection visibility: layered read + selectLearnings, exactly what run-task.ts calls
  const projectDir = tmpDir("commons-project-");
  writeFileSync(join(projectDir, "shard.yaml"), JSON.stringify(projectEntries));
  const layered = loadLayeredLearningsForTaskFiles(
    { projectDir, globalArtifactPath: artifactPath },
    ["src/lib/learnings.ts"],
  );
  assert.equal(layered.globalRefusedReason, undefined);
  const { selected } = selectLearnings(layered.entries, ["src/lib/learnings.ts"]);
  const selectedIds = selected.map((e) => e.id);
  assert.ok(selectedIds.includes("shared-fact"), "the imported entry must be injectable");
});

test("W1-T425: import refuses when the operator's --pin does not match the bundle's own declared hash", () => {
  const built = buildExportBundle([entry({ id: "shared-fact", share: "public" })], provenance);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const bundleText = renderExportBundle(built.bundle);
  const result = verifyBundlePin(bundleText, "0".repeat(64));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.reason, /pin mismatch/);
});

// ── (iv) TAMPER DIRECTION: a bundle edited after export is refused by the EXISTING guard ─────

test("W1-T425: a bundle hand-edited after export still passes the pin check (attacker didn't touch the hash field) but is REFUSED by the existing loadGlobalArtifact guard — import never reimplements the tamper check", () => {
  const built = buildExportBundle([entry({ id: "shared-fact", share: "public" })], provenance);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const bundleText = renderExportBundle(built.bundle);

  // Tamper AFTER export: mutate the fact text but leave the declared `hash:` field untouched —
  // exactly the "hand-edited or corrupted pull" shape loadGlobalArtifact's own falsifier covers.
  const tamperedText = bundleText.replace(built.bundle.entries[0].fact, "This fact was tampered with after export.");
  assert.notEqual(tamperedText, bundleText, "the tamper must actually change the text under test");

  // The pin check only compares the bundle's OWN declared hash to the operator's pin — an
  // attacker who edits entries but not the hash field passes it.
  const pinned = verifyBundlePin(tamperedText, built.bundle.hash);
  assert.equal(pinned.ok, true, "pin check alone does not catch an entries-vs-hash tamper");

  const globalDir = tmpDir("commons-tamper-");
  const artifactPath = join(globalDir, "artifact.yaml");
  writeFileSync(artifactPath, tamperedText, "utf8");

  // The EXISTING guard (never reimplemented here) catches what the pin check could not.
  const loaded = loadGlobalArtifact(artifactPath);
  assert.equal(loaded.ok, false, "the pre-existing hash-pinned-artifact guard must refuse the tampered bundle");
  if (loaded.ok) return;
  assert.match(loaded.reason, /hash mismatch/);
});
