import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { acquireDrainLock } from "../src/lib/drain-lock.js";
import {
  claimTriage,
  claimTriageWithLogging,
  decideTriageClaim,
  decideTriageClaimRelease,
  feedbackOutcomeObserved,
  gitTriageClaimReserver,
  releaseTriageClaim,
  releaseTriageClaimWithLogging,
  triageClaimRef,
  triageLockPath,
  type TriageClaimOutcome,
  type TriageClaimReserver,
} from "../src/lib/auto-triage.js";
import { mergedTriageSubjects, triageClaimReserverFor, triageCommand } from "../src/run-task.js";
import type { WorkerResult } from "../src/lib/worker.js";

// ── WHAT THIS FILE PROVES (W1-T1132) ─────────────────────────────────────────────────────────
// The duplicate-triage guard W1-T300 shipped and W1-T1019 wired IS cross-host: it reads an OPEN
// triage PR on GitHub, which every host shares. It still could not stop the 2026-08-22 collisions
// (#2452/#2462, mirror-image verdicts neither of which could merge) because a triage PR does not
// exist until the triage FINISHES, and the grind is MINUTES long with an Architect call in the
// middle. Two lanes starting inside that window both read "no open PR" and both spend.
//
// So the claim proved here is taken BEFORE the Architect call, on a ref every host can see. Every
// DECISION is pure and asserted without a git remote; the one I/O seam is asserted against a real
// local bare repo, because a suite where every test injects a fake never executes the seam at all.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}
function tmp(p: string): string {
  return mkdtempSync(join(tmpdir(), p));
}

/** An in-memory stand-in for `origin`'s ref store: create-if-absent, exactly what a ref update on
 *  a remote gives, so two "hosts" can be driven against ONE shared remote inside one process. */
function fakeRemote(): { refs: Map<string, string>; calls: string[]; reserverFor: (anchor: string) => TriageClaimReserver } {
  const refs = new Map<string, string>();
  const calls: string[] = [];
  return {
    refs,
    calls,
    reserverFor: (anchor: string): TriageClaimReserver => ({
      mintAnchor: () => {
        calls.push("mintAnchor");
        return anchor;
      },
      attempt: (feedbackId, a) => {
        calls.push(`attempt:${feedbackId}`);
        const ref = triageClaimRef(feedbackId);
        if (refs.has(ref)) return "taken";
        refs.set(ref, a);
        return "created";
      },
      holder: (feedbackId) => {
        calls.push(`holder:${feedbackId}`);
        return refs.get(triageClaimRef(feedbackId));
      },
      drop: (feedbackId, opts = {}) => {
        calls.push(`drop:${feedbackId}:${opts.expect ?? "-"}`);
        const ref = triageClaimRef(feedbackId);
        if (opts.expect !== undefined && refs.get(ref) !== opts.expect) return false;
        return refs.delete(ref);
      },
    }),
  };
}

/** A reserver whose every attempt reports the remote unreadable — the fail-closed arm. */
function unreachableReserver(): TriageClaimReserver {
  return {
    mintAnchor: () => "anchor-unreachable",
    attempt: () => "unreachable" as TriageClaimOutcome,
    holder: () => undefined,
    drop: () => false,
  };
}

// ── THE PURE DECISIONS — no git, no clock, no remote ──────────────────────────────────────────

test("W1-T1132 PURE: a won claim proceeds; a lost one refuses and NAMES the claim it lost to", () => {
  const won = decideTriageClaim("created", { feedbackId: "fb-1" });
  assert.equal(won.proceed, true);

  const lost = decideTriageClaim("taken", { feedbackId: "fb-1", holder: "deadbeef" });
  assert.equal(lost.proceed, false);
  // NAMED, not anonymous: an operator must be able to `git ls-remote` the ref and `git show` the
  // anchor. "Someone else is doing it" is unactionable, which is the whole point of this arm.
  assert.match(lost.reason, /refs\/rmd-triage\/fb-1/);
  assert.match(lost.reason, /deadbeef/);

  // And an anonymous holder still refuses — a failed holder READ must never become a proceed.
  const lostAnon = decideTriageClaim("taken", { feedbackId: "fb-1" });
  assert.equal(lostAnon.proceed, false);
  assert.doesNotMatch(lostAnon.reason, /held by/);
});

