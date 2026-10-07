// W1-T6025 — A TAKEOVER INSIDE THE GRACE PERIOD LOSES AT task-id-existence, AND THE REFUSAL NAMES
// WHO WINS.
//
// MEASURED 2026-10-06: refs/rmd-id/W1-T5997 = ec2cf986, a reclaimer at 11:36:40.316Z (branch
// file-followups2-1791286555509, host Remudero, source=reclaimed,
// taken_over_from=codex/portable-fixture-plan-1791286800000) whose PARENT 876d5390 was the original
// at 11:36:25.567Z (the codex branch, host Mac-mini, source=automatic): a 14.75s-old reservation
// taken over by a client 687 commits behind main. The gate never read source=reclaimed, said only
// "reserved by X", and its open-PR half refused BOTH colliding PRs with the same "renumber" text,
// so #9556 and #9557 both renumbered and the id was filed by nobody.
//
// Every fixture below pushes that exact two-commit chain to a LOCAL bare origin — never a real
// refs/rmd-id/* — under a synthetic id.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { gitRepo, type GitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { formatReservationAnchorMessage, RESERVATION_PUSH_GRACE_MS } from "../src/lib/task-id-reservation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gate = await import(pathToFileURL(join(__dirname, "..", "scripts", "task-id-existence-check.mjs")).href);

const ID = "W1-T9597";
const REF = `refs/rmd-id/${ID}`;
const CODEX = "codex/portable-fixture-plan-1791286800000";
const RECLAIMER = "file-followups2-1791286555509";
const CODEX_STARTED = "2026-10-06T11:36:25.567Z";
const RECLAIMER_STARTED = "2026-10-06T11:36:40.316Z";
const THREE_HOURS_EARLIER = new Date(Date.parse(CODEX_STARTED) - 3 * 60 * 60 * 1000).toISOString();

