import assert from "node:assert/strict";
import fs, { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { gunzipSync, gzipSync } from "node:zlib";
import * as analytics from "#src/lib/analytics-route.js";
import { fixedClock } from "#src/lib/clock.js";
import { realWriteAtomicIo, writeAtomic } from "#src/lib/fs-race-safe.js";
import { applyProposalVerdict, ledgerProposalVerdicts, loadProposalRegistry } from "#src/lib/inbox.js";
import { registryThreadItems } from "#src/lib/inbox-responder.js";
import { appendLedger, compactedArchiveName, ledgerRotationLockPath, rotateLedger, tryAcquireRotationLock } from "#src/lib/ledger.js";
import { LEDGER_COLD_STORE_DIRNAME, ledgerCompactCommand } from "#src/lib/ledger-compact.js";
import { compactLedgerInWorker } from "#src/lib/ledger-compact-worker.js";
import { readLedgerUnionRecordsSync, realLedgerFs } from "#src/lib/ledger-union.js";
import { inboxFirstSeenPath } from "#src/lib/panel-graph.js";
import { expireUnansweredSkillDrafts, reportSkillDraftExpiry, skillDraftExpiryBound } from "#src/lib/skill-workshop.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-11-19T12:00:00.000Z");
const clock = fixedClock(NOW);
const BACKFILL = "2026-10-13T00:00:00.000Z";
const SKILL_MARKDOWN = "---\nname: proc\napplies-to: implement\n---\n\n## Procedure\n\n- Add a failing test first.\n";

interface Site { root: string; stateDir: string; registryPath: string; ledgerPath: string; done: () => void }