test("W1-T1132 PURE: an unreachable origin REFUSES rather than triaging optimistically", () => {
  const d = decideTriageClaim("unreachable", { feedbackId: "fb-2" });
  assert.equal(d.proceed, false, "a failed READ of the world is never read as 'free'");
  assert.match(d.reason, /cannot reach origin/);
});

test("W1-T1132 PURE: the evidence predicate matches a merged subject naming the entry, and nothing else", () => {
  const subjects = [
    "chore(triage): feedback#fb-1785897208072-a690af — already decided, no task (#2480)",
    "fix(sweep): classify a base-branch race retryable (#2455)",
  ];
  assert.equal(feedbackOutcomeObserved(subjects, "fb-1785897208072-a690af"), true);
  assert.equal(feedbackOutcomeObserved(subjects, "fb-does-not-appear"), false);
  assert.equal(feedbackOutcomeObserved([], "fb-1785897208072-a690af"), false, "an empty read is NOT evidence");
  // A feedback id carries `-` freely and this must be a SUBSTRING test, never a regex built from
  // caller-supplied text — a pattern would make the first id containing a metacharacter a bug.
  assert.equal(feedbackOutcomeObserved(["x fb-a.c y"], "fb-a?c"), false);
});

test("W1-T1132 PURE: release has exactly three arms, and the third refuses rather than guessing", () => {
  const holder = decideTriageClaimRelease({ heldByThisRun: true, outcomeObserved: false, feedbackId: "fb-3" });
  assert.deepEqual({ arm: holder.arm, release: holder.release }, { arm: "holder", release: true });

  const evidence = decideTriageClaimRelease({ heldByThisRun: false, outcomeObserved: true, feedbackId: "fb-3" });
  assert.deepEqual({ arm: evidence.arm, release: evidence.release }, { arm: "evidence", release: true });

  const operator = decideTriageClaimRelease({ heldByThisRun: false, outcomeObserved: false, feedbackId: "fb-3" });
  assert.deepEqual({ arm: operator.arm, release: operator.release }, { arm: "operator", release: false });
  // Cross-host liveness is not decidable, so the honest answer is a person WITH THE COMMAND —
  // a refusal that does not say how to clear the thing it refused is a dead end.
  assert.match(operator.reason, /git push origin :refs\/rmd-triage\/fb-3/);

  // PRECEDENCE: holding beats evidence, so a lane's own completion never takes the wider arm.
  assert.equal(decideTriageClaimRelease({ heldByThisRun: true, outcomeObserved: true, feedbackId: "fb-3" }).arm, "holder");
});

test("W1-T1132 NO TIMER: the release decision reads no clock — W1-T1067's stranded lock is the precedent", () => {
  // A BEHAVIOURAL pin first: the verdict is a pure function of its two booleans, so no elapsed
  // time can change it. Asserted across a real delay-free repeat rather than asserted about time.
  const a = decideTriageClaimRelease({ heldByThisRun: false, outcomeObserved: false, feedbackId: "fb-4" });
  const b = decideTriageClaimRelease({ heldByThisRun: false, outcomeObserved: false, feedbackId: "fb-4" });
  assert.deepEqual(a, b);

  // And a SOURCE pin, because the behavioural one cannot catch an expiry added tomorrow: the
  // decision's own body must reference no clock at all. A triage is MINUTES long, so any expiry
  // short enough to clear a stuck claim promptly is short enough to fire on healthy work — this
  // repo's own recurring "a bound that fires on a HEALTHY condition" defect.
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "auto-triage.ts"), "utf8");
  const start = src.indexOf("export function decideTriageClaimRelease");
  assert.ok(start > 0, "the decision function is present under that exact name");
  const body = src.slice(start, src.indexOf("\n}", start));
  for (const clock of ["Date.now", "new Date", "setTimeout", "expiresAt", "ttl", "TTL", "elapsed"]) {
    assert.ok(!body.includes(clock), `the release decision must not consult ${clock}`);
  }
});

// ── THE ORCHESTRATION — one shared fake remote, two "hosts" ───────────────────────────────────

