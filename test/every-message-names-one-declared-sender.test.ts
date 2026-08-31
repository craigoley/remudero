import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PLAN_TASK_ID_PATTERN,
  PRODUCER_IDENTITIES,
  UndeclaredProducerError,
  groupBySender,
  resolveProducerIdentity,
  type ProducerIdentity,
} from "../src/lib/producer-identity.js";
import { appendLedger, appendProducerLedger } from "../src/lib/ledger.js";

// W1-T2495: seventeen pseudo senders write to the ledger and two of them — DAEMON/daemon,
// RETRO/retro — are the same colleague under two spellings; nothing declared any of the
// seventeen, so a message has no "From" a human could recognise and one producer's rows split
// across two keys. This suite proves producer-identity.ts's registry and ledger.ts's
// appendProducerLedger satisfy every acceptance claim on this task's own record.

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-producer-identity-")), "ledger.ndjson");
}

function readLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ── SURFACE: every raw task_id literal actually written to the ledger by a producer in
// src/, scraped from source rather than hand-copied, so this suite fails the moment a new
// spelling lands without a matching registry entry (the regression this whole task guards). ──

const SRC_ROOT = join(import.meta.dirname, "..", "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function scrapedTaskIdLiterals(): Set<string> {
  const found = new Set<string>();
  for (const file of listTsFiles(SRC_ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/task_id:\s*"([^"]+)"/g)) found.add(m[1]);
  }
  // `serviceFreshnessGate` (run-task.ts) stamps `task_id: cmd.toUpperCase()`, called only with
  // cmd "daemon" or "serve" (run-task.ts's main() gates that call to `cmd === "daemon" || cmd
  // === "serve"`) — both literals already present above, folded in explicitly since the scrape
  // above only matches string literals, not the dynamic expression.
  found.add("DAEMON");
  found.add("SERVE");
  // `panel-actions.ts` ledgers non-task-scoped panel actions under the `PANEL_TASK_ID` constant
  // (`"PANEL"`), not a literal at the call site — folded in for the same reason.
  found.add("PANEL");
  return found;
}

test("every raw task_id literal a producer writes to the ledger resolves to exactly one declared entry", () => {
  const literals = scrapedTaskIdLiterals();
  assert.ok(literals.size >= 17, `expected at least the seventeen known pseudo senders, found ${literals.size}`);
  for (const raw of literals) {
    const identity = resolveProducerIdentity(raw);
    assert.equal(typeof identity.id, "string");
    assert.ok(identity.id.length > 0);
  }
});

test("the two case-variant pairs collapse to one sender each", () => {
  assert.equal(resolveProducerIdentity("DAEMON").id, resolveProducerIdentity("daemon").id);
  assert.equal(resolveProducerIdentity("RETRO").id, resolveProducerIdentity("retro").id);
  // Not merely equal ids by coincidence — the SAME identity object, so a display-name edit to
  // one spelling can never drift from the other.
  assert.equal(resolveProducerIdentity("DAEMON"), resolveProducerIdentity("daemon"));
  assert.equal(resolveProducerIdentity("RETRO"), resolveProducerIdentity("retro"));
  // And the two producers remain genuinely distinct from each other.
  assert.notEqual(resolveProducerIdentity("DAEMON").id, resolveProducerIdentity("RETRO").id);
});

test("an undeclared sender is refused rather than silently accepted", () => {
  assert.throws(() => resolveProducerIdentity("EIGHTEENTH"), UndeclaredProducerError);
  assert.throws(() => resolveProducerIdentity("Daemon")); // a THIRD casing nobody declared
  assert.throws(() => resolveProducerIdentity(""));
});

test("every declared sender carries a human-readable display name", () => {
  for (const [raw, identity] of Object.entries(PRODUCER_IDENTITIES)) {
    assert.equal(typeof identity.displayName, "string", `${raw} has no displayName`);
    assert.ok(identity.displayName.trim().length > 0, `${raw}'s displayName is blank`);
  }
  // DAEMON is a log prefix, not a colleague's name — the whole point of this registry is that
  // the console prints something a human recognises instead of the raw internal label.
  assert.equal(PRODUCER_IDENTITIES.DAEMON!.displayName, "Daemon");
  assert.notEqual(PRODUCER_IDENTITIES.DAEMON!.displayName, "DAEMON");
});