function site(): Site {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}skill-draft-expiry-`));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, registryPath: join(stateDir, "inbox-proposals.json"), ledgerPath: join(stateDir, "ledger.ndjson"),
    done: () => rmSync(root, { recursive: true, force: true }) };
}

function row(s: Site, step: string, taskId: string, ts: string, extra: Record<string, unknown> = {}) {
  appendLedger(s.ledgerPath, { ts, run_id: "PANEL-1", task_id: taskId, step, ...extra });
}

/** The retro's own log shape (run-task.ts retroCommand). */
const retroLog = (s: Site) => (step: string, extra: Record<string, unknown> = {}, expectedLiveVersion?: string) =>
  appendLedger(s.ledgerPath, { run_id: "RETRO-1", task_id: "RETRO", step, lane: "retro", ...extra }, { expectedLiveVersion });

/** An answered population whose longest measured wait is p-b's 7.5 days. */
function answered(s: Site, firstSeen: Record<string, string>) {
  writeFileSync(inboxFirstSeenPath(s.stateDir), JSON.stringify({
    "backfill-1": BACKFILL,
    "p-a": "2026-10-20T00:00:00.000Z",
    "p-b": "2026-10-25T00:00:00.000Z",
    "p-c": "2026-10-26T00:00:00.000Z",
    ...firstSeen,
  }));
  row(s, "ratify.approved", "backfill-1", "2026-11-18T00:00:00.000Z", { origin: "rmd-cli" }); // 36 days, but its age is unknown
  row(s, "panel.proposal_declined", "p-a", "2026-10-19T00:00:00.000Z", { origin: "rmd-cli" }); // before first-seen: not an answer
  row(s, "ratify.approved", "p-a", "2026-10-23T00:00:00.000Z", { origin: "rmd-cli" }); // 3 days: the first answer
  row(s, "panel.proposal_declined", "p-a", "2026-11-10T00:00:00.000Z", { origin: "rmd-cli" }); // a later answer
  row(s, "panel.proposal_declined", "p-b", "2026-11-01T12:00:00.000Z", { origin: "fleet-lane" }); // 7.5 days
  row(s, "panel.proposal_declined", "p-c", "2026-11-15T00:00:00.000Z",
    { origin: "skill-workshop", reason: "expired: unanswered for 20.00 days" }); // the workshop's own expiry
}

function union(s: Site) {
  return readLedgerUnionRecordsSync(s.stateDir, { step: ["ratify.approved", "panel.proposal_declined"], refuseIncomplete: true });
}

function skillDraft(id: string, extra: Record<string, unknown> = {}) {
  return { id, summary: SKILL_MARKDOWN, evidenceAnchors: [], skillFile: { name: id.replace(/\W/g, "-"), markdown: SKILL_MARKDOWN },
    skillFileStagedAt: "2026-10-14T00:00:00.000Z", ...extra };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Drafts: one old and unanswered, one young, one approved, one declined, one the workshop closed and the operator restored. */
function drafts(s: Site) {
  answered(s, {
    "skill-draft:old": "2026-11-01T12:00:00.000Z",
    "skill-draft:young": "2026-11-15T12:00:00.000Z",
    "skill-draft:approved": "2026-11-01T00:00:00.000Z",
    "skill-draft:declined": "2026-11-01T00:00:00.000Z",
    "skill-draft:closed": "2026-11-01T00:00:00.000Z",
  });
  row(s, "ratify.approved", "skill-draft:approved", "2026-11-02T00:00:00.000Z", { origin: "rmd-cli" });
  row(s, "panel.proposal_declined", "skill-draft:declined", "2026-11-03T00:00:00.000Z", { origin: "rmd-cli" });
  row(s, "panel.proposal_declined", "skill-draft:closed", "2026-11-04T00:00:00.000Z", { origin: "skill-workshop", reason: "withdrawn: x" });
  row(s, "panel.proposal_restored", "skill-draft:closed", "2026-11-05T00:00:00.000Z", { origin: "rmd-cli" });
  writeFileSync(s.registryPath, JSON.stringify({ proposals: [
    skillDraft("skill-draft:old"),
    skillDraft("skill-draft:young"),
    skillDraft("skill-draft:approved"),
    skillDraft("skill-draft:declined"),
    skillDraft("skill-draft:closed", { skillDraftClose: { at: "2026-11-04T00:00:00.000Z", reason: "withdrawn: x", skillSha256: sha(SKILL_MARKDOWN) } }),
  ] }));
}

const rows = (s: Site) => [...readLedgerLines(s.ledgerPath)];
const declinesOf = (s: Site, id: string) => rows(s).filter((r) => r.step === "panel.proposal_declined" && r.task_id === id);
const pass = (s: Site) => expireUnansweredSkillDrafts(s.registryPath, s.stateDir, retroLog(s), clock);

function writeArchive(s: Site, stamp: string, entries: Record<string, unknown>[]): string {
  const path = join(s.stateDir, compactedArchiveName(stamp));
  writeFileSync(path, gzipSync(entries.map((entry) => JSON.stringify(entry) + "\n").join("")));
  return path;
}

function publishCompactedArchives(s: Site, maxSources: number): string[] {
  const removals: string[] = [];
  const errors: string[] = [];
  const result = ledgerCompactCommand(["--older-than", "0", "--max-sources", String(maxSources)], {
    stateDir: s.stateDir,
    clock,
    fs: {
      readdirSync, readFileSync, existsSync, writeAtomic, gzipSync, gunzipSync,
      rmSync: (path) => removals.push(path),
    },
    error: (message) => errors.push(message),
    out: () => {},
  });
  assert.equal(result, 0, errors.join("\n"));
  return removals;
}

function compactionAnswers(s: Site) {
  writeFileSync(inboxFirstSeenPath(s.stateDir), JSON.stringify({
    backfill: BACKFILL, short: "2026-11-03T01:00:00Z", long: "2026-10-20T12:00:00Z",
    "skill-draft:middle": "2026-11-09T12:00:00Z", "skill-draft:old": "2026-11-01T12:00:00Z",
  }));
  writeFileSync(s.registryPath, JSON.stringify({ proposals: [skillDraft("skill-draft:middle"), skillDraft("skill-draft:old")] }));
  writeFileSync(s.ledgerPath, "");
  const short = { step: "ratify.approved", task_id: "short", ts: "2026-11-05T01:00:00Z" };
  const long = { step: "panel.proposal_declined", task_id: "long", ts: "2026-11-05T00:00:00Z" };
  const marker = { step: "skill.staged", task_id: "RETRO", ts: "2026-11-06T00:00:00Z" };
  const earlier = writeArchive(s, short.ts, [short]);
  const later = writeArchive(s, marker.ts, [marker]);
  const publishAnswer = () => writeArchive(s, marker.ts, [long, marker]);
  // Simulate an older writer that moves the answer between two unchanged filenames.
  const replaceArchives = () => {
    assert.equal(writeAtomic(earlier, gzipSync([long, short].map((r) => JSON.stringify(r) + "\n").join(""))), true);
    assert.equal(writeAtomic(later, gzipSync(JSON.stringify(marker) + "\n")), true);
  };
  return { earlier, later, publishAnswer, replaceArchives };
}

function replaceArchivesAfterReadingEarlier(
  t: TestContext,
  s: Site,
  archives: ReturnType<typeof compactionAnswers>,
) {
  const read = realLedgerFs.readFileSync;
  const archiveNames = () => readdirSync(s.stateDir).filter((name) => name.endsWith(".ndjson.gz")).sort();
  const names = archiveNames();
  const before = [archives.earlier, archives.later, s.ledgerPath].map((path) => statSync(path).ino);
  let replaced = false;
  t.mock.method(realLedgerFs, "readFileSync", (path: string) => {
    const bytes = read(path);
    if (path === archives.earlier && !replaced) {
      archives.replaceArchives();
      assert.deepEqual(archiveNames(), names);
      assert.notEqual(statSync(archives.earlier).ino, before[0]);
      assert.notEqual(statSync(archives.later).ino, before[1]);
      assert.equal(statSync(s.ledgerPath).ino, before[2]);
      assert.doesNotMatch(gunzipSync(bytes).toString(), /"task_id":"long"/);
      assert.doesNotMatch(gunzipSync(read(archives.later)).toString(), /"task_id":"long"/);
      replaced = true;
    }
    return bytes;
  });
  return () => assert.equal(replaced, true, "compaction replaced both archives during the read");
}

test("W1-T13859 criterion 1: same-name archive compaction cannot shrink the sampled wait", (t) => {
  const s = site();
  try {
    const archives = compactionAnswers(s);
    archives.publishAnswer();
    const complete = { bound: 15.5 * DAY, sample: 2 };
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), complete);
    const verifyCompaction = replaceArchivesAfterReadingEarlier(t, s, archives);
    const raced = skillDraftExpiryBound(s.stateDir);
    verifyCompaction();
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), complete);
    assert.deepEqual(raced, { unmeasured: "incomplete ledger union: ledger archives changed during read" });
  } finally { s.done(); }
});

test("W1-T13859 criterion 2: expiry waits for a complete compaction read and closes only the draft past the true bound", (t) => {
  const s = site();
  try {
    const archives = compactionAnswers(s);
    archives.publishAnswer();
    const registry = readFileSync(s.registryPath);
    const verifyCompaction = replaceArchivesAfterReadingEarlier(t, s, archives);
    const raced = pass(s);
    verifyCompaction();
    assert.deepEqual(raced, { expired: [], reason: "no skill draft expires: incomplete ledger union: ledger archives changed during read" });
    assert.deepEqual(rows(s), []);
    assert.deepEqual(readFileSync(s.registryPath), registry);

    assert.deepEqual(pass(s).expired, ["skill-draft:old"]);
    assert.deepEqual(pass(s).expired, []);
    const reason = "expired: unanswered for 18.00 days; the longest wait of any answered proposal is 15.50 days (2 answered)";
    assert.deepEqual(rows(s).map(({ step, task_id, origin, reason }) => ({ step, task_id, origin, reason })), [
      { step: "panel.proposal_declined", task_id: "skill-draft:old", origin: "skill-workshop", reason },
    ]);
    assert.deepEqual(loadProposalRegistry(s.registryPath).map(({ id, skillDraftClose }) => [id, skillDraftClose?.reason]), [
      ["skill-draft:middle", undefined], ["skill-draft:old", reason],
    ]);
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: same-name compaction during the locked reread stops expiry and retro prints why", (t) => {
  const s = site();
  try {
    const archives = compactionAnswers(s);
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 2 * DAY, sample: 1 });
    const registry = readFileSync(s.registryPath);
    const printed: string[] = [];
    let verifyCompaction: (() => void) | undefined;
    const racingClock = { ...clock, now: () => {
      archives.publishAnswer();
      assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 15.5 * DAY, sample: 2 });
      verifyCompaction = replaceArchivesAfterReadingEarlier(t, s, archives);
      return NOW;
    } };
    reportSkillDraftExpiry(
      () => expireUnansweredSkillDrafts(s.registryPath, s.stateDir, retroLog(s), racingClock),
      retroLog(s), (message) => printed.push(message),
    );
    assert.ok(verifyCompaction);
    verifyCompaction();
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 15.5 * DAY, sample: 2 });
    assert.deepEqual(printed, ["skill drafts: skill draft expiry stopped: incomplete ledger union: ledger archives changed during read"]);
    assert.deepEqual(rows(s), []);
    assert.deepEqual(readFileSync(s.registryPath), registry);
  } finally { s.done(); }
});

for (const phase of ["initial read", "locked reread"]) {
  test(`W1-T13859 criterion 3: an older restore in a later archive cannot clear a newer decline at the ${phase}`, () => {
    const s = site();
    try {
      const id = "skill-draft:old";
      const restore = { step: "panel.proposal_restored", task_id: id, ts: "2026-11-15T02:00:00Z", origin: "rmd-cli" };
      const decline = { step: "panel.proposal_declined", task_id: id, ts: "2026-11-15T04:00:00Z", origin: "rmd-cli", reason: "operator declined again" };
      const marker = { step: "skill.staged", task_id: "RETRO", ts: "2026-11-15T12:00:00Z" };
      const firstSource = writeArchive(s, "2026-11-16T03:00:00Z", [restore]);
      const secondSource = writeArchive(s, "2026-11-16T12:00:00Z", [marker]);
      const draftRegistry = JSON.stringify({ proposals: [skillDraft(id)] });
      writeFileSync(s.registryPath, draftRegistry);
      writeFileSync(inboxFirstSeenPath(s.stateDir), JSON.stringify({
        backfill: BACKFILL, short: "2026-11-03T00:00:00Z", [id]: "2026-11-01T12:00:00Z",
      }));
      row(s, "ratify.approved", "short", "2026-11-05T00:00:00Z");
      const ledger = readFileSync(s.ledgerPath);
      const installDecline = () => {
        writeArchive(s, "2026-11-15T01:00:00Z", [decline]);
        const removals = publishCompactedArchives(s, 2);
        assert.deepEqual(removals, [firstSource, secondSource]);
        for (const path of removals) rmSync(path);
        const verdictsInFileOrder = readLedgerUnionRecordsSync(s.stateDir, {
          step: ["panel.proposal_declined", "panel.proposal_restored"], refuseIncomplete: true,
        });
        assert.equal(verdictsInFileOrder.ok, true);
        assert.deepEqual(verdictsInFileOrder.rows.map((r) => r.ts), [decline.ts, restore.ts]);
      };
      if (phase === "initial read") installDecline();
      const racingClock = phase === "initial read" ? clock : { ...clock, now: () => {
        installDecline();
        return NOW;
      } };
      assert.deepEqual(expireUnansweredSkillDrafts(s.registryPath, s.stateDir, retroLog(s), racingClock).expired, []);
      assert.deepEqual(readFileSync(s.ledgerPath), ledger);
      assert.equal(readFileSync(s.registryPath, "utf8"), draftRegistry);
    } finally { s.done(); }
  });
}

function treeOf(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${relative(dir, p)}:${readFileSync(p, "utf8")}`);
    }
  };
  walk(dir);
  return out;
}

test("W1-T13859 criterion 1: the bound is the longest first-seen-to-first-answer wait, without backfill stamps or workshop answers", () => {
  const s = site();
  try {
    answered(s, {});
    writeFileSync(join(s.stateDir, "ledger.2026-11-18T00-00-00-000Z.ndjson.gz"), gzipSync(readFileSync(s.ledgerPath)));
    writeFileSync(s.ledgerPath, "");
    const measured = skillDraftExpiryBound(s.stateDir);
    assert.deepEqual(measured, { bound: 7.5 * DAY, sample: 2 });
    appendFileSync(s.ledgerPath, '{"step":"ratify.approved","task_id":"p-b","ts":"2026-10-26');
    const torn = union(s);
    assert.equal(torn.ok, true, "a readable corpus can still lose a row");
    assert.equal(torn.torn, 1);
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), {
      unmeasured: "incomplete ledger union: 0 unread file(s), 1 torn row(s)",
    });
  } finally { s.done(); }
});

