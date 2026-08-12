/**
 * W1-T444 — TWO SHIPPED READERS EACH SAW HALF THE ROTATIONS, IN OPPOSITE DIRECTIONS.
 *
 * `resolveLedgerUnion` (`ledger-grep.ts`, behind `rmd ledger-grep`) filtered
 * `n.endsWith(".ndjson.gz")` and missed every uncompressed rotation. `ledgerCorpusFiles`
 * (`run-task.ts`, behind `rmd emissions`) filtered `n.endsWith(".ndjson")` and missed every
 * gzipped one. Measured on the mini 2026-08-12 over 418,898 distinct lines: ledger-grep reached
 * 384,039 (missing 8.3%), emissions reached 38,744 — MISSING 90.8%, one line in eleven.
 *
 * Both forms are legitimate: `datedArchivePath` writes `<base>.<stamp>.ndjson` and nothing in the
 * repo runs gzip, so plain is what the code produces and the `.gz` half is out-of-band compression
 * that stopped at 2026-08-05T10-56-55Z.
 *
 * EVERY FIXTURE HERE GIVES THE TWO FORMS DISTINCT MARKERS. A test that asserted a TOTAL count would
 * pass against a reader that opened one form twice, which is the failure mode a "wider glob" invites.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerRotationEntries, resolveLedgerUnion } from "../src/lib/ledger-grep.js";
import { emissionsCommand, ledgerCorpusFiles } from "../src/run-task.js";

const GZ_ONLY = '{"ts":"2026-07-01T00:00:00.000Z","step":"run.start","marker":"only-in-gzip"}';
const PLAIN_ONLY = '{"ts":"2026-08-10T00:00:00.000Z","step":"run.start","marker":"only-in-plain"}';
const LIVE_ONLY = '{"ts":"2026-08-12T00:00:00.000Z","step":"run.start","marker":"only-in-live"}';

/** A state dir holding ONE gzipped rotation, ONE plain rotation and the live file — each with a
 *  line that exists nowhere else, so "was this form read" is answerable per form. */
function mixedCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger-both-forms-"));
  writeFileSync(join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz"), gzipSync(Buffer.from(`${GZ_ONLY}\n`)));
  writeFileSync(join(dir, "ledger.2026-08-10T00-00-00-000Z.ndjson"), `${PLAIN_ONLY}\n`);
  writeFileSync(join(dir, "ledger.ndjson"), `${LIVE_ONLY}\n`);
  return dir;
}

// ── DIRECTION 1: ledger-grep finds the row that lives ONLY in the form it used to miss ─────────

