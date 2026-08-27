// W1-T2388: `buildDigest` used to open exactly ONE path (the live ledger file). `rotateLedger`
// (ledger.ts) sheds every row whose `step` is not in `DECISION_RELEVANT_LEDGER_STEPS` out of the
// live file on every rotation — 7 of the 10 steps `summarize`/`renderDigest` sweep are absent
// from that set, so their rows survive ONLY in the archive rotation moved them to. This file
// proves the fix: a bounded rotation union (`collectDigestLedgerLines`) that opens the live file
// plus every archive that can still hold a row inside `[sinceIso, now]`, skips archives it can
// prove are too old to matter, degrades a no-rotation window to exactly today's read, and never
// lets an unreadable archive inside the window pass as a quiet, complete board.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { buildDigest, collectDigestLedgerLines, renderDigest, renderIncompleteReadNotice, summarize } from "../src/lib/digest.js";
import { readLedgerLines } from "../src/lib/status.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function tmpStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A dated rotation's filename, the exact inverse of `rotationStampIso`/`datedArchivePath`. */
function archiveName(iso: string, form: "gzip" | "plain" = "gzip"): string {
  return `ledger.${iso.replace(/[:.]/g, "-")}.ndjson${form === "gzip" ? ".gz" : ""}`;
}

