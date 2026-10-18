import assert from "node:assert/strict";
import { test } from "node:test";
import { createService } from "#src/lib/service.js";
import { buildInboxAttentionCensusRoute } from "#src/lib/panel-graph.js";
import { runSlowLaneWorker } from "#src/lib/read-model-slow-lane.js";
import { readPersistedInbox } from "#src/lib/fleet-lane.js";
import { defaultInstanceInboxSources, NO_INSTANCE_RATIFY } from "#src/lib/instance-gateway.js";
import { mountInstanceInboxRoutes } from "#src/lib/instance-inbox-contract.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const scope = { instance: "core", repository: "owner/core", proposalId: "verify-human:W1-T216", taskId: "W1-T216" };
const snapshotKey = "a".repeat(64);
const window = { from: "2026-10-13T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z" };
const coverage = { receipts: "observed", outcomes: "observed", plan: "observed", registry: "observed" } as const;
const controls = { heldSecurity: { taskId: "W1-T216", observed: true, passed: true }, terminalMechanical: { observed: true, passed: true } };
const retirement = { id: "retirement-1", kind: "retire", scope, snapshotKey, at: "2026-10-13T12:00:00.000Z", authority: "automatic", heldAtRetirement: true } as const;

test("an inbox dismissal audit keeps partial sources unmeasurable", async () => {
  const { buildInboxDismissalAudit } = await import("#src/lib/inbox-dismissal-audit.js");
  const input = { scope: { instance: "core", repository: "owner/core" }, window, coverage, controls, receipts: [] };
  const empty = buildInboxDismissalAudit(input);
  assert.equal(empty.state, "measured");
  assert.equal(empty.measurement.falseDismissals, 0);
  assert.equal(empty.measurement.falseDismissalRate, null, "an empty denominator has no precision estimate");
  const { validInboxDismissalAudit } = await import("#src/lib/inbox-dismissal-audit.js");
  assert.equal(validInboxDismissalAudit({ ...empty, scope: { instance: null, repository: null } }), undefined);
  assert.equal(validInboxDismissalAudit({ ...empty, window: { from: window.to, to: window.from } }), undefined);
  assert.equal(validInboxDismissalAudit({ ...empty, truncated: true }), undefined);
  assert.equal(buildInboxDismissalAudit({ ...input, coverage: {} as typeof coverage }).measurement.falseDismissals, null);
  const missing = buildInboxDismissalAudit({ ...input, coverage: { ...coverage, receipts: "partial" } });
  assert.equal(missing.state, "unmeasurable");
  assert.equal(missing.measurement.falseDismissals, null);
  assert.equal(missing.measurement.falseDismissalRate, null);
});

test("an inbox dismissal audit includes a held security ask as its negative control", async () => {
  const { buildInboxDismissalAudit } = await import("#src/lib/inbox-dismissal-audit.js");
  const terminalScope = { ...scope, proposalId: "ruling:terminal", taskId: "W1-T900" };
  const terminal = { ...retirement, id: "terminal-retirement", scope: terminalScope, heldAtRetirement: false };
  const outcome = { id: "terminal-outcome", kind: "outcome", retirementId: terminal.id, scope: terminalScope, snapshotKey, at: "2026-10-13T13:00:00.000Z", outcome: "terminal_confirmed", evidence: "merged-own-task-receipt" } as const;
  const input = { scope: { instance: "core", repository: "owner/core" }, window, coverage, controls, receipts: [retirement, terminal, outcome] };
  const result = buildInboxDismissalAudit(input);
  assert.equal(result.denominator.eligible, 2);
  assert.equal(result.denominator.sampled, 2);
  assert.equal(result.observed.falseDismissals, 1);
  assert.equal(result.observed.terminalConfirmed, 1);
  assert.equal(result.measurement.falseDismissals, 1);
  assert.equal(result.measurement.falseDismissalRate, 0.5);
  const absent = buildInboxDismissalAudit({ ...input, controls: { ...controls, heldSecurity: { taskId: "W1-T216", observed: false, passed: false } } });
  assert.equal(absent.measurement.falseDismissals, null, "no affirmative zero or rate without the mandatory control");
});

