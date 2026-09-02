// W1-T2601: `retireSettledFollowups` (lib/retro.ts) shipped with W1-T2563 — built, documented and
// tested — with ZERO production call sites. Its producer, `routeFollowupsToRegistry`, WAS wired.
// So the registry could only ever grow: MEASURED 2026-09-01, 351 proposals, every one
// `followup:`-prefixed, against 317 two hours earlier and 16 two days before that.
//
// ⚠ THE TASK THAT BUILT IT COULD NOT HAVE WIRED IT. W1-T2563's declared `files:` are
// `[src/lib/retro.ts, test/routed-followups-retire.test.ts]`; this call site lives in run-task.ts,
// outside that scope. Stopping at the seam was correct, which is why a separate task exists rather
// than an oversight to scold — and why a "built but unreachable" census finds this shape at all.
//
// THE FAILURE DIRECTION THAT MATTERS. Retirement REMOVES entries from the registry, so the read it
// is given must fail toward NOT retiring: an absent plan file or a throwing projection must yield
// `unreadable`, never an empty merged set dressed up as a successful read.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { retireSettledFollowups, routeFollowupsToRegistry, type FollowupReferentRead } from "../src/lib/retro.js";
import type { Proposal } from "../src/lib/inbox.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const runTaskSrc = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");

/** A registry entry in exactly the shape `routeFollowupsToRegistry` mints, so the referent parses
 *  the way production's does rather than the way a hand-written fixture wishes it did. */
function routedFollowup(entryId: string, taskId: string): Proposal {
  let minted: Proposal[] = [];
  routeFollowupsToRegistry(
    {
      candidates: [{ entryId, type: "task", text: "something a worker named", runId: `${taskId}-run`, taskId }],
      deduped: [],
    } as never,
    {
      registryPath: "/dev/null",
      updateRegistry: (_p, update) => {
        minted = update([]) ?? [];
        return minted;
      },
    },
  );
  assert.equal(minted.length, 1, "the producer must mint exactly one proposal for one routable candidate");
  return minted[0];
}

// ── the call site itself ─────────────────────────────────────────────────────────────────────

test("the retirement arm HAS a production call site — the defect was that it had none", () => {
  assert.match(
    runTaskSrc,
    /retireSettledFollowups\(followupReferentRead, \{ registryPath: followupRegistryPath \}\)/,
    "retireSettledFollowups must be CALLED in production, not merely exported and tested",
  );
  // And it must run beside its producer, against the SAME registry path — a retirement pointed at a
  // different file would silently retire nothing forever, which is the defect wearing a fix's coat.
  assert.match(runTaskSrc, /routeFollowupsToRegistry\(gather\.followups, \{ registryPath: followupRegistryPath \}\)/);
  const producerAt = runTaskSrc.indexOf("routeFollowupsToRegistry(gather.followups");
  const retireAt = runTaskSrc.indexOf("retireSettledFollowups(followupReferentRead");
  assert.ok(producerAt > 0 && retireAt > producerAt, "retirement must run AFTER this pass routes its own candidates");
});

test("the read defaults to UNREADABLE and only becomes ok on a projection that completed", () => {
  assert.match(
    runTaskSrc,
    /let followupReferentRead: FollowupReferentRead = \{ kind: "unreadable" \}/,
    "the default must be unreadable — retirement removes entries, so an unread surface must retire nothing",
  );
  // The `ok` assignment must sit INSIDE the try/existsSync block that proves the projection ran.
  const decl = runTaskSrc.indexOf('let followupReferentRead: FollowupReferentRead = { kind: "unreadable" }');
  const ok = runTaskSrc.indexOf("followupReferentRead = {", decl);
  const projection = runTaskSrc.indexOf("const planHealthProjection = projectPlan(", decl);
  assert.ok(ok > projection, "the ok read must be assigned only after projectPlan has actually returned");
});

// ── the behaviour the call site buys ────────────────────────────────────────────────────────

test("a routed follow-up whose originating task has merged is REMOVED from the registry", () => {
  const live = routedFollowup("RUN-1:2026-09-01T00:00:00.000Z:0", "W1-T1000");
  const settled = routedFollowup("RUN-2:2026-09-01T00:00:00.000Z:0", "W1-T2000");
  let after: Proposal[] | null = null;
  const outcomes = retireSettledFollowups(
    { kind: "ok", merged: new Set(["W1-T2000"]) },
    {
      registryPath: "/dev/null",
      updateRegistry: (_p, update) => {
        after = update([live, settled]);
        return after;
      },
    },
  );
  assert.equal(outcomes.length, 1, "exactly the settled one retires");
  assert.equal(outcomes[0].taskId, "W1-T2000");
  assert.deepEqual((after as Proposal[] | null)?.map((p) => p.id), [live.id], "and the live one stays");
});

test("⚠ an UNREADABLE read retires NOTHING — cannot-observe means wait, never wipe", () => {
  const a = routedFollowup("RUN-1:2026-09-01T00:00:00.000Z:0", "W1-T1000");
  let called = false;
  const outcomes = retireSettledFollowups({ kind: "unreadable" } as FollowupReferentRead, {
    registryPath: "/dev/null",
    updateRegistry: () => {
      called = true;
      return [a];
    },
  });
  assert.deepEqual(outcomes, []);
  assert.equal(called, false, "an unreadable read must not even open the registry for writing");
});

test("an empty merged set retires nothing, so a degraded-but-readable projection cannot wipe the registry either", () => {
  const a = routedFollowup("RUN-1:2026-09-01T00:00:00.000Z:0", "W1-T1000");
  let wrote: Proposal[] | null | undefined;
  const outcomes = retireSettledFollowups(
    { kind: "ok", merged: new Set<string>() },
    {
      registryPath: "/dev/null",
      updateRegistry: (_p, update) => {
        wrote = update([a]);
        return wrote ?? null;
      },
    },
  );
  assert.deepEqual(outcomes, []);
  assert.equal(wrote, null, "no settled entries ⇒ the writer is told there is nothing to commit");
});

test("a proposal that is not a routed follow-up is never touched, whatever the merged set says", () => {
  const foreign: Proposal = { id: "board-review:escalation:#1", summary: "not a routed follow-up", evidenceAnchors: [] };
  let wrote: Proposal[] | null | undefined;
  const outcomes = retireSettledFollowups(
    { kind: "ok", merged: new Set(["W1-T2000", "W1-T1000"]) },
    {
      registryPath: "/dev/null",
      updateRegistry: (_p, update) => {
        wrote = update([foreign]);
        return wrote ?? null;
      },
    },
  );
  assert.deepEqual(outcomes, [], "no referent parses ⇒ no retirement, never a guessed one");
  assert.equal(wrote, null);
});
