/**
 * W1-T13368 — the SRE lane's landed-entry read runs its git off the daemon loop.
 *
 * MEASURED 2026-11-17 (core ledger, daemon.loop_stall_profile): each SRE pass asked origin/main for an incident's
 * feedback entry with a synchronous `git show`, and staged its filing with synchronous git: 32 calls and 4.5 s in
 * the 16 stall rows of 22 minutes. The pass now awaits both. Its answers do not change.
 *
 * The synchronous spawns are observed for real, as in test/the-sre-lane-files-incidents-off-the-daemon-loop.test.ts.
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { mock, test } from "node:test";
import { stringify as stringifyYaml } from "yaml";

import { FeedbackError, feedbackEntryPath, listFeedback, readLandedFeedbackEntry, readLandedFeedbackEntryAsync, type FeedbackEntry } from "#src/lib/feedback.js";
import { queuedFeedbackLandings } from "#src/lib/feedback-landing.js";
import { planDestinationPath } from "#src/lib/plan-destination.js";
import {
  aggregateIncidents,
  daemonSreLaneInput,
  fingerprintAlreadyOpen,
  incidentFeedbackId,
  incidentFeedbackOrigin,
  landedIncidentOpen,
  openIncidentFeedbackOrigins,
  runSreLanePass,
  worstOpenIncident,
  type IncidentLedgerEvent,
  type SreLaneInput,
} from "#src/lib/sre-lane.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const fp = (letter: string): string => letter.repeat(64);
const queuedPath = (fingerprint: string): string => `plan/feedback/${incidentFeedbackId(fingerprint)}.yaml`;
const scratch = (kind: string): string => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w13368-${kind}-`));

function entry(id: string, origin: string, status: FeedbackEntry["status"]): FeedbackEntry {
  return {
    id, ts: "2026-11-17T06:00:00.000Z", raw: `Incident ${id}`, attachments: [], origin: origin as FeedbackEntry["origin"], status,
    reply_to: null, proposal_pr: null, summary: null, expansion: null, submission_key: null, thread_id: null,
  };
}

interface LaggingHost {
  /** A checkout whose HEAD is older than its fetched origin/main. */
  dir: string;
  /** Land `entry` on origin/main through a second clone; the working tree of `dir` never gets it. */
  land: (landed: FeedbackEntry) => void;
}

/** The daemon's 2026-10-15 tree (W1-T9624): real git, a local bare remote, and a HEAD that lags origin/main. */
function laggingHost(): LaggingHost {
  const origin = gitRepo({ bare: true, kind: "w13368-origin" });
  const writer = gitRepo({ cloneFrom: origin.dir, kind: "w13368-writer" });
  writer.git("commit", "--quiet", "--allow-empty", "-m", "chore: seed");
  writer.git("push", "--quiet", "origin", "HEAD:main");
  const lagging = gitRepo({ cloneFrom: origin.dir, kind: "w13368-lagging" });
  return {
    dir: lagging.dir,
    land: (landed) => {
      const rel = `plan/feedback/${landed.id}.yaml`;
      mkdirSync(join(writer.dir, "plan", "feedback"), { recursive: true });
      writeFileSync(join(writer.dir, rel), stringifyYaml(landed));
      writer.git("add", rel);
      writer.git("commit", "--quiet", "-m", `chore(feedback): land ${landed.id}`);
      writer.git("push", "--quiet", "origin", "HEAD:main");
      lagging.git("fetch", "--quiet", "origin");
      assert.equal(existsSync(join(lagging.dir, rel)), false, "fixture: the working tree lacks the landed entry");
    },
  };
}

/** `count` rows of one fingerprint inside one hour, so its burn is `count` an hour. */
function events(fingerprint: string, count: number): IncidentLedgerEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    fingerprint, ts: Date.parse("2026-11-17T12:00:00.000Z") + i * 60_000, kind: "http_5xx", templateId: "service.internal-error", name: "TypeError", message: "boom", instance: "core",
  }));
}