test("W1-T13859 criterion 1: a constructor decline counts only with a stored first-seen timestamp", () => {
  const s = site();
  try {
    const firstSeen = { backfill: BACKFILL, approved: "2026-10-20T00:00:00.000Z" };
    writeFileSync(inboxFirstSeenPath(s.stateDir), JSON.stringify(firstSeen));
    row(s, "ratify.approved", "approved", "2026-10-23T00:00:00.000Z");
    row(s, "panel.proposal_declined", "constructor", "2026-11-05T00:00:00.000Z");
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 3 * DAY, sample: 1 });

    writeFileSync(inboxFirstSeenPath(s.stateDir), JSON.stringify({ ...firstSeen, constructor: "2026-11-01T00:00:00.000Z" }));
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 4 * DAY, sample: 2 });
  } finally { s.done(); }
});

test("W1-T13859 criterion 1: a rotation between listing and reading live cannot shrink the measured bound", (t) => {
  const s = site();
  try {
    writeFileSync(inboxFirstSeenPath(s.stateDir), JSON.stringify({ backfill: BACKFILL, short: "2026-10-20", long: "2026-10-21" }));
    row(s, "ratify.approved", "short", "2026-10-22T00:00:00.000Z");
    const retained = readFileSync(s.ledgerPath);
    row(s, "panel.proposal_declined", "long", "2026-11-05T00:00:00.000Z");
    const measured = { bound: 15 * DAY, sample: 2 };
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), measured);

    const list = realLedgerFs.readdirSync;
    const rotate = t.mock.method(realLedgerFs, "readdirSync", (dir: string) => {
      const names = list(dir);
      writeFileSync(join(dir, "ledger.2026-11-18T00-00-00-000Z.ndjson.gz"), gzipSync(readFileSync(s.ledgerPath)));
      writeFileSync(s.ledgerPath, retained);
      return names;
    }, { times: 1 });
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { unmeasured: "incomplete ledger union: ledger rotated during read" });
    assert.equal(rotate.mock.callCount(), 1);
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), measured);
  } finally { s.done(); }
});

test("W1-T13859 criterion 1: a replaced live ledger invalidates the read even with identical archive names", (t) => {
  const s = site();
  try {
    answered(s, {});
    const list = realLedgerFs.readdirSync;
    const replace = t.mock.method(realLedgerFs, "readdirSync", (dir: string) => {
      const names = list(dir);
      const replacement = join(dir, "replacement");
      writeFileSync(replacement, readFileSync(s.ledgerPath));
      renameSync(replacement, s.ledgerPath);
      return names;
    }, { times: 1 });
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { unmeasured: "incomplete ledger union: ledger rotated during read" });
    assert.equal(replace.mock.callCount(), 1);
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 7.5 * DAY, sample: 2 });
  } finally { s.done(); }
});

test("W1-T13859 criterion 1: a committed approval awaiting the old inode's drain leaves the bound unmeasured", (t) => {
  const s = site();
  try {
    const proposalId = "skill-draft:old";
    const unansweredId = "skill-draft:unanswered";
    const firstSeen = "2026-11-01T12:00:00.000Z";
    writeFileSync(inboxFirstSeenPath(s.stateDir), JSON.stringify({
      backfill: BACKFILL, short: "2026-10-20", [proposalId]: firstSeen, [unansweredId]: firstSeen,
    }));
    writeFileSync(s.registryPath, JSON.stringify({ proposals: [skillDraft(proposalId), skillDraft(unansweredId)] }));
    row(s, "ratify.approved", "short", "2026-10-22T00:00:00.000Z");
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 2 * DAY, sample: 1 });

    const registry = readFileSync(s.registryPath);
    const approvalAt = "2026-11-16T12:00:00.000Z";
    const rename = realWriteAtomicIo.renameSync;
    let inspectedSwap = false;
    t.mock.method(realWriteAtomicIo, "renameSync", (from: string, to: string) => {
      rename(from, to);
      if (to !== s.ledgerPath) return;
      inspectedSwap = true;
      assert.equal(existsSync(ledgerRotationLockPath(s.ledgerPath)), true);
      const ledger = readFileSync(s.ledgerPath);
      const beforeDrain = union(s);
      assert.equal(beforeDrain.ok, true);
      assert.equal(beforeDrain.liveFileRead, true);
      assert.equal(beforeDrain.archiveFiles.length, 1);
      assert.deepEqual(beforeDrain.rows.map((r) => r.task_id), ["short"]);

      const unmeasured = "incomplete ledger union: the ledger is being rotated or compacted";
      const bound = skillDraftExpiryBound(s.stateDir);
      const printed: string[] = [];
      reportSkillDraftExpiry(() => pass(s), retroLog(s), (message) => printed.push(message));
      // W1-T13859 criterion 4: the incomplete union leaves both stores intact and retro prints why.
      assert.deepEqual(readFileSync(s.ledgerPath), ledger, "expiry appended during the drain");
      assert.deepEqual(readFileSync(s.registryPath), registry);
      assert.deepEqual(printed, [`skill drafts: no skill draft expires: ${unmeasured}`]);
      assert.deepEqual(bound, { unmeasured });
    });
    assert.equal(rotateLedger(s.ledgerPath, {
      ceilingBytes: 100,
      smoothingWindowMs: 0,
      now: () => new Date(NOW),
      beforeRename: () => row(s, "ratify.approved", proposalId, approvalAt, { origin: "rmd-cli" }),
    }).rotated, true);
    assert.equal(inspectedSwap, true);
    assert.equal(existsSync(ledgerRotationLockPath(s.ledgerPath)), false);
    assert.equal(union(s).rows.find((r) => r.task_id === proposalId)?.ts, approvalAt);
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 15 * DAY, sample: 2 });
    // W1-T13859 criterion 2: once the union is complete, only the unanswered draft expires, once.
    assert.deepEqual(pass(s).expired, [unansweredId]);
    assert.deepEqual(pass(s).expired, []);
    // W1-T13859 criterion 3: the approval survived rotation and protects its draft.
    assert.deepEqual(declinesOf(s, proposalId), []);
    assert.equal(loadProposalRegistry(s.registryPath).find((p) => p.id === proposalId)?.skillDraftClose, undefined);
    assert.deepEqual(declinesOf(s, unansweredId).map(({ origin, reason }) => ({ origin, reason })), [{
      origin: "skill-workshop",
      reason: "expired: unanswered for 18.00 days; the longest wait of any answered proposal is 15.00 days (2 answered)",
    }]);
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: a held rotation lock leaves the bound unmeasured, and the read keeps rotation out", (t) => {
  const s = site();
  try {
    drafts(s);
    const ledger = readFileSync(s.ledgerPath);
    const registry = readFileSync(s.registryPath);
    const lockPath = ledgerRotationLockPath(s.ledgerPath);
    const unmeasured = "incomplete ledger union: the ledger is being rotated or compacted";
    const release = tryAcquireRotationLock(lockPath);
    assert.ok(release, "the test holds the rotation lock");
    try {
      assert.deepEqual(skillDraftExpiryBound(s.stateDir), { unmeasured });
      assert.deepEqual(pass(s), { expired: [], reason: `no skill draft expires: ${unmeasured}` });
    } finally { release(); }
    assert.deepEqual(readFileSync(s.ledgerPath), ledger);
    assert.deepEqual(readFileSync(s.registryPath), registry);

    const list = realLedgerFs.readdirSync;
    let rotated: boolean | undefined;
    t.mock.method(realLedgerFs, "readdirSync", (dir: string) => {
      if (rotated === undefined) {
        assert.equal(existsSync(lockPath), true, "the reader holds the lock while it lists the union");
        rotated = rotateLedger(s.ledgerPath, { ceilingBytes: 1, smoothingWindowMs: 0, now: () => new Date(NOW) }).rotated;
      }
      return list(dir);
    });
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 7.5 * DAY, sample: 4 });
    assert.equal(rotated, false, "rotation waits for the reader");
    assert.equal(existsSync(lockPath), false, "the reader releases the lock");
  } finally { s.done(); }
});

