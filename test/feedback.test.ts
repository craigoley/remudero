import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  FEEDBACK_ORIGINS,
  FEEDBACK_STATUSES,
  FeedbackError,
  captureFeedback,
  feedbackAttachmentsDir,
  feedbackEntryPath,
  listFeedback,
  parseFeedbackAddArgs,
  readFeedbackEntry,
  setFeedbackStatus,
} from "../src/lib/feedback.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "rmd-feedback-"));
}

// ── parseFeedbackAddArgs (pure) ──────────────────────────────────────────────

test("parseFeedbackAddArgs: bare text with no flags, default origin cli, no attachments", () => {
  const parsed = parseFeedbackAddArgs(["the", "drain", "loop", "hung"]);
  assert.deepEqual(parsed, { raw: "the drain loop hung", attachments: [], origin: "cli" });
});

test("parseFeedbackAddArgs: --attach is repeatable and order-independent relative to text", () => {
  const parsed = parseFeedbackAddArgs(["broken", "--attach", "shot.png", "ui", "--attach", "https://x.test/log"]);
  assert.deepEqual(parsed, {
    raw: "broken ui",
    attachments: ["shot.png", "https://x.test/log"],
    origin: "cli",
  });
});

test("parseFeedbackAddArgs: --origin accepts every value in the closed enum", () => {
  for (const origin of FEEDBACK_ORIGINS) {
    const parsed = parseFeedbackAddArgs(["x", "--origin", origin]);
    assert.deepEqual(parsed, { raw: "x", attachments: [], origin });
  }
});

test("parseFeedbackAddArgs FAILS LOUD: unrecognized flag returns an error, not a silent guess", () => {
  const parsed = parseFeedbackAddArgs(["hi", "--bogus", "wat"]);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /unrecognized flag '--bogus'/);
});

test("parseFeedbackAddArgs FAILS LOUD: --origin outside the enum is rejected", () => {
  const parsed = parseFeedbackAddArgs(["hi", "--origin", "telepathy"]);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /--origin must be one of/);
});

test("parseFeedbackAddArgs FAILS LOUD: no text at all is rejected", () => {
  const parsed = parseFeedbackAddArgs(["--origin", "cli"]);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /no feedback text given/);
});

test("parseFeedbackAddArgs FAILS LOUD: --attach with no value is rejected", () => {
  const parsed = parseFeedbackAddArgs(["hi", "--attach"]);
  assert.ok("error" in parsed);
  assert.match((parsed as { error: string }).error, /--attach requires a value/);
});

// ── captureFeedback (I/O) ─────────────────────────────────────────────────────

test("captureFeedback writes plan/feedback/<id>.yaml with status new and the §7B schema shape", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "the digest fired twice" });

  assert.equal(entry.raw, "the digest fired twice");
  assert.equal(entry.status, "new");
  assert.equal(entry.origin, "cli");
  assert.deepEqual(entry.attachments, []);
  assert.equal(entry.proposal_pr, null);
  assert.match(entry.id, /^fb-\d+-[0-9a-f]{6}$/);
  assert.ok(!Number.isNaN(Date.parse(entry.ts)));

  const p = feedbackEntryPath(r, entry.id);
  assert.ok(existsSync(p));
  const onDisk = parseYaml(readFileSync(p, "utf8"));
  assert.deepEqual(onDisk, entry);
});

test("captureFeedback returns instantly (no network/LLM) and never lost — two captures land as two files", () => {
  const r = root();
  const a = captureFeedback(r, { raw: "first" });
  const b = captureFeedback(r, { raw: "second" });
  assert.notEqual(a.id, b.id);
  assert.ok(existsSync(feedbackEntryPath(r, a.id)));
  assert.ok(existsSync(feedbackEntryPath(r, b.id)));
});

test("captureFeedback rejects empty/whitespace-only text — nothing written", () => {
  const r = root();
  assert.throws(() => captureFeedback(r, { raw: "   " }), FeedbackError);
  assert.deepEqual(listFeedback(r), []);
});