function writeGzArchive(stateDir: string, iso: string, lines: Array<Record<string, unknown>>): string {
  const name = archiveName(iso);
  writeFileSync(join(stateDir, name), gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8")));
  return join(stateDir, name);
}

function writeCorruptArchive(stateDir: string, iso: string): string {
  const name = archiveName(iso);
  // Not a real gzip stream at all — opening this (gunzipSync) throws.
  writeFileSync(join(stateDir, name), Buffer.from("not actually gzip data", "utf8"));
  return join(stateDir, name);
}

function writeLive(stateDir: string, lines: Array<Record<string, unknown>>): string {
  const p = join(stateDir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  return p;
}

// ── claim: "the digest renders a step whose rows have already been rotated out of the live file" ──

test("buildDigest renders a step whose only surviving row lives in a rotation, not the live file", () => {
  const dir = tmpStateDir("rmd-digest-rotation-render-");
  try {
    // inbox.polled is one of the seven steps absent from DECISION_RELEVANT_LEDGER_STEPS — rotation
    // can shed it from the live file completely while leaving it here, in an archive.
    writeGzArchive(dir, "2026-08-20T01:00:00.000Z", [
      { ts: "2026-08-20T00:30:00.000Z", step: "inbox.polled", inbox: { ready: 4 } },
    ]);
    const ledgerPath = writeLive(dir, [{ ts: "2026-08-20T02:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged" }]);

    const text = buildDigest(ledgerPath, "2026-08-20T00:00:00.000Z");
    assert.match(text, /inbox: 4 ready/, "the rotated-out inbox.polled row must still render");
    assert.match(text, /merged: W1-T1/, "the live file's own row must still render too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── claim: "an archive stamped before the window is never opened" ──────────────────────────────

test("collectDigestLedgerLines never calls readFileBuffer for an archive stamped before sinceIso", () => {
  const dir = tmpStateDir("rmd-digest-rotation-bound-");
  try {
    const beforePath = writeGzArchive(dir, "2026-08-19T23:00:00.000Z", [
      { ts: "2026-08-19T22:00:00.000Z", step: "inbox.polled", inbox: { ready: 99 } },
    ]);
    const inPath = writeGzArchive(dir, "2026-08-20T01:00:00.000Z", [
      { ts: "2026-08-20T00:30:00.000Z", step: "inbox.polled", inbox: { ready: 4 } },
    ]);
    const ledgerPath = writeLive(dir, []);

    const opened: string[] = [];
    const { lines, unreadArchives } = collectDigestLedgerLines(ledgerPath, "2026-08-20T00:00:00.000Z", {
      readFileBuffer: (p) => {
        opened.push(p);
        return readFileSync(p);
      },
    });

    assert.ok(!opened.includes(beforePath), "the before-window archive must never be opened");
    assert.ok(opened.includes(inPath), "the in-window archive must be opened");
    assert.deepEqual(unreadArchives, []);
    // Only the in-window row (99 must never appear — its archive was never even read).
    assert.ok(!lines.some((l) => (l as { inbox?: { ready?: number } }).inbox?.ready === 99));
    assert.ok(lines.some((l) => (l as { inbox?: { ready?: number } }).inbox?.ready === 4));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildDigest never throws on a CORRUPT before-window archive — proof it was never opened at all", () => {
  const dir = tmpStateDir("rmd-digest-rotation-bound-corrupt-");
  try {
    // A corrupt archive that would throw on open — but it is stamped before sinceIso, so a
    // correct reader never gets far enough to find out.
    writeCorruptArchive(dir, "2026-08-19T00:00:00.000Z");
    const ledgerPath = writeLive(dir, [{ ts: "2026-08-20T02:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged" }]);

    const text = buildDigest(ledgerPath, "2026-08-20T00:00:00.000Z");
    assert.match(text, /merged: W1-T1/);
    assert.ok(!/INCOMPLETE READ/.test(text), "a corrupt archive outside the window must never surface as an incomplete read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── claim: "a window with no rotation reads exactly what it reads today" ───────────────────────

test("buildDigest with zero archives on disk matches the plain live-file read exactly", () => {
  const dir = tmpStateDir("rmd-digest-rotation-noarchive-");
  try {
    const rows = [
      { ts: "2026-08-20T01:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged", cost_usd: 1 },
      { ts: "2026-08-20T02:00:00.000Z", step: "escalation.issue_opened", task_id: "W1-T2", class: "BLOCKED", issue_url: "https://x/1" },
    ];
    const ledgerPath = writeLive(dir, rows);
    const sinceIso = "2026-08-20T00:00:00.000Z";

    const { lines, unreadArchives } = collectDigestLedgerLines(ledgerPath, sinceIso);
    assert.deepEqual(unreadArchives, []);
    assert.deepEqual(lines, [...readLedgerLines(ledgerPath)], "the union must equal the plain live read byte for byte");
    assert.equal(buildDigest(ledgerPath, sinceIso), buildDigest(ledgerPath, sinceIso), "deterministic re-render");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildDigest with archives that ALL fall before the window still matches the plain live-file read", () => {
  const dir = tmpStateDir("rmd-digest-rotation-allbefore-");
  try {
    writeGzArchive(dir, "2026-08-19T00:00:00.000Z", [{ ts: "2026-08-18T00:00:00.000Z", step: "inbox.polled", inbox: { ready: 7 } }]);
    writeGzArchive(dir, "2026-08-19T12:00:00.000Z", [{ ts: "2026-08-19T11:00:00.000Z", step: "inbox.polled", inbox: { ready: 8 } }]);
    const rows = [{ ts: "2026-08-20T01:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged" }];
    const ledgerPath = writeLive(dir, rows);
    const sinceIso = "2026-08-20T00:00:00.000Z";

    const withArchives = buildDigest(ledgerPath, sinceIso);
    const liveOnly = renderDigest(summarize(readLedgerLines(ledgerPath), sinceIso));
    assert.equal(withArchives, liveOnly, "rotations entirely before the window must change nothing about the render");
    assert.ok(!/inbox:/.test(withArchives), "neither pre-window archive's row may leak in");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── claim: "an incomplete read is rendered as incomplete and never as a quiet board" ───────────

test("buildDigest names an unreadable in-window archive rather than silently dropping its rows", () => {
  const dir = tmpStateDir("rmd-digest-rotation-incomplete-");
  try {
    const corruptPath = writeCorruptArchive(dir, "2026-08-20T01:00:00.000Z"); // inside the window
    const ledgerPath = writeLive(dir, [{ ts: "2026-08-20T02:00:00.000Z", step: "verdict", task_id: "W1-T1", verdict: "merged" }]);

    const text = buildDigest(ledgerPath, "2026-08-20T00:00:00.000Z");
    assert.match(text, /INCOMPLETE READ/, "an unopenable in-window archive must be flagged, never silently absent");
    assert.ok(text.includes(corruptPath), "the offending archive is NAMED, not summarised into a bare count");
    assert.match(text, /merged: W1-T1/, "the rest of the digest still renders — an incomplete read degrades, it does not blank the board");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderIncompleteReadNotice names every unread archive and its count", () => {
  const notice = renderIncompleteReadNotice(["/state/ledger.a.ndjson.gz", "/state/ledger.b.ndjson.gz"]);
  assert.match(notice, /^INCOMPLETE READ: 2 archive\(s\)/);
  assert.ok(notice.includes("/state/ledger.a.ndjson.gz"));
  assert.ok(notice.includes("/state/ledger.b.ndjson.gz"));
});

// ── claim: "no step is added to the decision relevant set by this task" ────────────────────────

test("digest.ts never imports or mutates DECISION_RELEVANT_LEDGER_STEPS — the fix is a read path, not a retention registration", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "digest.ts"), "utf8");
  // digest.ts's own doc comments NAME the set (explaining why this task deliberately does not
  // touch it, mirroring how deployer.ts/image-drift.ts/ci-parity.ts reference it in prose too) —
  // that is fine. What must never appear is an IMPORT of it (the only way this module could ever
  // read it) or a call that mutates it (`.add(` beside the name).
  assert.ok(
    !/import\s*\{[^}]*\bDECISION_RELEVANT_LEDGER_STEPS\b[^}]*\}\s*from/.test(src),
    "digest.ts must not import DECISION_RELEVANT_LEDGER_STEPS from ledger.ts at all",
  );
  assert.ok(
    !/DECISION_RELEVANT_LEDGER_STEPS\s*\.\s*add\s*\(/.test(src),
    "digest.ts must never add a step to the decision-relevant set",
  );
});

test("none of the seven previously-unretained steps this task is about are members of DECISION_RELEVANT_LEDGER_STEPS", () => {
  const unretained = [
    "board_review.ran",
    "inbox.polled",
    "issues.polled",
    "learnings.injected",
    "ops.alerts_polled",
    "review.downgrade_suppressed",
    "sweep.repeat_escalated",
  ];
  for (const step of unretained) {
    assert.ok(!DECISION_RELEVANT_LEDGER_STEPS.has(step), `${step} must stay OUT of the decision-relevant set — this task fixes the READER, not retention`);
  }
});

// ── claim: "the digest stays a reporter and files nothing" (grep proof: escalate: false) ───────

test("digest.ts's digest cadence policy still carries escalate: false — the digest never escalates", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "digest.ts"), "utf8");
  assert.match(src, /escalate:\s*false/, "the digest cadence must stay a pure reporter");
});

// ── claim: "nothing added paces or throttles or sleeps a call" ─────────────────────────────────

test("the rotation-union read path adds no pacing/throttling/sleep of any kind", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "digest.ts"), "utf8");
  const body = src.slice(src.indexOf("W1-T2388: THE ROTATION UNION"), src.indexOf("export function buildDigest") + 2000);
  assert.ok(!/setTimeout|setInterval|\bsleep\s*\(/i.test(body), "no timer/sleep primitive belongs in a synchronous ledger read");
  assert.equal(collectDigestLedgerLines.constructor.name, "Function", "collectDigestLedgerLines must be synchronous, never async");
  assert.equal(buildDigest.constructor.name, "Function", "buildDigest must be synchronous, never async");
});