/**
 * This source's stamp collides with the first output. Its rows span both replacement archives.
 */
function rowsInTransit(s: Site, inTransit: Record<string, unknown>[]) {
  const short = { step: "ratify.approved", task_id: "short", ts: "2026-11-05T01:00:00Z" };
  const x = writeArchive(s, short.ts, [short, ...inTransit]);
  // Two same-day rotations of similar size, so the compactor selects all three as ordinary rotations.
  writeArchive(s, "2026-11-05T00:30:00Z", [short, short]);
  writeArchive(s, "2026-11-05T00:10:00Z", [short, short]);
  writeFileSync(s.ledgerPath, "");
  return x;
}

function transitDrafts(s: Site): string {
  writeFileSync(inboxFirstSeenPath(s.stateDir), JSON.stringify({
    backfill: BACKFILL, short: "2026-11-03T01:00:00Z", long: "2026-10-20T12:00:00Z",
    "skill-draft:middle": "2026-11-09T12:00:00Z", "skill-draft:old": "2026-11-01T12:00:00Z",
    "skill-draft:approved": "2026-11-01T12:00:00Z",
  }));
  writeFileSync(s.registryPath, JSON.stringify({ proposals: [
    skillDraft("skill-draft:middle"), skillDraft("skill-draft:old"), skillDraft("skill-draft:approved"),
  ] }));
  return rowsInTransit(s, [
    { step: "panel.proposal_declined", task_id: "long", ts: "2026-11-06T00:00:00Z", origin: "rmd-cli" }, // 16.5 days
    { step: "ratify.approved", task_id: "skill-draft:approved", ts: "2026-11-06T06:00:00Z", origin: "rmd-cli" },
  ]);
}

/** Run the production compactor and inspect the ledger immediately after its first publication. */
function compactWithReadBetweenReplacements(t: TestContext, s: Site, x: string, between: () => void) {
  const originalNames = new Set(readdirSync(s.stateDir));
  const write = realWriteAtomicIo.writeFileSync;
  const source = readFileSync(x);
  let calls = 0;
  const hook = t.mock.method(realWriteAtomicIo, "writeFileSync", (...args: Parameters<typeof write>) => {
    if (++calls === 2) {
      const names = readdirSync(s.stateDir);
      const outputs = names.filter((name) => name.endsWith(".ndjson.gz") && !originalNames.has(name));
      assert.equal(outputs.length, 1, "the first output is already readable");
      assert.deepEqual(readFileSync(x), source, "the source stays readable during publication");
      assert.match(gunzipSync(source).toString(), /2026-11-06/);
      // The new 11-06 name goes first; the 11-05 output replaces the source that also holds 11-06 rows last.
      assert.doesNotMatch(gunzipSync(readFileSync(join(s.stateDir, outputs[0]!))).toString(), /2026-11-05/);
      assert.equal(outputs[0]!.startsWith("ledger.2026-11-06"), true);
      between();
    }
    write(...args);
  });
  const errors: string[] = [];
  const code = ledgerCompactCommand(["--older-than", "0", "--max-sources", "3"], {
    stateDir: s.stateDir, clock, out: () => {}, error: (message) => errors.push(message),
  });
  hook.mock.restore();
  assert.equal(code, 0, errors.join("\n"));
  assert.equal(calls, 2, "the compactor published both outputs");
}

const allDeclinesOf = (s: Site, id: string) => readLedgerUnionRecordsSync(s.stateDir, { step: "panel.proposal_declined", refuseIncomplete: true })
  .rows.filter((r) => r.task_id === id);

test("W1-T13859 criterion 1: the production compactor waits while the bound is read", (t) => {
  const s = site();
  try {
    const x = transitDrafts(s);
    const complete = { bound: 16.5 * DAY, sample: 3 };
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), complete);
    const corpus = () => readdirSync(s.stateDir).sort().map((name) => `${name}:${sha(readFileSync(join(s.stateDir, name)).toString("base64"))}`);
    const before = corpus();
    const read = realLedgerFs.readFileSync;
    const outcome: { code?: number; errors: string[] } = { errors: [] };
    t.mock.method(realLedgerFs, "readFileSync", (path: string) => {
      if (path === x && outcome.code === undefined) {
        outcome.code = ledgerCompactCommand(["--older-than", "0", "--max-sources", "3"], {
          stateDir: s.stateDir, clock, out: () => {}, error: (message) => outcome.errors.push(message),
        });
      }
      return read(path);
    });
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), complete);
    assert.equal(outcome.code, 1);
    assert.match(outcome.errors.join("\n"), /holds the rotation lock; nothing was compacted/);
    assert.deepEqual(corpus(), before, "the compactor changed nothing during the read");
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: a read between two production compactor replacements closes nothing and retro prints why", (t) => {
  const s = site();
  try {
    const x = transitDrafts(s);
    const registry = readFileSync(s.registryPath);
    const unmeasured = "incomplete ledger union: the ledger is being rotated or compacted";
    const printed: string[] = [];
    let bound: unknown;
    compactWithReadBetweenReplacements(t, s, x, () => {
      bound = skillDraftExpiryBound(s.stateDir);
      reportSkillDraftExpiry(() => pass(s), retroLog(s), (message) => printed.push(message));
    });
    assert.deepEqual(bound, { unmeasured });
    assert.deepEqual(printed, [`skill drafts: no skill draft expires: ${unmeasured}`]);
    assert.deepEqual(rows(s), []);
    assert.deepEqual(readFileSync(s.registryPath), registry);

    // W1-T13859 criterion 2: after the pass, the complete union closes only the draft past the true bound, once.
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 16.5 * DAY, sample: 3 });
    assert.deepEqual(pass(s).expired, ["skill-draft:old"]);
    assert.deepEqual(pass(s).expired, []);
    // W1-T13859 criterion 3: the approval the compactor moved still protects its draft, and the younger draft stays open.
    assert.deepEqual(rows(s).map(({ step, task_id, origin, reason }) => ({ step, task_id, origin, reason })), [{
      step: "panel.proposal_declined", task_id: "skill-draft:old", origin: "skill-workshop",
      reason: "expired: unanswered for 18.00 days; the longest wait of any answered proposal is 16.50 days (3 answered)",
    }]);
    assert.deepEqual(loadProposalRegistry(s.registryPath).map(({ id, skillDraftClose }) => [id, skillDraftClose === undefined]), [
      ["skill-draft:middle", true], ["skill-draft:old", false], ["skill-draft:approved", true],
    ]);
  } finally { s.done(); }
});

test("W1-T13859 criterion 6: a restored expiry stays open while the compactor moves its receipts", (t) => {
  const s = site();
  try {
    const id = "skill-draft:old";
    writeFileSync(inboxFirstSeenPath(s.stateDir), JSON.stringify({ backfill: BACKFILL, short: "2026-11-03T01:00:00Z", [id]: "2026-11-01T12:00:00Z" }));
    // The expiry decline landed, its registry write failed, and the operator restored the draft.
    const registry = JSON.stringify({ proposals: [skillDraft(id)] });
    writeFileSync(s.registryPath, registry);
    const x = rowsInTransit(s, [
      { step: "panel.proposal_declined", task_id: id, ts: "2026-11-06T00:00:00Z", origin: "skill-workshop",
        reason: "expired: unanswered for 4.50 days; the longest wait of any answered proposal is 2.00 days (1 answered)",
        skill_draft_close_id: "close-1", skill_draft_sha256: sha(SKILL_MARKDOWN) },
      { step: "panel.proposal_restored", task_id: id, ts: "2026-11-06T06:00:00Z", origin: "rmd-cli", reason: "still considering it" },
    ]);
    assert.deepEqual(pass(s).expired, []);
    let between: unknown;
    compactWithReadBetweenReplacements(t, s, x, () => { between = pass(s); });
    assert.deepEqual(between, { expired: [], reason: "no skill draft expires: incomplete ledger union: the ledger is being rotated or compacted" });
    assert.deepEqual(pass(s).expired, []);
    assert.equal(allDeclinesOf(s, id).length, 1, "the restored draft is not closed again");
    assert.equal(readFileSync(s.registryPath, "utf8"), registry);
  } finally { s.done(); }
});