test("a dismissal audit joins only the exact source and retirement attempt", async () => {
  const { buildInboxDismissalAudit } = await import("#src/lib/inbox-dismissal-audit.js");
  const input = { scope: { instance: "core", repository: "owner/core" }, window, coverage, controls,
    receipts: [{ ...retirement, heldAtRetirement: false },
      { id: "foreign-outcome", kind: "outcome", retirementId: retirement.id, scope: { ...scope, repository: "owner/site", instance: "site" }, snapshotKey, at: retirement.at, outcome: "terminal_confirmed", evidence: "foreign" },
      { id: "wrong-attempt", kind: "outcome", retirementId: "other-retirement", scope, snapshotKey, at: retirement.at, outcome: "terminal_confirmed", evidence: "wrong attempt" },
      { id: "wrong-snapshot", kind: "restore", retirementId: retirement.id, scope, snapshotKey: "b".repeat(64), at: retirement.at }] };
  const before = JSON.stringify(input);
  const audit = buildInboxDismissalAudit(input);
  assert.equal(audit.denominator.eligible, 1);
  assert.equal(audit.denominator.foreign, 1);
  assert.equal(audit.observed.restored, 0);
  assert.equal(audit.observed.terminalConfirmed, 0);
  assert.equal(audit.observed.unresolved, 1);
  assert.equal(audit.measurement.falseDismissals, null);
  assert.equal(JSON.stringify(input), before);
});

test("conflicting immutable receipts and unqualified legacy rows remain unmeasurable", async () => {
  const { buildInboxDismissalAudit, inboxDismissalReceipts } = await import("#src/lib/inbox-dismissal-audit.js");
  const input = { scope: { instance: "core", repository: "owner/core" }, window, coverage, controls };
  const conflict = buildInboxDismissalAudit({ ...input, receipts: [retirement, { ...retirement, heldAtRetirement: false }] });
  assert.equal(conflict.denominator.conflicting, 1);
  assert.equal(conflict.measurement.falseDismissals, null);
  const duplicate = buildInboxDismissalAudit({ ...input, receipts: [retirement, retirement] });
  assert.equal(duplicate.denominator.duplicates, 1);
  assert.equal(duplicate.denominator.eligible, 1);
  assert.equal(duplicate.observed.falseDismissals, 1);
  const legacy = inboxDismissalReceipts([{ step: "panel.proposal_declined" }, { step: "panel.proposal_restored" },
    { step: "ratify.approved", released: "verify-human" }, { step: "ordinary-step" }, { dismissalAuditReceipt: retirement }]);
  const audit = buildInboxDismissalAudit({ ...input, receipts: legacy });
  assert.equal(audit.denominator.unqualified, 3);
  assert.equal(audit.denominator.eligible, 1);
  assert.equal(audit.observed.falseDismissals, 1);
  assert.equal(audit.measurement.falseDismissals, null);
});

test("restoration is a later outcome and never proof of a false dismissal by itself", async () => {
  const { buildInboxDismissalAudit } = await import("#src/lib/inbox-dismissal-audit.js");
  const restore = { id: "restore-1", kind: "restore", retirementId: retirement.id, scope, snapshotKey, at: "2026-10-13T14:00:00.000Z" };
  const audit = buildInboxDismissalAudit({ scope: { instance: "core", repository: "owner/core" }, window, coverage, controls,
    receipts: [{ ...retirement, heldAtRetirement: false, authority: "operator" }, restore] });
  assert.equal(audit.observed.restored, 1);
  assert.equal(audit.observed.falseDismissals, 0);
  assert.equal(audit.observed.unresolved, 1);
  assert.equal(audit.measurement.falseDismissals, null);
});