test("captureFeedback: an http(s) --attach is a LINK, stored verbatim, nothing copied", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "see this", attachments: ["https://example.test/screenshot.png"] });
  assert.deepEqual(entry.attachments, ["https://example.test/screenshot.png"]);
});

test("captureFeedback: a local-path --attach is copied into plan/feedback/attachments/<id>/", () => {
  const r = root();
  const src = join(mkdtempSync(join(tmpdir(), "rmd-feedback-src-")), "terminal.log");
  writeFileSync(src, "boom\n");

  const entry = captureFeedback(r, { raw: "crash log attached", attachments: [src] });

  assert.equal(entry.attachments.length, 1);
  assert.equal(entry.attachments[0], `plan/feedback/attachments/${entry.id}/terminal.log`);
  const dest = join(feedbackAttachmentsDir(r, entry.id), "terminal.log");
  assert.equal(readFileSync(dest, "utf8"), "boom\n");
});

test("captureFeedback FAILS LOUD on a missing local attachment — no entry written", () => {
  const r = root();
  assert.throws(() => captureFeedback(r, { raw: "x", attachments: ["/no/such/file.png"] }), FeedbackError);
  assert.deepEqual(listFeedback(r), []);
});

test("captureFeedback rejects an origin outside the closed enum", () => {
  const r = root();
  // @ts-expect-error deliberately invalid at the type level, guarded at runtime too
  assert.throws(() => captureFeedback(r, { raw: "x", origin: "carrier-pigeon" }), FeedbackError);
});

// ── read / list / lifecycle ───────────────────────────────────────────────────

test("readFeedbackEntry round-trips what captureFeedback wrote", () => {
  const r = root();
  const written = captureFeedback(r, { raw: "round trip me" });
  assert.deepEqual(readFeedbackEntry(r, written.id), written);
});

test("readFeedbackEntry throws on an unknown id", () => {
  const r = root();
  assert.throws(() => readFeedbackEntry(r, "fb-nope"), FeedbackError);
});

test("listFeedback on an empty/nonexistent inbox returns []", () => {
  assert.deepEqual(listFeedback(root()), []);
});

test("listFeedback returns every captured entry, optionally filtered by status", () => {
  const r = root();
  const a = captureFeedback(r, { raw: "a" });
  const b = captureFeedback(r, { raw: "b" });
  setFeedbackStatus(r, b.id, "proposed");

  const all = listFeedback(r);
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((e) => e.id).sort(),
    [a.id, b.id].sort(),
  );

  const proposedOnly = listFeedback(r, { status: "proposed" });
  assert.deepEqual(proposedOnly.map((e) => e.id), [b.id]);
});

test("setFeedbackStatus moves an entry through the §7B lifecycle and can attach a proposal_pr", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "grill me" });
  assert.equal(entry.status, "new");

  const grilling = setFeedbackStatus(r, entry.id, "grilling");
  assert.equal(grilling.status, "grilling");
  assert.equal(grilling.proposal_pr, null);

  const proposed = setFeedbackStatus(r, entry.id, "proposed", { proposalPr: "https://github.com/x/y/pull/1" });
  assert.equal(proposed.status, "proposed");
  assert.equal(proposed.proposal_pr, "https://github.com/x/y/pull/1");

  const accepted = setFeedbackStatus(r, entry.id, "accepted");
  assert.equal(accepted.status, "accepted");
  // proposal_pr survives a later transition that doesn't pass a new one:
  assert.equal(accepted.proposal_pr, "https://github.com/x/y/pull/1");

  assert.deepEqual(FEEDBACK_STATUSES, ["new", "grilling", "proposed", "accepted", "rejected"]);
});

test("setFeedbackStatus rejects a status outside the closed enum", () => {
  const r = root();
  const entry = captureFeedback(r, { raw: "x" });
  assert.throws(() => setFeedbackStatus(r, entry.id, "vibing" as never), FeedbackError);
});

test("setFeedbackStatus throws on an unknown id", () => {
  assert.throws(() => setFeedbackStatus(root(), "fb-nope", "proposed"), FeedbackError);
});
