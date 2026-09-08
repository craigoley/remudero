/**
 * test/an-advisory-id-from-a-stale-checkout-says-so.test.ts — W1-T3062.
 *
 * W1-T2710 taught the mint that a stale local half inverts `MAX_MENTION_LEAD`, and gave it the
 * remote PLAN ceiling to check against. That surface is a TRACKING REF, and a tracking ref is only
 * as fresh as the last fetch — so in a container that never fetched it reads exactly as stale as
 * the working tree, and the guard fires anyway.
 *
 * MEASURED 2026-09-07, the operator's own three consecutive mints, every number from the verb's
 * own output and from origin at the same moment:
 *
 *   printed:  W1-T2844 (max 2843 across tasks.yaml 280, shards 2843, open PRs not enumerated, …)
 *             — DEGRADED: open-prs (read fine but uncorroborated: its highest mention leads the
 *               plan's own ceiling by 216 (> 100), so it was dropped …)
 *   origin:   tasks.yaml 280 (agrees), shards 3059, reservations 3065
 *
 * THE GUARD FIRED CORRECTLY AND NAMED THE WRONG SUSPECT. The open-PR read was not the problem; it
 * was the only surface that was CURRENT. The local half was 216 behind, which is precisely the
 * divergence the message reports and then attributes elsewhere.
 *
 * ONLY THE RESERVATION NAMESPACE SAVED THE ANSWER: `--reserve` reads `refs/rmd-id/` from origin,
 * which is why the three ids reserved that afternoon were correct while the advisory answer was
 * 216 low. That number is free on the path that already consults it.
 *
 * WHAT THIS DOES NOT DO. It does not FETCH — the read stays injected at the edge, so the verb
 * still answers on a network-less host and in the W1-T2203 403 class. It does not stop dropping an
 * uncorroborated mention; that guard is correct and criterion 3 pins it. And it does not silently
 * correct the ceiling from a surface it has not decided to trust: it NAMES the staleness.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_MENTION_LEAD, describeMint, mintNextTaskId } from "../src/lib/task-id.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/** A plan whose LOCAL half declares exactly `localCeiling` — a monolith plus one shard, the two
 *  sources `mintNextTaskId` folds as "the plan". Same shape as W1-T2710's fixture beside it. */
