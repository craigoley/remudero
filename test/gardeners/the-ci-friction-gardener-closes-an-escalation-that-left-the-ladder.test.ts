import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CI_FRICTION_FLEET_COMMENT_RE,
  CI_FRICTION_ISSUE_URL_RE,
  CI_FRICTION_LEDGER_STEPS,
  ciFrictionGardenSpec,
  closeCiFrictionReleases,
  escalatedCiFrictionOrigins,
  ghCiFrictionEscalationIssues,
  operatorCommentIsNewest,
  releaseCiFrictionEscalations,
  type CiFrictionCausePrice,
  type CiFrictionEscalationIssues,
  type CiFrictionGardenSources,
  type CiFrictionIssueComment,
} from "#src/lib/ci-friction-gardener.js";
import type { OwnerSearch } from "#src/lib/ci-friction-remedy.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ISSUE = (n: number) => `https://github.com/acme/remudero/issues/${n}`;

function price(key: string, minutes: number): CiFrictionCausePrice {
  const [kind, ...rest] = key.split(":");
  return { cause: { kind: kind as "check", name: rest.join(":") }, minutes, rounds: 3, prs: 2 };
}

/** Nine costlier causes ahead of `key`, so `key` ranks 10th: outside the top LADDER_DEPTH (8). */
const outside = (key: string, minutes = 4): CiFrictionCausePrice[] => [...Array.from({ length: 9 }, (_, i) => price(`check:hot-${i}`, 100 - i)), price(key, minutes)];
const inside = (key: string): CiFrictionCausePrice[] => [price(key, 500), ...Array.from({ length: 9 }, (_, i) => price(`check:hot-${i}`, 100 - i))];

const escalated = (key: string, n: number, msAgo = 20 * DAY, rung = 1): LedgerRecord =>
  ({ step: "ci-friction.remedy_escalated", origin: rung > 1 ? `ci-friction:${key}#r${rung}` : `ci-friction:${key}`, issue_url: ISSUE(n), ts: at(msAgo) });
const below = (key: string, msAgo: number): LedgerRecord => ({ step: "ci-friction.remedy_below_ladder", cause: key, ts: at(msAgo) });

function gateway(opts: { comments?: Record<string, CiFrictionIssueComment[]>; failRead?: boolean; failClose?: boolean } = {}) {
  const closed: Array<{ url: string; comment: string }> = [];
  const issues: CiFrictionEscalationIssues = {
    listComments: (url) => { if (opts.failRead) throw new Error("HTTP 502"); return opts.comments?.[url] ?? []; },
    close: (url, comment) => { if (opts.failClose) throw new Error("HTTP 403"); closed.push({ url, comment }); },
  };
  return { issues, closed };
}

async function run(records: LedgerRecord[], priced: CiFrictionCausePrice[], issues: CiFrictionEscalationIssues) {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); };
  const decided = releaseCiFrictionEscalations({ records, priced, nowMs: NOW, log });
  const released = await closeCiFrictionReleases(decided.due, issues, log);
  return { ...decided, released, rows, steps: rows.map((r) => r.step) };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("W1-T13219 criterion 1: an escalated cause outside the top LADDER_DEPTH for seven days has its issue closed with its price, rank and window", async () => {
  const { issues, closed } = gateway();
  // check:stale was escalated at rungs 1 and 2 (one shared issue); it first ranked outside the ladder 8 days ago.
  const records = [escalated("check:stale", 10), escalated("check:stale", 10, 15 * DAY, 2), below("check:stale", 8 * DAY)];
  await run(records, outside("check:stale"), issues);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.url, ISSUE(10));
  assert.match(closed[0]!.comment, /check:stale now costs 4 PR minute\(s\)/, "the current price");
  assert.match(closed[0]!.comment, /rank 10 of 10 priced cause\(s\)/, "the rank");
  assert.match(closed[0]!.comment, new RegExp(`outside the top 8 on every pass from ${at(8 * DAY)} to ${at(0)}`), "the window");

  // Six days outside is not yet seven: nothing closes, and no new streak row is written.
  const young = gateway();
  const waiting = await run([escalated("check:stale", 10), below("check:stale", 6 * DAY)], outside("check:stale"), young.issues);
  assert.deepEqual(young.closed, []);
  assert.deepEqual(waiting.outcomes.map((o) => o.decision), ["waiting"]);
  assert.deepEqual(waiting.steps, []);

  // The first pass outside the ladder opens the streak and closes nothing; a cause with no priced round left is outside too.
  const first = await run([escalated("check:stale", 10)], [price("check:other", 9)], gateway().issues);
  assert.deepEqual(first.steps, ["ci-friction.remedy_below_ladder"]);
  assert.equal(first.rows[0]!.extra?.rank, null);
  const gone = await run([escalated("check:gone", 11), below("check:gone", 9 * DAY)], [price("check:other", 9)], gateway().issues);
  assert.deepEqual(gone.outcomes.map((o) => o.decision), ["due"]);
  assert.deepEqual(gone.released, ["check:gone"]);
  assert.match(String(gone.rows.find((r) => r.step === "ci-friction.remedy_released")?.extra?.citation), /unranked \(no priced round left\)/);
});