test("W1-T13859 criterion 2: a failed second publication preserves approvals and the established bound", (t) => {
  const s = site();
  try {
    const source = transitDrafts(s);
    const measured = { bound: 16.5 * DAY, sample: 3 };
    const sourceBytes = readFileSync(source);
    const before = union(s);
    assert.equal(before.ok, true);
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), measured);

    const originalNames = new Set(readdirSync(s.stateDir));
    const write = realWriteAtomicIo.writeFileSync;
    const errors: string[] = [];
    let attempted = 0;
    const hook = t.mock.method(realWriteAtomicIo, "writeFileSync", (...args: Parameters<typeof write>) => {
      if (++attempted === 2) throw new Error("fixture: second archive publication failed");
      write(...args);
    });
    let code: number;
    try {
      code = ledgerCompactCommand(["--older-than", "0", "--max-sources", "3"], {
        stateDir: s.stateDir, clock, out: () => {}, error: (message) => errors.push(message),
      });
    } finally { hook.mock.restore(); }

    assert.equal(code, 1);
    assert.match(errors.join("\n"), /second archive publication failed/);
    assert.equal(attempted, 2);
    assert.equal(existsSync(ledgerRotationLockPath(s.ledgerPath)), false);
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), measured);
    assert.deepEqual(readFileSync(source), sourceBytes);
    assert.equal(readdirSync(s.stateDir).filter((name) => name.endsWith(".ndjson.gz") && !originalNames.has(name)).length, 1);
    const after = union(s);
    assert.equal(after.ok, true);
    assert.deepEqual(new Set(after.rows), new Set(before.rows));

    const reason = "expired: unanswered for 18.00 days; the longest wait of any answered proposal is 16.50 days (3 answered)";
    assert.deepEqual(pass(s).expired, ["skill-draft:old"]);
    assert.deepEqual(pass(s).expired, []);
    assert.deepEqual(rows(s).map(({ step, task_id, origin, reason }) => ({ step, task_id, origin, reason })), [
      { step: "panel.proposal_declined", task_id: "skill-draft:old", origin: "skill-workshop", reason },
    ]);
    assert.deepEqual(loadProposalRegistry(s.registryPath).map(({ id, skillDraftClose }) => [id, skillDraftClose?.reason]), [
      ["skill-draft:middle", undefined], ["skill-draft:old", reason], ["skill-draft:approved", undefined],
    ]);

    assert.equal(ledgerCompactCommand(["--older-than", "0", "--max-sources", "4"], {
      stateDir: s.stateDir, clock, out: () => {}, error: assert.fail,
    }), 0);
    // The 11-05 output keeps the source's name and replaces it; the source's own bytes go to cold storage.
    assert.notDeepEqual(readFileSync(source), sourceBytes, "a complete retry retires the source");
    assert.deepEqual(readFileSync(join(s.stateDir, LEDGER_COLD_STORE_DIRNAME, basename(source))), sourceBytes);
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), measured);
    assert.deepEqual(pass(s).expired, []);
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: the daemon's compaction worker waits for a held rotation lock and frees its own when the thread ends", async () => {
  const s = site();
  try {
    transitDrafts(s);
    const corpus = () => readdirSync(s.stateDir).sort().map((name) => `${name}:${sha(readFileSync(join(s.stateDir, name)).toString("base64"))}`);
    const before = corpus();
    const lockPath = ledgerRotationLockPath(s.ledgerPath);
    const args = ["--older-than", "0", "--max-sources", "3"];
    const release = tryAcquireRotationLock(lockPath);
    assert.ok(release, "the test holds the rotation lock, as a complete-ledger read does");
    try {
      assert.deepEqual(await compactLedgerInWorker(args, s.stateDir), {
        code: 1, errors: ["rmd ledger-compact: a ledger rotation or a complete-ledger read holds the rotation lock; nothing was compacted"],
      });
    } finally { release(); }
    assert.deepEqual(corpus(), before, "no worker ran while the lock was held");
    const passed = await compactLedgerInWorker(args, s.stateDir);
    assert.equal(passed.code, 0, passed.errors.join("\n"));
    assert.equal(existsSync(lockPath), false, "the parent thread freed the lock when the worker exited");
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 16.5 * DAY, sample: 3 });
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: a rotation lock that cannot be taken leaves the bound unmeasured and compacts nothing", () => {
  const s = site();
  try {
    const missing = join(s.root, "missing-state");
    const bound = skillDraftExpiryBound(missing);
    assert.ok("unmeasured" in bound);
    assert.match(bound.unmeasured, /^incomplete ledger union: could not take the ledger rotation lock: Error: ENOENT/);
    const errors: string[] = [];
    assert.equal(ledgerCompactCommand(["--older-than", "0"], { stateDir: missing, clock, out: () => {}, error: (m) => errors.push(m) }), 1);
    assert.match(errors.join("\n"), /^rmd ledger-compact: cannot take the ledger rotation lock in .*missing-state — ENOENT/);
    assert.equal(existsSync(missing), false);
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: readable archives cannot substitute for a missing live ledger", () => {
  const s = site();
  try {
    drafts(s);
    const archive = join(s.stateDir, "ledger.2026-11-18T00-00-00-000Z.ndjson.gz");
    const archived = gzipSync(readFileSync(s.ledgerPath));
    writeFileSync(archive, archived);
    rmSync(s.ledgerPath);
    const registry = readFileSync(s.registryPath);
    const partial = union(s);
    assert.equal(partial.ok, true);
    assert.equal(partial.liveFileRead, false);
    assert.ok(partial.rows.length > 0);
    const unmeasured = "incomplete ledger union: live ledger is missing";
    const bound = skillDraftExpiryBound(s.stateDir);
    const result = pass(s);
    assert.equal(existsSync(s.ledgerPath), false, "expiry recreated the missing ledger");
    assert.deepEqual(readFileSync(archive), archived);
    assert.deepEqual(readFileSync(s.registryPath), registry);
    assert.deepEqual(result, { expired: [], reason: `no skill draft expires: ${unmeasured}` });
    assert.deepEqual(bound, { unmeasured });
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: a failed archive inventory recheck leaves expiry unmeasured", (t) => {
  const s = site();
  try {
    drafts(s);
    const ledger = readFileSync(s.ledgerPath);
    const registry = readFileSync(s.registryPath);
    const list = realLedgerFs.readdirSync;
    let reads = 0;
    t.mock.method(realLedgerFs, "readdirSync", (dir: string) => {
      reads += 1;
      if (reads === 2) throw new Error("could not list rotations");
      return list(dir);
    });
    assert.deepEqual(pass(s), {
      expired: [], reason: "no skill draft expires: incomplete ledger union: could not verify ledger files: Error: could not list rotations",
    });
    assert.equal(reads, 2);
    assert.deepEqual(readFileSync(s.ledgerPath), ledger);
    assert.deepEqual(readFileSync(s.registryPath), registry);
  } finally { s.done(); }
});

test("W1-T13859 criterion 2: an old unanswered draft closes once as expired despite an unmatched constructor decline", () => {
  const s = site();
  try {
    drafts(s);
    row(s, "panel.proposal_declined", "constructor", "2026-11-10T00:00:00.000Z");
    const first = pass(s);
    assert.deepEqual(first.expired, ["skill-draft:old"]);
    const declined = declinesOf(s, "skill-draft:old");
    assert.equal(declined.length, 1);
    assert.equal(declined[0]!.origin, "skill-workshop");
    assert.equal(declined[0]!.reason,
      "expired: unanswered for 18.00 days; the longest wait of any answered proposal is 7.50 days (4 answered)");
    assert.match(loadProposalRegistry(s.registryPath).find((p) => p.id === "skill-draft:old")?.skillDraftClose?.reason ?? "", /^expired:/);
    assert.equal(ledgerProposalVerdicts(rows(s)).isDeclined("skill-draft:old")?.startsWith("expired:"), true);

    const before = rows(s).length;
    const second = pass(s);
    assert.equal(second.expired.length, 0);
    assert.equal(rows(s).length, before, "a second pass writes no row");
  } finally { s.done(); }
});

