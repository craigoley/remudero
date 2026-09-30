import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { triageClaimReserverFor } from "../src/run-task.js";
import {
  TRIAGE_CLAIM_AGE_ONLY_CEILING_MS,
  TRIAGE_CLAIM_LIVENESS_WINDOW_MS,
  assessTriageClaimLiveness,
  decideAutoTriage,
  decideTriageClaimRelease,
  parseTriageClaimAnchorMessage,
  sweepTriageClaims,
  triageClaimRef,
  type AutoTriageInputs,
  type TriageClaimReserver,
  type TriageLivenessRow,
} from "../src/lib/auto-triage.js";

// W1-T4769 — a dead holder's triage claim stalled a 44-entry backlog because every pass re-selected
// the same oldest entry and nothing could release a claim whose lane died before its `finally`.

const NOW = new Date("2026-09-30T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const iso = (agoMs: number): string => new Date(NOW.getTime() - agoMs).toISOString();

/** A reserver over an in-memory claim namespace; records drops so a test can assert on them. */
function fakeReserver(claims: Record<string, { sha: string; message: string }>): TriageClaimReserver & { drops: string[] } {
  const live = new Map(Object.entries(claims));
  const drops: string[] = [];
  return {
    drops,
    mintAnchor: () => "unused",
    attempt: () => "taken",
    holder: (id) => live.get(id)?.sha,
    drop(id, opts = {}) {
      const cur = live.get(id);
      if (!cur || (opts.expect !== undefined && opts.expect !== cur.sha)) return false;
      live.delete(id);
      drops.push(id);
      return true;
    },
    holderMessage: (id) => live.get(id)?.message,
    claimedIds: () => new Map([...live].map(([id, c]) => [id, c.sha])),
  };
}

const anchor = (pid: number, host: string, agoMs: number): string => `rmd-triage claim ${pid}@${host} ${iso(agoMs)}\n`;

function sweep(reserver: TriageClaimReserver, candidates: string[], rows: TriageLivenessRow[] | undefined) {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const result = sweepTriageClaims(candidates, reserver, {
    now: NOW,
    readRows: () => rows,
    log: (step, extra) => logged.push({ step, extra }),
  });
  return { result, logged };
}

test("W1-T4769: a silent holder past the window is released on the liveness arm", () => {
  const claimedAgo = 3 * 24 * HOUR;
  const reserver = fakeReserver({ "fb-dead": { sha: "sha-dead", message: anchor(94, "94fb66771d4b", claimedAgo) } });
  // The ledger can see the host (its claim row) but nothing from that pid since.
  const rows: TriageLivenessRow[] = [
    { ts: iso(claimedAgo - 1000), host: "94fb66771d4b", actor_pid: 94 },
    { ts: iso(HOUR), host: "some-other-host", actor_pid: 94 },
    { ts: iso(HOUR), host: "94fb66771d4b", actor_pid: 7 },
  ];
  const { result, logged } = sweep(reserver, ["fb-dead"], rows);

  assert.deepEqual(result.released, ["fb-dead"]);
  assert.deepEqual(result.held, []);
  assert.deepEqual(reserver.drops, ["fb-dead"], "the ref was dropped");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].step, "triage.claim_released");
  assert.equal(logged[0].extra?.arm, "liveness");
  assert.equal(logged[0].extra?.tier, "silent");
  assert.equal(logged[0].extra?.verdict, "dead");
  assert.equal(logged[0].extra?.holder_host, "94fb66771d4b");
  assert.equal(logged[0].extra?.holder_pid, 94);
  assert.equal(logged[0].extra?.claimed_at, iso(claimedAgo));
  assert.equal(logged[0].extra?.last_host_row_ts, iso(HOUR), "the last row seen from the host is ledgered");
  assert.equal(logged[0].extra?.dropped, true);
});

test("W1-T4769: a holder still writing rows keeps its claim", () => {
  const claimedAgo = 30 * 24 * HOUR;
  const reserver = fakeReserver({ "fb-live": { sha: "sha-live", message: anchor(41, "hostA", claimedAgo) } });
  const rows: TriageLivenessRow[] = [
    { ts: iso(claimedAgo - 1000), host: "hostA", actor_pid: 41 },
    { ts: iso(5 * 60 * 1000), host: "hostA", actor_pid: 41 },
  ];
  const { result, logged } = sweep(reserver, ["fb-live"], rows);

  assert.deepEqual(result.held, ["fb-live"], "however old the claim is, a writing holder keeps it");
  assert.deepEqual(result.released, []);
  assert.deepEqual(reserver.drops, []);
  assert.deepEqual(logged, [], "nothing is released, so nothing is ledgered as a release");
  assert.equal(assessTriageClaimLiveness({ holder: parseTriageClaimAnchorMessage(anchor(41, "hostA", claimedAgo)), rows, now: NOW }).verdict, "alive");

  // And a claim younger than the window is alive without any ledger at all.
  const young = assessTriageClaimLiveness({ holder: parseTriageClaimAnchorMessage(anchor(1, "h", 10 * 60 * 1000)), rows: undefined, now: NOW });
  assert.equal(young.verdict, "alive");
  assert.equal(young.releasable, false);
});