test("W1-T1132 CONTENTION: a second host triaging a claimed entry REFUSES, and the winner is untouched", () => {
  const remote = fakeRemote();
  const first = claimTriage("fb-race", remote.reserverFor("anchor-A"));
  assert.equal(first.proceed, true, "the first lane wins");
  assert.equal(first.anchor, "anchor-A");

  const second = claimTriage("fb-race", remote.reserverFor("anchor-B"));
  assert.equal(second.proceed, false, "the second lane refuses — before any Architect call");
  assert.equal(second.anchor, undefined, "and holds nothing it could later release");
  assert.match(second.reason, /anchor-A/, "the refusal names the claim it lost to");

  // The loser must never steal the winner's claim — the same invariant the per-host lock keeps.
  assert.equal(remote.refs.get(triageClaimRef("fb-race")), "anchor-A");
});

test("W1-T1132 RELEASE ARM 1 (HOLDER): a completed triage drops its claim immediately, waiting for nothing", () => {
  const remote = fakeRemote();
  const reserver = remote.reserverFor("anchor-A");
  const claim = claimTriage("fb-done", reserver);
  remote.calls.length = 0;

  const released = releaseTriageClaim("fb-done", reserver, { anchor: claim.anchor });
  assert.equal(released.arm, "holder");
  assert.equal(released.dropped, true);
  assert.equal(remote.refs.has(triageClaimRef("fb-done")), false, "the ref is gone");
  // WAITING FOR NOTHING, measured rather than asserted in prose: exactly one remote operation,
  // and it is the drop. A release that polled, retried or slept would show extra calls here.
  assert.deepEqual(remote.calls, ["drop:fb-done:anchor-A"]);
});

test("W1-T1132 RELEASE ARM 1 IS CONDITIONAL: a stale anchor cannot delete a claim that is now someone else's", () => {
  const remote = fakeRemote();
  claimTriage("fb-moved", remote.reserverFor("anchor-NEW"));
  // A lane whose claim was already dropped and retaken elsewhere tries to release its OWN anchor.
  const released = releaseTriageClaim("fb-moved", remote.reserverFor("x"), { anchor: "anchor-OLD" });
  assert.equal(released.dropped, false, "the conditional delete refuses");
  assert.equal(remote.refs.get(triageClaimRef("fb-moved")), "anchor-NEW", "and the live claim survives");
});

test("W1-T1132 RELEASE ARM 2 (EVIDENCE): a claim whose entry already has a merged outcome is releasable by ANY host", () => {
  const remote = fakeRemote();
  claimTriage("fb-stale", remote.reserverFor("anchor-DEAD")); // a lane that died holding it

  // A DIFFERENT host, holding no anchor, meets the claim and carries fresh evidence the entry
  // is already triaged. That is the read-the-evidence-that-already-exists shape (W1-T1110).
  const second = claimTriage("fb-stale", remote.reserverFor("anchor-B"), {
    mergedSubjects: () => ["chore(triage): feedback#fb-stale — already decided, no task (#9999)"],
  });
  assert.equal(second.staleReleased, true, "the stale claim was dropped by a host that never held it");
  assert.equal(remote.refs.has(triageClaimRef("fb-stale")), false);
  // AND IT STILL REFUSES. An entry with a merged outcome does not want re-triaging — dropping the
  // ref unblocks the NEXT lane; it does not license this one to spend.
  assert.equal(second.proceed, false);
  assert.match(second.reason, /already has a merged triage outcome/);
});

test("W1-T1132 RELEASE ARM 3 (OPERATOR): contention with no merged outcome leaves the claim alone", () => {
  const remote = fakeRemote();
  claimTriage("fb-live", remote.reserverFor("anchor-A"));
  const second = claimTriage("fb-live", remote.reserverFor("anchor-B"), { mergedSubjects: () => ["fix(sweep): unrelated (#1)"] });
  assert.equal(second.proceed, false);
  assert.equal(second.staleReleased, false, "a live claim is NOT dropped on a guess");
  assert.equal(remote.refs.get(triageClaimRef("fb-live")), "anchor-A");
  assert.match(second.reason, /git push origin :refs\/rmd-triage\/fb-live/, "the refusal hands the operator the command");
});

test("W1-T1132 FAIL-CLOSED: an unreachable origin refuses and takes no claim", () => {
  const r = claimTriage("fb-net", unreachableReserver());
  assert.equal(r.proceed, false);
  assert.equal(r.anchor, undefined);
  assert.equal(r.staleReleased, undefined, "the evidence arm is not consulted on an unreadable remote");
});