test("W1-T13859 criterion 3: young, approved, declined and workshop-closed drafts are not changed and get no row", () => {
  const s = site();
  try {
    drafts(s);
    const keep = ["skill-draft:young", "skill-draft:approved", "skill-draft:declined", "skill-draft:closed"];
    const before = new Map(keep.map((id) => [id, JSON.stringify(loadProposalRegistry(s.registryPath).find((p) => p.id === id))]));
    const declinesBefore = new Map(keep.map((id) => [id, declinesOf(s, id).length]));
    pass(s);
    for (const id of keep) {
      assert.equal(JSON.stringify(loadProposalRegistry(s.registryPath).find((p) => p.id === id)), before.get(id), id);
      assert.equal(declinesOf(s, id).length, declinesBefore.get(id), id);
    }
  } finally { s.done(); }
});

test("W1-T13859 criterion 3: an operator decline committed after the initial ledger read wins over expiry", () => {
  const s = site();
  try {
    drafts(s);
    const registry = readFileSync(s.registryPath, "utf8");
    const racingClock = { ...clock, now: () => {
      row(s, "panel.proposal_declined", "skill-draft:old", "2026-11-19T11:59:59.999Z",
        { origin: "rmd-cli", reason: "duplicate draft" });
      return NOW;
    } };
    const result = expireUnansweredSkillDrafts(s.registryPath, s.stateDir, retroLog(s), racingClock);
    assert.deepEqual(result.expired, []);
    assert.deepEqual(declinesOf(s, "skill-draft:old").map(({ origin, reason }) => ({ origin, reason })), [
      { origin: "rmd-cli", reason: "duplicate draft" },
    ]);
    assert.equal(readFileSync(s.registryPath, "utf8"), registry);
  } finally { s.done(); }
});

test("W1-T13859 criterion 3: the daemon's inbox responder only receives operator items and excludes skill drafts", () => {
  const s = site();
  try {
    const draft = skillDraft("skill-draft:old");
    const ruling = { id: "ruling:needs-operator", summary: "Choose the next step", evidenceAnchors: [] };
    writeFileSync(s.registryPath, JSON.stringify({ proposals: [draft, ruling] }));
    assert.deepEqual(loadProposalRegistry(s.registryPath).map((p) => p.id), [draft.id, ruling.id]);
    const items = registryThreadItems(s.stateDir, s.ledgerPath, { repository: "owner/core" });
    assert.deepEqual(items.map((item) => item.proposalId), [ruling.id]);
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: an unreadable archive blocks expiry and retro prints the incomplete-union reason", () => {
  const s = site();
  try {
    drafts(s);
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 7.5 * DAY, sample: 4 });
    row(s, "panel.proposal_declined", "constructor", "2026-11-10T00:00:00.000Z");
    writeFileSync(join(s.stateDir, "ledger.2026-10-01T00-00-00-000Z.ndjson.gz"), "not gzip");
    const ledger = readFileSync(s.ledgerPath);
    const registry = readFileSync(s.registryPath);
    const unmeasured = "incomplete ledger union: 1 unread file(s), 0 torn row(s)";
    const reason = `no skill draft expires: ${unmeasured}`;
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { unmeasured });
    assert.deepEqual(pass(s), { expired: [], reason });
    const printed: string[] = [];
    reportSkillDraftExpiry(() => pass(s), retroLog(s), (message) => printed.push(message));
    assert.deepEqual(printed, [`skill drafts: ${reason}`]);
    assert.deepEqual(readFileSync(s.ledgerPath), ledger);
    assert.deepEqual(readFileSync(s.registryPath), registry);
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: an unmatched constructor decline leaves zero measured waits and retro prints why", () => {
  const s = site();
  try {
    const id = "skill-draft:old";
    writeFileSync(inboxFirstSeenPath(s.stateDir), JSON.stringify({ backfill: BACKFILL, [id]: "2026-10-20T00:00:00.000Z" }));
    writeFileSync(s.registryPath, JSON.stringify({ proposals: [skillDraft(id)] }));
    row(s, "ratify.approved", "unrelated", "2026-11-01T00:00:00.000Z");
    row(s, "panel.proposal_declined", "constructor", "2026-11-10T00:00:00.000Z");
    const ledger = readFileSync(s.ledgerPath);
    const registry = readFileSync(s.registryPath);
    const unmeasured = "no answered proposal has a measured wait";
    const reason = `no skill draft expires: ${unmeasured}`;
    const printed: string[] = [];
    reportSkillDraftExpiry(() => pass(s), retroLog(s), (message) => printed.push(message));
    assert.deepEqual(printed, [`skill drafts: ${reason}`]);
    assert.deepEqual(pass(s), { expired: [], reason });
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { unmeasured });
    assert.deepEqual(readFileSync(s.ledgerPath), ledger);
    assert.deepEqual(readFileSync(s.registryPath), registry);
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: a torn approval in a readable ledger leaves both stores unchanged and retro prints why", () => {
  const s = site();
  try {
    drafts(s);
    appendFileSync(s.ledgerPath, '{"step":"ratify.approved","task_id":"skill-draft:old","ts":"2026-11-19');
    const ledger = readFileSync(s.ledgerPath, "utf8");
    const registry = readFileSync(s.registryPath, "utf8");
    const reason = "no skill draft expires: incomplete ledger union: 0 unread file(s), 1 torn row(s)";
    assert.deepEqual(pass(s), { expired: [], reason });
    const printed: string[] = [];
    reportSkillDraftExpiry(() => pass(s), retroLog(s), (message) => printed.push(message));
    assert.deepEqual(printed, [`skill drafts: ${reason}`]);
    assert.equal(readFileSync(s.ledgerPath, "utf8"), ledger);
    assert.equal(readFileSync(s.registryPath, "utf8"), registry);
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: expiry stops if an approval tears after its first read", () => {
  const s = site();
  try {
    drafts(s);
    const registry = readFileSync(s.registryPath, "utf8");
    const torn = '{"step":"ratify.approved","task_id":"skill-draft:old","ts":"2026-11-19';
    const ledger = readFileSync(s.ledgerPath, "utf8") + torn;
    const racingClock = { ...clock, now: () => {
      appendFileSync(s.ledgerPath, torn);
      return NOW;
    } };
    const result = expireUnansweredSkillDrafts(s.registryPath, s.stateDir, retroLog(s), racingClock);
    assert.deepEqual(result.expired, []);
    assert.match(result.reason, /incomplete ledger union: 0 unread file\(s\), 1 torn row\(s\)/);
    assert.equal(readFileSync(s.ledgerPath, "utf8"), ledger);
    assert.equal(readFileSync(s.registryPath, "utf8"), registry);
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: a same-inode torn append after the final live read leaves both stores unchanged by expiry", (t) => {
  const s = site();
  try {
    drafts(s);
    const registry = readFileSync(s.registryPath);
    const original = readFileSync(s.ledgerPath, "utf8");
    const torn = '{"step":"ratify.approved","task_id":"skill-draft:old"';
    const inode = statSync(s.ledgerPath).ino;
    const read = realLedgerFs.readFileSync;
    let liveReads = 0;
    t.mock.method(realLedgerFs, "readFileSync", (path: string) => {
      const bytes = read(path);
      if (path === s.ledgerPath && ++liveReads === 2) appendFileSync(path, torn);
      return bytes;
    });
    const printed: string[] = [];
    reportSkillDraftExpiry(() => pass(s), retroLog(s), (message) => printed.push(message));
    assert.equal(statSync(s.ledgerPath).ino, inode);
    assert.equal(readFileSync(s.ledgerPath, "utf8"), original + torn);
    assert.deepEqual(readFileSync(s.registryPath), registry);
    assert.deepEqual(printed, ["skill drafts: skill draft expiry stopped: incomplete ledger union: live ledger changed during read"]);
  } finally { s.done(); }
});

for (const tail of ["torn", "complete"] as const) {
  test(`W1-T13859 criterion 4: a ${tail} approval appended at the decline boundary invalidates the expiry decision`, () => {
    const s = site();
    try {
      drafts(s);
      const registry = readFileSync(s.registryPath);
      const original = readFileSync(s.ledgerPath, "utf8");
      const answer = JSON.stringify({ step: "ratify.approved", task_id: "skill-draft:old", ts: clock.iso() });
      const added = tail === "torn" ? answer : answer + "\n";
      const log = (step: string, extra?: Record<string, unknown>, expectedLiveVersion?: string) => {
        if (step === "panel.proposal_declined") appendFileSync(s.ledgerPath, added);
        retroLog(s)(step, extra, expectedLiveVersion);
      };
      const printed: string[] = [];
      reportSkillDraftExpiry(
        () => expireUnansweredSkillDrafts(s.registryPath, s.stateDir, log, clock),
        log,
        (message) => printed.push(message),
      );
      assert.equal(readFileSync(s.ledgerPath, "utf8"), original + added);
      assert.deepEqual(readFileSync(s.registryPath), registry);
      assert.deepEqual(printed, [`skill drafts: skill draft expiry stopped: incomplete ledger union: ${tail === "torn"
        ? "live ledger has an unterminated tail" : "live ledger changed before the decline append"}`]);
    } finally { s.done(); }
  });
}

test("W1-T13859 criterion 4: expiry reports when the live ledger disappears before append without recreating it", () => {
  const s = site();
  try {
    drafts(s);
    const registry = readFileSync(s.registryPath);
    const racingClock = { ...clock, iso: () => {
      rmSync(s.ledgerPath);
      return clock.iso();
    } };
    const printed: string[] = [];
    reportSkillDraftExpiry(
      () => expireUnansweredSkillDrafts(s.registryPath, s.stateDir, retroLog(s), racingClock),
      retroLog(s),
      (message) => printed.push(message),
    );
    assert.equal(existsSync(s.ledgerPath), false);
    assert.deepEqual(readFileSync(s.registryPath), registry);
    assert.deepEqual(printed, ["skill drafts: skill draft expiry stopped: incomplete ledger union: live ledger is missing before the decline append"]);
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: a valid JSON live tail without a newline leaves both stores unchanged and retro prints why", () => {
  const s = site();
  try {
    drafts(s);
    appendFileSync(s.ledgerPath, JSON.stringify({ step: "ratify.approved", task_id: "other", ts: clock.iso() }));
    assert.equal(union(s).torn, 0, "the final object parses without its newline");
    const ledger = readFileSync(s.ledgerPath);
    const registry = readFileSync(s.registryPath);
    const printed: string[] = [];
    reportSkillDraftExpiry(() => pass(s), retroLog(s), (message) => printed.push(message));
    assert.deepEqual(printed, ["skill drafts: no skill draft expires: incomplete ledger union: 0 unread file(s), 1 torn row(s)"]);
    assert.deepEqual(readFileSync(s.ledgerPath), ledger);
    assert.deepEqual(readFileSync(s.registryPath), registry);
  } finally { s.done(); }
});

test("W1-T13859 criterion 5: the workshop's own expiry declines never enter the sample", () => {
  const s = site();
  try {
    answered(s, {});
    const withExpiry = union(s);
    const pc = withExpiry.rows.find((r) => r.task_id === "p-c");
    assert.ok(pc && at(String(pc.ts)) - at("2026-10-26T00:00:00.000Z") > 7.5 * DAY, "the expiry would be the longest wait");
    const measured = skillDraftExpiryBound(s.stateDir);
    writeFileSync(s.ledgerPath, rows(s).filter((r) => r.task_id !== "p-c").map((r) => JSON.stringify(r) + "\n").join(""));
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), measured);
  } finally { s.done(); }
});

