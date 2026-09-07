import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decideRetroPublicationEscalation,
  escalateRetroPublicationFailure,
  RETRO_PUBLICATION_STRIKE_CAP,
  type RetroLedgerRowView,
} from "../src/lib/retro.js";

const NOW = Date.parse("2026-09-06T23:48:02.314Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;

/** N prepublish failures inside the current episode. */
function failures(n: number, spacingMs = 20 * MIN): RetroLedgerRowView[] {
  return Array.from({ length: n }, (_, i) => ({ step: "retro.preflight_failed", ts: ago((i + 1) * spacingMs) }));
}

/** A create-only gateway — no network, and it records what it was asked to raise. */
function fakeIssues() {
  const raised: Array<{ title: string; body: string }> = [];
  return { raised, gw: { create: (title: string, body: string) => (raised.push({ title, body }), "https://example.invalid/issues/1") } };
}

function lane() {
  const dir = mkdtempSync(join(tmpdir(), "rmd-retro-escalation-"));
  return { dir, ledgerPath: join(dir, "ledger.ndjson"), markerPath: join(dir, "last-retro.json") };
}

test("W1-T2988: a repeated prepublish failure escalates rather than retrying silently", () => {
  const { ledgerPath } = lane();
  const { raised, gw } = fakeIssues();
  const rows = failures(RETRO_PUBLICATION_STRIKE_CAP);
  const decision = escalateRetroPublicationFailure(
    { attempts: 2 },
    { owner: "o", repo: "r", ledgerPath, runId: "RETRO-1", issues: gw, nowMs: NOW, readLedger: () => rows },
  );
  assert.equal(decision.escalate, true);
  assert.equal(decision.strikes, RETRO_PUBLICATION_STRIKE_CAP);
  // It reached the operator, and the notice NAMES its own reason rather than only the symptom.
  assert.equal(raised.length, 1);
  assert.match(raised[0]!.title, /retro cannot publish/i);
  assert.match(raised[0]!.body, /W1-T2988/);
  assert.match(raised[0]!.body, /marker is deliberately NOT advanced/i);
  // ...and the episode marker is written, so the next fire inside the window stays silent.
  const written = readFileSync(ledgerPath, "utf8");
  assert.match(written, /"step":"retro\.publication\.escalated"/);
  assert.match(written, /"delivered":true/);
});

test("W1-T2988: a failed retro leaves the marker unchanged", () => {
  const { ledgerPath, markerPath } = lane();
  const frozen = JSON.stringify({ ts: "2026-09-03T02:24:39.835Z", learnings_count: 79, runs_seen: 10 });
  writeFileSync(markerPath, frozen);
  const { gw } = fakeIssues();
  escalateRetroPublicationFailure(
    { attempts: 2 },
    { owner: "o", repo: "r", ledgerPath, runId: "RETRO-1", issues: gw, nowMs: NOW, readLedger: () => failures(5) },
  );
  // Withholding the marker on failure is CORRECT and this task must not change it: advancing it
  // would permanently discard the runs the retro exists to read. Escalating is orthogonal.
  assert.equal(readFileSync(markerPath, "utf8"), frozen);
});

test("W1-T2988: a single failure is below the strike cap and says nothing", () => {
  const { ledgerPath } = lane();
  const { raised, gw } = fakeIssues();
  const decision = escalateRetroPublicationFailure(
    { attempts: 1 },
    { owner: "o", repo: "r", ledgerPath, runId: "RETRO-1", issues: gw, nowMs: NOW, readLedger: () => failures(1) },
  );
  assert.equal(decision.escalate, false);
  assert.match(decision.reason, /below the strike cap/);
  assert.equal(raised.length, 0);
});

test("W1-T2988: a second failure inside the same episode does not re-open the issue", () => {
  const rows: RetroLedgerRowView[] = [
    ...failures(4),
    { step: "retro.publication.escalated", ts: ago(30 * MIN) },
  ];
  const d = decideRetroPublicationEscalation(rows, NOW);
  assert.equal(d.escalate, false);
  assert.match(d.reason, /already open/);
});

test("W1-T2988: an escalation that has aged out of the episode window escalates again", () => {
  const rows: RetroLedgerRowView[] = [
    ...failures(4, 30 * MIN),
    { step: "retro.publication.escalated", ts: ago(48 * 60 * MIN) }, // two days ago — a prior episode
  ];
  const d = decideRetroPublicationEscalation(rows, NOW);
  assert.equal(d.escalate, true);
});

test("W1-T2988: rows outside the episode window are not counted as strikes", () => {
  const stale: RetroLedgerRowView[] = Array.from({ length: 9 }, (_, i) => ({
    step: "retro.preflight_failed",
    ts: ago((48 * 60 + i) * MIN),
  }));
  const d = decideRetroPublicationEscalation(stale, NOW);
  assert.equal(d.strikes, 0);
  assert.equal(d.escalate, false);
});
