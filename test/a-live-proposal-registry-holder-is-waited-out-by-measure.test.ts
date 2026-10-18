import assert from "node:assert/strict";
import fs from "node:fs";
import { hostname } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { loadProposalRegistry, ProposalRegistryBusyError, pruneOrphanedDraftsAsync,
  updateProposalRegistry, updateProposalRegistryAsync, type Proposal } from "#src/lib/inbox.js";
import { mineFollowups, parseLedger, publishFollowupHarvestAsync, withRetroPublicationCancellation } from "#src/lib/retro.js";

const proposal = (id: string): Proposal => ({ id, summary: id, evidenceAnchors: [] });

async function heldPrune(t: TestContext) {
  const f = ownedFixtureDir(t, "registry-holder-progress");
  const path = join(f.dir, "inbox-proposals.json");
  const drafts = join(f.dir, "inbox-drafts.json");
  updateProposalRegistry(path, () => []);
  fs.writeFileSync(drafts, JSON.stringify({ gone: { proposalId: "gone", fragmentYaml: "", stampLine: "", anchorFingerprint: "" } }));
  let entered!: () => void;
  let release!: () => void;
  const underLock = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const holder = pruneOrphanedDraftsAsync(drafts, path, { refresh: async () => {
    if (++calls === 2) { entered(); await gate; }
    return new Map();
  } });
  f.until(holder);
  t.after(() => release());
  await underLock;
  assert.ok(fs.existsSync(`${path}.lock`), "positive control: real async holder acquired the lock");
  return { path, holder, release };
}

function planted(t: TestContext) {
  const f = ownedFixtureDir(t, "registry-live-lock");
  const path = join(f.dir, "inbox-proposals.json");
  const holder = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  const raw = JSON.stringify(holder);
  fs.writeFileSync(`${path}.lock`, raw);
  // Independent cleanup bounds deletion mutants too; disappearance cannot turn a refused waiter into success.
  const watchdog = setTimeout(() => fs.rmSync(`${path}.lock`, { force: true }), 1500);
  t.after(() => clearTimeout(watchdog));
  return { path, raw, holder };
}

test("W1-T9240: a same-process registry holder can release while its contender waits", async t => {
  const f = await heldPrune(t);
  fs.writeFileSync(`${f.path}.lock-hold.json`, JSON.stringify({ held_ms: 0 }));
  let release: ReturnType<typeof setTimeout> | undefined;
  let observedContention = false;
  const contender = updateProposalRegistryAsync(f.path, current => [...current, proposal("landed")], {
    maxWaitMs: 1000, log: step => {
      if (step === "proposal_registry.lock_wait_long" && !observedContention) {
        observedContention = true;
        release = setTimeout(f.release, 0);
      }
    },
  });
  // An independent release closes the real holder even when a mutant refuses before scheduling it.
  const watchdog = setTimeout(f.release, 1500);
  t.after(() => { clearTimeout(release); clearTimeout(watchdog); });
  const [holder, update] = await Promise.allSettled([f.holder, contender]);
  assert.equal(observedContention, true, "the contender actually encountered the held lock before release");
  assert.equal(holder.status, "fulfilled");
  assert.equal(update.status, "fulfilled", "a ready holder must progress before the contender's deadline");
  if (holder.status === "fulfilled") assert.equal(holder.value?.count, 1);
  if (update.status === "fulfilled") assert.equal(update.value?.[0]?.id, "landed");
  assert.deepEqual(loadProposalRegistry(f.path).map(p => p.id), ["landed"]);
  assert.equal(fs.existsSync(`${f.path}.lock`), false);
});

test("W1-T9240: cancellation leaves the live holder lock untouched and never runs the update", async t => {
  const f = planted(t);
  const controller = new AbortController();
  let calls = 0;
  const contender = updateProposalRegistryAsync(f.path, () => { calls++; return []; }, {
    signal: controller.signal, maxWaitMs: 400, pollIntervalMs: 200,
  });
  const abort = setTimeout(() => controller.abort(), 10);
  t.after(() => clearTimeout(abort));
  await assert.rejects(contender, e => e instanceof ProposalRegistryBusyError && e.outcome === "cancelled");
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(`${f.path}.lock`, "utf8"), f.raw);
  fs.unlinkSync(`${f.path}.lock`);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(fs.existsSync(f.path), false, "a canceled waiter cannot acquire after the holder disappears");
});

