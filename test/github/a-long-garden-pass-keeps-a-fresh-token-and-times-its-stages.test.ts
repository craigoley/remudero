/**
 * W1-T14677: GARDEN-ci-friction-1795531073256 renewed its App token at 14:37:53Z, spent 97 minutes scoring 646 units
 * with no row, and its hand-fix read at 16:15:43Z failed "gh: Bad credentials (HTTP 401)": the pass outlived its own
 * token, and nothing said where the time went. An awaited pass now renews a token with less than five minutes left
 * before each stage that reads GitHub and before each release's issue I/O, every stage writes its duration, and a kept
 * release row names only its own failure, never a count of releases the pass did not record.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  CI_FRICTION_STAGES,
  CI_FRICTION_STAGE_STEP,
  ciFrictionGardenSpec,
  type CiFrictionEscalationIssues,
  type CiFrictionGardenSources,
  type CiFrictionHandFixRead,
} from "#src/lib/ci-friction-gardener.js";
import type { OwnerSearch } from "#src/lib/ci-friction-remedy.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import {
  GH_APP_ID_ENV,
  GH_APP_INSTALLATION_ID_ENV,
  GH_APP_PRIVATE_KEY_PATH_ENV,
  HELD_TOKEN_READ_MARGIN_MS,
  INSTALLATION_TOKEN_LIFETIME_MS,
  ensureHeldTokenFresh,
  startInstallationTokenRefresh,
} from "#src/lib/github-app.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const START = Date.parse("2026-11-24T14:37:53.000Z");
const MIN = 60_000, DAY = 24 * 60 * MIN;
const ISSUE = (n: number) => `https://github.com/acme/remudero/issues/${n}`;

/** A real refresh loop over a scripted exchange and clock: each mint writes a new token and lives one hour. */
function loop(clock: { ms: number }, outcomes: boolean[] = []) {
  const env: Record<string, string | undefined> = { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" };
  let mints = 0;
  const renewal = startInstallationTokenRefresh({
    log: () => {}, env, now: () => clock.ms, setTimer: () => ({}), clearTimer: () => {},
    refresh: async (o) => {
      mints++;
      if (outcomes.length > 0 && outcomes.shift() === false) return { ok: false, reason: "exchange_failed" };
      o.env!.GH_TOKEN = `ghs_minted_${mints}`;
      return { ok: true, expiresAtMs: clock.ms + INSTALLATION_TOKEN_LIFETIME_MS };
    },
  });
  return { renewal, env, mints: () => mints };
}

type Row = { step: string; extra?: Record<string, unknown> };

/** The spec as the garden child builds it (awaited), with a pass whose unit collection outlives the start token. */
function pass(clock: { ms: number }, opts: { collectFor: number; handFix: (seen: string | undefined) => void; env?: Record<string, string | undefined>;
  ledger?: LedgerRecord[]; issues?: CiFrictionEscalationIssues; freshToken?: () => Promise<unknown>; awaitReleases?: boolean }) {
  const root = gitRepo({ kind: "w1-t14677-garden-token" }).dir;
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const rows: Row[] = [];
  const deps: GardenerDeps = {
    stateDir, repoRoot: root, seed: 1, clock: clockFromMillisFn(() => clock.ms),
    openWorkspace: () => { throw new Error("no workspace"); },
    log: (step, extra) => { rows.push({ step, extra }); },
  };
  const nobody: OwnerSearch = { filesContaining: () => [], fileExists: () => true };
  const sources: CiFrictionGardenSources = {
    ledgerRecords: () => opts.ledger ?? [],
    // The 97 minutes: the clock moves while the pass scores, with no await in between.
    planState: () => { clock.ms += opts.collectFor; return { tasks: [] }; },
    ownerSearch: nobody,
    handFixes: (): CiFrictionHandFixRead => { opts.handFix(opts.env?.GH_TOKEN); return { state: "observed", fixes: [] }; },
    mintTaskId: () => { throw new Error("mints nothing"); },
    awaitReleases: opts.awaitReleases ?? true,
    ...(opts.issues ? { issues: opts.issues } : {}),
    ...(opts.freshToken ? { freshToken: opts.freshToken } : {}),
  };
  return { spec: ciFrictionGardenSpec(deps, sources), rows };
}

test("W1-T14677: a pass that outlives its token refreshes before the next read", async () => {
  for (const [label, collectFor] of [["past its expiry", 97 * MIN], ["inside the five-minute margin", 57 * MIN]] as const) {
    const clock = { ms: START };
    const { renewal, env, mints } = loop(clock);
    try {
      await renewal.ready;
      const start = env.GH_TOKEN;
      let seen: string | undefined;
      const { spec } = pass(clock, { collectFor, env, handFix: (token) => { seen = token; } });
      await spec.inventoryAsync!();
      assert.equal(mints(), 2, `${label}: the pass renewed once before its hand-fix read`);
      assert.notEqual(seen, start, `${label}: the hand-fix read never presented the pass-start token`);
      assert.equal(renewal.tokenState!(seen), "fresh", `${label}: the token it presented is the held, unexpired one`);
    } finally {
      renewal.stop!();
    }
  }
  // A token with more than the margin left is used as it is.
  const clock = { ms: START };
  const { renewal, env, mints } = loop(clock);
  try {
    await renewal.ready;
    const { spec } = pass(clock, { collectFor: 30 * MIN, env, handFix: () => {} });
    await spec.inventoryAsync!();
    assert.equal(mints(), 1);
  } finally {
    renewal.stop!();
  }
  // The sync inventory cannot await a renewal, so it keeps W1-T14623's refusal and renews nothing.
  const syncClock = { ms: START };
  const sync = loop(syncClock);
  try {
    await sync.renewal.ready;
    const { spec } = pass(syncClock, { collectFor: 97 * MIN, env: sync.env, handFix: () => {}, awaitReleases: false });
    assert.equal(spec.inventoryAsync, undefined);
    spec.inventory();
    assert.equal(sync.mints(), 1);
  } finally {
    sync.renewal.stop!();
  }
  // Each release's issue I/O waits for a fresh token first.
  const order: string[] = [];
  const keys = ["check:a", "check:b"];
  const ledger: LedgerRecord[] = keys.flatMap((key, i) => [
    { step: "ci-friction.remedy_escalated", origin: `ci-friction:${key}`, issue_url: ISSUE(70 + i), ts: new Date(START - 20 * DAY).toISOString() },
    { step: "ci-friction.remedy_below_ladder", cause: key, ts: new Date(START - 9 * DAY).toISOString() },
  ]);
  const issues: CiFrictionEscalationIssues = {
    listComments: async (url) => { order.push(`read ${url.slice(-2)}`); return []; },
    close: async (url) => { order.push(`close ${url.slice(-2)}`); },
  };
  const released = pass({ ms: START }, { collectFor: 0, handFix: () => {}, ledger, issues, freshToken: async () => { order.push("fresh"); } });
  await released.spec.inventoryAsync!();
  assert.deepEqual(order, ["fresh", "fresh", "read 70", "close 70", "fresh", "read 71", "close 71"]);
});

test("W1-T14677: the held-token margin renews, waits or refuses by what the loop holds", async () => {
  assert.equal(await ensureHeldTokenFresh(), "not_armed", "no loop is armed here: nothing is done");
  const clock = { ms: START };
  const { renewal, mints } = loop(clock, [true, false, false, false]);
  try {
    await renewal.ready;
    assert.equal(await ensureHeldTokenFresh(), "fresh", "a new token is outside the margin");
    clock.ms = START + INSTALLATION_TOKEN_LIFETIME_MS - HELD_TOKEN_READ_MARGIN_MS + 1;
    assert.equal(await ensureHeldTokenFresh(), "fresh", "a failed renewal inside the margin still presents the unexpired token");
    assert.equal(mints(), 2);
    assert.equal(await renewal.ensureFresh!(HELD_TOKEN_READ_MARGIN_MS), "fresh", "a retry not yet due waits for its timer while the token lives");
    assert.equal(mints(), 2);
    clock.ms = START + INSTALLATION_TOKEN_LIFETIME_MS + 1;
    assert.equal(await renewal.ensureFresh!(), "token_expired", "a failed renewal past expiry is refused");
    assert.equal(await renewal.ensureFresh!(), "token_expired", "its one urgent retry fails too and is refused");
    assert.equal(mints(), 4);
    assert.equal(await renewal.ensureFresh!(), "token_expired", "an expired token whose retry is not yet due is refused unsent");
    assert.equal(mints(), 4);
    clock.ms += 3 * MIN;
    assert.equal(await ensureHeldTokenFresh(), "renewed", "a due retry that succeeds renews");
    assert.equal(mints(), 5);
  } finally {
    renewal.stop!();
  }
  assert.equal(await ensureHeldTokenFresh(), "not_armed", "a stopped loop is no longer reached");
});

test("W1-T14677: each garden stage logs its duration", async () => {
  const clock = { ms: START };
  const { spec, rows } = pass(clock, { collectFor: 97 * MIN, handFix: () => {}, freshToken: async () => {} });
  const inventory = await spec.inventoryAsync!();
  spec.scorecard(inventory, { actions: [] } as never);
  const stages = rows.filter((r) => r.step === CI_FRICTION_STAGE_STEP);
  assert.deepEqual(stages.map((r) => r.extra?.name), [...CI_FRICTION_STAGES]);
  for (const stage of stages) {
    assert.equal(typeof stage.extra?.started_at, "string");
    assert.ok(Number.isSafeInteger(stage.extra?.duration_ms) && (stage.extra!.duration_ms as number) >= 0, JSON.stringify(stage));
  }
  assert.equal(stages[0]!.extra?.duration_ms, 97 * MIN, "the stage that spent the 97 minutes says so");
  assert.equal(stages[0]!.extra?.started_at, new Date(START).toISOString());
});

test("W1-T14677: a kept row cites only the releases the pass recorded", async () => {
  // Six due releases: one closes, five fail. No kept row may count releases, least of all ones never recorded.
  const keys = ["check:closes", ...[1, 2, 3, 4, 5].map((n) => `check:fails-${n}`)];
  const ledger: LedgerRecord[] = keys.flatMap((key, i) => [
    { step: "ci-friction.remedy_escalated", origin: `ci-friction:${key}`, issue_url: ISSUE(80 + i), ts: new Date(START - 20 * DAY).toISOString() },
    { step: "ci-friction.remedy_below_ladder", cause: key, ts: new Date(START - 9 * DAY).toISOString() },
  ]);
  const issues: CiFrictionEscalationIssues = {
    listComments: async () => [],
    close: async (url) => { if (url !== ISSUE(80)) throw new Error("gh: Bad credentials (HTTP 401)"); },
  };
  const { spec, rows } = pass({ ms: START }, { collectFor: 0, handFix: () => {}, ledger, issues, freshToken: async () => {} });
  await spec.inventoryAsync!();
  const released = rows.filter((r) => r.step === "ci-friction.remedy_released");
  const kept = rows.filter((r) => r.step === "ci-friction.remedy_release_kept");
  assert.deepEqual(released.map((r) => r.extra?.cause), ["check:closes"]);
  assert.equal(kept.length, 5, "every other due release is kept, none held back by a count");
  for (const row of kept) {
    const reason = String(row.extra?.reason);
    assert.doesNotMatch(reason, /already released|\(cap\)|\b\d+ escalations?\b/, reason);
    assert.match(reason, /^closing the issue failed: gh: Bad credentials \(HTTP 401\)$/);
  }
});