test("W1-T13859 criterion 7: retro survives expiry append failure even when its failure row cannot be written", () => {
  const s = site();
  try {
    drafts(s);
    const registry = readFileSync(s.registryPath, "utf8");
    for (const failReport of [false, true]) {
      const printed: string[] = [];
      const steps: string[] = [];
      const log = (step: string, extra?: Record<string, unknown>) => {
        steps.push(step);
        if (step === "panel.proposal_declined") throw new Error("decline append failed");
        if (failReport) throw new Error("failure append failed");
        retroLog(s)(step, extra);
      };
      reportSkillDraftExpiry(
        () => expireUnansweredSkillDrafts(s.registryPath, s.stateDir, log, clock),
        log,
        (message) => printed.push(message),
      );
      assert.deepEqual(steps, ["panel.proposal_declined", "skill.expire_failed"]);
      assert.deepEqual(printed, failReport
        ? ["skill.expire_failed: decline append failed (writing the failure to the ledger also failed: Error: failure append failed)"]
        : []);
      assert.equal(readFileSync(s.registryPath, "utf8"), registry);
      assert.deepEqual(declinesOf(s, "skill-draft:old"), []);
    }
    assert.deepEqual(rows(s).filter((r) => r.step === "skill.expire_failed").map((r) => r.error), ["decline append failed"]);
  } finally { s.done(); }
});

test("W1-T13859 criterion 6: invariant:approve-only-writes-skills an expiry writes nothing under .claude/skills and a restore keeps the draft open", () => {
  const s = site();
  try {
    const skills = join(s.root, ".claude", "skills", "existing");
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, "SKILL.md"), "---\nname: existing\n---\n");
    const tree = treeOf(join(s.root, ".claude"));
    drafts(s);
    assert.deepEqual(pass(s).expired, ["skill-draft:old"]);
    assert.deepEqual(treeOf(join(s.root, ".claude")), tree);
    row(s, "panel.proposal_restored", "skill-draft:old", "2026-11-19T13:00:00.000Z", { origin: "rmd-cli" });
    pass(s);
    pass(s);
    assert.equal(declinesOf(s, "skill-draft:old").length, 1, "the restored draft is not closed again");
    assert.equal(ledgerProposalVerdicts(rows(s)).isDeclined("skill-draft:old"), undefined);
    assert.deepEqual(treeOf(join(s.root, ".claude")), tree);
  } finally { s.done(); }
});

// W1-T13859 criterion 6: the terminal verdict suite exercises rmd restore with a stale lock and an archived expiry.
test("W1-T13859 criterion 6: restoring after a failed registry write keeps that text open", (t) => {
  const s = site();
  try {
    drafts(s);
    const proposalId = "skill-draft:old";
    const registry = readFileSync(s.registryPath);
    const skills = join(s.root, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, "existing.md"), "existing skill\n");
    const tree = treeOf(skills);
    const rename = fs.renameSync;
    const write = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (to === s.registryPath) throw new Error("registry rename failed");
      return rename(from, to);
    });
    try {
      assert.throws(() => pass(s), /registry rename failed/);
    } finally { write.mock.restore(); }
    assert.deepEqual(readFileSync(s.registryPath), registry);
    assert.equal(declinesOf(s, proposalId).length, 1);
    assert.match(ledgerProposalVerdicts(rows(s)).isDeclined(proposalId) ?? "", /^expired:/);
    assert.deepEqual(applyProposalVerdict("restore", { proposalId, reason: "still considering it" }, {
      exists: true, classification: { proposalId, state: "declined", reasons: [] },
    }, (step, id, reason) => row(s, step, id, "2026-11-19T13:00:00.000Z", { reason, origin: "rmd-cli" })), { ok: true });

    assert.deepEqual(pass(s).expired, []);
    assert.equal(declinesOf(s, proposalId).length, 1);
    assert.equal(ledgerProposalVerdicts(rows(s)).isDeclined(proposalId), undefined);
    assert.deepEqual(readFileSync(s.registryPath), registry);
    assert.deepEqual(treeOf(skills), tree);

    const markdown = `${SKILL_MARKDOWN}\n- Verify the revised draft.\n`;
    const revised = skillDraft(proposalId, { skillFile: { name: "skill-draft-old", markdown } });
    writeFileSync(s.registryPath, JSON.stringify({ proposals: [revised] }));
    assert.deepEqual(pass(s).expired, [proposalId]);
    assert.deepEqual(declinesOf(s, proposalId).map((row) => row.skill_draft_sha256), [sha(SKILL_MARKDOWN), sha(markdown)]);
    assert.deepEqual(treeOf(skills), tree);
  } finally { s.done(); }
});