/** A lane input with no detector and no injected landed read: the pass uses its own default read. */
function laneInput(root: string, incidents: IncidentLedgerEvent[], extra: Partial<SreLaneInput> = {}): SreLaneInput {
  const stateRoot = scratch("home");
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  return {
    stateDir: join(stateRoot, "state"), root, landingStateRoot: stateRoot,
    readEvents: () => incidents, hasOpenTask: () => false, framesFor: () => [], mergedPrsSince: () => [],
    mergedLastDay: () => 10, detectors: [], readFlowRows: async () => [], writeFlowEvent: () => {}, log: () => {},
    ...extra,
  };
}

/** Every synchronous child-process spawn `run` makes, as argv (the command first). */
async function syncSpawnsDuring<T>(run: () => Promise<T>): Promise<{ result: T; spawns: string[][] }> {
  const spawns: string[][] = [];
  const real = { execFileSync: childProcess.execFileSync, spawnSync: childProcess.spawnSync, execSync: childProcess.execSync };
  const record = (file: unknown, args: unknown) => { spawns.push([String(file), ...(Array.isArray(args) ? args.map(String) : [])]); };
  mock.method(childProcess, "execFileSync", (file: string, args?: readonly string[], opts?: object) => (record(file, args), real.execFileSync(file, args, opts as never)));
  mock.method(childProcess, "spawnSync", (file: string, args?: readonly string[], opts?: object) => (record(file, args), real.spawnSync(file, args, opts as never)));
  mock.method(childProcess, "execSync", (command: string, opts?: object) => (record(command, []), real.execSync(command, opts as never)));
  syncBuiltinESMExports();
  try {
    return { result: await run(), spawns };
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

/** A `git` first on PATH that holds every `show` of an `origin/main:<path>` for one second, then runs the real git.
 *  `held` exists only while a read is held; `holds()` counts the reads held so far. */
function gitThatHoldsLandedReads(): { bin: string; held: string; holds: () => number } {
  const bin = scratch("bin");
  const realGit = childProcess.execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const held = join(bin, "held");
  const log = join(bin, "holds");
  writeFileSync(log, "");
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    'case "$*" in',
    `  *" show "*"origin/main:"*) echo hold >> '${log}'; : > '${held}'; sleep 1; rm -f '${held}';;`,
    "esac",
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  return { bin, held, holds: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length };
}

test("W1-T13368 criterion 1: invariant:no-synchronous-git-in-a-pass — the daemon's pass runs no synchronous child for the landed read or the staging, and a 20 ms timer fires while each git is held", async () => {
  const host = laggingHost();
  const stateRoot = scratch("home");
  const ledger = writeLedger(
    events(fp("a"), 2).map((e) => ({ task_id: "INCIDENT", step: "incident.event", fingerprint: e.fingerprint, template_id: e.templateId, kind: e.kind, name: e.name, message: e.message, ts: new Date(e.ts).toISOString() })),
    { dir: join(stateRoot, "state") },
  );
  const logged: string[] = [];
  const input = await daemonSreLaneInput({
    stateDir: join(stateRoot, "state"), root: host.dir, ledgerPath: ledger.path, owner: "o", repo: "r",
    mergedLastDay: () => 10, log: (step) => { logged.push(step); },
  });
  assert.equal(input.readLandedEntry, undefined, "the daemon's input injects no landed read: the pass uses its default");

  const slow = gitThatHoldsLandedReads();
  const savedPath = process.env.PATH;
  process.env.PATH = `${slow.bin}${delimiter}${savedPath ?? ""}`;
  // The hold a tick saw, by its number: a tick can run only when the daemon thread is free.
  const holdsATickSaw = new Set<number>();
  const timer = setInterval(() => { if (existsSync(slow.held)) holdsATickSaw.add(slow.holds()); }, 20);
  try {
    const { result, spawns } = await syncSpawnsDuring(() => runSreLanePass(input));
    assert.equal(result.filed, fp("a"), "the open incident is filed");
    assert.deepEqual(logged, ["sre_lane.filed"]);
    assert.deepEqual(queuedFeedbackLandings(stateRoot), [queuedPath(fp("a"))], "the staging ran: the filing waits in the landing queue");
    // Positive control: the pass's landed read and the staging's own landed read both went through the held git.
    assert.equal(slow.holds(), 2, "two `git show origin/main:` reads were each held for one second");
    assert.deepEqual(spawns, [], "the pass made no execFileSync, spawnSync or execSync call");
    assert.deepEqual([...holdsATickSaw].sort(), [1, 2], "a 20 ms timer fired while each of the two reads was held");
  } finally {
    clearInterval(timer);
    process.env.PATH = savedPath;
  }
});

/** The awaited answer, after asserting it equals the synchronous one. */
async function sameAnswer(root: string, id: string): Promise<FeedbackEntry | null> {
  const awaited = await readLandedFeedbackEntryAsync(root, id);
  assert.deepEqual(awaited, readLandedFeedbackEntry(root, id), `the awaited read of ${id} equals the synchronous read`);
  return awaited;
}

test("W1-T13368 criterion 2: the awaited read answers as readLandedFeedbackEntry does for each case, with real git and a bare remote", async () => {
  const host = laggingHost();
  const open = entry(incidentFeedbackId(fp("a")), incidentFeedbackOrigin(fp("a")), "new");
  const closed = entry(incidentFeedbackId(fp("b")), incidentFeedbackOrigin(fp("b")), "rejected");
  const otherOrigin = entry(incidentFeedbackId(fp("c")), "cli", "new");
  for (const landed of [open, closed, otherOrigin]) host.land(landed);

  assert.equal(await sameAnswer(host.dir, incidentFeedbackId(fp("d"))), null, "no entry on origin/main");
  assert.deepEqual(await sameAnswer(host.dir, open.id), open, "an open entry");
  assert.equal((await sameAnswer(host.dir, closed.id))?.status, "rejected", "a closed entry");
  assert.equal((await sameAnswer(host.dir, otherOrigin.id))?.origin, "cli", "an entry with another origin");
  assert.equal(await sameAnswer(scratch("nogit"), open.id), null, "a git failure is absent in both reads");

  // Two roots: the host file names a plan destination, read the way production reads it (HOME points at a fixture config).
  const home = scratch("two-roots");
  const configRoot = join(home, "Remudero");
  mkdirSync(join(configRoot, "state"), { recursive: true });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root: configRoot }));
  writeFileSync(planDestinationPath(join(configRoot, "state")), JSON.stringify({ repository: "zz-private-owner/zz-private-plan", kinds: [] }));
  const destination = laggingHost();
  mkdirSync(join(configRoot, "repos"), { recursive: true });
  childProcess.execFileSync("git", ["clone", "-q", destination.dir, join(configRoot, "repos", "zz-private-plan")], { stdio: "ignore" });
  const destinationCheckout = join(configRoot, "repos", "zz-private-plan");
  const refreshDestination = (): void => {
    childProcess.execFileSync("git", ["-C", destinationCheckout, "fetch", "-q", destination.dir, "+refs/remotes/origin/main:refs/remotes/origin/main"], { stdio: "ignore" });
  };
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    destination.land(open);
    refreshDestination();
    assert.deepEqual(await sameAnswer(host.dir, open.id), open, "the same bytes in the public root and the plan destination");
    destination.land(entry(closed.id, incidentFeedbackOrigin(fp("b")), "accepted"));
    refreshDestination();
    let refusal: unknown;
    try {
      readLandedFeedbackEntry(host.dir, closed.id);
    } catch (error) {
      refusal = error;
    }
    assert.ok(refusal instanceof FeedbackError && /different bytes/.test(refusal.message), `the synchronous read refuses different bytes: ${String(refusal)}`);
    await assert.rejects(readLandedFeedbackEntryAsync(host.dir, closed.id), (error: unknown) => {
      assert.ok(error instanceof FeedbackError, "the awaited read throws the same FeedbackError class");
      assert.equal(error.message, (refusal as Error).message);
      return true;
    });
  } finally {
    process.env.HOME = savedHome;
  }
});