function planFixture(localCeiling: number): { planPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mint-reservation-`));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T280\n    title: old monolith id\n");
  writeFileSync(
    join(root, "plan", "tasks.d", `W1-T${localCeiling}-a-shard.yaml`),
    `- id: W1-T${localCeiling}\n  title: the highest id this checkout can see\n`,
  );
  return { planPath: join(root, "plan", "tasks.yaml"), root };
}

/** The measured incident's own numbers, so every case below is the real shape rather than a
 *  round-number stand-in. */
const LOCAL_CEILING = 2843;
const ORIGIN_SHARDS = 3059;
const RESERVATIONS = 3065;

function mint(opts: { local: number; openPrCeiling?: number; reservations?: number | null; remotePlan?: number | null }) {
  const { planPath, root } = planFixture(opts.local);
  try {
    return mintNextTaskId({
      planPath,
      openPrTexts: opts.openPrCeiling === undefined ? undefined : () => [`filing W1-T${opts.openPrCeiling}`],
      remotePlanCeiling: opts.remotePlan === undefined ? undefined : () => opts.remotePlan ?? null,
      reservationCeiling: opts.reservations === undefined ? undefined : () => opts.reservations ?? null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── criterion 1: the report names the LOCAL surface and the gap ────────────────────────────────

test("W1-T3062 criterion 1: when the reservation namespace leads the local ceiling, the local surface is named as stale", () => {
  const m = mint({ local: LOCAL_CEILING, openPrCeiling: ORIGIN_SHARDS, reservations: RESERVATIONS });
  const local = m.degraded.find((d) => d.source === "local-plan");
  assert.ok(local, "the local half must be reported as the stale surface");
  assert.match(local.reason, /plan half is 222 id\(s\) behind the reservation namespace/, "the gap and the witness are both named");
  assert.equal(m.planBehindBy, RESERVATIONS - LOCAL_CEILING, "and it is carried as a number, not only as prose");
});

test("W1-T3062 criterion 1: the mention source is no longer blamed for the local half's staleness", () => {
  // THE MEASURED DEFECT ITSELF. Before this, the only CURRENT source was the one the DEGRADED line
  // accused. The reservation ceiling corroborates the mention, so the lead is small and the guard
  // has nothing to say about it.
  const m = mint({ local: LOCAL_CEILING, openPrCeiling: ORIGIN_SHARDS, reservations: RESERVATIONS });
  assert.equal(
    m.degraded.some((d) => d.source === "open-prs"),
    false,
    "open-prs must not be degraded when a current surface corroborates it",
  );
  assert.equal(m.sources.openPrs, ORIGIN_SHARDS, "and the corroborated mention keeps its ceiling rather than being nulled");
});

// ── criterion 2: a current checkout sees exactly what it sees today ────────────────────────────

test("W1-T3062 criterion 2: when the local surface is current, nothing is reported and the ceiling is unchanged", () => {
  const m = mint({ local: RESERVATIONS, openPrCeiling: RESERVATIONS, reservations: RESERVATIONS });
  assert.deepEqual(m.degraded, [], "a current checkout raises no degradation at all");
  assert.equal(m.planBehindBy, 0);
  assert.equal(m.id, `W1-T${RESERVATIONS + 1}`, "and the answer is the one it already gave");
});

test("W1-T3062 criterion 2: with NO reservation reader injected, every field is what it was before", () => {
  // THE OFFLINE AND 403 LANES, PINNED. A verb that needs the network to answer is a different
  // verb, and this is the assertion that keeps it from becoming one.
  const withReader = mint({ local: LOCAL_CEILING, openPrCeiling: ORIGIN_SHARDS, reservations: null });
  const without = mint({ local: LOCAL_CEILING, openPrCeiling: ORIGIN_SHARDS });
  assert.equal(without.sources.reservations, null, "no reader means no ceiling, never a fabricated zero");
  assert.equal(without.planBehindBy, 0, "an UNMEASURED gap is never reported as a measured zero");
  assert.deepEqual(
    without.degraded.map((d) => d.source),
    withReader.degraded.map((d) => d.source),
    "a reader that answers nothing degrades exactly as an absent one does",
  );
});

// ── criterion 3: the uncorroborated-mention guard is NOT weakened ──────────────────────────────

test("W1-T3062 criterion 3: a mention leading an otherwise-current local ceiling is STILL dropped", () => {
  // Local half current AND corroborated by the reservation namespace; the mention alone runs
  // ahead. That is the W1-T1039 shape the guard exists for, and it must be untouched — the defect
  // was the REPORT, not the trust decision.
  const m = mint({ local: RESERVATIONS, openPrCeiling: RESERVATIONS + MAX_MENTION_LEAD + 1, reservations: RESERVATIONS });
  const dropped = m.degraded.find((d) => d.source === "open-prs");
  assert.ok(dropped, "an uncorroborated mention must still be dropped");
  assert.match(dropped.reason, /read fine but uncorroborated/);
  assert.equal(m.sources.openPrs, null, "and nulled, so the burned number is never echoed back");
  assert.equal(m.id, `W1-T${RESERVATIONS + 1}`, "the mint stands on the plan, not on the outlier");
});

test("W1-T3062 criterion 3: MAX_MENTION_LEAD is unchanged — the discriminator is trust, never tolerance", () => {
  assert.equal(MAX_MENTION_LEAD, 100, "widening the bound would re-open W1-T1039, as its own doc warns");
});

// ── criterion 4: the warning rides on the advisory answer ──────────────────────────────────────

test("W1-T3062 criterion 4: the staleness appears on the advisory line itself", () => {
  // A lane that cannot reserve — the W1-T2203 403 class — never reaches the footnote a successful
  // reservation prints. This line is all it gets, so this is where the warning has to be.
  const line = describeMint(mint({ local: LOCAL_CEILING, openPrCeiling: ORIGIN_SHARDS, reservations: RESERVATIONS }));
  assert.match(line, /DEGRADED/, "the advisory answer carries its own warning");
  assert.match(line, /plan half is 222 id\(s\) behind the reservation namespace/);
  assert.match(line, new RegExp(`reservations ${RESERVATIONS}`), "and names the surface it compared against");
});

test("W1-T3062 criterion 4: a current checkout's advisory line still names the comparison it made", () => {
  // NAME THE COMPARISON, NOT JUST ITS RESULT — W1-T2710's own rule, extended to the new source: a
  // dash says the check never ran, a number says it ran and found nothing.
  const line = describeMint(mint({ local: RESERVATIONS, openPrCeiling: RESERVATIONS, reservations: RESERVATIONS }));
  assert.match(line, new RegExp(`reservations ${RESERVATIONS}`));
  assert.doesNotMatch(line, /DEGRADED/, "and says nothing else, because there is nothing to say");
  assert.match(describeMint(mint({ local: RESERVATIONS, openPrCeiling: RESERVATIONS })), /reservations -/, "no reader reads as a dash");
});
