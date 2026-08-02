/**
 * test/ops-alert-reconcile.test.ts — impl-EV.
 *
 * THE CHAIN THIS CLOSES. `rmd ops` captured a feedback entry per open alert and NOTHING ever
 * closed one when the alert was dismissed or fixed on GitHub. Those entries sat at `status: new`
 * forever, aged into being the OLDEST such entry, and auto-triage — which selects exactly that —
 * bought a task for them. On 2026-08-02 it spent $1.48 filing W1-T286 against alerts #60/#61,
 * dismissed as false positives eleven days earlier; implementing that non-issue then raised a
 * real high-severity alert on the helper it added.
 *
 * Every test below drives the REAL `pollAlerts` / `staleAlertFeedbackIds`, never a hand-built
 * fixture that already carries the state being asserted.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { captureFeedback, feedbackDir, listFeedback } from "../src/lib/feedback.js";
import {
  alertFeedbackId,
  pollAlerts,
  priorReconciledAlertFeedbackIds,
  staleAlertFeedbackIds,
  type RawAlert,
} from "../src/lib/ops.js";

const SANDBOX = mkdtempSync(join(tmpdir(), "rmd-ev-reconcile-"));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

const OWNER = "craigoley";
const REPO = "remudero";
let seq = 0;

function newRoot(): string {
  const root = join(SANDBOX, `root-${seq++}`);
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function alert(id: number, state: "open" | "dismissed" | "fixed" = "open"): RawAlert {
  return {
    source: "code-scanning",
    id: String(id),
    severity: "high",
    summary: `Potential file system race condition (#${id})`,
    url: `https://github.com/${OWNER}/${REPO}/security/code-scanning/${id}`,
    state,
    createdAt: "2026-07-21T17:40:35Z",
  } as unknown as RawAlert;
}

/** Capture an entry the way `rmd ops` really does — never a hand-written yaml. */
function captureAlertEntry(root: string, a: RawAlert): string {
  const id = alertFeedbackId(OWNER, REPO, a);
  captureFeedback(root, {
    id,
    raw: `${OWNER}/${REPO} code-scanning alert #${a.id}`,
    origin: `alert#code-scanning-${a.id}`,
    land: { git: () => "", gh: () => "" } as never, // bridge stubbed: no network, no bot branch
  });
  return id;
}

function statusOf(root: string, id: string): string {
  return /^status:\s*(\S+)\s*$/m.exec(readFileSync(join(feedbackDir(root), `${id}.yaml`), "utf8"))?.[1] ?? "?";
}

/** A `pollAlerts` deps bag with every network edge stubbed and the bridge recorded. */
function deps(root: string, open: RawAlert[], ledger: Array<Record<string, unknown>>, landed: string[]) {
  return {
    alerts: {
      codeScanning: () => open,
      dependabot: () => [],
      secretScanning: () => [],
    },
    issues: { create: () => "https://github.com/x/y/issues/1" },
    ledgerPath: join(root, "state", "ledger.ndjson"),
    runId: "OPS-TEST",
    root,
    readLedger: () => ledger,
    now: () => Date.parse("2026-08-02T00:00:00Z"),
    // The landing bridge, recorded rather than executed: asserts we went THROUGH it.
    land: { git: (args: string[]) => (landed.push(args.join(" ")), ""), gh: () => "" } as never,
  } as never;
}

