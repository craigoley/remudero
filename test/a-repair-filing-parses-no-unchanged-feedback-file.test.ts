/**
 * W1-T13334 — A REPAIR FILING PARSES NO UNCHANGED FEEDBACK FILE.
 *
 * Before the sweep files a repair it reads every entry of plan/feedback, to learn whether the operator rejected the
 * latest filing for that surface. listFeedback read and parsed all 828 files on each pass: 197 stalls and 314 s inside
 * the capture in six hours on 2026-11-17. Each test uses real files in a temporary root and counts the entry files
 * listFeedback reads: it parses exactly the files it reads.
 */
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { stringify as stringifyYaml } from "yaml";

import { feedbackEntryPath, listFeedback, type FeedbackEntry, type FeedbackStatus } from "#src/lib/feedback.js";
import { queuedFeedbackLandings } from "#src/lib/feedback-landing.js";
import { planDestinationPath } from "#src/lib/plan-destination.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { captureRepairFeedbackWithPriorVerdictAsync } from "#test/helpers/run-task-test.js";

const TIMEOUT = { timeout: 240_000 };
const SURFACE = "repair#blocked-fixable";
/** listFeedback keeps a file only when its last change is two seconds old. */
const SETTLE_MS = 2_000;
const idOf = (n: number): string => `fb-${1_700_000_000_000 + n}-${n.toString(16).padStart(6, "0")}`;

function entry(n: number, over: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    id: idOf(n), ts: new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString(), raw: `text of entry ${n}`, attachments: [], origin: "cli",
    status: "new", reply_to: null, proposal_pr: null, summary: null, expansion: null, submission_key: null, ...over,
  };
}

function world(t: TestContext, entries: FeedbackEntry[]): { root: string; stateRoot: string; path: (id: string) => string; write: (e: FeedbackEntry) => void } {
  const root = ownedFixtureDir(t, "feedback-kept").dir;
  const stateRoot = ownedFixtureDir(t, "feedback-kept-state").dir;
  const path = (id: string): string => feedbackEntryPath(root, id);
  const write = (e: FeedbackEntry): void => {
    mkdirSync(dirname(path(e.id)), { recursive: true });
    writeFileSync(path(e.id), stringifyYaml(e));
  };
  for (const e of entries) write(e);
  return { root, stateRoot, path, write };
}