test("W1-T4769: an unseen holder host is unobservable and not dead", () => {
  const holder = parseTriageClaimAnchorMessage(anchor(9, "ghost-host", TRIAGE_CLAIM_LIVENESS_WINDOW_MS + HOUR));
  const rows: TriageLivenessRow[] = [{ ts: iso(HOUR), host: "another-host", actor_pid: 9 }];

  const a = assessTriageClaimLiveness({ holder, rows, now: NOW });
  assert.equal(a.verdict, "unobservable");
  assert.notEqual(a.verdict, "dead");
  assert.equal(a.releasable, false, "past the window but under the ceiling: not released");

  // An unreadable union and an unparseable anchor are the same: never dead.
  assert.equal(assessTriageClaimLiveness({ holder, rows: undefined, now: NOW }).verdict, "unobservable");
  assert.equal(assessTriageClaimLiveness({ holder: undefined, rows, now: NOW }).verdict, "unobservable");

  // Through the sweep the claim stays held and nothing is dropped.
  const reserver = fakeReserver({ "fb-ghost": { sha: "s", message: anchor(9, "ghost-host", TRIAGE_CLAIM_LIVENESS_WINDOW_MS + HOUR) } });
  const under = sweep(reserver, ["fb-ghost"], rows);
  assert.deepEqual(under.result.held, ["fb-ghost"]);
  assert.deepEqual(reserver.drops, []);

  // Past the separately named ceiling it releases, on the age-only tier, and the row says so.
  const old = fakeReserver({ "fb-ghost": { sha: "s", message: anchor(9, "ghost-host", TRIAGE_CLAIM_AGE_ONLY_CEILING_MS + HOUR) } });
  const past = sweep(old, ["fb-ghost"], rows);
  assert.deepEqual(past.result.released, ["fb-ghost"]);
  assert.equal(past.logged[0].extra?.arm, "liveness");
  assert.equal(past.logged[0].extra?.tier, "age-only");
  assert.equal(past.logged[0].extra?.verdict, "unobservable");
  assert.match(String(past.logged[0].extra?.reason), /AGE ALONE/);
  assert.ok(TRIAGE_CLAIM_AGE_ONLY_CEILING_MS >= 3 * TRIAGE_CLAIM_LIVENESS_WINDOW_MS, "a second tier, several times the window");
});

test("W1-T4769: the release decision stays clock-free and the liveness arm needs a releasable verdict", () => {
  const base = { heldByThisRun: false, outcomeObserved: false, feedbackId: "fb-x" };
  const dead = assessTriageClaimLiveness({
    holder: parseTriageClaimAnchorMessage(anchor(1, "h", 5 * HOUR)),
    rows: [{ ts: iso(5 * HOUR), host: "h", actor_pid: 1 }],
    now: NOW,
  });
  assert.equal(decideTriageClaimRelease({ ...base, liveness: dead }).arm, "liveness");
  assert.equal(decideTriageClaimRelease({ ...base }).arm, "operator", "no verdict, no release");
  assert.equal(decideTriageClaimRelease({ ...base, heldByThisRun: true, liveness: dead }).arm, "holder", "holder still wins");
  assert.equal(decideTriageClaimRelease({ ...base, outcomeObserved: true, liveness: dead }).arm, "evidence");
});

function inputs(over: Partial<AutoTriageInputs> = {}): AutoTriageInputs {
  return {
    policy: { enabled: true, minIntervalMinutes: 30, maxPerDay: 10 },
    deferralPending: false,
    dispatchCount: 0,
    laneBudget: 0,
    lockHeld: false,
    marker: { kind: "absent" },
    now: NOW,
    candidates: ["fb-oldest", "fb-second", "fb-third"],
    ...over,
  };
}

