import assert from "node:assert/strict";
import fs, { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fixedClock } from "#src/lib/clock.js";
import { realWriteAtomicIo } from "#src/lib/fs-race-safe.js";
import { applyProposalVerdict, ledgerProposalVerdicts, loadProposalRegistry } from "#src/lib/inbox.js";
import { registryThreadItems } from "#src/lib/inbox-responder.js";
import { appendLedger, ledgerRotationLockPath, rotateLedger } from "#src/lib/ledger.js";
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
const retroLog = (s: Site) => (step: string, extra: Record<string, unknown> = {}) =>
  appendLedger(s.ledgerPath, { run_id: "RETRO-1", task_id: "RETRO", step, lane: "retro", ...extra });

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

      const unmeasured = "incomplete ledger union: ledger rotation in progress";
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

test("W1-T13859 criterion 4: the rotation lock is checked again after reading the union", (t) => {
  const s = site();
  try {
    drafts(s);
    const list = realLedgerFs.readdirSync;
    const lockPath = ledgerRotationLockPath(s.ledgerPath);
    let listings = 0;
    t.mock.method(realLedgerFs, "readdirSync", (dir: string) => {
      if (++listings === 2) writeFileSync(lockPath, "", { flag: "wx" });
      return list(dir);
    });
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { unmeasured: "incomplete ledger union: ledger rotation in progress" });
    rmSync(lockPath);
    assert.deepEqual(skillDraftExpiryBound(s.stateDir), { bound: 7.5 * DAY, sample: 4 });
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

test("W1-T13859 criterion 2: an old unanswered draft closes once as expired, with its age, the bound and the sample", () => {
  const s = site();
  try {
    drafts(s);
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

test("W1-T13859 criterion 4: an incomplete ledger union or an empty sample closes nothing and returns a reason", () => {
  const s = site();
  try {
    drafts(s);
    writeFileSync(join(s.stateDir, "ledger.2026-10-01T00-00-00-000Z.ndjson.gz"), "not gzip");
    const registry = readFileSync(s.registryPath, "utf8");
    const before = rows(s).length;
    const r = pass(s);
    assert.equal(r.expired.length, 0);
    assert.match(r.reason, /^no skill draft expires: .*incomplete ledger union/);
    assert.equal(rows(s).length, before);
    assert.equal(readFileSync(s.registryPath, "utf8"), registry);
  } finally { s.done(); }

  const e = site();
  try {
    writeFileSync(inboxFirstSeenPath(e.stateDir), JSON.stringify({ "skill-draft:old": BACKFILL, "skill-draft:new": "2026-10-20T00:00:00.000Z" }));
    writeFileSync(e.registryPath, JSON.stringify({ proposals: [skillDraft("skill-draft:old"), skillDraft("skill-draft:new")] }));
    row(e, "ratify.approved", "unrelated", "2026-11-01T00:00:00.000Z");
    const r = pass(e);
    assert.equal(r.expired.length, 0);
    assert.match(r.reason, /^no skill draft expires: no answered proposal has a measured wait/);
    assert.equal(declinesOf(e, "skill-draft:old").length + declinesOf(e, "skill-draft:new").length, 0);
  } finally { e.done(); }
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