function scratch(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}takeover-grace-`));
}

/** The W1-T5997 chain, original -> reclaimer, pushed to a local bare origin as `REF`. The
 *  original's started_at is a parameter so the falsifier's "3h earlier" arm is the same chain. */
function pushTakeoverChain(originalStartedAt = CODEX_STARTED): { origin: GitRepo; work: GitRepo; base: string } {
  const origin = gitRepo({ bare: true, kind: "takeover-origin" });
  const work = gitRepo({ cloneFrom: origin.dir, kind: "takeover-work" });
  mkdirSync(join(work.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(work.dir, "plan", "tasks.yaml"), "# base declares nothing\n");
  work.git("add", "plan/tasks.yaml");
  work.git("commit", "--quiet", "-m", "base");
  work.git("push", "--quiet", "origin", "HEAD:main");
  const base = work.git("rev-parse", "HEAD");
  const tree = work.git("hash-object", "-t", "tree", "/dev/null");
  const original = work.git(
    "commit-tree",
    tree,
    "-m",
    formatReservationAnchorMessage({ branch: CODEX, pid: 51234, host: "Mac-mini", startedAt: originalStartedAt, source: "automatic" }),
  );
  const reclaimer = work.git(
    "commit-tree",
    tree,
    "-p",
    original,
    "-m",
    formatReservationAnchorMessage({
      branch: RECLAIMER,
      pid: 70707,
      host: "Remudero",
      startedAt: RECLAIMER_STARTED,
      source: "reclaimed",
      takenOverFrom: CODEX,
    }),
  );
  work.git("push", "--quiet", "origin", `${reclaimer}:${REF}`);
  return { origin, work, base };
}

/** A shard declaring `ID`. The reclaimer's copy carries the hand-off line its own stale minter
 *  PRINTED — the takeover's output, not an operator's — which must not buy it the id. */
function writeShard(dir: string, note?: string): string {
  const rel = `plan/tasks.d/${ID}-takeover.yaml`;
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, rel), [`- id: ${ID}`, '  title: "contested"', ...(note ? ["  note: |", `    ${note}`] : []), ""].join("\n"));
  return rel;
}

function holderRead(origin: GitRepo, work: GitRepo) {
  return gate.resolveReservedIds(origin.dir, work.dir, { readHoldersFor: new Set([ID]) });
}

function conflictsFor(filer: string, origin: GitRepo, work: GitRepo, note?: string) {
  const rel = writeShard(work.dir, note);
  return gate.evaluateReservationHolderConflicts([ID], new Map([[ID, [{ file: rel, line: 1 }]]]), holderRead(origin, work), filer, work.dir);
}

test("W1-T6025: the gate's grace period is the reservation allocator's, to the millisecond", () => {
  assert.equal(gate.RESERVATION_PUSH_GRACE_MS, RESERVATION_PUSH_GRACE_MS);
});

test("W1-T6025: the W1-T5997 chain reads the ORIGINAL holder as rightful when the takeover is younger than the grace", () => {
  const { origin, work } = pushTakeoverChain();
  const read = holderRead(origin, work);
  assert.deepEqual(read.holders.get(ID), { status: "known", branch: CODEX });
  const record = read.records.get(ID);
  assert.equal(record.takeover.winner, "original");
  assert.equal(record.takeover.ageMs, 14_749);
  assert.equal(record.fields.host, "Mac-mini");
  assert.equal(record.takeover.reclaimer.branch, RECLAIMER);
});

test("W1-T6025: the original holder's filing passes the holder check with no hand-off note", () => {
  const { origin, work } = pushTakeoverChain();
  assert.deepEqual(conflictsFor(CODEX, origin, work), []);
});

test("W1-T6025: the reclaimer's filing is refused even with its own printed hand-off line, naming the original branch, host and started_at", () => {
  const { origin, work } = pushTakeoverChain();
  const conflicts = conflictsFor(RECLAIMER, origin, work, gate.reservationHandoffNoteLine(CODEX, RECLAIMER));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].holderBranch, CODEX);
  const line = gate.formatHolderConflictLine(conflicts[0]);
  assert.match(line, /LOST THE RACE/);
  assert.ok(line.includes(CODEX), line);
  assert.match(line, /host=Mac-mini/);
  assert.match(line, /pid=51234/);
  assert.ok(line.includes(`started_at=${CODEX_STARTED}`), line);
  assert.match(line, /source=automatic/);
  assert.match(line, /14\.7s/);
});

test("W1-T6025: a takeover OLDER than the grace is the reclaimer's — the original is then the one refused, naming the reclaimer", () => {
  const { origin, work } = pushTakeoverChain(THREE_HOURS_EARLIER);
  assert.equal(holderRead(origin, work).records.get(ID).takeover.winner, "reclaimer");
  assert.deepEqual(conflictsFor(RECLAIMER, origin, work), []);
  const refused = conflictsFor(CODEX, origin, work);
  assert.equal(refused.length, 1);
  const line = gate.formatHolderConflictLine(refused[0]);
  assert.match(line, new RegExp(`reserved by ${RECLAIMER}, while this filing is ${CODEX}`));
  assert.match(line, /host=Remudero pid=70707 started_at=2026-10-06T11:36:40\.316Z source=reclaimed/);
});

test("W1-T6025: every holder refusal names host, pid, started_at and source — unrecorded fields say so", () => {
  const plain = gate.formatHolderConflictLine({
    id: ID,
    reason: "holder differs",
    holderBranch: "run-a",
    filerBranch: "run-b",
    holder: { branch: "run-a", host: "h1", pid: "7", startedAt: "2026-10-06T00:00:00.000Z", source: "automatic" },
  });
  assert.equal(plain, "reserved by run-a, while this filing is run-b -- holder host=h1 pid=7 started_at=2026-10-06T00:00:00.000Z source=automatic");
  const unreadable = gate.formatHolderConflictLine({ id: ID, reason: "could not fetch x", filerBranch: "run-b" });
  assert.equal(
    unreadable,
    "holder unreadable (could not fetch x) -- holder host=<unrecorded> pid=<unrecorded> started_at=<unrecorded> source=<unrecorded>",
  );
});

test("W1-T6025: a chain that cannot be adjudicated keeps the reclaimer as holder, exactly as before", () => {
  const reclaimed = `rmd-id holder branch=${RECLAIMER} host=Remudero started_at=${RECLAIMER_STARTED} source=reclaimed taken_over_from=${encodeURIComponent(CODEX)}`;
  const head = { holder: gate.parseReservationHolderLine(reclaimed), fields: gate.parseReservationHolderFields(reclaimed) };
  const parentOf = (line: string) => ({ holder: gate.parseReservationHolderLine(line), fields: gate.parseReservationHolderFields(line) });
  const kept = { holder: { status: "known", branch: RECLAIMER }, fields: head.fields };
  // No parent read at all (an unreadable FETCH_HEAD^).
  assert.deepEqual(gate.adjudicateReservationHolder(head), kept);
  // A parent with no holder line, an unattributable one (`main`, `unknown`) — a takeover of those is a repair.
  for (const line of ["reserve W1-T9597 host-pid-time", "rmd-id holder branch=main", "rmd-id holder branch=unknown"]) {
    assert.deepEqual(gate.adjudicateReservationHolder({ ...head, parent: parentOf(line) }), kept, line);
  }
  // A parent that is not the branch the reclaimer says it took over from.
  assert.deepEqual(
    gate.adjudicateReservationHolder({ ...head, parent: parentOf(`rmd-id holder branch=someone-else started_at=${CODEX_STARTED}`) }),
    kept,
  );
  // An original whose started_at does not parse.
  assert.deepEqual(
    gate.adjudicateReservationHolder({ ...head, parent: parentOf(`rmd-id holder branch=${encodeURIComponent(CODEX)} started_at=not-a-time`) }),
    kept,
  );
  // A head that is not a reclaim is never re-read.
  const plain = "rmd-id holder branch=run-x source=automatic";
  assert.deepEqual(gate.adjudicateReservationHolder({ holder: gate.parseReservationHolderLine(plain), fields: gate.parseReservationHolderFields(plain) }), {
    holder: { status: "known", branch: "run-x" },
    fields: gate.parseReservationHolderFields(plain),
  });
  assert.equal(gate.parseReservationHolderFields("no holder line"), undefined);
  assert.equal(gate.parseReservationHolderFields("rmd-id holder branch=%zz"), undefined);
});

test("W1-T6025: a head-only readable chain keeps the reclaimer without inventing a parent", () => {
  const calls: string[][] = [];
  const reclaimed = `rmd-id holder branch=${RECLAIMER} source=reclaimed taken_over_from=x`;
  const record = gate.readReservationHolderRecord("origin", scratch(), REF, (args: string[]) => {
    calls.push(args);
    if (args[0] === "fetch") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "log" && args.at(-1) === "FETCH_HEAD") return { status: 0, stdout: `${reclaimed}\0`, stderr: "" };
    return { status: 128, stdout: "", stderr: "unexpected command" };
  });
  assert.deepEqual(calls.map((a) => a.at(-1)), [REF, "FETCH_HEAD"]);
  assert.equal(record.chain.length, 1);
  assert.deepEqual(gate.adjudicateReservationHolder(record).holder, { status: "known", branch: RECLAIMER });
  assert.deepEqual(record.holder, { status: "known", branch: RECLAIMER });
});

test("W1-T6025: the open-PR collision refuses only the non-holder and names the winner's PR and branch", () => {
  const rows = [
    { number: 9556, html_url: "https://example.test/pull/9556", title: `file ${ID}`, body: "", head: { ref: CODEX } },
    { number: 9557, html_url: "https://example.test/pull/9557", title: `file ${ID}`, body: "", head: { ref: RECLAIMER } },
  ];
  const rightful = () => CODEX;
  const asReclaimer = gate.evaluateOpenPrIdCollisions([ID], rows, RECLAIMER, undefined, rightful);
  assert.deepEqual(asReclaimer[0].winner, { number: 9556, url: "https://example.test/pull/9556", branch: CODEX });
  const asCodex = gate.evaluateOpenPrIdCollisions([ID], rows, CODEX, undefined, rightful);
  assert.deepEqual(asCodex[0].winner, { self: true, branch: CODEX });
  // No readable holder: today's symmetric refusal, byte-for-byte the old shape.
  const blind = gate.evaluateOpenPrIdCollisions([ID], rows, RECLAIMER, undefined, () => undefined);
  assert.deepEqual(blind, [{ id: ID, prs: [{ number: 9556, url: "https://example.test/pull/9556" }] }]);
  // A holder that is neither PR: symmetric too.
  assert.equal(gate.evaluateOpenPrIdCollisions([ID], rows, RECLAIMER, undefined, () => "run-elsewhere")[0].winner, undefined);
});

function runGateMain(argv: string[]): { out: string; err: string; exitCode: string | number | undefined } {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void err.push(args.join(" "));
  try {
    gate.main(argv);
    return { out: out.join("\n"), err: err.join("\n"), exitCode: process.exitCode };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = previousExitCode;
  }
}

test("W1-T6025: main passes the original holder's PR and refuses the reclaimer's, naming the winner on both halves", (t) => {
  const { origin, work, base } = pushTakeoverChain();
  const prRow = (n: number, ref: string) => ({ number: n, html_url: `https://example.test/pull/${n}`, title: `file ${ID}`, body: "", head: { ref } });
  const declares = JSON.stringify([{ filename: `plan/tasks.d/${ID}-takeover.yaml`, patch: `+- id: ${ID}` }]);
  const shim = ghShim(
    [
      { when: "pulls/9556/files", stdout: declares },
      { when: "pulls/9557/files", stdout: declares },
      { when: "pulls?state=open", stdout: JSON.stringify([prRow(9556, CODEX), prRow(9557, RECLAIMER)]) },
    ],
    { kind: "takeover-main" },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const baseline = join(scratch(), "baseline.json");
  writeFileSync(baseline, "[]\n");
  const argv = (headRef: string) => [
    "--cwd", work.dir, "--remote", origin.dir, "--base", base, "--baseline", baseline,
    "--head-ref", headRef, "--owner", "owner", "--repo", "repo", "--require-open-prs",
  ];

  writeShard(work.dir, gate.reservationHandoffNoteLine(CODEX, RECLAIMER));
  const loser = runGateMain(argv(RECLAIMER));
  assert.equal(loser.exitCode, 1, loser.err);
  assert.match(loser.err, /LOST THE RACE/);
  assert.ok(loser.err.includes(`host=Mac-mini pid=51234 started_at=${CODEX_STARTED} source=automatic`), loser.err);
  assert.match(loser.err, /rightful holder is https:\/\/example\.test\/pull\/9556 \(branch codex\/portable-fixture-plan-1791286800000\)/);

  writeShard(work.dir);
  const winner = runGateMain(argv(CODEX));
  assert.equal(winner.exitCode, 0, winner.err);
  assert.doesNotMatch(winner.err, /FAILED/);
  assert.match(winner.out, /is the reservation's rightful holder/);
  assert.ok(winner.out.includes("https://example.test/pull/9557"), winner.out);
});