test("W1-T13368 criterion 3: invariant:a-landed-open-incident-is-never-filed-again — an entry open on origin/main is passed over, and a git failure reads as absent", async () => {
  const hot = fp("a");
  const other = fp("b");
  // The landed fingerprint burns hotter, so a pass that missed the landed entry would file it.
  const host = laggingHost();
  host.land(entry(incidentFeedbackId(hot), incidentFeedbackOrigin(hot), "new"));
  const both = laneInput(host.dir, [...events(hot, 4), ...events(other, 1)]);
  assert.equal((await runSreLanePass(both)).filed, other, "the pass files the next worst incident");
  assert.deepEqual(queuedFeedbackLandings(both.landingStateRoot!), [queuedPath(other)], "the landed incident is not staged again");
  assert.equal(existsSync(feedbackEntryPath(host.dir, incidentFeedbackId(hot))), false, "and no copy of it appears in the working tree");

  const alone = laneInput(host.dir, events(hot, 4));
  assert.equal((await runSreLanePass(alone)).filed, undefined, "with no other incident the pass files nothing");
  assert.deepEqual(queuedFeedbackLandings(alone.landingStateRoot!), []);
  assert.equal(listFeedback(host.dir).length, 0);

  // W1-T9624: git that cannot answer reads as absent, never as present, so the incident is filed.
  const noGit = scratch("nogit");
  assert.equal(await readLandedFeedbackEntryAsync(noGit, incidentFeedbackId(hot)), null);
  const failing = laneInput(noGit, events(hot, 4));
  assert.equal((await runSreLanePass(failing)).filed, hot, "a git failure does not hide an incident");
  assert.deepEqual(queuedFeedbackLandings(failing.landingStateRoot!), [queuedPath(hot)]);
});

