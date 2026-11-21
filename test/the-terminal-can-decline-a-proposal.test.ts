/**
 * `rmd decline` and `rmd restore` — the terminal's route to the console's two inbox verdicts. Both commands and both
 * serve routes (test/the-console-inbox-can-decline-a-proposal.test.ts, test/a-decline-can-be-taken-back.test.ts) go
 * through `applyProposalVerdict`, so these cases pin the command's own arms and the one live path from argv to a
 * ledger row.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { fixedClock, systemClock } from "#src/lib/clock.js";
import { inflightLockPath } from "#src/lib/inflight-lock.js";
import { appendLedger, compactedArchiveName, ledgerRotationLockPath, tryAcquireRotationLock } from "#src/lib/ledger.js";
import { ledgerLivePath } from "#src/lib/ledger-union.js";
import { writeDaemonTargetRecord } from "#src/lib/repo-location.js";
import { expireUnansweredSkillDrafts, inboxFirstSeenPath, readSkillDraftVerdicts, withSkillDraftVerdictLock } from "#src/lib/skill-workshop.js";
import { readLedgerLines } from "#src/lib/status.js";
import type { InboxClassification, Proposal } from "../src/lib/inbox.js";
import { proposalVerdictCommand } from "../src/lib/inbox-verdict-command.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { proposalVerdictCliCommand } from "../src/run-task.js";

type Found = { exists: boolean; classification?: InboxClassification };

function run(kind: "decline" | "restore", rest: string[], found: Found) {
  const recorded: Array<[string, string, string]> = [];
  const out: string[] = [];
  const err: string[] = [];
  const savedLog = console.log;
  const savedError = console.error;
  console.log = (line: unknown) => void out.push(String(line));
  console.error = (line: unknown) => void err.push(String(line));
  try {
    const code = proposalVerdictCommand(kind, rest, () => found, (step, id, reason) => recorded.push([step, id, reason]));
    return { code, recorded, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = savedLog;
    console.error = savedError;
  }
}

const notReady: Found = { exists: true, classification: { proposalId: "P1", state: "not_ready", reasons: [] } as InboxClassification };
const declined: Found = {
  exists: true,
  classification: { proposalId: "P1", state: "declined", reasons: [], declinedReason: "a duplicate" } as InboxClassification,
};
const ratified: Found = { exists: true, classification: { proposalId: "P1", state: "ratified", reasons: [] } as InboxClassification };

test("rmd decline records one panel.proposal_declined row with the reason verbatim and names the way back", () => {
  const r = run("decline", ["P1", "--reason", "legacy duplicate of skill-draft:8aa4"], notReady);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.recorded, [["panel.proposal_declined", "P1", "legacy duplicate of skill-draft:8aa4"]]);
  assert.match(r.out, /P1 DECLINED — take it back with rmd restore P1 --reason/);
});

test("rmd decline refuses an unknown, a ratified or an already-declined proposal and records nothing", () => {
  const unknown = run("decline", ["P9", "--reason", "r"], { exists: false });
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /no active proposal "P9"/);
  const done = run("decline", ["P1", "--reason", "r"], ratified);
  assert.equal(done.code, 1);
  assert.match(done.err, /already RATIFIED — declining now cannot un-file/);
  const again = run("decline", ["P1", "--reason", "r"], declined);
  assert.equal(again.code, 1);
  assert.match(again.err, /was already declined \(a duplicate\)/);
  assert.deepEqual([...unknown.recorded, ...done.recorded, ...again.recorded], []);
});

test("rmd restore records panel.proposal_restored for a declined proposal and refuses one that is not declined", () => {
  const r = run("restore", ["P1", "--reason", "the decline was wrong"], declined);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.recorded, [["panel.proposal_restored", "P1", "the decline was wrong"]]);
  assert.match(r.out, /P1 RESTORED/);
  const refused = run("restore", ["P1", "--reason", "r"], notReady);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /is not declined \(state: not_ready\) — there is nothing to restore/);
  const done = run("restore", ["P1", "--reason", "r"], ratified);
  assert.match(done.err, /already RATIFIED — restoring it cannot un-file/);
  assert.deepEqual([...refused.recorded, ...done.recorded], []);
});

test("rmd decline without a reason, with an empty reason, or with a stray argument is a usage error that records nothing", () => {
  for (const rest of [["P1"], ["P1", "--reason", "  "], ["P1", "--reason"], ["--reason", "r"], ["P1", "--reason", "r", "--force"], []]) {
    const r = run("decline", rest, notReady);
    assert.equal(r.code, 2, `argv ${JSON.stringify(rest)}`);
    assert.match(r.err, /usage: rmd decline <proposalId> --reason "<text>"/);
    assert.deepEqual(r.recorded, []);
  }
});

test("rmd decline and rmd restore, end to end: a real registry, the live classification, and the ledger they share", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rmd-decline-cli-`));
  const errors: string[] = [];
  const savedError = console.error;
  const savedLog = console.log;
  try {
    console.error = (line: unknown) => void errors.push(String(line));
    console.log = () => {};
    mkdirSync(join(root, "state"), { recursive: true });
    const proposal: Proposal = { id: "skill-draft:legacy-1", summary: "s", evidenceAnchors: [] };
    writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [proposal] }), "utf8");
    const config = { claudeBin: "/usr/bin/true", root } as never;
    const rows = () =>
      readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.task_id === "skill-draft:legacy-1");

    assert.equal(proposalVerdictCliCommand("decline", ["skill-draft:legacy-1", "--reason", "legacy duplicate"], config), 0);
    assert.deepEqual(
      rows().map((l) => [l.step, l.origin, l.reason]),
      [["panel.proposal_declined", "rmd-cli", "legacy duplicate"]],
    );
    // The second decline must SEE the first: only a classification with the ledger's declines applied refuses it.
    assert.equal(proposalVerdictCliCommand("decline", ["skill-draft:legacy-1", "--reason", "again"], config), 1);
    assert.match(errors.join("\n"), /was already declined \(legacy duplicate\)/);
    assert.equal(proposalVerdictCliCommand("restore", ["skill-draft:legacy-1", "--reason", "wrong call"], config), 0);
    assert.equal(proposalVerdictCliCommand("restore", ["skill-draft:legacy-1", "--reason", "twice"], config), 1);
    assert.equal(proposalVerdictCliCommand("decline", ["no-such-proposal", "--reason", "r"], config), 1);
    assert.deepEqual(
      rows().map((l) => l.step),
      ["panel.proposal_declined", "panel.proposal_restored"],
    );
  } finally {
    console.error = savedError;
    console.log = savedLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T13859 criterion 6: rmd restore reclaims a stale foreign verdict lock and reverses an archived expiry", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rmd-restore-expiry-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const ledgerPath = ledgerLivePath(stateDir);
  const registryPath = join(stateDir, "inbox-proposals.json");
  const skills = join(root, ".claude", "skills");
  const skillPath = join(skills, "existing.md");
  mkdirSync(stateDir);
  mkdirSync(skills, { recursive: true });
  writeFileSync(skillPath, "existing skill\n");
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  assert.deepEqual(writeDaemonTargetRecord(stateDir, {
    owner: "fixture", repo: "fixture", isSelf: false, checkoutRoot: root,
  }), { written: true });

  const id = "skill-draft:old";
  const clock = fixedClock(Date.parse("2026-11-19T12:00:00Z"));
  const markdown = "---\nname: proc\n---\n";
  writeFileSync(registryPath, JSON.stringify({ proposals: [
    { id, summary: markdown, evidenceAnchors: [], skillFile: { name: "proc", markdown }, skillFileStagedAt: "2026-11-01T00:00:00Z" },
  ] }));
  writeFileSync(inboxFirstSeenPath(stateDir), JSON.stringify({
    backfill: "2026-10-13T00:00:00Z", answered: "2026-11-01T00:00:00Z", [id]: "2026-11-01T00:00:00Z",
  }));
  const answer = { step: "ratify.approved", task_id: "answered", run_id: "PANEL", ts: "2026-11-03T00:00:00Z" };
  const log = (step: string, extra?: Record<string, unknown>, expectedLiveVersion?: string) =>
    appendLedger(ledgerPath, { step, task_id: "RETRO", run_id: "RETRO", ...extra }, { expectedLiveVersion });
  appendLedger(ledgerPath, answer);
  const expire = () => expireUnansweredSkillDrafts(registryPath, stateDir, log, clock);
  assert.deepEqual(expire().expired, [id]);
  assert.deepEqual(readdirSync(skills), ["existing.md"]);
  assert.equal(readFileSync(skillPath, "utf8"), "existing skill\n");

  const lock = inflightLockPath(stateDir, `skill-draft-verdict-${createHash("sha256").update(id).digest("hex")}`);
  const restoreClock = fixedClock(Date.parse("2026-11-19T13:00:00Z"));
  t.mock.method(systemClock, "now", restoreClock.now);
  const holder = { pid: process.pid, run_id: id, host: "decommissioned-verdict-host", startedAt: restoreClock.iso() };
  const recent = JSON.stringify(holder);
  withSkillDraftVerdictLock(stateDir, id, () => {
    writeFileSync(lock, recent);
  });
  assert.equal(readFileSync(lock, "utf8"), recent, "release preserves a successor's lock");
  const restore = () => proposalVerdictCliCommand("restore", [id, "--reason", "keep considering this draft"], { root } as never);
  const restores = () => readLedgerLines(ledgerPath).filter((row) => row.step === "panel.proposal_restored" && row.task_id === id);
  assert.throws(restore, /verdict is in progress/);
  assert.equal(readFileSync(lock, "utf8"), recent);
  assert.deepEqual(restores(), []);
  rmSync(lock);

  const expiry = readLedgerLines(ledgerPath).find((row) => row.step === "panel.proposal_declined" && row.task_id === id);
  assert.ok(expiry);
  writeFileSync(join(stateDir, compactedArchiveName(clock.iso())), gzipSync(JSON.stringify(expiry) + "\n"));
  writeFileSync(ledgerPath, JSON.stringify(answer) + "\n");
  const releaseRotation = tryAcquireRotationLock(ledgerRotationLockPath(ledgerPath));
  assert.ok(releaseRotation);
  try {
    assert.throws(restore, /rmd restore: incomplete ledger union/);
    assert.deepEqual(restores(), []);
  } finally { releaseRotation(); }

  writeFileSync(lock, JSON.stringify({ ...holder, startedAt: clock.iso() }));
  assert.equal(restore(), 0);
  assert.equal(existsSync(lock), false);
  assert.deepEqual(restores().map(({ origin, reason }) => ({ origin, reason })), [
    { origin: "rmd-cli", reason: "keep considering this draft" },
  ]);
  assert.equal(restore(), 1);
  assert.equal(restores().length, 1);
  assert.deepEqual(expire().expired, []);
  const verdicts = readSkillDraftVerdicts(stateDir);
  assert.ok(!("unmeasured" in verdicts));
  assert.equal(verdicts.isDeclined(id), undefined);
  assert.deepEqual(readdirSync(skills), ["existing.md"]);
  assert.equal(readFileSync(skillPath, "utf8"), "existing skill\n");
});

test("W1-T13859 criterion 6: rmd restore reverses live operator declines and expiries despite an unrelated unreadable archive", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rmd-restore-live-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const ledgerPath = ledgerLivePath(stateDir);
  const registryPath = join(stateDir, "inbox-proposals.json");
  const skills = join(root, ".claude", "skills");
  mkdirSync(stateDir);
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, "existing.md"), "existing skill\n");
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  assert.deepEqual(writeDaemonTargetRecord(stateDir, {
    owner: "fixture", repo: "fixture", isSelf: false, checkoutRoot: root,
  }), { written: true });

  const expired = "skill-draft:expired";
  const declined = "skill-draft:declined";
  const clock = fixedClock(Date.parse("2026-11-19T12:00:00Z"));
  t.mock.method(systemClock, "now", clock.now);
  const markdown = "---\nname: proc\n---\n";
  writeFileSync(registryPath, JSON.stringify({ proposals: [expired, declined].map((id) => ({
    id, summary: markdown, evidenceAnchors: [], skillFile: { name: "proc", markdown },
  })) }));
  writeFileSync(inboxFirstSeenPath(stateDir), JSON.stringify({
    backfill: "2026-10-13", answered: "2026-11-01", [expired]: "2026-11-01",
  }));
  appendLedger(ledgerPath, { step: "ratify.approved", task_id: "answered", run_id: "PANEL", ts: "2026-11-03T00:00:00Z" });
  const log = (step: string, extra?: Record<string, unknown>, expectedLiveVersion?: string) =>
    appendLedger(ledgerPath, { step, task_id: "RETRO", run_id: "RETRO", ...extra }, { expectedLiveVersion });
  const expire = () => expireUnansweredSkillDrafts(registryPath, stateDir, log, clock);
  assert.deepEqual(expire().expired, [expired]);
  const config = { root } as never;
  assert.equal(proposalVerdictCliCommand("decline", [declined, "--reason", "operator decline"], config), 0);
  t.mock.method(systemClock, "now", () => clock.now() + 1000);
  const unreadable = join(stateDir, compactedArchiveName("2026-10-31T00:00:00Z"));
  writeFileSync(unreadable, "not gzip");
  const registry = readFileSync(registryPath);
  const restore = (id: string) => proposalVerdictCliCommand("restore", [id, "--reason", "keep open"], config);
  const intactLedger = readFileSync(ledgerPath, "utf8");
  const tornLedger = intactLedger + JSON.stringify({ step: "unrelated", task_id: "other", ts: clock.iso() });
  writeFileSync(ledgerPath, tornLedger);
  assert.throws(() => restore(declined), /incomplete ledger union: 1 unread file\(s\), 1 torn row\(s\)/);
  assert.equal(readFileSync(ledgerPath, "utf8"), tornLedger);
  writeFileSync(ledgerPath, intactLedger);
  for (const id of [declined, expired]) assert.equal(restore(id), 0);
  assert.deepEqual(readLedgerLines(ledgerPath).filter((r) => r.step === "panel.proposal_restored").map((r) => r.task_id), [declined, expired]);
  rmSync(unreadable);
  const ledger = readFileSync(ledgerPath);
  assert.deepEqual(expire().expired, []);
  assert.deepEqual(readFileSync(ledgerPath), ledger);
  assert.deepEqual(readFileSync(registryPath), registry);
  assert.deepEqual(readdirSync(skills), ["existing.md"]);
  assert.equal(readFileSync(join(skills, "existing.md"), "utf8"), "existing skill\n");
});

test("W1-T13859 criterion 6: rmd restore reopens live declines and expiries beside a malformed row in a readable archive", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rmd-restore-torn-archive-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const ledgerPath = ledgerLivePath(stateDir);
  const registryPath = join(stateDir, "inbox-proposals.json");
  const skills = join(root, ".claude", "skills");
  mkdirSync(stateDir);
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, "existing.md"), "existing skill\n");
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  assert.deepEqual(writeDaemonTargetRecord(stateDir, {
    owner: "fixture", repo: "fixture", isSelf: false, checkoutRoot: root,
  }), { written: true });

  const expired = "skill-draft:expired";
  const declined = "skill-draft:declined";
  const clock = fixedClock(Date.parse("2026-11-19T12:00:00Z"));
  t.mock.method(systemClock, "now", clock.now);
  const markdown = "---\nname: proc\n---\n";
  writeFileSync(registryPath, JSON.stringify({ proposals: [expired, declined].map((id) => ({
    id, summary: markdown, evidenceAnchors: [], skillFile: { name: "proc", markdown },
  })) }));
  writeFileSync(inboxFirstSeenPath(stateDir), JSON.stringify({
    backfill: "2026-10-13", answered: "2026-11-01", [expired]: "2026-11-01",
  }));
  appendLedger(ledgerPath, { step: "ratify.approved", task_id: "answered", run_id: "PANEL", ts: "2026-11-03T00:00:00Z" });
  const log = (step: string, extra?: Record<string, unknown>, expectedLiveVersion?: string) =>
    appendLedger(ledgerPath, { step, task_id: "RETRO", run_id: "RETRO", ...extra }, { expectedLiveVersion });
  const expire = () => expireUnansweredSkillDrafts(registryPath, stateDir, log, clock);
  assert.deepEqual(expire().expired, [expired]);
  const config = { root } as never;
  assert.equal(proposalVerdictCliCommand("decline", [declined, "--reason", "operator decline"], config), 0);
  t.mock.method(systemClock, "now", () => clock.now() + 1000);
  // One unrelated malformed row in an archive that gunzips cleanly; the live ledger is intact.
  const malformed = join(stateDir, compactedArchiveName("2026-10-31T00:00:00Z"));
  writeFileSync(malformed, gzipSync(`${JSON.stringify({ step: "unrelated", task_id: "other", ts: "2026-10-30T00:00:00Z" })}\n{"step":"unrel\n`));
  const registry = readFileSync(registryPath);
  for (const id of [declined, expired]) {
    assert.equal(proposalVerdictCliCommand("restore", [id, "--reason", "keep open"], config), 0, `restore ${id}`);
  }
  assert.deepEqual(readLedgerLines(ledgerPath).filter((r) => r.step === "panel.proposal_restored").map((r) => r.task_id), [declined, expired]);
  // Expiry still refuses the incomplete union, so the restored draft stays open.
  assert.match(expire().reason, /incomplete ledger union: 0 unread file\(s\), 1 torn row\(s\)/);
  rmSync(malformed);
  assert.deepEqual(expire().expired, []);
  assert.deepEqual(readFileSync(registryPath), registry);
  assert.deepEqual(readdirSync(skills), ["existing.md"]);
});

test("W1-T13859 criterion 6: rmd restore skips an unrelated malformed live line and reopens an expiry and an operator decline", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rmd-restore-malformed-live-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const ledgerPath = ledgerLivePath(stateDir);
  const registryPath = join(stateDir, "inbox-proposals.json");
  const skills = join(root, ".claude", "skills");
  mkdirSync(stateDir);
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, "existing.md"), "existing skill\n");
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  assert.deepEqual(writeDaemonTargetRecord(stateDir, {
    owner: "fixture", repo: "fixture", isSelf: false, checkoutRoot: root,
  }), { written: true });

  const expired = "skill-draft:expired";
  const declined = "skill-draft:declined";
  const clock = fixedClock(Date.parse("2026-11-19T12:00:00Z"));
  t.mock.method(systemClock, "now", clock.now);
  const markdown = "---\nname: proc\n---\n";
  writeFileSync(registryPath, JSON.stringify({ proposals: [expired, declined].map((id) => ({
    id, summary: markdown, evidenceAnchors: [], skillFile: { name: "proc", markdown },
  })) }));
  writeFileSync(inboxFirstSeenPath(stateDir), JSON.stringify({
    backfill: "2026-10-13", answered: "2026-11-01", [expired]: "2026-11-01",
  }));
  appendLedger(ledgerPath, { step: "ratify.approved", task_id: "answered", run_id: "PANEL", ts: "2026-11-03T00:00:00Z" });
  const log = (step: string, extra?: Record<string, unknown>, expectedLiveVersion?: string) =>
    appendLedger(ledgerPath, { step, task_id: "RETRO", run_id: "RETRO", ...extra }, { expectedLiveVersion });
  const expire = () => expireUnansweredSkillDrafts(registryPath, stateDir, log, clock);
  assert.deepEqual(expire().expired, [expired]);
  const config = { root } as never;
  assert.equal(proposalVerdictCliCommand("decline", [declined, "--reason", "operator decline"], config), 0);
  t.mock.method(systemClock, "now", () => clock.now() + 1000);
  // An unrelated malformed line, then a valid row: the live tail is complete.
  writeFileSync(ledgerPath, readFileSync(ledgerPath, "utf8") + '{"step":"unrel\n' +
    JSON.stringify({ step: "unrelated", task_id: "other", ts: clock.iso() }) + "\n");
  const registry = readFileSync(registryPath);
  for (const id of [declined, expired]) {
    assert.equal(proposalVerdictCliCommand("restore", [id, "--reason", "keep open"], config), 0, `restore ${id}`);
  }
  assert.deepEqual(readLedgerLines(ledgerPath).filter((r) => r.step === "panel.proposal_restored").map((r) => r.task_id), [declined, expired]);
  const verdicts = readSkillDraftVerdicts(stateDir);
  assert.ok(!("unmeasured" in verdicts));
  assert.equal(verdicts.isDeclined(expired), undefined);
  assert.equal(verdicts.isDeclined(declined), undefined);
  // Expiry still refuses the malformed line, so nothing is written and the restored draft stays open.
  const ledger = readFileSync(ledgerPath);
  assert.match(expire().reason, /incomplete ledger union: 0 unread file\(s\), 1 torn row\(s\)/);
  assert.deepEqual(readFileSync(ledgerPath), ledger);
  assert.deepEqual(readFileSync(registryPath), registry);
  assert.deepEqual(readdirSync(skills), ["existing.md"]);
});

test("W1-T13859 criterion 6: rmd restore reopens a live operator decline while the ledger rotation lock is held", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}rmd-restore-rotation-lock-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const ledgerPath = ledgerLivePath(stateDir);
  const registryPath = join(stateDir, "inbox-proposals.json");
  mkdirSync(stateDir);
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan", "tasks.yaml"), "[]\n");
  assert.deepEqual(writeDaemonTargetRecord(stateDir, {
    owner: "fixture", repo: "fixture", isSelf: false, checkoutRoot: root,
  }), { written: true });
  const id = "skill-draft:declined";
  const markdown = "---\nname: proc\n---\n";
  writeFileSync(registryPath, JSON.stringify({ proposals: [{ id, summary: markdown, evidenceAnchors: [], skillFile: { name: "proc", markdown } }] }));
  appendLedger(ledgerPath, { step: "ratify.approved", task_id: "answered", run_id: "PANEL", ts: "2026-11-03T00:00:00Z" });
  const config = { root } as never;
  assert.equal(proposalVerdictCliCommand("decline", [id, "--reason", "operator decline"], config), 0);
  const restores = () => readLedgerLines(ledgerPath).filter((row) => row.step === "panel.proposal_restored" && row.task_id === id);

  const releaseRotation = tryAcquireRotationLock(ledgerRotationLockPath(ledgerPath));
  assert.ok(releaseRotation, "this test holds the rotation lock, as a rotation or compaction would");
  try {
    assert.equal(proposalVerdictCliCommand("restore", [id, "--reason", "wrong call"], config), 0);
  } finally { releaseRotation(); }
  assert.deepEqual(restores().map(({ origin, reason }) => ({ origin, reason })), [{ origin: "rmd-cli", reason: "wrong call" }]);
  const verdicts = readSkillDraftVerdicts(stateDir);
  assert.ok(!("unmeasured" in verdicts));
  assert.equal(verdicts.isDeclined(id), undefined);
});
