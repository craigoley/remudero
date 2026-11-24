import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  GITHUB_TOKEN_TEXT_RE,
  ciFrictionGardenSpec,
  releaseCiFrictionEscalations,
  type CiFrictionCausePrice,
  type CiFrictionEscalationIssues,
  type CiFrictionGardenSources,
} from "#src/lib/ci-friction-gardener.js";
import type { OwnerSearch } from "#src/lib/ci-friction-remedy.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const NOW = Date.parse("2026-11-24T08:45:00.000Z");
const DAY = 24 * 3_600_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ISSUE = (n: number) => `https://github.com/acme/remudero/issues/${n}`;
const TOKEN = "ghs_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";

const escalated = (key: string, n: number): LedgerRecord =>
  ({ step: "ci-friction.remedy_escalated", origin: `ci-friction:${key}`, issue_url: ISSUE(n), ts: at(20 * DAY) });
const below = (key: string): LedgerRecord => ({ step: "ci-friction.remedy_below_ladder", cause: key, ts: at(9 * DAY) });

type Row = { step: string; extra?: Record<string, unknown> };

/** A registered-shape pass: the spec as the garden child builds it, with a scripted issue port. */
function pass(ledger: LedgerRecord[], issues: CiFrictionEscalationIssues, awaitReleases: boolean) {
  const root = gitRepo({ kind: "ci-friction-release-rows" }).dir;
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const rows: Row[] = [];
  const deps: GardenerDeps = {
    stateDir, repoRoot: root, seed: 1, clock: clockFromMillisFn(() => NOW),
    openWorkspace: () => { throw new Error("no workspace"); },
    log: (step, extra) => { rows.push({ step, extra }); },
  };
  const nobody: OwnerSearch = { filesContaining: () => [], fileExists: () => true };
  const sources: CiFrictionGardenSources = {
    ledgerRecords: () => ledger, planState: () => ({ tasks: [] }), ownerSearch: nobody,
    mintTaskId: () => { throw new Error("mints nothing"); }, issues, awaitReleases,
  };
  return { spec: ciFrictionGardenSpec(deps, sources), rows };
}

/** Each issue answers after a real turn of the loop, like the `gh` transport. */
const later = <T>(value: () => T): Promise<T> => new Promise((resolve, reject) => setTimeout(() => { try { resolve(value()); } catch (e) { reject(e); } }, 5));

const releaseRows = (rows: Row[]) => rows.filter((r) => r.step === "ci-friction.remedy_released" || r.step === "ci-friction.remedy_release_kept");

test("W1-T14624: a failed release close is kept with its failure and due again", async () => {
  const key = "check:stale-401";
  const ledger = [escalated(key, 31), below(key)];
  const issues: CiFrictionEscalationIssues = {
    listComments: () => later(() => []),
    close: () => later(() => { throw new Error("gh: Bad credentials (HTTP 401)"); }),
  };
  const { spec, rows } = pass(ledger, issues, true);
  await spec.inventoryAsync!();
  const kept = releaseRows(rows);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.step, "ci-friction.remedy_release_kept");
  assert.match(String(kept[0]!.extra?.reason), /closing the issue failed: .*HTTP 401/, "the row names the GitHub failure");
  // The kept row does not end the below-ladder streak, so the next pass finds the same release due.
  const next = releaseCiFrictionEscalations({ records: [...ledger, { step: "ci-friction.remedy_release_kept", cause: key, ts: at(0) }],
    priced: [] as CiFrictionCausePrice[], nowMs: NOW + 3_600_000, log: () => {} });
  assert.deepEqual(next.due.map((d) => d.cause), [key]);
});

test("W1-T14624: every due release ends in exactly one row", async () => {
  const keys = ["check:closes", "check:read-fails", "check:close-fails", "check:person-spoke"];
  const ledger = keys.flatMap((k, i) => [escalated(k, 40 + i), below(k)]);
  const issues: CiFrictionEscalationIssues = {
    listComments: (url) => later(() => {
      if (url === ISSUE(41)) throw new Error("HTTP 502");
      return url === ISSUE(43)
        ? [{ authorLogin: "craigoley", authorType: "User", authorAssociation: "OWNER", createdAt: at(0), body: "keep this open" }]
        : [];
    }),
    close: (url) => later(() => { if (url === ISSUE(42)) throw new Error("HTTP 403"); }),
  };
  const { spec, rows } = pass(ledger, issues, true);
  await spec.inventoryAsync!();
  const byCause = new Map<string, string[]>();
  for (const r of releaseRows(rows)) byCause.set(String(r.extra?.cause), [...(byCause.get(String(r.extra?.cause)) ?? []), r.step]);
  assert.deepEqual(Object.fromEntries(byCause), {
    "check:closes": ["ci-friction.remedy_released"],
    "check:read-fails": ["ci-friction.remedy_release_kept"],
    "check:close-fails": ["ci-friction.remedy_release_kept"],
    "check:person-spoke": ["ci-friction.remedy_release_kept"],
  }, "the pass returns only after each due release wrote its one row");

  // Without the await (the sync inventory, as an in-process caller runs it) the pass returns before any row.
  const offPass = pass(keys.flatMap((k, i) => [escalated(k, 50 + i), below(k)]), issues, false);
  assert.equal(offPass.spec.inventoryAsync, undefined);
  offPass.spec.inventory();
  assert.deepEqual(releaseRows(offPass.rows), []);
});

test("W1-T14624: no token reaches a release row", async () => {
  const saved = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "held-test-token-value-0123";
  try {
    const keys = ["check:echoes-a-pattern", "check:echoes-the-held"];
    const issues: CiFrictionEscalationIssues = {
      listComments: () => later(() => []),
      close: (url) => later(() => {
        throw new Error(url === ISSUE(60) ? `gh: 401 for Authorization: token ${TOKEN}` : `gh: 401 using ${process.env.GH_TOKEN}`);
      }),
    };
    const { spec, rows } = pass(keys.flatMap((k, i) => [escalated(k, 60 + i), below(k)]), issues, true);
    await spec.inventoryAsync!();
    const text = JSON.stringify(rows);
    assert.equal(releaseRows(rows).length, 2);
    assert.ok(!text.includes(TOKEN) && !text.includes("held-test-token-value-0123"), text);
    assert.equal((text.match(/\[redacted\]/g) ?? []).length, 2);
    assert.equal(GITHUB_TOKEN_TEXT_RE.test(`token ${TOKEN}`), true);
    assert.equal(GITHUB_TOKEN_TEXT_RE.test("ghs_short and gh_notatoken0123456789abcdef"), false);
  } finally {
    if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved;
  }
});