test("W1-T13219 criterion 2: a release ledgers remedy_released and drops the origins, so a cause back in the ladder is escalated like a new one", async () => {
  const { issues } = gateway();
  const records = [escalated("check:stale", 10), escalated("check:stale", 10, 15 * DAY, 2), below("check:stale", 8 * DAY)];
  const out = await run(records, outside("check:stale"), issues);
  const row = out.rows.find((r) => r.step === "ci-friction.remedy_released")?.extra;
  assert.deepEqual(row?.origins, ["ci-friction:check:stale", "ci-friction:check:stale#r2"]);
  assert.equal(row?.issue_url, ISSUE(10));
  assert.deepEqual(out.released, ["check:stale"]);
  const after = [...records, { step: "ci-friction.remedy_released", ...row, ts: at(0) } as LedgerRecord];
  assert.deepEqual(escalatedCiFrictionOrigins(after), [], "the released origins leave the escalated set");
  assert.deepEqual(escalatedCiFrictionOrigins([...after, escalated("check:stale", 12, 0)]), ["ci-friction:check:stale"], "a later escalation holds it again");
  for (const step of ["ci-friction.remedy_below_ladder", "ci-friction.remedy_in_ladder", "ci-friction.remedy_released"]) {
    assert.ok(CI_FRICTION_LEDGER_STEPS.includes(step), `the history read keeps ${step}`);
  }

  // No escalation row recorded an issue URL: the origin is released with nothing to close.
  const noUrl = await run([{ step: "ci-friction.remedy_escalated", origin: "ci-friction:check:quiet", issue_url: null, ts: at(20 * DAY) }, below("check:quiet", 8 * DAY)],
    outside("check:quiet"), gateway().issues);
  assert.equal(noUrl.rows.find((r) => r.step === "ci-friction.remedy_released")?.extra?.issue_url, null);

  // End to end: the pass that releases the cause drops it from the ladder's held set, so the same pass's ladder
  // escalates it afresh once it is priced again.
  const root = gitRepo({ kind: "ci-friction-release-pass" }).dir;
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const deps: GardenerDeps = {
    stateDir, repoRoot: root, seed: 1, clock: clockFromMillisFn(() => NOW),
    openWorkspace: () => { throw new Error("no workspace"); },
    log: (step, extra) => { events.push({ step, extra }); },
  };
  const key = "check:nobody names this";
  const nobody: OwnerSearch = { filesContaining: () => [], fileExists: () => true };
  const pass = (ledger: LedgerRecord[], port: CiFrictionEscalationIssues) => {
    const sources: CiFrictionGardenSources = {
      ledgerRecords: () => ledger, planState: () => ({ tasks: [] }), ownerSearch: nobody,
      mintTaskId: () => { throw new Error("mints nothing"); }, issues: port,
    };
    return ciFrictionGardenSpec(deps, sources).inventory();
  };
  // Held, with no priced round: nothing to act on. The streak is 8 days old, so this pass releases it.
  const g = gateway();
  const released = pass([escalated(key, 20), below(key, 8 * DAY)], g.issues);
  assert.equal(released.next, undefined);
  assert.equal(events.some((e) => e.step === "ci-friction.remedy_released"), false, "the close runs off the pass, on the awaited transport");
  // A second pass while the first release is still in flight never closes the issue twice.
  pass([escalated(key, 20), below(key, 8 * DAY)], g.issues);
  await flush();
  assert.deepEqual(g.closed.map((c) => c.url), [ISSUE(20)]);
  assert.equal(events.filter((e) => e.step === "ci-friction.remedy_released").length, 1);
  // The cause costs rounds again after its release: the ladder escalates it at rung 1 like a new cause.
  const rounds: LedgerRecord[] = [
    { step: "pr.opened", run_id: "run-1", pr_url: "https://github.com/acme/remudero/pull/2", ts: at(2 * 3_600_000) },
    { step: "fix.dispatch", run_id: "run-1", mode: "nobody names this", round: 1, ts: at(3_600_000) },
  ];
  const releasedRow = { step: "ci-friction.remedy_released", ...events.find((e) => e.step === "ci-friction.remedy_released")!.extra, ts: at(1000) } as LedgerRecord;
  const back = pass([escalated(key, 20), below(key, 8 * DAY), releasedRow, ...rounds], gateway().issues);
  assert.equal(back.next?.origin, "ci-friction:check:nobody names this");
  assert.equal(back.next?.decision.kind, "escalate");
  // Without the release row the same rounds stay held.
  const held = pass([escalated(key, 20, 3 * DAY), ...rounds], gateway().issues);
  assert.equal(held.next, undefined);
});