test("W1-T13368 criterion 4: the pass picks the same worst incident, asks a fingerprint's landed entry once, and asks no more than the synchronous pass", async () => {
  // Ranked by burn: 1 has open feedback in the working tree, 2 is open on origin/main, 3 has a plan task, 4 is free, 5 is free.
  const [f1, f2, f3, f4, f5] = ["1", "2", "3", "4", "5"].map(fp);
  const incidents = [...events(f1, 5), ...events(f2, 4), ...events(f3, 3), ...events(f4, 2), ...events(f5, 1)];
  const landed = entry(incidentFeedbackId(f2), incidentFeedbackOrigin(f2), "new");
  const landedById = (id: string): FeedbackEntry | null => (id === landed.id ? landed : null);
  const hasOpenTask = (fingerprint: string): boolean => fingerprint === f3;
  const fixture = (extra: Partial<SreLaneInput>): SreLaneInput => {
    const root = scratch("five");
    mkdirSync(join(root, "plan", "feedback"), { recursive: true });
    writeFileSync(feedbackEntryPath(root, incidentFeedbackId(f1)), stringifyYaml(entry(incidentFeedbackId(f1), incidentFeedbackOrigin(f1), "new")));
    return laneInput(root, incidents, { hasOpenTask, ...extra });
  };

  // The pass as it was before this task: the synchronous walk over a synchronous landed read.
  const syncReads: string[] = [];
  const before = fixture({});
  const openOrigins = openIncidentFeedbackOrigins(before.root, before.landingStateRoot);
  const worstBefore = worstOpenIncident(aggregateIncidents(incidents), (fingerprint) =>
    fingerprintAlreadyOpen(fingerprint, openOrigins, hasOpenTask) || landedIncidentOpen(fingerprint, (id) => { syncReads.push(id); return landedById(id); }));
  assert.equal(worstBefore?.fingerprint, f4, "fixture: the synchronous walk picks the fourth fingerprint");
  assert.deepEqual(syncReads, [incidentFeedbackId(f2), incidentFeedbackId(f4)], "fixture: it reads two landed entries");

  const reads: string[] = [];
  const awaited = await runSreLanePass(fixture({ readLandedEntry: async (id) => { reads.push(id); return landedById(id); } }));
  assert.equal(awaited.filed, worstBefore?.fingerprint, "the same worst incident");
  assert.equal(new Set(reads).size, reads.length, "a fingerprint's landed entry is read at most once");
  assert.deepEqual(reads, syncReads, "the same reads in the same order: no candidate is read ahead of the ranking");

  // An injected synchronous read (the tests before this task) still works.
  const syncInjected = await runSreLanePass(fixture({ readLandedEntry: landedById }));
  assert.equal(syncInjected.filed, f4);
});