test("W1-T9240: a caller deadline refuses a live holder with an attributable wait receipt", async t => {
  const f = planted(t);
  const rows: Array<{ step: string; detail: Record<string, unknown> }> = [];
  let calls = 0;
  // Independent release makes a deleted deadline fail its assertion rather than hang the suite.
  const release = setTimeout(() => fs.rmSync(`${f.path}.lock`, { force: true }), 400);
  t.after(() => clearTimeout(release));
  await assert.rejects(updateProposalRegistryAsync(f.path, () => { calls++; return []; }, {
    maxWaitMs: 45, pollIntervalMs: 10, log: (step, detail) => rows.push({ step, detail }),
  }), e => e instanceof ProposalRegistryBusyError && e.outcome === "deadline");
  assert.equal(calls, 0);
  assert.deepEqual(rows.find(r => r.step === "proposal_registry.lock_wait_refused")?.detail,
    { outcome: "deadline", lock_path: `${f.path}.lock`, holder: f.holder });
  assert.equal(fs.readFileSync(`${f.path}.lock`, "utf8"), f.raw);
});

test("W1-T9240: long wait evidence does not authorize stealing a live lock", async t => {
  const f = planted(t);
  fs.writeFileSync(`${f.path}.lock-hold.json`, JSON.stringify({ held_ms: 0 }));
  const rows: string[] = [];
  await assert.rejects(updateProposalRegistryAsync(f.path, () => [], {
    maxWaitMs: 70, pollIntervalMs: 5, log: step => rows.push(step),
  }), ProposalRegistryBusyError);
  assert.equal(rows.filter(s => s === "proposal_registry.lock_wait_long").length, 1);
  assert.equal(fs.readFileSync(`${f.path}.lock`, "utf8"), f.raw);
  assert.equal(fs.existsSync(f.path), false);
});

test("W1-T9240: a synchronous contender refuses its locally owned async holder without starving release", async t => {
  const f = await heldPrune(t);
  try {
    assert.throws(() => updateProposalRegistry(f.path, () => []),
      e => e instanceof ProposalRegistryBusyError && e.outcome === "same-process-busy");
  } finally { f.release(); }
  await f.holder;
});

test("W1-T9240: a dead holder is reclaimed by the same identity-checked writer", async t => {
  const f = planted(t);
  const next = await updateProposalRegistryAsync(f.path, () => [proposal("after-crash")], { maxWaitMs: 1000, isPidAlive: () => false });
  assert.equal(next?.[0]?.id, "after-crash");
  assert.equal(fs.existsSync(`${f.path}.lock`), false);
  assert.ok(Number.isFinite(JSON.parse(fs.readFileSync(`${f.path}.lock-hold.json`, "utf8")).held_ms));
});

test("W1-T9240: an unbounded uncancellable caller refuses before creating any lock", async t => {
  const path = join(ownedFixtureDir(t, "registry-unbounded").dir, "registry.json");
  for (const opts of [{}, { maxWaitMs: Infinity }, { maxWaitMs: NaN }, { maxWaitMs: -1 }]) {
    await assert.rejects(updateProposalRegistryAsync(path, () => [], opts), /finite budget/);
    assert.equal(fs.existsSync(`${path}.lock`), false);
  }
  assert.throws(() => updateProposalRegistry(path, () => [], { maxWaitMs: Infinity }), /must be finite/);
});

test("W1-T9240: malformed hold evidence is explicit and measurement failure does not lose a committed update", async t => {
  const f = planted(t);
  fs.writeFileSync(`${f.path}.lock-hold.json`, "not-json");
  const rows: Array<Record<string, unknown>> = [];
  await assert.rejects(updateProposalRegistryAsync(f.path, () => [], {
    maxWaitMs: 40, log: (_step, detail) => rows.push(detail),
  }), ProposalRegistryBusyError);
  assert.equal(rows[0]?.measurement, "unreadable");
  fs.unlinkSync(`${f.path}.lock`);
  fs.unlinkSync(`${f.path}.lock-hold.json`);
  fs.mkdirSync(`${f.path}.lock-hold.json`);
  const next = await updateProposalRegistryAsync(f.path, () => [proposal("saved")], {
    maxWaitMs: 1000, log: (_step, detail) => rows.push(detail),
  });
  assert.equal(next?.[0]?.id, "saved");
  assert.equal(loadProposalRegistry(f.path)[0]?.id, "saved");
  assert.equal(fs.existsSync(`${f.path}.lock`), false);
  assert.ok(rows.some(r => typeof r.reason === "string"));
});