test("no historical ledger row is rewritten by this path", () => {
  const path = ledgerPath();
  appendLedger(path, { run_id: "R1", task_id: "DAEMON", step: "daemon.boot" });
  const before = readFileSync(path, "utf8");
  appendProducerLedger(path, "daemon", { run_id: "R2", step: "daemon.heartbeat" });
  const after = readFileSync(path, "utf8");
  // The first line's bytes are untouched — appendProducerLedger only ever appends.
  assert.equal(after.slice(0, before.length), before);
  const lines = readLines(path);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.task_id, "DAEMON"); // exact original spelling, never rewritten
  assert.equal(lines[1]!.task_id, "daemon"); // exact spelling the caller passed, never canonicalised
});

test("a plan task id is never treated as a pseudo sender", () => {
  assert.throws(() => resolveProducerIdentity("W1-T2495"));
  assert.ok(PLAN_TASK_ID_PATTERN.test("W1-T2495"));
  assert.equal(PRODUCER_IDENTITIES["W1-T2495"], undefined);
});

test("grouping by sender yields one bucket for a producer that used two spellings", () => {
  const buckets = groupBySender(["DAEMON", "daemon", "DAEMON", "RETRO"]);
  const daemonId = resolveProducerIdentity("daemon").id;
  const retroId = resolveProducerIdentity("retro").id;
  assert.equal(buckets.size, 2);
  assert.deepEqual(buckets.get(daemonId), ["DAEMON", "daemon", "DAEMON"]);
  assert.deepEqual(buckets.get(retroId), ["RETRO"]);
});

test("replacing the registry with case-folding lets an undeclared sender through", () => {
  // The naive alternative this task's rationale explicitly rejects: fold every raw id to a
  // fixed case and accept anything, rather than consulting a closed, declared list. Case-folding
  // alone cannot refuse a brand-new label — it has no notion of "known" vs. "unknown" at all —
  // so a genuinely undeclared eighteenth sender sails through where the real registry refuses it.
  const caseFoldingOnly = (raw: string): ProducerIdentity => ({ id: raw.toLowerCase(), displayName: raw.toLowerCase() });

  assert.doesNotThrow(() => caseFoldingOnly("EIGHTEENTH"));
  assert.throws(() => resolveProducerIdentity("EIGHTEENTH"), UndeclaredProducerError);

  // Case-folding also fails to distinguish a plan task id from a pseudo sender: it would
  // "resolve" W1-T2495 into a fake sender bucket instead of refusing it as the real function does.
  assert.doesNotThrow(() => caseFoldingOnly("W1-T2495"));
  assert.throws(() => resolveProducerIdentity("W1-T2495"));
});

test("the ledger write path resolves the sender rather than the registry standing alone", () => {
  const path = ledgerPath();
  // A declared sender writes fine, and appendProducerLedger reports the resolved identity.
  const identity = appendProducerLedger(path, "SWEEP", { run_id: "R1", step: "sweep.tick" });
  assert.equal(identity.id, "sweep");
  assert.equal(readLines(path)[0]!.task_id, "SWEEP");

  // An undeclared sender is refused BEFORE anything is written — proving the write path
  // actively resolves the id (and can therefore refuse), rather than the registry merely
  // existing unconsulted alongside a write path that writes anything it is handed.
  assert.throws(() => appendProducerLedger(path, "EIGHTEENTH", { run_id: "R2", step: "x" }), UndeclaredProducerError);
  assert.equal(readLines(path).length, 1, "the refused write must leave no trace");
});

test("declares (at least) the seventeen known pseudo senders with no eighteenth spelling silently added", () => {
  const declaredRaw = Object.keys(PRODUCER_IDENTITIES);
  const distinctProducers = new Set(Object.values(PRODUCER_IDENTITIES).map((p) => p.id));
  assert.ok(declaredRaw.length >= 17, `expected at least 17 declared spellings, found ${declaredRaw.length}`);
  // Two known case-variant pairs collapse the raw spelling count down by exactly two.
  assert.equal(declaredRaw.length - distinctProducers.size, 2);
});