test("W1-T13859 criterion 2: a compaction onto the newest source's own name keeps the analytics checkpoint count", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}skill-draft-analytics-`));
  try {
    const invoked = (verb: string, ts: string, n = 0) => JSON.stringify({ ts, task_id: "CLI", run_id: `CLI-${verb}-${n}`, step: "cli.invoked", verb });
    // Three similar rotations, each named for its own newest row, so the day's output name collides with the
    // newest one. Each holds more rows than the scan's per-step replay window, so a re-read past the checkpoint
    // cannot be deduplicated.
    const rotation = (verb: string, newestIso: string) => writeFileSync(join(dir, compactedArchiveName(newestIso)), gzipSync(
      `${Array.from({ length: 300 }, (_, i) => invoked(verb, new Date(Date.parse(newestIso) - i * 1000).toISOString(), i)).join("\n")}\n`));
    const newest = "2026-09-20T12:00:00.000Z";
    rotation("alpha", "2026-09-20T10:00:00.000Z");
    rotation("bravo", "2026-09-20T11:00:00.000Z");
    rotation("charlie", newest);
    writeFileSync(join(dir, "ledger.ndjson"), `${invoked("delta", "2026-10-06T20:00:00.000Z")}\n`);
    const scanClock = fixedClock(Date.parse("2026-10-06T21:00:00.000Z"));
    const first = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, scanClock);
    const prior = JSON.parse(JSON.stringify(first.checkpoint)) as analytics.AnalyticsCheckpoint;

    assert.equal(ledgerCompactCommand(["--older-than", "7"], { stateDir: dir, clock: scanClock, out: () => {}, error: assert.fail }), 0);
    const resumed = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, scanClock, undefined, prior);
    const fresh = await analytics.deriveAnalyticsSnapshotFromCheckpointedLedger(dir, scanClock);
    assert.deepEqual(resumed.snapshot.invocationsByVerb, fresh.snapshot.invocationsByVerb, "a resumed scan counts what a fresh scan counts");
    assert.deepEqual(fresh.snapshot.invocationsByVerb, { alpha: 300, bravo: 300, charlie: 300, delta: 1 });
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".ndjson.gz")), [compactedArchiveName(newest)],
      "the output keeps the newest source's name, never a stamp past the checkpoint");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("W1-T13859 criterion 4: an unterminated row appended after the final version check stops expiry and retro prints why", (t) => {
  const s = site();
  try {
    drafts(s);
    const registry = readFileSync(s.registryPath);
    const torn = JSON.stringify({ step: "ratify.approved", task_id: "skill-draft:old", ts: clock.iso() });
    const write = fs.writeSync;
    let injected = false;
    const hook = t.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
      const [, data] = args;
      if (!injected && Buffer.isBuffer(data) && data.includes('"origin":"skill-workshop"') && data.includes('"expired:')) {
        injected = true;
        appendFileSync(s.ledgerPath, torn);
      }
      return (write as (...a: unknown[]) => number)(...args);
    });
    syncBuiltinESMExports();
    const printed: string[] = [];
    try {
      reportSkillDraftExpiry(() => pass(s), retroLog(s), (message) => printed.push(message));
    } finally {
      hook.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(injected, true, "the competing append landed after the version check");
    assert.deepEqual(printed, ["skill drafts: skill draft expiry stopped: incomplete ledger union: live ledger gained an unterminated row before the decline append"]);
    assert.deepEqual(rows(s).filter((r) => r.step === "skill.expire_failed"), []);
    assert.deepEqual(declinesOf(s, "skill-draft:old"), []);
    assert.deepEqual(readFileSync(s.registryPath), registry);
    assert.deepEqual(pass(s), { expired: [], reason: "no skill draft expires: incomplete ledger union: 0 unread file(s), 1 torn row(s)" });
  } finally { s.done(); }
});

/** Run `pass` with `bytes` appended to the live ledger after the decline's version check, just before its write. */
function appendAtDeclineWrite(t: TestContext, s: Site, bytes: string): { landed: () => boolean } {
  const write = fs.writeSync;
  let injected = false;
  const hook = t.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
    const [, data] = args;
    if (!injected && Buffer.isBuffer(data) && data.includes('"origin":"skill-workshop"') && data.includes('"expired:')) {
      injected = true;
      appendFileSync(s.ledgerPath, bytes);
    }
    return (write as (...a: unknown[]) => number)(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { hook.mock.restore(); syncBuiltinESMExports(); });
  return { landed: () => injected };
}

test("W1-T13859 criterion 2: an approval that lands at the decline write and raises the bound leaves the 18-day draft open", (t) => {
  const s = site();
  try {
    // One answer: a 2.00-day wait. The draft has waited 18.00 days.
    writeFileSync(inboxFirstSeenPath(s.stateDir), JSON.stringify({
      backfill: BACKFILL, short: "2026-11-05T00:00:00.000Z", long: "2026-10-24T00:00:00.000Z",
      "skill-draft:old": "2026-11-01T12:00:00.000Z",
    }));
    row(s, "ratify.approved", "short", "2026-11-07T00:00:00.000Z", { origin: "rmd-cli" });
    writeFileSync(s.registryPath, JSON.stringify({ proposals: [skillDraft("skill-draft:old")] }));
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 2 * DAY, sample: 1 });
    const registry = readFileSync(s.registryPath);
    const original = readFileSync(s.ledgerPath, "utf8");
    // A second answer, 24.50 days after first-seen, completes between the expiry's read and its append.
    const approval = JSON.stringify({ ts: "2026-11-17T12:00:00.000Z", step: "ratify.approved", task_id: "long", origin: "rmd-cli" }) + "\n";
    const race = appendAtDeclineWrite(t, s, approval);
    const printed: string[] = [];
    reportSkillDraftExpiry(() => pass(s), retroLog(s), (message) => printed.push(message));
    assert.equal(race.landed(), true, "the approval landed after the version check");
    assert.deepEqual(printed, ["skill drafts: skill draft expiry stopped: incomplete ledger union: live ledger gained a row before the decline append"]);
    assert.deepEqual(declinesOf(s, "skill-draft:old"), [], "no decline computed from the 1-answer sample survives");
    assert.doesNotMatch(readFileSync(s.ledgerPath, "utf8"), /skill-workshop/);
    assert.equal(readFileSync(s.ledgerPath, "utf8").replace(/\n *\n$/, "\n"), original + approval, "the approval is intact");
    assert.deepEqual(readFileSync(s.registryPath), registry);

    // The next pass measures the new bound; an 18-day draft is younger than 24.50 days and stays open.
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 24.5 * DAY, sample: 2 });
    const ledger = readFileSync(s.ledgerPath);
    assert.deepEqual(pass(s), { expired: [], reason: "0 skill draft(s) expired; the bound is 24.50 days over 2 answered proposal(s)" });
    assert.deepEqual(readFileSync(s.ledgerPath), ledger);
    assert.deepEqual(readFileSync(s.registryPath), registry);
  } finally { s.done(); }
});

test("W1-T13859 criterion 4: an unterminated approval at the decline write keeps every decline byte out of the real ledger", (t) => {
  const s = site();
  try {
    drafts(s);
    const registry = readFileSync(s.registryPath);
    const original = readFileSync(s.ledgerPath, "utf8");
    const torn = JSON.stringify({ step: "ratify.approved", task_id: "skill-draft:old", ts: clock.iso() });
    const race = appendAtDeclineWrite(t, s, torn);
    const printed: string[] = [];
    reportSkillDraftExpiry(() => pass(s), retroLog(s), (message) => printed.push(message));
    assert.equal(race.landed(), true, "the unterminated approval landed after the version check");
    assert.deepEqual(printed, ["skill drafts: skill draft expiry stopped: incomplete ledger union: live ledger gained an unterminated row before the decline append"]);
    const bytes = readFileSync(s.ledgerPath, "utf8");
    // Only spaces follow the partial approval: no decline byte, and no newline that would join or commit it.
    assert.equal(bytes.slice(0, original.length + torn.length), original + torn);
    assert.match(bytes.slice(original.length + torn.length), /^ +$/);
    assert.deepEqual(declinesOf(s, "skill-draft:old"), []);
    assert.deepEqual(readFileSync(s.registryPath), registry);
    // The next append meets the same unterminated tail it would have met had the decline never been written.
    assert.deepEqual(pass(s), { expired: [], reason: "no skill draft expires: incomplete ledger union: 0 unread file(s), 1 torn row(s)" });
    assert.equal(readFileSync(s.ledgerPath, "utf8"), bytes);
  } finally { s.done(); }
});