test("W1-T9240: canceled retro publication leaves harvest acknowledgements retryable", async t => {
  const f = planted(t);
  const ledgerPath = join(f.path, "..", "ledger.ndjson");
  const records = [{ ts: new Date().toISOString(), step: "report.followups", run_id: "fixture-run", task_id: "fixture-task",
    entries: [{ type: "task", text: "repair the notification retry contract" }] }];
  const controller = new AbortController();
  const publication = publishFollowupHarvestAsync(mineFollowups(records), { registryPath: f.path, ledgerPath }, {
    signal: controller.signal, maxWaitMs: 500, log: step => {
      if (step === "proposal_registry.lock_measurement_unavailable") controller.abort();
    },
  });
  await assert.rejects(publication, e => e instanceof ProposalRegistryBusyError && e.outcome === "cancelled");
  assert.equal(fs.existsSync(ledgerPath), false, "an unpublished source must never be acknowledged");
  assert.equal(fs.readFileSync(`${f.path}.lock`, "utf8"), f.raw);
  assert.equal(mineFollowups(records).candidates.length, 1);
  fs.unlinkSync(`${f.path}.lock`);
  const deps = { registryPath: f.path, ledgerPath };
  // The real default owns/removes its process handlers on success; no process is signalled.
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await withRetroPublicationCancellation(signal => publishFollowupHarvestAsync(mineFollowups(records), deps, { signal }));
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
  assert.equal(loadProposalRegistry(f.path).length, 1);
  const marks = parseLedger(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(mineFollowups([...records, ...marks]).candidates.length, 0);
  await publishFollowupHarvestAsync(mineFollowups(records), deps, { maxWaitMs: 1000 });
  assert.equal(loadProposalRegistry(f.path).length, 1, "publication replay preserves the existing stable-id dedup");
});

test("W1-T9240: the publication lifetime cancels waiting work and disposes handlers on failure", async () => {
  const signals = new EventEmitter();
  await assert.rejects(withRetroPublicationCancellation(async signal => {
    signals.emit("SIGTERM");
    assert.equal(signal.aborted, true);
    throw new Error("attempt terminated");
  }, signals as NodeJS.Process), /attempt terminated/);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("W1-T9240: acquisition failures and thrown updates release without fabricating success", async t => {
  const root = ownedFixtureDir(t, "registry-acquisition-failure").dir;
  const blocked = join(root, "not-a-directory");
  fs.writeFileSync(blocked, "fixture");
  await assert.rejects(updateProposalRegistryAsync(join(blocked, "registry.json"), () => [], { maxWaitMs: 1000 }), /EEXIST|ENOTDIR/);
  const path = join(root, "registry.json");
  await assert.rejects(updateProposalRegistryAsync(path, () => { throw new Error("update failed"); }, { maxWaitMs: 1000 }), /update failed/);
  assert.equal(fs.existsSync(`${path}.lock`), false);
  assert.equal(fs.existsSync(path), false);
  await updateProposalRegistryAsync(path, () => [proposal("retry")], { maxWaitMs: 1000 });
  assert.equal(loadProposalRegistry(path)[0]?.id, "retry");
});

test("W1-T9240: cancellation arriving during real lock creation prevents a later callback", async t => {
  const path = join(ownedFixtureDir(t, "registry-open-cancel").dir, "registry.json");
  const controller = new AbortController();
  const open = fs.promises.open;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    controller.abort();
    return handle;
  });
  let calls = 0;
  await assert.rejects(updateProposalRegistryAsync(path, () => { calls++; return []; }, {
    maxWaitMs: 1000, signal: controller.signal,
  }), e => e instanceof ProposalRegistryBusyError && e.outcome === "cancelled");
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(`${path}.lock`), false);
});

test("W1-T9240: a failed lock publication cleans only its own inode", async t => {
  const root = ownedFixtureDir(t, "registry-lock-write-failure").dir;
  const open = fs.promises.open;
  for (const replacement of [false, true]) {
    const path = join(root, `${replacement}.json`);
    const raw = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    const mock = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      t.mock.method(handle, "writeFile", async () => {
        if (replacement) {
          fs.writeFileSync(`${path}.replacement`, raw);
          fs.renameSync(`${path}.replacement`, `${path}.lock`);
        }
        throw new Error("fixture lock write failed");
      });
      return handle;
    });
    await assert.rejects(updateProposalRegistryAsync(path, () => [], { maxWaitMs: 1000 }), /fixture lock write failed/);
    mock.mock.restore();
    assert.equal(fs.existsSync(`${path}.lock`), replacement, "never delete another acquisition's replacement");
    if (replacement) assert.equal(fs.readFileSync(`${path}.lock`, "utf8"), raw);
  }
});