test("the bounded evidence excerpt never caps the audit denominator or hides a later false dismissal", async () => {
  const { buildInboxDismissalAudit, validInboxDismissalAudit } = await import("#src/lib/inbox-dismissal-audit.js");
  const receipts = Array.from({ length: 101 }, (_, i) => ({ ...retirement, id: `retire-${i}` }));
  const audit = buildInboxDismissalAudit({ scope: { instance: "core", repository: "owner/core" }, window, coverage, controls, receipts });
  assert.equal(audit.denominator.eligible, 101);
  assert.equal(audit.denominator.sampled, 101);
  assert.equal(audit.items.length, 100);
  assert.equal(audit.observed.falseDismissals, 101);
  assert.equal(audit.measurement.falseDismissalRate, 1);
  assert.equal(audit.truncated, true);
  assert.ok(validInboxDismissalAudit(JSON.parse(JSON.stringify(audit))));
  assert.equal(validInboxDismissalAudit({ ...audit, measurement: { falseDismissals: 0, falseDismissalRate: 0 } }), undefined);
  assert.equal(validInboxDismissalAudit({ ...audit, denominator: { ...audit.denominator, sampled: 100 } }), undefined);
});

test("malformed audit inputs cannot certify an empty retirement history", async () => {
  const { buildInboxDismissalAudit, validInboxDismissalAudit } = await import("#src/lib/inbox-dismissal-audit.js");
  const input = { scope: { instance: "core", repository: "owner/core" }, window, coverage, controls };
  for (const raw of [null, [], {}, { ...retirement, at: "not-time" }, { ...retirement, snapshotKey: "not-snapshot" },
    { ...retirement, authority: "unbound" }, { ...retirement, heldAtRetirement: "yes" }, { ...retirement, kind: "unknown" }]) {
    const audit = buildInboxDismissalAudit({ ...input, receipts: [raw] });
    assert.equal(audit.denominator.unqualified, 1);
    assert.equal(audit.measurement.falseDismissals, null);
    assert.ok(validInboxDismissalAudit(audit));
  }
  assert.equal(validInboxDismissalAudit(null), undefined);
  assert.equal(validInboxDismissalAudit({ contract: "inbox-dismissal-audit-v1", state: "measured" }), undefined);
  const audit = buildInboxDismissalAudit({ ...input, receipts: [retirement] });
  for (const patch of [{ scope: {} }, { window: {} }, { coverage: {} }, { controls: {} }, { denominator: {} }, { observed: {} },
    { measurement: {} }, { items: [{}] }, { truncated: "yes" }, { state: "unmeasurable" }]) assert.equal(validInboxDismissalAudit({ ...audit, ...patch }), undefined);
});