test("W1-T4769: a held oldest entry passes the fire to the next unclaimed entry", () => {
  const d = decideAutoTriage(inputs({ heldCandidates: ["fb-oldest"] }));
  assert.equal(d.fire, true);
  if (d.fire) {
    assert.equal(d.feedbackId, "fb-second");
    assert.match(d.reason, /passed over 1 held/);
  }
  // Skips a held middle entry too, and an unheld head is unchanged.
  const skip = decideAutoTriage(inputs({ heldCandidates: ["fb-oldest", "fb-second"] }));
  assert.equal(skip.fire && skip.feedbackId, "fb-third");
  const head = decideAutoTriage(inputs({ heldCandidates: [] }));
  assert.equal(head.fire && head.feedbackId, "fb-oldest");
  // An unreadable namespace (undefined) is today's behaviour: oldest, the lane's own claim decides.
  const unread = decideAutoTriage(inputs({ heldCandidates: undefined }));
  assert.equal(unread.fire && unread.feedbackId, "fb-oldest");
});

test("W1-T4769: every candidate held declines with a named reason", () => {
  const d = decideAutoTriage(inputs({ heldCandidates: ["fb-oldest", "fb-second", "fb-third"] }));
  assert.equal(d.fire, false);
  assert.match(d.reason, /every one of the 3 candidate\(s\) .* held by a live triage claim/);
});

test("W1-T4769: the claim ref namespace the sweep reads is the one the lane claims on", () => {
  const reserver = fakeReserver({ "fb-a": { sha: "s", message: "" } });
  assert.ok(reserver.claimedIds?.()?.has("fb-a"));
  assert.equal(triageClaimRef("fb-a"), "refs/rmd-triage/fb-a");
  // A claim whose anchor message cannot be read is unobservable: held, never dropped as dead.
  const { result } = sweep(reserver, ["fb-a"], []);
  assert.deepEqual(result.held, ["fb-a"]);
  // An unreadable namespace surfaces as undefined, never an empty set.
  const blind: TriageClaimReserver = { ...reserver, claimedIds: () => undefined };
  assert.equal(sweepTriageClaims(["fb-a"], blind, { now: NOW, readRows: () => [], log: () => {} }).held, undefined);
});

// ── THE REAL GIT HALF — the two added reserver methods, against a real bare repo ─────────────

