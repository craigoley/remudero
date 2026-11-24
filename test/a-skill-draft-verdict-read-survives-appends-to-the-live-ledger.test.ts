import assert from "node:assert/strict";
import fs, { appendFileSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { loadProposalRegistry } from "#src/lib/inbox.js";
import { appendLedger, ledgerFileVersion } from "#src/lib/ledger.js";
import { realLedgerFs } from "#src/lib/ledger-union.js";
import {
  expireUnansweredSkillDrafts,
  inboxFirstSeenPath,
  PROCEDURAL_STEP_TEXT,
  readSkillDraftVerdicts,
  renderSkillDraft,
  skillDraftProposalId,
  stageSkillDrafts,
  workerAllowlistFromSettings,
} from "#src/lib/skill-workshop.js";
import { readLedgerLines } from "#src/lib/status.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const clock = fixedClock(NOW);
const allowlist = workerAllowlistFromSettings(undefined);
const reachability = () => ({ reachable: false, reason: "unapproved proposals are not injected" });
const unrelated = () => JSON.stringify({ ts: clock.iso(), run_id: "SWEEP-1", task_id: "RETRO", step: "sweep.summary" }) + "\n";
const answer = (step: string, taskId: string) => JSON.stringify({ ts: clock.iso(), run_id: "PANEL-1", task_id: taskId, step, origin: "rmd-cli" }) + "\n";

interface Site { stateDir: string; registryPath: string; ledgerPath: string }

function site(t: TestContext, rows: Array<Record<string, unknown>> = []): Site {
  const { dir, path } = writeLedger(rows, { scope: t });
  return { stateDir: dir, registryPath: join(dir, "inbox-proposals.json"), ledgerPath: path };
}

/** The retro's log shape: the decline append carries the live version its decision read. */
const retroLog = (s: Site) => (step: string, extra: Record<string, unknown> = {}, expectedLiveVersion?: string) =>
  appendLedger(s.ledgerPath, { run_id: "RETRO-1", task_id: "RETRO", step, lane: "retro", ...extra }, { expectedLiveVersion });

/** A log whose first decline append meets `bytes` appended just before it. */
const appendBeforeDecline = (s: Site, bytes: string) => {
  let pending = true;
  return (step: string, extra?: Record<string, unknown>, expectedLiveVersion?: string) => {
    if (pending && step === "panel.proposal_declined") {
      pending = false;
      appendFileSync(s.ledgerPath, bytes);
    }
    retroLog(s)(step, extra, expectedLiveVersion);
  };
};

/** Run `action` just after the `nth` read of the live file. */
function afterLiveRead(t: TestContext, s: Site, nth: number, action: () => void): { landed: () => boolean } {
  const read = realLedgerFs.readFileSync;
  let reads = 0;
  t.mock.method(realLedgerFs, "readFileSync", (path: string) => {
    const bytes = read(path);
    if (path === s.ledgerPath && ++reads === nth) action();
    return bytes;
  });
  return { landed: () => reads >= nth };
}

/** Append `bytes` after the decline append's check, just before its write. */
function appendAtDeclineWrite(t: TestContext, s: Site, marker: string, bytes: string): { landed: () => boolean } {
  const write = fs.writeSync;
  let injected = false;
  const hook = t.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
    const [, data] = args;
    if (!injected && Buffer.isBuffer(data) && data.includes('"origin":"skill-workshop"') && data.includes(marker)) {
      injected = true;
      appendFileSync(s.ledgerPath, bytes);
    }
    return (write as (...a: unknown[]) => number)(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { hook.mock.restore(); syncBuiltinESMExports(); });
  return { landed: () => injected };
}

/** Replace the live file with a copy, on another inode, that also holds one unrelated row. */
function replaceLive(s: Site): void {
  const copy = `${s.ledgerPath}.copy`;
  writeFileSync(copy, Buffer.concat([readFileSync(s.ledgerPath), Buffer.from(unrelated())]));
  renameSync(copy, s.ledgerPath);
}

const rowsOf = (s: Site) => [...readLedgerLines(s.ledgerPath)];
/** The workshop's own decline rows for `id`. */
const declinesOf = (s: Site, id: string) =>
  rowsOf(s).filter((r) => r.step === "panel.proposal_declined" && r.task_id === id && r.origin === "skill-workshop");
const closeOf = (s: Site, id: string) => loadProposalRegistry(s.registryPath).find((p) => p.id === id)?.skillDraftClose;

// ── The legacy withdrawal ─────────────────────────────────────────────────────────────────────

/** A staged legacy draft whose stored procedure is one signal-table line. */
function legacyDraft(s: Site): string {
  const draft = renderSkillDraft({
    shapeKey: "implement:fully_executed_proof", taskType: "implement", signals: ["fully_executed_proof"],
    runIds: ["run-a", "run-b"], taskIds: ["W1-T1", "W1-T2"], supportingRuns: 2,
  }, {
    runs: ["run-a", "run-b"].map((runId, i) => ({ runId, taskId: `W1-T${i + 1}`, type: "implement", verdict: "merged" })),
    records: ["run-a", "run-b"].flatMap((runId) => ["Bash:npm run typecheck", "Edit:src/lib/plan.ts"].map((tool_signature) =>
      ({ run_id: runId, step: "worker.activity", event_kind: "tool-executing", tool_name: tool_signature.split(":")[0], tool_signature }))),
  });
  assert.ok(draft);
  const markdown = draft.markdown.replace(/## Procedure\n[\s\S]*?(?=## Evidence)/,
    `## Procedure\n\n- ${PROCEDURAL_STEP_TEXT.fully_executed_proof}\n\n`);
  const id = skillDraftProposalId(draft.procedureKey);
  writeFileSync(s.registryPath, JSON.stringify({ proposals: [{ id, summary: markdown, evidenceAnchors: [],
    skillFile: { name: draft.name, markdown }, skillFileStagedAt: "2026-10-14T00:00:00.000Z" }] }));
  return id;
}

/** Run the legacy withdrawal; return the errors of the skill.stage_failed rows it wrote. */
function withdraw(s: Site, log = retroLog(s)): string[] {
  const failures: string[] = [];
  stageSkillDrafts(s.registryPath, [], allowlist, reachability, (step, extra, expectedLiveVersion) => {
    if (step === "skill.stage_failed") failures.push(String(extra?.error));
    log(step, extra, expectedLiveVersion);
  });
  return failures;
}

function assertWithdrawn(s: Site, id: string, failures: string[]): void {
  const declines = declinesOf(s, id);
  assert.equal(declines.length, 1);
  assert.match(String(declines[0]?.reason), /^withdrawn: outcome-only:/);
  assert.match(closeOf(s, id)?.reason ?? "", /^withdrawn: outcome-only:/);
  assert.deepEqual(failures, []);
}

function assertUnverified(s: Site, id: string, failures: string[], label: string): void {
  assert.deepEqual(declinesOf(s, id), [], label);
  assert.equal(closeOf(s, id), undefined, label);
  assert.deepEqual(failures, [`Error: could not verify the ledger verdict for ${id}`], label);
}

for (const [label, bytes] of [
  ["an unrelated step", unrelated()],
  ["an approval of another skill draft", answer("ratify.approved", "skill-draft:other")],
  ["a decline of another skill draft", answer("panel.proposal_declined", "skill-draft:other")],
] as const) {
  test(`W1-T14511 criterion 1: the legacy withdrawal closes its draft when ${label} is appended during the union read`, (t) => {
    const s = site(t, [{ ts: "2026-11-18T00:00:00.000Z", run_id: "R", task_id: "RETRO", step: "sweep.summary" }]);
    const id = legacyDraft(s);
    const inode = statSync(s.ledgerPath).ino;
    const race = afterLiveRead(t, s, 1, () => appendFileSync(s.ledgerPath, bytes));
    const failures = withdraw(s);
    assert.equal(race.landed(), true);
    assert.equal(statSync(s.ledgerPath).ino, inode);
    assertWithdrawn(s, id, failures);
  });
}

test("W1-T14511 criterion 1: the legacy withdrawal closes its draft when an unrelated row is appended before the decline append", (t) => {
  const s = site(t, [{ ts: "2026-11-18T00:00:00.000Z", run_id: "R", task_id: "RETRO", step: "sweep.summary" }]);
  const id = legacyDraft(s);
  assertWithdrawn(s, id, withdraw(s, appendBeforeDecline(s, unrelated())));
});

for (const step of ["ratify.approved", "panel.proposal_declined", "panel.proposal_restored"]) {
  test(`W1-T14511 criterion 2: invariant:own-verdict-still-refuses a ${step} row for the draft stops the legacy withdrawal`, (t) => {
    for (const point of ["read", "append", "write"] as const) {
      const s = site(t, [{ ts: "2026-11-18T00:00:00.000Z", run_id: "R", task_id: "RETRO", step: "sweep.summary" }]);
      const id = legacyDraft(s);
      const own = answer(step, id);
      let landed: () => boolean = () => true;
      if (point === "read") landed = afterLiveRead(t, s, 1, () => appendFileSync(s.ledgerPath, own)).landed;
      if (point === "write") landed = appendAtDeclineWrite(t, s, '"withdrawn:', own).landed;
      const failures = withdraw(s, point === "append" ? appendBeforeDecline(s, own) : retroLog(s));
      assert.equal(landed(), true, point);
      assertUnverified(s, id, failures, point);
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}

test("W1-T14511 criterion 3: invariant:replaced-or-shrunk-still-refuses a replaced, shrunk or unterminated live ledger stops the legacy withdrawal", (t) => {
  const changes: Record<string, (s: Site) => void> = {
    replaced: (s) => replaceLive(s),
    shrunk: (s) => truncateSync(s.ledgerPath, statSync(s.ledgerPath).size - 1),
    unterminated: (s) => appendFileSync(s.ledgerPath, unrelated().trimEnd()),
  };
  for (const [label, change] of Object.entries(changes)) {
    const s = site(t, [{ ts: "2026-11-18T00:00:00.000Z", run_id: "R", task_id: "RETRO", step: "sweep.summary" }]);
    const id = legacyDraft(s);
    const race = afterLiveRead(t, s, 1, () => change(s));
    const failures = withdraw(s);
    assert.equal(race.landed(), true, label);
    assertUnverified(s, id, failures, label);
    t.mock.restoreAll();
  }
});

// ── Expiry ────────────────────────────────────────────────────────────────────────────────────

const OLD = "skill-draft:old";

/** One answered proposal (a 2-day wait) and one skill draft unanswered for 18 days. */
function expirySite(t: TestContext): Site {
  const s = site(t, [{ ts: "2026-11-07T00:00:00.000Z", run_id: "PANEL-1", task_id: "short", step: "ratify.approved", origin: "rmd-cli" }]);
  writeFileSync(inboxFirstSeenPath(s.stateDir), JSON.stringify({
    backfill: "2026-10-13T00:00:00.000Z", short: "2026-11-05T00:00:00.000Z", [OLD]: "2026-11-01T12:00:00.000Z",
  }));
  const markdown = "---\nname: proc\napplies-to: implement\n---\n\n## Procedure\n\n- Add a failing test first.\n";
  writeFileSync(s.registryPath, JSON.stringify({ proposals: [{ id: OLD, summary: markdown, evidenceAnchors: [],
    skillFile: { name: "proc", markdown }, skillFileStagedAt: "2026-10-14T00:00:00.000Z" }] }));
  return s;
}

const expire = (s: Site, log = retroLog(s)) => expireUnansweredSkillDrafts(s.registryPath, s.stateDir, log, clock);

test("W1-T14511 criterion 4: expiry closes the draft when unrelated rows are appended during the locked re-read and before the decline append", (t) => {
  const s = expirySite(t);
  const race = afterLiveRead(t, s, 2, () => appendFileSync(s.ledgerPath, unrelated()));
  const result = expire(s, appendBeforeDecline(s, unrelated()));
  assert.equal(race.landed(), true);
  assert.deepEqual(result.expired, [OLD]);
  const declines = declinesOf(s, OLD);
  assert.equal(declines.length, 1);
  assert.match(String(declines[0]?.reason), /^expired:/);
  assert.match(closeOf(s, OLD)?.reason ?? "", /^expired:/);
});

test("W1-T14511 criterion 4: an answer for any id appended during or after the re-read still stops expiry", (t) => {
  const other = answer("ratify.approved", "p-other");
  const cases = {
    read: "live ledger changed during read",
    append: "live ledger changed before the decline append",
    write: "live ledger gained a row before the decline append",
  };
  for (const [point, message] of Object.entries(cases)) {
    const s = expirySite(t);
    const registry = readFileSync(s.registryPath);
    let landed: () => boolean = () => true;
    if (point === "read") landed = afterLiveRead(t, s, 2, () => appendFileSync(s.ledgerPath, other)).landed;
    if (point === "write") landed = appendAtDeclineWrite(t, s, '"expired:', other).landed;
    const result = expire(s, point === "append" ? appendBeforeDecline(s, other) : retroLog(s));
    assert.equal(landed(), true, point);
    assert.deepEqual(result, { expired: [], reason: `skill draft expiry stopped: incomplete ledger union: ${message}` });
    assert.deepEqual(declinesOf(s, OLD), [], point);
    assert.deepEqual(readFileSync(s.registryPath), registry, point);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

// ── The verdict read rmd restore uses ─────────────────────────────────────────────────────────

test("W1-T14511 criterion 5: readSkillDraftVerdicts tolerates an unrelated append and refuses a verdict row, a torn tail or a new inode", (t) => {
  const declined = { ts: "2026-11-18T00:00:00.000Z", run_id: "PANEL-1", task_id: "skill-draft:a", step: "panel.proposal_declined", origin: "rmd-cli" };
  const changed = { unmeasured: "incomplete ledger union: live ledger changed during read" };

  const fine = site(t, [declined]);
  afterLiveRead(t, fine, 1, () => appendFileSync(fine.ledgerPath, unrelated()));
  const verdicts = readSkillDraftVerdicts(fine.stateDir);
  assert.ok(!("unmeasured" in verdicts), JSON.stringify(verdicts));
  assert.match(verdicts.isDeclined("skill-draft:a") ?? "", /./);
  t.mock.restoreAll();

  for (const bytes of [answer("panel.proposal_restored", "skill-draft:b"), unrelated().trimEnd()]) {
    const s = site(t, [declined]);
    afterLiveRead(t, s, 1, () => appendFileSync(s.ledgerPath, bytes));
    assert.deepEqual(readSkillDraftVerdicts(s.stateDir), changed, bytes);
    t.mock.restoreAll();
  }

  // The read sees a copy with another inode; the original, grown by one unrelated row, is back by the final stat.
  const s = site(t, [declined]);
  const aside = join(writeLedger([], { scope: t }).dir, "original.ndjson");
  const listDir = realLedgerFs.readdirSync;
  let swapped = false;
  t.mock.method(realLedgerFs, "readdirSync", (dir: string) => {
    if (!swapped && dir === s.stateDir) {
      swapped = true;
      renameSync(s.ledgerPath, aside);
      writeFileSync(s.ledgerPath, readFileSync(aside));
    }
    return listDir(dir);
  });
  afterLiveRead(t, s, 1, () => {
    renameSync(aside, s.ledgerPath);
    appendFileSync(s.ledgerPath, unrelated());
  });
  assert.deepEqual(readSkillDraftVerdicts(s.stateDir), changed);
  assert.equal(swapped, true);
});

// ── appendLedger without a predicate ───────────────────────────────────────────────────────────

test("W1-T14511 criterion 6: appendLedger with expectedLiveVersion refuses any growth of the live file", (t) => {
  const s = site(t, [{ ts: "2026-11-18T00:00:00.000Z", run_id: "R", task_id: "RETRO", step: "sweep.summary" }]);
  const version = ledgerFileVersion(statSync(s.ledgerPath, { bigint: true }));
  appendFileSync(s.ledgerPath, unrelated());
  const before = readFileSync(s.ledgerPath, "utf8");
  assert.throws(() => retroLog(s)("panel.proposal_declined", { task_id: "skill-draft:a" }, version),
    /live ledger changed before the decline append/);
  assert.equal(readFileSync(s.ledgerPath, "utf8"), before);
});
