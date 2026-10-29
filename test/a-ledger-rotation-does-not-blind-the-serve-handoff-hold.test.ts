import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { realLedgerFs, type LedgerGrepFsDeps } from "#src/lib/ledger-union.js";
import {
  SERVE_HANDOFF_ROTATION_WINDOW_MS,
  realServePolicyDeps,
  runServePolicyCycle,
  serveHandoffInProgressFromLedger,
} from "#src/lib/serve-policy-convergence.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T9509 — 2026-10-14: every serve-policy tick from 16:03Z held serve's replace on its handoff rows, until the ledger
// rotated at 17:00:22Z; the tick at 17:02:56Z read the fresh live ledger.ndjson alone, found no handoff row, and replaced.
const row = (ts: string, step: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts, task_id: "SERVE", step, lane: "serve", ...extra });
const OLDER_ROTATION = "ledger.2026-10-14T15-20-55-785Z.ndjson";
const NEWEST_ROTATION = "ledger.2026-10-14T17-00-22-760Z.ndjson.gz";
/** A handoff that forked its standby and is mid-promote when the ledger rotates under it. */
const OPENED = [
  row("2026-10-14T16:59:28.100Z", "serve.handoff_requested", { reason: "checkout_behind" }),
  row("2026-10-14T16:59:30.200Z", "serve.handoff_shed", { generation: 1, answered: true, gc: true }),
];
const UNRELATED = [row("2026-10-14T17:01:00.000Z", "deploy.serve_policy_held"), row("2026-10-14T17:02:00.000Z", "fix.dispatch")];
const NOW = Date.parse("2026-10-14T17:02:56Z");
const DRIFT = { expected: `sha256:${"d".repeat(64)}`, actual: `sha256:${"3".repeat(64)}` };

interface Corpus { older?: string[]; newest?: string[]; live?: string[] }

function primary(t: TestContext, corpus: Corpus) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}serve-rotation-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installPath = join(root, "install");
  const stateRoot = join(root, "primary-state");
  const stateDir = join(stateRoot, "state");
  mkdirSync(join(installPath, ".remudero"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(installPath, ".remudero", "daemon-instances.yaml"),
    `instances:\n  core:\n    primary: true\n    state_dir: ${stateRoot}\n    container_name: remudero-daemon\n`);
  const text = (rows: string[]) => `${rows.join("\n")}\n`;
  // the read-the-ledger-union doctrine: both rotated forms, plain and gzipped, beside the live file
  if (corpus.older) writeFileSync(join(stateDir, OLDER_ROTATION), text(corpus.older));
  if (corpus.newest) writeFileSync(join(stateDir, NEWEST_ROTATION), gzipSync(text(corpus.newest)));
  if (corpus.live) writeFileSync(join(stateDir, "ledger.ndjson"), text(corpus.live));
  return { installPath, stateRoot, stateDir };
}

function cycle(serveHandoffInProgress: () => boolean | undefined) {
  const rows: string[] = [];
  let replaced = 0;
  const deps = {
    log: (step: string) => rows.push(step),
    now: () => NOW,
    stopPresent: () => false,
    pausePresent: () => false,
    serveHandoffInProgress,
    serveHealthy: () => true,
    servePolicyLastFailedAtMs: () => undefined,
    servePolicyDrift: () => [],
    serveMountPlanDrift: () => [],
    serveImageDrift: () => (replaced > 0 ? undefined : DRIFT),
    replaceServe: () => { replaced++; },
    clearServePolicyFailure: () => {},
  } as unknown as Parameters<typeof runServePolicyCycle>[0];
  const out = runServePolicyCycle(deps, { imageDriftOnly: true });
  return { out, rows, replaced: () => replaced };
}

test("W1-T9509: a ledger rotation does not blind the serve handoff hold", (t) => {
  const site = primary(t, { older: [row("2026-10-14T15:00:00.000Z", "serve.supervisor_ready")], newest: OPENED, live: UNRELATED });
  const seams = realServePolicyDeps(site);
  assert.equal(seams.serveHandoffInProgress!(), true, "the open handoff sits in the newest rotation");
  const c = cycle(seams.serveHandoffInProgress!);
  assert.equal(c.out.replaced, false, c.out.reason);
  assert.equal(c.replaced(), 0);
  assert.match(c.out.reason, /a serve handoff is in progress/);
});