test("resolveLedgerUnion reads BOTH rotation forms — the plain-only row is found, not just the gzip one", () => {
  const dir = mixedCorpus();
  try {
    const result = resolveLedgerUnion(dir, "run\\.start");
    assert.equal(result.ok, true, "a healthy mixed corpus is fully covered");
    assert.equal(result.archiveCount, 2, "BOTH rotations count as archives, not just the gzipped one");
    // Asserted per-marker, never by total: a reader that opened the gz twice would still total 3.
    assert.ok(result.matches.includes(GZ_ONLY), "the gzipped rotation was decompressed and read");
    assert.ok(result.matches.includes(PLAIN_ONLY), "the UNCOMPRESSED rotation was read — this is the row that used to be invisible");
    assert.ok(result.matches.includes(LIVE_ONLY), "and the live file, as before");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an uncompressed rotation is read WITHOUT being gunzipped — the form is decided from the name", () => {
  const dir = mixedCorpus();
  try {
    // A plain rotation handed to gunzipSync raises `incorrect header check`; that it does not is
    // the proof the branch is taken on the NAME, before the read, rather than by trying and failing.
    const result = resolveLedgerUnion(dir, "only-in-plain");
    assert.deepEqual(result.matches, [PLAIN_ONLY]);
    assert.deepEqual(result.unread, [], "and nothing was recorded as unreadable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── DIRECTION 2: emissions' corpus gains the form it used to miss ─────────────────────────────

test("ledgerCorpusFiles returns BOTH forms plus the live file, each tagged with how to read it", () => {
  const dir = mixedCorpus();
  try {
    const entries = ledgerCorpusFiles(dir);
    const byName = new Map(entries.map((e) => [e.path.split("/").pop()!, e.form]));
    assert.equal(byName.get("ledger.2026-07-01T00-00-00-000Z.ndjson.gz"), "gzip", "the gzipped rotation is included AND tagged");
    assert.equal(byName.get("ledger.2026-08-10T00-00-00-000Z.ndjson"), "plain");
    assert.equal(byName.get("ledger.ndjson"), "plain", "the live file is plain and is still included");
    assert.equal(entries.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── DIRECTION 3: the guard fires on PARTIAL coverage, not only on an empty dir ─────────────────

test("a rotation that exists but cannot be read is REPORTED and refuses the answer", () => {
  const dir = mixedCorpus();
  try {
    // Present, correctly named, and undecompressable — the exact case a catch-based sniff would
    // silently swallow by treating it as a plain file.
    writeFileSync(join(dir, "ledger.2026-07-02T00-00-00-000Z.ndjson.gz"), "not gzip data");
    const result = resolveLedgerUnion(dir, "run\\.start");
    assert.equal(result.ok, false, "partial coverage must refuse — this is what a zero-only guard cannot see");
    assert.deepEqual(
      result.unread.map((p) => p.split("/").pop()),
      ["ledger.2026-07-02T00-00-00-000Z.ndjson.gz"],
      "and the unread file is NAMED, so the operator knows which half is missing",
    );
    assert.deepEqual(result.matches, [], "the partial answer is withheld rather than handed back as if complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt archive stays LOUD — it is never mistaken for a plain rotation", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-corrupt-loud-"));
  try {
    writeFileSync(join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz"), "not gzip data");
    writeFileSync(join(dir, "ledger.ndjson"), `${LIVE_ONLY}\n`);
    const result = resolveLedgerUnion(dir, "run\\.start");
    assert.equal(result.ok, false);
    assert.equal(result.unread.length, 1, "a genuinely corrupt archive must not degrade into a silent skip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── DIRECTION 4: the healthy paths are unchanged ──────────────────────────────────────────────

test("a gz-only corpus still behaves exactly as before — this ran on every host until today", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-gz-only-"));
  try {
    writeFileSync(join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz"), gzipSync(Buffer.from(`${GZ_ONLY}\n`)));
    writeFileSync(join(dir, "ledger.ndjson"), `${LIVE_ONLY}\n`);
    const result = resolveLedgerUnion(dir, "run\\.start");
    assert.equal(result.ok, true);
    assert.equal(result.archiveCount, 1);
    assert.deepEqual(result.matches.sort(), [GZ_ONLY, LIVE_ONLY].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corpus with NO rotations at all is still the zero-archive verdict, not a coverage failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-none-"));
  try {
    writeFileSync(join(dir, "ledger.ndjson"), `${LIVE_ONLY}\n`);
    const result = resolveLedgerUnion(dir, "run\\.start");
    assert.equal(result.archiveCount, 0);
    assert.deepEqual(result.unread, [], "absent is not unread — a fresh checkout has no rotations and that is not a fault");
    assert.equal(result.ok, false, "the zero-archive refusal is unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── THE CLASSIFIER ITSELF ─────────────────────────────────────────────────────────────────────

test("ledgerRotationEntries excludes the live file and every decoy, and tags each form from its name", () => {
  const entries = ledgerRotationEntries(
    [
      "ledger.2026-07-01T00-00-00-000Z.ndjson.gz",
      "ledger.2026-08-10T00-00-00-000Z.ndjson",
      "ledger.ndjson", // the live file is NEVER a rotation
      "ledger-archive.txt", // not .ndjson
      "ledger.2026-07-01T00-00-00-000Z.ndjson.bak", // neither form
      "service-tokens.json", // not a ledger
    ],
    "/state",
  );
  assert.deepEqual(entries, [
    { path: "/state/ledger.2026-07-01T00-00-00-000Z.ndjson.gz", form: "gzip" },
    { path: "/state/ledger.2026-08-10T00-00-00-000Z.ndjson", form: "plain" },
  ]);
});

/**
 * THE `emissions` READER DECOMPRESSES FOR REAL. Every assertion above about that verb is on
 * `ledgerCorpusFiles`, which only decides WHICH files and how they are tagged — a change that
 * dropped the `gunzipSync` branch in the scan loop itself left all of them green (measured: that
 * falsifier reddened 0 of 32). This drives the whole command over a corpus whose ONLY rotation is
 * gzipped, so the in-window event it counts can have come from nowhere else.
 */
test("emissionsCommand counts events out of a GZIPPED rotation, not just plain ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "emissions-gz-"));
  const ts = new Date().toISOString(); // inside the default 30-day window
  const line = `{"ts":"${ts}","step":"drain.tick","marker":"only-in-gzip"}`;
  writeFileSync(join(dir, "ledger.2026-07-01T00-00-00-000Z.ndjson.gz"), gzipSync(Buffer.from(`${line}\n`)));

  const out: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  let code: number;
  try {
    code = emissionsCommand([], { stateDir: dir });
  } finally {
    console.log = realLog;
  }
  assert.equal(code, 0, "the command completed");
  const corpus = out.find((l) => l.includes("corpus"));
  assert.ok(corpus, "the corpus line is rendered — the fixture reached the scan");
  assert.match(corpus, /1 ledger file\(s\)/, "the gzipped rotation is in the corpus");
  const events = Number(/([0-9]+) distinct in-window events/.exec(corpus)?.[1] ?? "0");
  assert.ok(events >= 1, `the gz line was decompressed and counted (got ${events}) — reading it raw yields no "step" match`);
  rmSync(dir, { recursive: true, force: true });
});
