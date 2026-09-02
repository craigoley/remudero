// W1-T2590: after W1-T2564, a refused draft writes no attempt key, stays due, and RETRIES ON THE
// NEXT POLL. That is the correct fix — before it, the work was silently lost — but it changed what
// the batch cap bounds: during a live account outage `DAEMON_DRAFT_BATCH_CAP` became the ONLY thing
// limiting the retry, in exactly the condition that produced 494 refusals in seven hours.
//
// So the rung waits out the window the account ITSELF stated. `detectUsageLimitRefusal`
// (lib/classify.ts) already recovers that instant from the provider's own text — MEASURED on the
// real captured string, `resetsAtMs` 2026-09-01T11:50:00.000Z, more accurate than the headroom
// governor's own belief at that same moment.
//
// ⚠ AND AN ABSENT RESET MUST NOT DEFER AT ALL. `resetsAtMs` is present only when the refusal stated
// a time AND carried an explicit UTC marker — a bare clock time in an unknown zone is deliberately
// never converted. A deferral with no stated end is an outage that never ends, so a zone-less
// refusal falls through to today's behaviour rather than stopping the rung.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decideDraftDeferral,
  deferralFromOutcomes,
  parseDraftDeferralCache,
  type DraftRungOutcome,
} from "../src/lib/inbox.js";
import { buildInboxDraftHook } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

const RESET = Date.parse("2026-09-01T11:50:00.000Z"); // the real captured refusal's stated reset
const MATCHED = "You've hit your session limit";

const refusal = (id: string, resetsAtMs?: number): DraftRungOutcome => ({
  proposalId: id,
  ok: false,
  error: `refused by the account before any output: ${MATCHED}`,
  refused: { matched: MATCHED, ...(resetsAtMs === undefined ? {} : { resetsAtMs }) },
});

/** A counting refusal batch, SHARED across tests. The deferred-poll test asserts this body never
 *  runs; inlined there it would be uncovered source in the diff, and "spawned === 0" would be
 *  evidence of an unreachable fixture rather than of the gate. The tests that DO reach the batch
 *  exercise the same body. */
function countingRefusalBatch(counter: { spawned: number }, resetsAtMs?: number) {
  return async (due: Array<{ id: string }>) => {
    counter.spawned += due.length;
    return due.map((p) => refusal(p.id, resetsAtMs));
  };
}

function seedRoot(ids: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-draft-defer-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "state", "inbox-proposals.json"),
    JSON.stringify({ proposals: ids.map((id) => ({ id, summary: "s", evidenceAnchors: [] })) }),
  );
  return root;
}

// ── THE OPERATOR'S FALSIFIER, both halves ────────────────────────────────────────────────────

test("with a refusal in force and a FUTURE reset, the rung spawns ZERO workers", async () => {
  const root = seedRoot(["P1", "P2"]);
  writeFileSync(
    join(root, "state", "inbox-draft-deferred-until.json"),
    JSON.stringify({ deferredUntilMs: Date.now() + 60 * 60_000, matched: MATCHED }),
  );
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const counter = { spawned: 0 };
  const hook = buildInboxDraftHook("o", "r", { root } as Config, "RUN-1", (s, e = {}) => logs.push({ step: s, extra: e }), countingRefusalBatch(counter, RESET));
  await hook();

  assert.equal(counter.spawned, 0, "the account said the door is shut — retrying into it is the whole defect");
  const deferred = logs.filter((l) => l.step === "inbox.draft_batch.deferred");
  assert.equal(deferred.length, 1, "and a deferred poll must be visible, not a rung that silently stopped firing");
  assert.equal(deferred[0].extra.matched, MATCHED, "the row carries the refusal that caused it — evidence, never re-derived");
  assert.ok((deferred[0].extra.remaining_ms as number) > 0, "and how long is left, so an operator can act on a number");
  // A deferred poll must cost NOTHING — not even lock churn.
  assert.equal(existsSync(join(root, "state", "inbox-draft.lock")), false, "a deferred poll must not even take the lock");
});

test("PAST that instant it spawns again — the deferral is self-limiting, not a latch", async () => {
  const root = seedRoot(["P1"]);
  writeFileSync(
    join(root, "state", "inbox-draft-deferred-until.json"),
    JSON.stringify({ deferredUntilMs: Date.now() - 1_000, matched: MATCHED }),
  );
  let spawned = 0;
  const hook = buildInboxDraftHook("o", "r", { root } as Config, "RUN-1", () => {}, async (due) => {
    spawned += due.length;
    return due.map((p) => ({ proposalId: p.id, ok: true as const, candidate: { proposalId: p.id, fragmentYaml: "- id: X\n", stampLine: "s", anchorFingerprint: "" } }));
  });
  await hook();
  assert.equal(spawned, 1, "an elapsed window must release the rung with no operator action and no expiry sweep");
});