test("the default slow-lane pass persists an audit that the native read exposes without mutation", async t => {
  const fixture = gitRepo(); t.after(() => fixture.cleanup());
  fixture.addRemote("origin", "https://example.invalid/owner/core.git");
  const root = fixture.dir, state = join(root, "state"), planPath = join(root, "plan/tasks.yaml"), ledgerPath = join(state, "ledger.ndjson");
  mkdirSync(state); mkdirSync(join(root, "plan"));
  writeFileSync(planPath, "- id: W1-T216\n  title: Held security fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: human\n  budget_usd: 1\n  risk: high\n  band_meaning: blast-radius\n  dispatch_hold: true\n  files: [fixture.ts]\n  acceptance: []\n");
  const registryPath = join(state, "inbox-proposals.json");
  writeFileSync(registryPath, JSON.stringify({ proposals: [{ id: "verify-human:W1-T216", summary: "Held synthetic drill", evidenceAnchors: [] }] }));
  writeFileSync(ledgerPath, "");
  const paths = [planPath, registryPath, ledgerPath], before = paths.map(path => readFileSync(path, "utf8"));
  let message: ((value: { type?: string; held?: unknown }) => void) | undefined;
  const worker = runSlowLaneWorker({ on: (_event, fn) => { message = fn; }, postMessage() {} },
    { inbox: { root, planPath, ledgerPath, inboxRoot: root, repository: "owner/core" } }, { schedule: () => () => {} });
  t.after(() => worker.stop());
  message?.({ type: "lease", held: true });
  const deadline = Date.now() + 10_000;
  while (!readPersistedInbox(state) && Date.now() < deadline) await sleep(20);
  const snapshot = readPersistedInbox(state);
  assert.equal(snapshot?.dismissalAudit?.scope.repository, "owner/core");
  assert.equal(snapshot?.dismissalAudit?.scope.instance, "core");
  assert.equal(snapshot?.dismissalAudit?.controls.heldSecurity.observed, true);
  assert.equal(snapshot?.dismissalAudit?.measurement.falseDismissals, null);
  const service = createService({ tokens: { read: "fixture-read", write: "fixture-write" }, routes: [buildInboxAttentionCensusRoute({
    root, planPath, ledgerPath, inboxRoot: root, inboxFromSlowLane: true, github: { prView: () => null }, statusGithub: fakeGitHub(), ratify: NO_INSTANCE_RATIFY,
  })] });
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(service.address() as AddressInfo).port}/v1/inbox/attention-census`, { headers: { authorization: "Bearer fixture-read" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { dismissalAudit: { state: string; measurement: { falseDismissals: number | null } } };
    assert.equal(body.dismissalAudit.state, "unmeasurable");
    assert.equal(body.dismissalAudit.measurement.falseDismissals, null);
    assert.deepEqual(paths.map(path => readFileSync(path, "utf8")), before);
  } finally { worker.stop(); service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); }
});

test("an instance audit inherits its maintained producer source identity", { timeout: 30_000 }, async t => {
  const fixture = gitRepo(); t.after(() => fixture.cleanup());
  fixture.addRemote("origin", "https://example.invalid/owner/site.git");
  const root = join(fixture.dir, "instance"), checkout = join(root, "repos", "site"), state = join(root, "state");
  mkdirSync(join(root, "repos"), { recursive: true }); fixture.addWorktree(checkout, "site");
  mkdirSync(state); mkdirSync(join(checkout, "plan"));
  const planPath = join(checkout, "plan/tasks.yaml"), ledgerPath = join(state, "ledger.ndjson"), registry = join(state, "inbox-proposals.json");
  writeFileSync(planPath, "- id: W1-T216\n  title: Held security fixture\n  repo: site\n  depends_on: []\n  type: implement\n  verify: human\n  budget_usd: 1\n  risk: high\n  band_meaning: blast-radius\n  dispatch_hold: true\n  files: [fixture.ts]\n  acceptance: []\n");
  writeFileSync(ledgerPath, ""); writeFileSync(registry, JSON.stringify({ proposals: [{ id: "verify-human:W1-T216", summary: "Site held fixture", evidenceAnchors: [] }] }));
  const paths = [planPath, ledgerPath, registry], before = paths.map(path => readFileSync(path, "utf8"));
  let message: ((value: { type?: string; held?: unknown; instances?: unknown }) => void) | undefined;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const worker = runSlowLaneWorker({ on: (_event, fn) => { message = fn; }, postMessage(value) {
    const row = value as { type?: string; step?: string; extra?: { instance?: string; unit?: string; error?: string } };
    if (row.step === "inbox.classification_written" && row.extra?.instance === "site") resolveReady();
    if (row.step === "read_model.slow_unit_failed" && row.extra?.unit === "inbox:site") rejectReady(new Error(row.extra.error));
  } }, { instanceInboxes: [{ instance: "site", repository: "owner/site", root: checkout, planPath, ledgerPath, inboxRoot: root }] }, { schedule: () => () => {} });
  const service = createService({ tokens: { read: "fixture-read", write: "fixture-write" }, routes: mountInstanceInboxRoutes({
    instance: "site", repository: "owner/site", stateDir: state,
    routes: defaultInstanceInboxSources({ instance: "site", root, planPath, ledgerPath }, "owner/site", fakeGitHub()),
  }) });
  try {
    message?.({ type: "lease", held: true, instances: ["site"] }); await ready;
    assert.deepEqual(readPersistedInbox(state)?.dismissalAudit?.scope, { instance: "site", repository: "owner/site" });
    await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${(service.address() as AddressInfo).port}/v1/i/site/inbox/attention-census`, { headers: { authorization: "Bearer fixture-read" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { repository: string; instance: string; dismissalAudit: { scope: unknown; measurement: { falseDismissals: number | null } } };
    assert.equal(body.repository, "owner/site"); assert.equal(body.instance, "site");
    assert.deepEqual(body.dismissalAudit.scope, { instance: "site", repository: "owner/site" });
    assert.equal(body.dismissalAudit.measurement.falseDismissals, null);
    assert.deepEqual(paths.map(path => readFileSync(path, "utf8")), before);
  } finally { worker.stop(); service.closeAllConnections(); if (service.listening) await new Promise<void>(resolve => service.close(() => resolve())); }
});