test("W1-T13219 criterion 3: an unreadable price, a pass inside the ladder, or a person's newer comment keeps the issue open", async () => {
  // Unreadable price.
  const unreadable = gateway();
  const u = await run([escalated("check:stale", 10), below("check:stale", 8 * DAY)], [...outside("check:other"), price("check:stale", Number.NaN)], unreadable.issues);
  assert.deepEqual(unreadable.closed, []);
  assert.match(String(u.outcomes.find((o) => o.cause === "check:stale")!.reason), /price is unreadable/);

  // A pass inside the ladder ends the streak with remedy_in_ladder; the next pass outside starts a new one.
  const inLadder = gateway();
  const i = await run([escalated("check:stale", 10), below("check:stale", 8 * DAY)], inside("check:stale"), inLadder.issues);
  assert.deepEqual(inLadder.closed, []);
  assert.deepEqual(i.steps, ["ci-friction.remedy_in_ladder"]);
  const restarted = await run([escalated("check:stale", 10), below("check:stale", 8 * DAY), { step: "ci-friction.remedy_in_ladder", cause: "check:stale", ts: at(2 * DAY) }],
    outside("check:stale"), inLadder.issues);
  assert.deepEqual(inLadder.closed, [], "one pass inside the window resets the seven days");
  assert.deepEqual(restarted.steps, ["ci-friction.remedy_below_ladder"]);
  // Inside with no open streak writes nothing.
  assert.deepEqual((await run([escalated("check:stale", 10)], inside("check:stale"), inLadder.issues)).steps, []);

  // A person's comment newer than the fleet's newest keeps it open; an older one does not.
  const fleet = { authorLogin: "remudero-fleet[bot]", authorType: "Bot", authorAssociation: "NONE", body: "Another escalation observed the same condition (task x)" };
  const person = { authorLogin: "craigoley", authorType: "User", authorAssociation: "OWNER", body: "looking at this" };
  const spoke = gateway({ comments: { [ISSUE(10)]: [{ ...fleet, createdAt: at(5 * DAY) }, { ...person, createdAt: at(DAY) }] } });
  const s = await run([escalated("check:stale", 10), below("check:stale", 8 * DAY)], outside("check:stale"), spoke.issues);
  assert.deepEqual(spoke.closed, []);
  assert.match(String(s.rows.find((r) => r.step === "ci-friction.remedy_release_kept")?.extra?.reason), /a person commented after the fleet's newest comment/);
  assert.equal(operatorCommentIsNewest([{ ...person, createdAt: at(5 * DAY) }, { ...fleet, createdAt: at(DAY) }]), false);
  // The fleet's own text under a person's login is the fleet's, and a non-collaborator is nobody's operator.
  assert.equal(operatorCommentIsNewest([{ ...person, createdAt: at(DAY), body: "Another escalation observed the same condition (task x)" }]), false);
  assert.equal(operatorCommentIsNewest([{ ...person, authorAssociation: "NONE", createdAt: at(DAY) }]), false);
  assert.equal(operatorCommentIsNewest([{ ...person, createdAt: "not a date" }]), false);

  // An unreadable thread or a failed close keeps it open too.
  for (const [port, reason] of [[gateway({ failRead: true }).issues, /comments are unreadable: HTTP 502/], [gateway({ failClose: true }).issues, /closing the issue failed: HTTP 403/]] as const) {
    const r = await run([escalated("check:stale", 10), below("check:stale", 8 * DAY)], outside("check:stale"), port);
    assert.match(String(r.rows.find((row) => row.step === "ci-friction.remedy_release_kept")?.extra?.reason), reason);
    assert.deepEqual(r.released, []);
    assert.equal(r.steps.includes("ci-friction.remedy_released"), false);
  }
});

test("W1-T13219: the gh gateway reads comments over REST and closes through the escalation issue gateway", async () => {
  const calls: string[][] = [];
  const port = ghCiFrictionEscalationIssues(async (args) => {
    calls.push(args);
    return args.includes("--jq") ? '{"authorLogin":"a","authorType":"User","authorAssociation":"OWNER","createdAt":"2026-11-16T00:00:00Z","body":"x"}\n\n' : "";
  });
  assert.deepEqual(await port.listComments(ISSUE(7)), [{ authorLogin: "a", authorType: "User", authorAssociation: "OWNER", createdAt: "2026-11-16T00:00:00Z", body: "x" }]);
  assert.equal(calls[0]![1], "repos/acme/remudero/issues/7/comments?per_page=100");
  await port.close(ISSUE(7), "done");
  assert.deepEqual(calls[1], ["issue", "close", ISSUE(7), "--repo", "acme/remudero", "--comment", "done"]);
  await assert.rejects(Promise.resolve().then(() => port.close("https://github.com/acme/remudero/pull/7", "x")), /not a GitHub issue URL/);
  assert.equal(CI_FRICTION_ISSUE_URL_RE.test(ISSUE(7)), true);
  assert.equal(CI_FRICTION_ISSUE_URL_RE.test("https://github.com/acme/remudero/pull/7"), false);
  assert.equal(CI_FRICTION_FLEET_COMMENT_RE.test("Closed by the ci-friction gardener (W1-T13219): x"), true);
  assert.equal(CI_FRICTION_FLEET_COMMENT_RE.test("I am looking at this"), false);
});
