/**
 * A `DEPLOY_FAILED` LATCH MUST DESCRIBE THE FAILURE THAT ACTUALLY HAPPENED.
 *
 * THE DEFECT. `STATIC_LATCHES`'s DEPLOY_FAILED `consequence` opened UNCONDITIONALLY with "the
 * checkout was rolled back — the daemon is running the PRIOR head", for both members of
 * `DeployFailureKind` (`deployer.ts`), which is exactly `dirty-tree-conflict |
 * health-check-rollback`. `deps.resetHard` has exactly ONE call site — the health-check arm of
 * `runDeployCycle`, which resets and then `kickstart`s. The dirty-tree arm returns immediately
 * after `deps.alert`, BEFORE `pullFf`: nothing pulled, nothing reset, the daemon still on the head
 * it already had. So on that path the sentence was false twice over, and there was no prior head
 * for the daemon to be on.
 *
 * MEASURED ON THE MINI, the rendered row: "the checkout was rolled back — the daemon is running the
 * PRIOR head (deploy aborted: locally-modified files conflict with the fast-forward:
 * src/lib/worker.ts, src/run-task.ts; failed head db6acf9096ca)" — the parenthetical accurate, the
 * clause in front of it not, one sentence disagreeing with itself about what happened.
 *
 * THE FIX WAS ALREADY IN HAND: the alert JSON carries `kind`, `consequence` is handed the whole
 * object, and it never read it — the computed-then-discarded shape.
 *
 * WHY BOTH KINDS ARE TESTED. A suite covering only the dirty-tree arm passes against a change that
 * simply hardcodes the new string, which would break the rollback arm in the opposite direction.
 * Each kind is asserted to render its OWN sentence AND to NOT render the other's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusBoard, type StatusBoardDeps } from "../src/lib/status-board.js";

const NOW_MS = Date.parse("2026-08-12T18:04:00.000Z");
const FAILED_HEAD = "db6acf9096caf2f850ec57efb5561046e6a24eee";

/** The conflicting paths ride inside the deployer's message as PROSE, not as a field. */
const DIRTY_MESSAGE =
  "deploy aborted: locally-modified files conflict with the fast-forward: src/lib/worker.ts, src/run-task.ts";
const ROLLBACK_MESSAGE = "deploy of db6acf90 failed health-check (no boot observed); rolled back to 11b7b56c";

/** Written field for field as `realDeployDeps.alert` writes it. */
function marker(over: Record<string, unknown>): Record<string, unknown> {
  return { message: DIRTY_MESSAGE, failedHead: FAILED_HEAD, kind: "dirty-tree-conflict", at: "2026-08-12T17:28:10.338Z", ...over };
}

function rowFor(m: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "deploy-failed-kind-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "DEPLOY_FAILED"), JSON.stringify(m));
  const deps: StatusBoardDeps = {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    // The failed head is still origin/main, so supersession does NOT fire and the row is the
    // live-instruction shape this suite is about — see deploy-failed-latch-superseded.test.ts.
    resolveOriginMainSha: () => FAILED_HEAD,
    isPidAlive: () => true,
  } as never;
  return buildStatusBoard(root, join(tmpdir(), "no-such-ledger.ndjson"), deps).latches.rows.find(
    (r) => r.name === "DEPLOY_FAILED",
  );
}

// ── THE FIXTURE REACHES THE RUNG ──────────────────────────────────────────────────────────────

test("the marker is actually read — a DEPLOY_FAILED row exists and carries the deployer's own message", () => {
  // Asserted BEFORE anything about the wording: a marker that never reached the rung would make
  // every "does not say X" assertion below pass vacuously, which is how several fixtures were
  // inverted this week.
  const row = rowFor(marker({}));
  assert.ok(row, "a DEPLOY_FAILED row was produced from the marker on disk");
  assert.match(row.consequence, /deploy aborted: locally-modified files conflict with the fast-forward/);
  assert.match(row.consequence, /failed head db6acf9096ca/, "and the failed head the deployer recorded");
});

// ── DIRECTION 1: a dirty-tree abort describes a deploy that never ran ─────────────────────────

test("a dirty-tree abort never claims a rollback and never claims a PRIOR head", () => {
  const row = rowFor(marker({}))!;
  assert.equal(/rolled back/i.test(row.consequence), false, "nothing was reset on this path — resetHard is never reached");
  assert.equal(/PRIOR head/.test(row.consequence), false, "the daemon is on the head it already had, so there is no prior head");
});

test("a dirty-tree abort says the fast-forward was refused and the daemon is on its existing head", () => {
  const row = rowFor(marker({}))!;
  assert.match(row.consequence, /fast-forward was REFUSED/, "the operative fact is that the pull did not happen");
  assert.match(row.consequence, /still on the head it already had/, "and that the daemon did not move");
  assert.match(row.consequence, /uncommitted local changes/, "which names what the operator must actually resolve");
});

// ── DIRECTION 2: a real rollback still reports the rollback it performed ──────────────────────

test("a health-check rollback still reports the rollback it really performed", () => {
  const row = rowFor(marker({ kind: "health-check-rollback", message: ROLLBACK_MESSAGE }))!;
  assert.match(row.consequence, /the checkout was rolled back/, "resetHard DID run on this path");
  assert.match(row.consequence, /PRIOR head/, "and the kickstart that follows it puts the daemon there");
  assert.equal(
    /fast-forward was REFUSED/.test(row.consequence),
    false,
    "the dirty-tree sentence must not leak onto the arm that genuinely deployed and rolled back",
  );
});

// ── DIRECTION 3: an unrecorded kind asserts neither fact ──────────────────────────────────────

test("a marker with no kind commits to neither story rather than guessing one", () => {
  const { kind: _dropped, ...noKind } = marker({});
  const row = rowFor(noKind)!;
  assert.equal(/the checkout was rolled back/.test(row.consequence), false, "asserting a rollback on no evidence is the defect being fixed");
  assert.equal(/fast-forward was REFUSED/.test(row.consequence), false, "and so is asserting the other one");
  assert.match(row.consequence, /does not record WHICH kind/, "it must say plainly that the reason was not recorded");
  assert.match(row.consequence, /deploy\.\* ledger rows/, "and point at the evidence that can still settle it");
});

test("an UNRECOGNISED kind degrades the same way as a missing one", () => {
  const row = rowFor(marker({ kind: "some-future-kind" }))!;
  assert.match(row.consequence, /does not record WHICH kind/, "an unknown value is no more evidence than an absent one");
});

// ── THE FILE LIST SURVIVES ────────────────────────────────────────────────────────────────────

test("the conflicting paths survive the rewrite verbatim — they are the most actionable thing on the row", () => {
  // The list already reached the operator before this change, as prose inside the message. A
  // rewrite of the clause in FRONT of it must not drop or truncate it.
  const row = rowFor(marker({}))!;
  assert.ok(row.consequence.includes(DIRTY_MESSAGE), "the deployer's message must appear verbatim, not summarised");
  assert.match(row.consequence, /src\/lib\/worker\.ts, src\/run-task\.ts/, "including BOTH conflicting paths");
});

test("a message-less marker no longer invents a health-check failure", () => {
  const { message: _dropped, ...noMessage } = marker({});
  const row = rowFor(noMessage)!;
  assert.equal(/health-check/.test(row.consequence), false, "the old default asserted a cause it had no evidence for");
  assert.match(row.consequence, /no message recorded/, "an absent message is reported as absent");
});