test("W1-T9509: a handoff that closed after the rotation lets the replace go", (t) => {
  const done = row("2026-10-14T17:01:30.000Z", "serve.handoff_done", { generation: 2 });
  const seams = realServePolicyDeps(primary(t, { newest: OPENED, live: [...UNRELATED, done] }));
  assert.equal(seams.serveHandoffInProgress!(), false);
  const c = cycle(seams.serveHandoffInProgress!);
  assert.equal(c.out.replaced, true, c.out.reason);
  assert.deepEqual(c.rows, ["deploy.serve_policy_replace", "deploy.serve_policy_replaced"]);
});

test("W1-T9509: the handoff rows are read in ts order, a row without a ts keeping its place", (t) => {
  // the close is stamped after the open, though written to the live file ahead of an earlier-stamped open
  const late = [row("2026-10-14T17:01:40.000Z", "serve.supervisor_start"), row("2026-10-14T17:01:20.000Z", "serve.handoff_requested")];
  assert.equal(serveHandoffInProgressFromLedger(primary(t, { newest: [], live: late }).stateDir), false);
  const unstamped = [row("2026-10-14T17:01:20.000Z", "serve.handoff_requested"), JSON.stringify({ step: "serve.handoff_done" })];
  assert.equal(serveHandoffInProgressFromLedger(primary(t, { live: unstamped }).stateDir), false);
});

test("W1-T9509: the read is bounded to rotations cut near the newest, but always the newest one", (t) => {
  assert.equal(SERVE_HANDOFF_ROTATION_WINDOW_MS, 2 * 60 * 60 * 1000);
  // the older rotation was cut 1h40m before the newest: inside the window, so its open handoff is still seen
  assert.equal(serveHandoffInProgressFromLedger(primary(t, { older: OPENED, newest: UNRELATED, live: UNRELATED }).stateDir), true);
  // one cut more than the window before the newest is never opened
  const site = primary(t, { newest: UNRELATED, live: UNRELATED });
  writeFileSync(join(site.stateDir, "ledger.2026-10-14T12-00-00-000Z.ndjson"), `${OPENED.join("\n")}\n`);
  const opened: string[] = [];
  const spy: LedgerGrepFsDeps = { ...realLedgerFs, readFileSync: (path) => { opened.push(path); return realLedgerFs.readFileSync(path); } };
  assert.equal(serveHandoffInProgressFromLedger(site.stateDir, spy), false);
  assert.ok(!opened.some((p) => p.endsWith("ledger.2026-10-14T12-00-00-000Z.ndjson")), opened.join(", "));
  assert.ok(opened.some((p) => p.endsWith(NEWEST_ROTATION)), "the newest rotation is read");
});

test("W1-T9509: an unreadable union holds the replace", (t) => {
  const site = primary(t, { newest: OPENED, live: UNRELATED });
  const failing = (bad: (path: string) => boolean): LedgerGrepFsDeps => ({
    ...realLedgerFs,
    readFileSync: (path) => { if (bad(path)) throw new Error("EACCES"); return realLedgerFs.readFileSync(path); },
  });
  assert.equal(serveHandoffInProgressFromLedger(site.stateDir, failing((p) => p.endsWith(NEWEST_ROTATION))), undefined, "unread rotation");
  assert.equal(serveHandoffInProgressFromLedger(site.stateDir, failing((p) => p.endsWith("ledger.ndjson"))), undefined, "unreadable live file");
  const throwing: LedgerGrepFsDeps = { ...realLedgerFs, existsSync: () => { throw new Error("EIO"); } };
  assert.equal(serveHandoffInProgressFromLedger(site.stateDir, throwing), undefined, "a read that throws");
  assert.equal(realServePolicyDeps(primary(t, { newest: OPENED })).serveHandoffInProgress!(), undefined, "no live file yet");
  assert.equal(cycle(() => undefined).out.replaced, false);
});