/** Waits until every given file was last changed more than the settle time ago, so the next listFeedback keeps it. */
async function settled(...paths: string[]): Promise<void> {
  const newest = Math.max(...paths.map((path) => Math.max(statSync(path).ctimeMs, statSync(path).mtimeMs)));
  while (Date.now() - newest < SETTLE_MS + 100) await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Records the entry files this process reads until `restore`. listFeedback parses a file only after it read it. */
function watchReads(): { names: () => string[]; restore: () => void } {
  const mod = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  const real = mod.readFileSync!;
  const seen: string[] = [];
  mod.readFileSync = (...args: unknown[]) => {
    const path = String(args[0]);
    if (path.endsWith(".yaml") && basename(dirname(path)) === "feedback") seen.push(basename(path, ".yaml"));
    return real(...args);
  };
  syncBuiltinESMExports();
  return {
    names: () => [...seen].sort(),
    restore: () => {
      mod.readFileSync = real;
      syncBuiltinESMExports();
    },
  };
}
function reading<T>(run: () => T): { value: T; read: string[] } {
  const watch = watchReads();
  try {
    return { value: run(), read: watch.names() };
  } finally {
    watch.restore();
  }
}

type Row = { step: string; extra?: Record<string, unknown> };
/** One repair filing through the daemon's capture; returns the rows it logged and whether the filing was staged. */
async function capture(fx: { root: string; stateRoot: string }, id: string): Promise<{ rows: Row[]; staged: boolean }> {
  const rows: Row[] = [];
  const raw = "SWEEP REPAIR RECURRENCE\n- PR #101 at aaa1111\n- PR #102 at bbb2222\n- PR #103 at ccc3333";
  await captureRepairFeedbackWithPriorVerdictAsync(fx.root, { id, origin: SURFACE, raw }, (step, extra) => rows.push({ step, extra }), fx.stateRoot);
  return { rows, staged: queuedFeedbackLandings(fx.stateRoot).includes(`plan/feedback/${id}.yaml`) };
}

test("W1-T13334 criterion 1: a second listFeedback over 200 unchanged entries parses none, and two captures of a suppressed filing parse each file once", TIMEOUT, async (t) => {
  const entries = Array.from({ length: 200 }, (_, n) => entry(n, n % 7 === 0 ? { status: "rejected" } : {}));
  const fx = world(t, entries);
  await settled(...entries.map((e) => fx.path(e.id)));
  const first = reading(() => listFeedback(fx.root));
  assert.equal(first.read.length, 200, "the first call reads every entry");
  assert.deepEqual(first.value, entries);
  const second = reading(() => listFeedback(fx.root));
  assert.deepEqual(second.read, [], "the second call parses no YAML document");
  assert.deepEqual(second.value, first.value);
  assert.deepEqual(second.value.map((e) => e.id), entries.map((e) => e.id), "the same order");
  for (const status of ["rejected", "new", "accepted"] satisfies FeedbackStatus[]) {
    const filtered = reading(() => listFeedback(fx.root, { status }));
    assert.deepEqual(filtered.read, []);
    assert.deepEqual(filtered.value, first.value.filter((e) => e.status === status), `the ${status} filter`);
  }

  // The daemon's capture, twice, for a filing the latest rejected entry of its surface suppresses.
  const prior = entry(500, { origin: SURFACE, status: "rejected" });
  const other = world(t, [...entries, prior]);
  await settled(...[...entries, prior].map((e) => other.path(e.id)));
  const watch = watchReads();
  try {
    const one = await capture(other, "fb-repair-window-1");
    const two = await capture(other, "fb-repair-window-1");
    assert.deepEqual([one.staged, two.staged], [false, false], "the filing is suppressed both times");
    assert.deepEqual(one.rows.map((row) => [row.step, row.extra?.rejected_entry_id, row.extra?.distinct_pr_count]), [["sweep.repair_filing_suppressed", prior.id, 3]]);
    assert.equal(watch.names().length, 201, "each entry file is parsed once in total");
    assert.deepEqual(new Set(watch.names()).size, 201);
  } finally {
    watch.restore();
  }
});

test("W1-T13334 criterion 2: invariant:a-changed-verdict-is-seen-at-once — a rewritten, replaced, added or deleted file is read on the next call, and no other", TIMEOUT, async (t) => {
  const entries = [0, 1, 2, 3, 4].map((n) => entry(n, { raw: "x".repeat(20) }));
  const fx = world(t, entries);
  // Whole-millisecond times, so the rewrite below can put the same mtime back.
  const stamp = new Date(Date.UTC(2026, 9, 2));
  for (const e of entries) utimesSync(fx.path(e.id), stamp, stamp);
  await settled(...entries.map((e) => fx.path(e.id)));
  assert.equal(reading(() => listFeedback(fx.root)).read.length, 5);
  assert.deepEqual(reading(() => listFeedback(fx.root)).read, []);

  // Rewritten in place: status new to rejected, the same byte length and the same mtime. Only the ctime shows it.
  const rewritten = { ...entries[2]!, status: "rejected" as const, raw: "x".repeat(15) };
  const before = statSync(fx.path(rewritten.id));
  fx.write(rewritten);
  utimesSync(fx.path(rewritten.id), stamp, stamp);
  const after = statSync(fx.path(rewritten.id));
  assert.deepEqual([after.size, after.mtimeMs, after.ino], [before.size, before.mtimeMs, before.ino], "the same size, mtime and inode");
  // Replaced by rename, added and deleted.
  const replaced = { ...entries[3]!, status: "accepted" as const };
  writeFileSync(join(fx.root, "replacement.tmp"), stringifyYaml(replaced));
  renameSync(join(fx.root, "replacement.tmp"), fx.path(replaced.id));
  const added = entry(9, { status: "proposed" });
  fx.write(added);
  rmSync(fx.path(entries[1]!.id));

  const expected = [entries[0]!, rewritten, replaced, entries[4]!, added];
  const changed = [rewritten.id, replaced.id, added.id].sort();
  const next = reading(() => listFeedback(fx.root));
  assert.deepEqual(next.value, expected, "the next call returns the new content");
  assert.deepEqual(next.read, changed, "only the files that changed are parsed");
  // A file changed moments ago is read again, never answered from an older parse.
  assert.deepEqual(reading(() => listFeedback(fx.root)).read, changed);
  await settled(...expected.map((e) => fx.path(e.id)));
  assert.deepEqual(reading(() => listFeedback(fx.root)).read, changed);
  const kept = reading(() => listFeedback(fx.root));
  assert.deepEqual([kept.read, kept.value], [[], expected]);
  // The whole directory is deleted: nothing is listed, and no kept parse answers for a file written there later.
  rmSync(dirname(fx.path(idOf(0))), { recursive: true });
  assert.deepEqual(reading(() => listFeedback(fx.root)), { value: [], read: [] });
  fx.write(rewritten);
  assert.deepEqual(reading(() => listFeedback(fx.root)), { value: [rewritten], read: [rewritten.id] });

  // A repair filing follows the verdict on disk: filed, then suppressed once the latest entry is rejected, then filed
  // again once that entry is deleted.
  const prior = entry(20, { origin: SURFACE, status: "new" });
  const repair = world(t, [entry(10), prior]);
  await settled(repair.path(prior.id), repair.path(idOf(10)));
  assert.equal((await capture(repair, "fb-repair-window-1")).staged, true, "an untriaged prior entry suppresses nothing");
  repair.write({ ...prior, status: "rejected" });
  const suppressed = await capture(repair, "fb-repair-window-2");
  assert.equal(suppressed.staged, false, "the entry that became rejected suppresses the next capture");
  assert.equal(suppressed.rows[0]?.extra?.rejected_entry_id, prior.id);
  rmSync(repair.path(prior.id));
  assert.equal((await capture(repair, "fb-repair-window-3")).staged, true, "with the rejected entry deleted the filing is made");
});

test("W1-T13334 criterion 3: invariant:an-unreadable-entry-never-silences-a-filing — a corrupt entry makes every call throw, and the capture still files", TIMEOUT, async (t) => {
  const prior = entry(2, { origin: SURFACE, status: "rejected" });
  const fx = world(t, [entry(0), entry(1), prior]);
  const corrupt = fx.path(idOf(3));
  writeFileSync(corrupt, "id: [not closed\nraw: : :\n");
  await settled(corrupt, fx.path(prior.id));
  const watch = watchReads();
  try {
    for (const call of ["first", "second", "third"]) assert.throws(() => listFeedback(fx.root), `the ${call} call throws`);
    assert.equal(watch.names().filter((name) => name === idOf(3)).length, 3, "the corrupt file is read on every call: the failure is never kept");
    assert.throws(() => listFeedback(fx.root, { status: "rejected" }));
  } finally {
    watch.restore();
  }
  // The rejected prior entry would suppress this filing; the unreadable neighbour makes the capture file it instead.
  for (const id of ["fb-repair-window-1", "fb-repair-window-2"]) {
    const filed = await capture(fx, id);
    assert.deepEqual([filed.staged, filed.rows], [true, []], `${id} is staged`);
  }
  // Once the file is readable the list is whole again.
  fx.write(entry(3));
  assert.deepEqual(listFeedback(fx.root).map((e) => e.id), [0, 1, 2, 3].map(idOf));
  assert.equal((await capture(fx, "fb-repair-window-3")).staged, false, "and the rejection suppresses again");
});

test("W1-T13334 criterion 4: invariant:one-copy-per-id — an id in both roots with different bytes is refused on every call, and equal bytes give one entry", TIMEOUT, async (t) => {
  // A host whose plan destination names a second checkout: HOME holds the config, the state dir holds the switch.
  const home = ownedFixtureDir(t, "feedback-kept-home").dir;
  const configRoot = join(home, "Remudero");
  mkdirSync(join(configRoot, "state"), { recursive: true });
  mkdirSync(join(configRoot, "repos"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root: configRoot }));
  writeFileSync(planDestinationPath(join(configRoot, "state")), JSON.stringify({ repository: "zz-private-owner/zz-private-plan", kinds: [] }));
  const destination = gitRepo({ scope: t, kind: "feedback-kept-destination" });
  // W1-T14617: the destination is read at its origin/main; these entries are captures neither main nor HEAD tracks.
  destination.git("update-ref", "refs/remotes/origin/main", "HEAD");
  symlinkSync(destination.dir, join(configRoot, "repos", "zz-private-plan"));
  const fx = world(t, [entry(0), entry(1)]);
  const shared = entry(1);
  const second = feedbackEntryPath(destination.dir, shared.id);
  mkdirSync(dirname(second), { recursive: true });
  writeFileSync(second, stringifyYaml(shared));
  writeFileSync(feedbackEntryPath(destination.dir, idOf(2)), stringifyYaml(entry(2)));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await settled(fx.path(idOf(0)), fx.path(shared.id), second);
    // Equal bytes: one entry for the id, on the first call and from the kept parse.
    for (const call of ["first", "repeat"]) assert.deepEqual(listFeedback(fx.root).map((e) => e.id), [0, 1, 2].map(idOf), call);
    // Different bytes: refused on the first call and on each repeat, kept or not.
    writeFileSync(second, stringifyYaml({ ...shared, raw: "other bytes in the destination" }));
    const refusal = new RegExp(`feedback entry "${shared.id}" is in both roots with different bytes`);
    for (const call of ["first", "repeat"]) assert.throws(() => listFeedback(fx.root), refusal, call);
    await settled(second);
    for (const call of ["settled", "settled repeat"]) assert.throws(() => listFeedback(fx.root), refusal, call);
    // The public copy changes too, to other bytes again: still refused.
    fx.write({ ...shared, raw: "other bytes in the public root" });
    assert.throws(() => listFeedback(fx.root), refusal);
    // Equal again: one entry, with the new content.
    writeFileSync(second, readFileSync(fx.path(shared.id)));
    assert.deepEqual(listFeedback(fx.root).map((e) => [e.id, e.raw]), [[idOf(0), "text of entry 0"], [idOf(1), "other bytes in the public root"], [idOf(2), "text of entry 2"]]);
  } finally {
    process.env.HOME = oldHome;
  }
});

test("W1-T13334 criterion 5: invariant:a-caller-cannot-change-the-kept-parse — a change to a returned entry does not reach the next call", TIMEOUT, async (t) => {
  const entries = [entry(0, { attachments: ["a.png"] }), entry(1)];
  const fx = world(t, entries);
  // Once before the files have settled, and once from the kept parse.
  for (const phase of ["read from disk", "kept"]) {
    if (phase === "kept") {
      await settled(...entries.map((e) => fx.path(e.id)));
      listFeedback(fx.root);
    }
    const returned = listFeedback(fx.root);
    if (phase === "kept") assert.deepEqual(reading(() => listFeedback(fx.root)).read, [], "the entries come from the kept parse");
    returned[0]!.status = "rejected";
    returned[0]!.attachments.push("added-by-a-caller.png");
    (returned[1] as unknown as Record<string, unknown>).raw = "changed by a caller";
    returned.pop();
    const next = listFeedback(fx.root);
    assert.deepEqual(next, entries, phase);
    assert.notEqual(next[0], returned[0], "each call returns its own objects");
  }
  assert.ok(existsSync(fx.path(idOf(0))));
});