test("W1-T1132 LEDGER: the claim and its release each write ONE row carrying the ref and the arm", () => {
  const remote = fakeRemote();
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => rows.push({ step, extra });

  const claim = claimTriageWithLogging(log, "fb-log", remote.reserverFor("anchor-A"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, "triage.claim");
  assert.equal(rows[0].extra.ref, "refs/rmd-triage/fb-log");
  assert.equal(rows[0].extra.proceed, true);
  assert.equal(rows[0].extra.stale_released, false, "PRESENT and false — a missing key and an empty one read alike to a later zgrep");

  releaseTriageClaimWithLogging(log, "fb-log", remote.reserverFor("x"), claim.anchor!);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].step, "triage.claim_released");
  assert.equal(rows[1].extra.arm, "holder");
  assert.equal(rows[1].extra.dropped, true);
});

test("W1-T1132 BEST-EFFORT RELEASE: a throwing remote costs a ledgered row, never the lane's own outcome", () => {
  const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const throwing: TriageClaimReserver = {
    mintAnchor: () => "a",
    attempt: () => "created",
    holder: () => undefined,
    drop: () => {
      throw new Error("origin went away mid-release");
    },
  };
  // This runs in a `finally`. A throw here would REPLACE whatever the lane actually reached —
  // including a legitimate error — with a release failure.
  const r = releaseTriageClaimWithLogging((s, e = {}) => rows.push({ step: s, extra: e }), "fb-throw", throwing, "a");
  assert.equal(r.dropped, false);
  assert.match(r.reason, /origin went away mid-release/);
  assert.equal(rows[0].step, "triage.claim_released");
});

// ── THE I/O SEAM — driven against a REAL bare repo, never a fake ──────────────────────────────