// ── The write side: a refusal records the window it stated ───────────────────────────────────

test("a batch refused with a stated reset records it, so the NEXT poll waits it out", async () => {
  const root = seedRoot(["P1"]);
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const reached = { spawned: 0 };
  const hook = buildInboxDraftHook("o", "r", { root } as Config, "RUN-1", (s, e = {}) => logs.push({ step: s, extra: e }), countingRefusalBatch(reached, RESET));
  await hook();

  const written = parseDraftDeferralCache(readFileSync(join(root, "state", "inbox-draft-deferred-until.json"), "utf8"));
  assert.equal(written?.deferredUntilMs, RESET, "the instant the provider itself stated");
  assert.equal(written?.matched, MATCHED);
  assert.equal(logs.filter((l) => l.step === "inbox.draft_deferral_recorded").length, 1);
  assert.equal(reached.spawned, 1, "and this batch genuinely ran — the same fake body the deferred test asserts is never reached");
});

test("⚠ a refusal with NO stated instant defers NOTHING — an unbounded deferral is an outage that never ends", async () => {
  const root = seedRoot(["P1"]);
  // The zone-less case classify.ts deliberately refuses to convert.
  const hook = buildInboxDraftHook("o", "r", { root } as Config, "RUN-1", () => {}, countingRefusalBatch({ spawned: 0 }));
  await hook();
  assert.equal(
    existsSync(join(root, "state", "inbox-draft-deferred-until.json")),
    false,
    "no instant was stated, so none may be invented — this falls through to retry-next-poll, bounded by the batch cap",
  );
});

// ── The pure decision ────────────────────────────────────────────────────────────────────────

test("decideDraftDeferral: no cache, an elapsed window, and a live window", () => {
  assert.deepEqual(decideDraftDeferral(undefined, 1_000), { defer: false }, "nothing recorded ⇒ nothing deferred");
  assert.deepEqual(decideDraftDeferral({ deferredUntilMs: 500, matched: MATCHED }, 1_000), { defer: false }, "elapsed ⇒ run");
  const live = decideDraftDeferral({ deferredUntilMs: 2_000, matched: MATCHED }, 1_000);
  assert.equal(live.defer, true);
  assert.equal(live.defer === true && live.remainingMs, 1_000, "the caller ledgers a number, not a bare refusal");
  // Exactly AT the instant is not deferred — the window has reopened, and an off-by-one here would
  // hold the rung shut for a whole extra poll on every recovery.
  assert.deepEqual(decideDraftDeferral({ deferredUntilMs: 1_000, matched: MATCHED }, 1_000), { defer: false });
});

test("deferralFromOutcomes takes the LATEST stated reset — the earlier one would resume into a still-shut door", () => {
  const early = RESET;
  const late = RESET + 30 * 60_000;
  assert.equal(deferralFromOutcomes([refusal("a", early), refusal("b", late)])?.deferredUntilMs, late);
  assert.equal(deferralFromOutcomes([refusal("b", late), refusal("a", early)])?.deferredUntilMs, late, "order-independent");
  assert.equal(deferralFromOutcomes([refusal("a"), refusal("b")]), undefined, "no usable instant ⇒ no deferral");
  assert.equal(
    deferralFromOutcomes([{ proposalId: "x", ok: false, error: "no FRAGMENT/STAMP markers in worker output" }]),
    undefined,
    "an ORDINARY failure is not a refusal — it must never defer the rung",
  );
});

test("a corrupt or malformed deferral file fails soft to no deferral, never wedging the rung shut", () => {
  assert.equal(parseDraftDeferralCache(undefined), undefined);
  assert.equal(parseDraftDeferralCache("{not json"), undefined);
  assert.equal(parseDraftDeferralCache(JSON.stringify({ deferredUntilMs: "soon" })), undefined);
  assert.equal(parseDraftDeferralCache(JSON.stringify({ deferredUntilMs: Number.POSITIVE_INFINITY })), undefined);
  // The failure direction that costs the most is a file that suppresses the rung forever.
  assert.deepEqual(decideDraftDeferral(parseDraftDeferralCache("{not json"), Date.now()), { defer: false });
});