test("W1-T4769 REAL GIT: the reserver lists claims in one ls-remote and reads the holder's anchor message", () => {
  const bare = mkdtempSync(join(tmpdir(), "rmd-liveness-bare-"));
  const work = mkdtempSync(join(tmpdir(), "rmd-liveness-work-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env });
  try {
    git(bare, "init", "--quiet", "--bare", "-b", "main");
    git(work, "init", "--quiet", "-b", "main");
    git(work, "config", "user.name", "remudero-test");
    git(work, "config", "user.email", "t@remudero.invalid");
    git(work, "commit", "--quiet", "--allow-empty", "-m", "seed");
    git(work, "remote", "add", "origin", bare);
    git(work, "push", "--quiet", "origin", "main");

    const reserver = triageClaimReserverFor(work);
    assert.equal(reserver.claimedIds?.()?.size, 0, "a readable but empty namespace is an empty map, not undefined");
    const anchor = reserver.mintAnchor();
    assert.equal(reserver.attempt("fb-real-claim", anchor), "created");

    const claimed = reserver.claimedIds?.();
    assert.equal(claimed?.get("fb-real-claim"), anchor);
    const holder = parseTriageClaimAnchorMessage(reserver.holderMessage?.("fb-real-claim") ?? "");
    assert.equal(holder?.pid, process.pid, "the anchor message round-trips through the parser");
    assert.equal(holder?.host, hostname());
    assert.equal(reserver.holderMessage?.("fb-absent"), undefined);

    execFileSync("git", ["-C", work, "remote", "set-url", "origin", join(bare, "does-not-exist")], { env });
    assert.equal(reserver.claimedIds?.(), undefined, "an unreachable origin is undefined, never an empty set");
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

// ── THE WIRING — autoTriageCheck itself, not just the pure halves ────────────────────────────

test("W1-T4769 WIRING: the default ledger read, the unresolvable-repo arm and a failing ledger write", async () => {
  const { autoTriageCheck } = await import("../src/run-task.js");
  const { loadPolicy, policyPath } = await import("../src/lib/policy.js");
  const { newFeedbackIdsOldestFirst } = await import("../src/lib/auto-triage.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = newFeedbackIdsOldestFirst(repo);
  if (candidates.length < 1) return; // nothing `status: new` in this checkout: the sweep is never reached
  const shipped = loadPolicy(policyPath(repo));
  const policy = { ...shipped, values: { ...shipped.values, autoTriage: { enabled: true, minIntervalMinutes: 1, maxPerDay: 50 } } };
  const now = new Date();
  const at = (agoMs: number): string => new Date(now.getTime() - agoMs).toISOString();
  const [head] = candidates;
  const args = { policy, now, deferralPending: true, dispatchCount: 1, laneBudget: 1 } as const;

  // (1) DEFAULT LEDGER READ: no injected reader, so the real union read over an empty state dir runs.
  // The holder's host has no rows there, so it is unobservable — held, never dropped as dead.
  const rootA = mkdtempSync(join(tmpdir(), "rmd-liveness-default-read-"));
  mkdirSync(join(rootA, "state"), { recursive: true });
  try {
    const config = { root: rootA, claudeBin: "/bin/true" } as unknown as import("../src/lib/config.js").Config;
    const reserver = fakeReserver({ [head]: { sha: "s", message: anchor(94, "h", 0).replace(iso(0), at(5 * HOUR)) } });
    const d = autoTriageCheck({ ...args, config, claimReserver: reserver });
    assert.deepEqual(reserver.drops, [], "an unobservable holder is not dropped on the default read");
    assert.notEqual(d.fire && d.feedbackId, head, "the held head is passed over");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
  }

  // (2) UNRESOLVABLE REPO + (3) FAILING LEDGER WRITE: `state` is a plain file, so the unavailable-sweep
  // row cannot be written; the pass still decides (today's behaviour: oldest candidate).
  const rootB = mkdtempSync(join(tmpdir(), "rmd-liveness-unresolvable-"));
  writeFileSync(join(rootB, "state"), "not a directory");
  const errs: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    errs.push(String(chunk));
    return true;
  };
  try {
    const config = { root: rootB, claudeBin: "/bin/true" } as unknown as import("../src/lib/config.js").Config;
    const d = autoTriageCheck({
      ...args,
      config,
      resolveClaimRepo: () => {
        throw new Error("no origin remote");
      },
    });
    assert.equal(d.fire && d.feedbackId, head, "an unreadable claim namespace keeps the oldest candidate");
  } finally {
    (process.stderr as { write: unknown }).write = realWrite;
    rmSync(rootB, { recursive: true, force: true });
  }
  assert.ok(
    errs.some((e) => /could not ledger triage\.claim_sweep_unavailable/.test(e)),
    "the lost ledger row is carried on stderr, not silent",
  );
});

test("W1-T4769 WIRING: autoTriageCheck skips a held head and releases a dead holder before deciding", async () => {
  const { autoTriageCheck } = await import("../src/run-task.js");
  const { loadPolicy, policyPath } = await import("../src/lib/policy.js");
  const { newFeedbackIdsOldestFirst } = await import("../src/lib/auto-triage.js");
  const { mkdirSync } = await import("node:fs");
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = newFeedbackIdsOldestFirst(repo);
  if (candidates.length < 2) return; // the checkout holds too few `status: new` entries to have a head to skip
  const shipped = loadPolicy(policyPath(repo));
  const policy = { ...shipped, values: { ...shipped.values, autoTriage: { enabled: true, minIntervalMinutes: 1, maxPerDay: 50 } } };
  const root = mkdtempSync(join(tmpdir(), "rmd-liveness-wiring-"));
  mkdirSync(join(root, "state"), { recursive: true });
  try {
    const config = { root, claudeBin: "/bin/true" } as unknown as import("../src/lib/config.js").Config;
    const now = new Date();
    const at = (agoMs: number): string => new Date(now.getTime() - agoMs).toISOString();
    const [head, second] = candidates;

    // A LIVE holder on the head (claimed minutes ago): the pass fires on the next entry.
    const live = fakeReserver({ [head]: { sha: "s1", message: anchor(5, "h", 60_000).replace(iso(60_000), at(60_000)) } });
    const skipped = autoTriageCheck({ config, now, policy, claimReserver: live, deferralPending: true, dispatchCount: 1, laneBudget: 1 });
    assert.equal(skipped.fire && skipped.feedbackId, second, "the held head is passed over, not fired on");
    assert.deepEqual(live.drops, [], "a live claim is never dropped");

    // A DEAD holder on the head: released before the decision, so the head is fired on.
    const oldMs = 3 * 24 * HOUR;
    const dead = fakeReserver({ [head]: { sha: "s2", message: anchor(94, "h", 0).replace(iso(0), at(oldMs)) } });
    const released = autoTriageCheck({
      config,
      now,
      policy,
      claimReserver: dead,
      readClaimLivenessRows: () => [{ ts: at(oldMs), host: "h", actor_pid: 94 }],
      deferralPending: true,
      dispatchCount: 1,
      laneBudget: 1,
    });
    assert.deepEqual(dead.drops, [head], "the dead holder's claim was dropped on the liveness arm");
    assert.equal(released.fire && released.feedbackId, head, "and the oldest entry is no longer stalled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