test("W1-T1132 REAL GIT: the reserver creates, contends, reads its holder and drops conditionally", () => {
  const bare = tmp("rmd-claim-bare-");
  const work = tmp("rmd-claim-work-");
  try {
    execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
    execFileSync("git", ["init", "--quiet", "-b", "main", work], { encoding: "utf8", env: GIT_ENV });
    writeFileSync(join(work, "seed.txt"), "seed\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "chore(triage): feedback#fb-real-done — already decided, no task");
    git(work, "remote", "add", "origin", bare);
    git(work, "push", "--quiet", "origin", "main");

    // The PRODUCTION constructor, not a hand-rolled one — this is the line `diff-coverage` would
    // otherwise flag, because every test above supplies its own reserver.
    const reserver = triageClaimReserverFor(work);
    const anchor = reserver.mintAnchor();
    assert.match(anchor, /^[0-9a-f]{40}$/, "the default anchor is a real orphan commit over the empty tree");
    assert.notEqual(anchor, reserver.mintAnchor(), "and two anchors differ, or the create-if-absent stops discriminating");

    assert.equal(reserver.attempt("fb-real", anchor), "created");
    assert.equal(reserver.attempt("fb-real", reserver.mintAnchor()), "taken", "a second writer meets contention, not an error");
    assert.equal(reserver.holder("fb-real"), anchor, "the holder read returns the anchor now on the ref");

    assert.equal(reserver.drop("fb-real", { expect: "0".repeat(40) }), false, "a wrong lease does not delete");
    assert.equal(reserver.holder("fb-real"), anchor, "and the claim survives it");
    assert.equal(reserver.drop("fb-real", { expect: anchor }), true, "the right lease deletes");
    assert.equal(reserver.holder("fb-real"), undefined, "and the ref is gone");

    // The evidence arm's real input, read from the real log.
    assert.equal(feedbackOutcomeObserved(mergedTriageSubjects(work), "fb-real-done"), true);
    assert.equal(feedbackOutcomeObserved(mergedTriageSubjects(work), "fb-never-triaged"), false);
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("W1-T1132 REAL GIT: an unreachable origin classifies as unreachable, and unreadable inputs fail closed", () => {
  const work = tmp("rmd-claim-noremote-");
  try {
    execFileSync("git", ["init", "--quiet", "-b", "main", work], { encoding: "utf8", env: GIT_ENV });
    git(work, "remote", "add", "origin", join(work, "does-not-exist.git"));
    const reserver = triageClaimReserverFor(work);
    // A push to a remote that is not there is NOT contention. Conflating the two is exactly what
    // `classifyPushFailure` exists to prevent, and it is why this shares that function rather
    // than re-deriving it.
    assert.equal(reserver.attempt("fb-nowhere", "0".repeat(40)), "unreachable");
    assert.equal(reserver.holder("fb-nowhere"), undefined, "an unreadable ls-remote reads as absent, never as a holder");
    assert.equal(reserver.drop("fb-nowhere"), false);
    // No `origin/main` exists here, so the subject read fails — and an EMPTY result classifies as
    // "no observable outcome", which leaves a claim in place for a person rather than dropping
    // someone else's live claim on a read that did not happen.
    assert.deepEqual(mergedTriageSubjects(work), []);

    // The default anchor path with a git that works but no remote — proves `mintAnchor` does not
    // depend on the remote being reachable.
    assert.match(reserver.mintAnchor(), /^[0-9a-f]{40}$/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ── END TO END THROUGH `triageCommand` — offline, with a fixture origin ───────────────────────

/** A bare origin carrying a minimal plan plus ONE `status: new` feedback entry — the same fixture
 *  shape `test/triage-plan-deps-seam.test.ts` uses to drive this command offline. */
function makeOrigin(feedbackId: string): string {
  const bare = tmp("claim-origin-");
  const seed = tmp("claim-seed-");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  mkdirSync(join(seed, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed, "plan", "tasks.yaml"), ["- id: W1-T1", "  title: seed", "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  status: queued", ""].join("\n"));
  writeFileSync(
    join(seed, "plan", "feedback", `${feedbackId}.yaml`),
    [`id: ${feedbackId}`, "ts: '2026-07-30T00:00:00.000Z'", "raw: fixture entry for the claim proof", "attachments: []", "origin: cli", "status: new", "proposal_pr: null", ""].join("\n"),
  );
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed plan");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

async function withOfflineHarness(
  feedbackId: string,
  body: (ctx: { configRoot: string; bare: string }) => Promise<void>,
): Promise<Array<Record<string, unknown>>> {
  const bare = makeOrigin(feedbackId);
  const home = tmp("claim-home-");
  const configRoot = tmp("claim-root-");
  const shimDir = tmp("claim-ghshim-");
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/usr/bin/true", root: configRoot }, null, 2));
    process.env.HOME = home;
    const originUrl = execFileSync("git", ["-C", REPO_ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const repoName = originUrl.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/)![2];
    const repoDir = join(configRoot, "repos", repoName);
    mkdirSync(dirname(repoDir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare, repoDir], { encoding: "utf8", env: GIT_ENV });
    // A REPO-LOCAL identity: `actions/checkout` sets NEITHER repo nor global, so a fixture that
    // relies on ambient config passes on every dev machine and fails on every CI runner.
    git(repoDir, "config", "user.name", "remudero-test");
    git(repoDir, "config", "user.email", "test@remudero.invalid");
    writeFileSync(join(shimDir, "gh"), ["#!/bin/sh", 'case "$*" in', '  *"pr list"*) echo "[]" ;;', "  *) exit 1 ;;", "esac", ""].join("\n"), { mode: 0o755 });
    process.env.PATH = `${shimDir}:${savedPath}`;
    await body({ configRoot, bare });
    const ledgerFile = join(configRoot, "state", "ledger.ndjson");
    if (!existsSync(ledgerFile)) return [];
    return readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } finally {
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const d of [bare, home, configRoot, shimDir]) rmSync(d, { recursive: true, force: true });
  }
}

test("W1-T1132 END TO END: a claimed entry makes the SECOND lane refuse WITHOUT spawning the Architect", async () => {
  const feedbackId = `fb-claimed-${Date.now()}`;
  let spawnCalls = 0;
  const ledger = await withOfflineHarness(feedbackId, async ({ bare }) => {
    // A FIRST HOST has already claimed this entry — planted directly on the shared origin, which
    // is exactly what a lane on another machine leaves behind mid-grind.
    const planter = tmp("claim-planter-");
    try {
      execFileSync("git", ["clone", "--quiet", bare, planter], { encoding: "utf8", env: GIT_ENV });
      // A REPO-LOCAL identity, same as `repoDir` below: `triageClaimReserverFor`'s `mintAnchor`
      // runs `git commit-tree` through bare `spawnSync` (no `env` override), which inherits the
      // fixture's empty `HOME` and finds no identity anywhere. Without this, `commit-tree` fails
      // and its `deps.run` — which reads `stdout` without checking `status` — silently returns an
      // EMPTY anchor, turning `attempt`'s push into `:refs/rmd-triage/<id>` (a delete-if-present,
      // not a create) that no-ops on a ref that does not exist yet and still exits 0. The planted
      // "first host" claim then never actually lands on `bare`, so the second lane's own push
      // hits no contention and this test cannot prove what its name says.
      git(planter, "config", "user.name", "remudero-test-other");
      git(planter, "config", "user.email", "other@remudero.invalid");
      const other = triageClaimReserverFor(planter);
      const otherAnchor = other.mintAnchor();
      assert.notEqual(otherAnchor, "", "mintAnchor must produce a real commit, not a silently-failed empty one");
      assert.equal(other.attempt(feedbackId, otherAnchor), "created", "the first host holds the claim");
    } finally {
      rmSync(planter, { recursive: true, force: true });
    }

    const code = await triageCommand([feedbackId], {
      spawn: async () => {
        spawnCalls += 1;
        return {} as WorkerResult;
      },
    });
    assert.equal(code, 2, "the second lane exits refused");
  });

  // THE PROOF, and the reason this is an end-to-end test rather than a unit one: the refusal
  // happens BEFORE the paid call. The loser's RESEARCH is the actual cost this task removes.
  assert.equal(spawnCalls, 0, "no Architect call was spent by the losing lane");
  const claim = ledger.filter((l) => l.step === "triage.claim");
  assert.equal(claim.length, 1, "the refusal is ledgered rather than silent");
  assert.equal(claim[0].proceed, false);
  assert.match(String(claim[0].reason ?? ""), /already being triaged by another lane/);
  assert.equal(ledger.filter((l) => l.step === "triage.synthesized").length, 0, "and nothing past the spawn ran");
});

test("W1-T1132 END TO END: an unclaimed entry takes the claim, and the run RELEASES it on the way out", async () => {
  const feedbackId = `fb-free-${Date.now()}`;
  let observed: string | undefined;
  const ledger = await withOfflineHarness(feedbackId, async ({ bare }) => {
    await triageCommand([feedbackId], {
      spawn: async () => {
        // Read the live ref WHILE the lane holds it — proving the claim exists during the window
        // an open-PR read is structurally blind to, which is the entire finding.
        observed = execFileSync("git", ["ls-remote", bare, triageClaimRef(feedbackId)], { encoding: "utf8", env: GIT_ENV }).trim();
        return {} as WorkerResult;
      },
    }).catch(() => undefined);

    // AND IT IS GONE AFTERWARDS — arm 1, in a `finally`, with no timer involved.
    const after = execFileSync("git", ["ls-remote", bare, triageClaimRef(feedbackId)], { encoding: "utf8", env: GIT_ENV }).trim();
    assert.equal(after, "", "the holder released its claim on completion");
  });
  assert.match(String(observed ?? ""), /refs\/rmd-triage\//, "the claim was live during the Architect call");
  const released = ledger.filter((l) => l.step === "triage.claim_released");
  assert.equal(released.length, 1);
  assert.equal(released[0].arm, "holder");
  assert.equal(released[0].dropped, true);
});

// ── THE PER-HOST LOCK IS UNCHANGED ────────────────────────────────────────────────────────────

test("W1-T1132 UNCHANGED: the per-host lock still refuses a hand-run racing the daemon", async () => {
  // The remote claim is a SECOND, WIDER gate — not a replacement. Removing the file lock would
  // trade a cross-host defect for a same-host one, and it is cheaper than a network round trip
  // for the case it covers.
  const root = tmp("rmd-claim-lock-");
  mkdirSync(join(root, "state"), { recursive: true });
  const rung = acquireDrainLock(triageLockPath(root)); // stands in for the daemon's rung
  const errs: string[] = [];
  const savedError = console.error;
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  try {
    const code = await triageCommand(["fb-anything"], {
      config: { claudeBin: "/usr/bin/true", root } as never,
      spawn: async () => {
        throw new Error("must never reach the worker");
      },
    });
    assert.equal(code, 2, "the hand-run refuses while the rung holds the lock");
    assert.match(errs.join("\n"), /rmd triage: REFUSED/, "and it says so, naming the holder");
    assert.match(errs.join("\n"), new RegExp(String(process.pid)), "the pid in the message is the live holder's");
  } finally {
    console.error = savedError;
    rung.release();
    rmSync(root, { recursive: true, force: true });
  }
});