describe("ops alert reconciliation", () => {
  it("an entry whose alert is DISMISSED is reconciled to rejected", async () => {
    const root = newRoot();
    const dismissed = captureAlertEntry(root, alert(60));
    assert.equal(statusOf(root, dismissed), "new", "fixture must start as a live triage candidate");

    // The poll observes NO open alerts — #60 was dismissed on GitHub since capture.
    const result = (await pollAlerts(OWNER, REPO, deps(root, [], [], []))) as { reconciled?: string[] };

    assert.deepEqual(result.reconciled, [dismissed], "the stale entry must be reconciled");
  });

  it("an entry whose alert is STILL OPEN is left alone — the false-positive lock", async () => {
    const root = newRoot();
    const stillOpen = captureAlertEntry(root, alert(11));
    const dismissed = captureAlertEntry(root, alert(60));

    const result = (await pollAlerts(OWNER, REPO, deps(root, [alert(11)], [], []))) as { reconciled?: string[] };

    assert.deepEqual(result.reconciled, [dismissed], "only the closed alert's entry may be touched");
    assert.equal(statusOf(root, stillOpen), "new", "an open alert's entry must remain a candidate");
  });

  it("a human's decision is never overridden — only status:new is reconciled", () => {
    const root = newRoot();
    const id = captureAlertEntry(root, alert(61));
    // Stand in for the operator (or triage) having already moved it on.
    const p = join(feedbackDir(root), `${id}.yaml`);
    writeFileSync(p, readFileSync(p, "utf8").replace(/^status: new$/m, "status: proposed"));

    assert.deepEqual(staleAlertFeedbackIds(root, OWNER, REPO, []), [], "a non-new entry is out of scope");
  });

  it("non-alert entries are never touched", () => {
    const root = newRoot();
    captureFeedback(root, { raw: "a human typed this", origin: "cli", land: { git: () => "", gh: () => "" } as never });
    assert.deepEqual(staleAlertFeedbackIds(root, OWNER, REPO, []), [], "only fb-alert- ids are in scope");
    assert.equal(listFeedback(root, {}).length, 1);
  });

  it("an unreadable entry is skipped, never a reason to refuse the whole poll", () => {
    const root = newRoot();
    const good = captureAlertEntry(root, alert(60));
    // A DIRECTORY named like an entry: readFileSync raises EISDIR on it.
    mkdirSync(join(feedbackDir(root), "fb-alert-craigoley-remudero-code-scanning-999.yaml"));

    const stale = staleAlertFeedbackIds(root, OWNER, REPO, []);

    assert.deepEqual(stale, [good], "the readable stale entry is still found; the unreadable one is skipped");
  });

  // ── TRAP 1: stability and re-capture ────────────────────────────────────────

  it("repeated polls with unchanged input do NOT thrash — the second poll reconciles nothing", async () => {
    const root = newRoot();
    const id = captureAlertEntry(root, alert(60));
    const ledger: Array<Record<string, unknown>> = [];
    const landed: string[] = [];

    const first = (await pollAlerts(OWNER, REPO, deps(root, [], ledger, landed))) as { reconciled?: string[] };
    assert.deepEqual(first.reconciled, [id], "first poll closes it");

    // The ledger is the dedup — feed the first poll's own line back, exactly as a real re-poll would.
    const written = readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(priorReconciledAlertFeedbackIds(written).has(id), "the poll must ledger its own dedup key");

    const second = (await pollAlerts(OWNER, REPO, deps(root, [], written, landed))) as { reconciled?: string[] };
    assert.deepEqual(second.reconciled, [], "a second poll with unchanged input must be a no-op");
  });

  it("a REOPENED alert stops being stale and its entry is not re-captured (same id)", async () => {
    const root = newRoot();
    const id = captureAlertEntry(root, alert(60));
    const before = readdirSync(feedbackDir(root)).filter((n) => n.endsWith(".yaml")).length;

    // Reopened on GitHub: same alert NUMBER, so the same feedback id returns to the open set.
    assert.deepEqual(staleAlertFeedbackIds(root, OWNER, REPO, [alert(60)]), [], "a reopened alert is not stale");

    const result = (await pollAlerts(OWNER, REPO, deps(root, [alert(60)], [], []))) as { feedbackCreated?: unknown[] };
    assert.deepEqual(result.feedbackCreated, [], "the existsSync dedup must not double-create");
    assert.equal(readdirSync(feedbackDir(root)).filter((n) => n.endsWith(".yaml")).length, before);
    assert.ok(id.endsWith("-60"), "identity is the alert NUMBER");
  });

  it("a REGRESSED finding arrives as a NEW number and is captured fresh", async () => {
    const root = newRoot();
    captureAlertEntry(root, alert(60));
    // CodeQL re-raises the same rule at a new location: a new alert number, hence a new id.
    const result = (await pollAlerts(OWNER, REPO, deps(root, [alert(84)], [], []))) as {
      feedbackCreated?: Array<{ id: string }>;
    };
    assert.equal(result.feedbackCreated?.length, 1, "a new alert number must still be captured");
    assert.equal(result.feedbackCreated?.[0].id, alertFeedbackId(OWNER, REPO, alert(84)));
  });

  // ── THE BRIDGE ──────────────────────────────────────────────────────────────

  it("the reconcile goes THROUGH the landing bridge — the working tree is untouched", async () => {
    const root = newRoot();
    const id = captureAlertEntry(root, alert(60));
    const landed: string[] = [];

    await pollAlerts(OWNER, REPO, deps(root, [], [], landed));

    assert.equal(statusOf(root, id), "new", "the LOCAL entry must be untouched — the bridge lands it, not a raw write");
    assert.ok(landed.length > 0, "the bridge must actually have been driven");
  });
});
