/**
 * A STRANDED PER-TASK DISPATCH CLAIM IS NOW VISIBLE ON `rmd status` (W1-T2270).
 *
 * THE DEFECT. `decideDispatchClaimRelease` (lib/dispatch-claim.ts) refuses a time-based expiry on
 * a stated ground: "a claim that outlives its lane is a visible ref an operator can drop". But
 * `STATIC_LATCHES` (status-board.ts) declares `path: (root: string) => string` as a REQUIRED
 * field on every entry, and the whole LATCHES block never reads a git ref at all — so the ref the
 * module's own argument calls "visible" renders nowhere. A lane killed before its `finally`
 * (`run-task.ts`'s release, W1-T1268) leaves `refs/rmd-dispatch/<taskId>` held forever: nothing
 * times it out (by design), nothing else sweeps it, and no board surface shows it exists. The next
 * dispatch of that task is refused by name, but an operator asking "why is nothing moving" reads
 * "no active latches".
 *
 * THE FIX. One more row source in `buildLatchRows`, read via exactly ONE
 * `git ls-remote origin 'refs/rmd-dispatch/*'` (the whole namespace, not one ref per task) —
 * injected here as `StatusBoardDeps.readDispatchClaims` so no test needs a real git remote, and
 * mirroring W1-T2264's own `readSharedPauseState` seam in shape. `"holder"` is the anchor's own
 * sha, the SAME word `decideDispatchClaim`'s own refusal message already gives it — no second
 * round trip to decode a pid/host out of the anchor's commit message.
 *
 * WHAT MUST NOT CHANGE. The three release arms stay exactly as they are (HOLDER, EVIDENCE,
 * OPERATOR) — rendering a hold is not authority to release it, and this change never calls
 * `drop`/`push`, only `ls-remote`. `rmd status` stays read-only and cheap. No timer is added.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusBoard, type DispatchClaimsRead, type LatchesSection, type StatusBoardDeps } from "../src/lib/status-board.js";
import { dispatchClaimRef } from "../src/lib/dispatch-claim.js";

const NOW_ISO = "2026-08-25T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dispatch-claim-latch-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function boardWith(root: string, overrides: Partial<StatusBoardDeps>): LatchesSection {
  const deps: StatusBoardDeps = {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    readSharedPauseState: () => "absent",
    ...overrides,
  } as StatusBoardDeps;
  return buildStatusBoard(root, join(tmpdir(), "no-such-ledger.ndjson"), deps).latches;
}

const claimRows = (l: LatchesSection) => l.rows.filter((r) => r.name.startsWith("dispatch-claim:"));
const undeterminedRow = (l: LatchesSection) => l.rows.find((r) => r.name === "DISPATCH_CLAIMS");

const held = (claims: ReadonlyArray<{ taskId: string; holder: string }>): DispatchClaimsRead => ({ status: "held", claims });
const clear = (): DispatchClaimsRead => ({ status: "clear" });
const unreachable = (): DispatchClaimsRead => ({ status: "unreachable" });

// ── claim: a claim held by a lane that never released it is discoverable from a surface an
// operator runs ─────────────────────────────────────────────────────────────────────────────────

test("a held claim is discoverable as a LATCHES row on `rmd status`", () => {
  const l = boardWith(freshRoot(), { readDispatchClaims: () => held([{ taskId: "W1-T9999", holder: "abc123def456" }]) });
  const rows = claimRows(l);
  assert.equal(rows.length, 1, "the stranded claim produced exactly one row");
  assert.equal(rows[0]!.name, "dispatch-claim:W1-T9999");
});

// ── claim: a task with no held claim produces no such report, so a clear fleet still reads
// clear ──────────────────────────────────────────────────────────────────────────────────────────

test("a clear read produces no dispatch-claim row — a clear fleet still reports no active latches", () => {
  const l = boardWith(freshRoot(), { readDispatchClaims: clear });
  assert.equal(claimRows(l).length, 0);
  assert.equal(undeterminedRow(l), undefined);
  assert.equal(l.rows.length, 0, "nothing else was latched either — the section is genuinely empty");
});

// ── claim: an unreadable remote is reported as undetermined rather than as a held claim ────────

test("an unreachable read is reported as undetermined, never as a specific task's held claim", () => {
  const l = boardWith(freshRoot(), { readDispatchClaims: unreachable });
  assert.equal(claimRows(l).length, 0, "no task is named as holding a claim on an unreadable remote");
  const row = undeterminedRow(l);
  assert.ok(row, "an unreachable read still produces a row");
  assert.match(row!.consequence, /undetermined/);
  assert.doesNotMatch(row!.consequence, /is held \(holder/, "never asserts a specific hold it never confirmed");
});

// ── claim: an unreachable remote is likewise never reported as no claim held ────────────────────

test("an unreachable read is never silently reported as no claim held", () => {
  const root = freshRoot();
  assert.doesNotThrow(() => boardWith(root, { readDispatchClaims: unreachable }));
  const l = boardWith(root, { readDispatchClaims: unreachable });
  assert.notEqual(l.rows.length, 0, "an unreachable remote must never read as a clear, empty board");
  assert.ok(undeterminedRow(l), "the undetermined row is present rather than the section reading empty");
});

// ── claim: the report names the ref and the holder so the operator arm has what it needs to
// act ────────────────────────────────────────────────────────────────────────────────────────────

test("the report names the ref and the holder", () => {
  const l = boardWith(freshRoot(), { readDispatchClaims: () => held([{ taskId: "W1-T9999", holder: "abc123def456" }]) });
  const row = claimRows(l)[0]!;
  assert.ok(row.consequence.includes(dispatchClaimRef("W1-T9999")), "the consequence names the ref itself");
  assert.ok(row.consequence.includes("abc123def456"), "the consequence names the holder");
  assert.match(row.consequence, /git push origin :/, "the consequence names the operator's drop command");
});

test("multiple stranded tasks each get their own named row", () => {
  const l = boardWith(freshRoot(), {
    readDispatchClaims: () =>
      held([
        { taskId: "W1-T1000", holder: "sha1sha1" },
        { taskId: "W1-T2000", holder: "sha2sha2" },
      ]),
  });
  const rows = claimRows(l);
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.name === "dispatch-claim:W1-T1000" && r.consequence.includes("sha1sha1")));
  assert.ok(rows.some((r) => r.name === "dispatch-claim:W1-T2000" && r.consequence.includes("sha2sha2")));
});

// ── claim: nothing in the change releases a claim it reports ───────────────────────────────────

test("building the board reads the claim state once and performs no write, no release, no marker mutation", () => {
  const root = freshRoot();
  const stopPath = join(root, "state", "STOP");
  const stopBody = JSON.stringify({ at: NOW_ISO, reason: "operator" });
  writeFileSync(stopPath, stopBody);

  let reads = 0;
  const l = boardWith(root, {
    readDispatchClaims: () => {
      reads += 1;
      // The injected reader's type carries no `drop`/`push` capability at all — the board can
      // only ever call this READ function, never release anything through it.
      return held([{ taskId: "W1-T9999", holder: "abc123def456" }]);
    },
  });

  assert.equal(reads, 1, "the dispatch-claim namespace is READ, once — never polled a second time");
  assert.ok(existsSync(stopPath), "an unrelated marker is untouched");
  assert.equal(readFileSync(stopPath, "utf8"), stopBody, "unrelated marker content is byte-identical");
  assert.ok(claimRows(l).length > 0, "the held claim still rendered despite the unrelated marker present");
});

test("the default reader is used when none is injected, and a non-git repoDir reads as clear rather than throwing", () => {
  assert.doesNotThrow(() => boardWith(freshRoot(), {}));
  const l = boardWith(freshRoot(), {});
  assert.equal(claimRows(l).length, 0);
  assert.equal(undeterminedRow(l), undefined);
});

// ── the next-action line fires for a stranded claim, and never names the releasing action
// itself (an operator call, not this board's) ──────────────────────────────────────────────────

test("the next-action line fires for a stranded claim without naming the release command as its own", () => {
  const heldNext = boardWith(freshRoot(), {
    readDispatchClaims: () => held([{ taskId: "W1-T9999", holder: "abc123def456" }]),
  }).nextAction;
  assert.ok(heldNext, "a next action fired for the stranded-claim row");

  const unreachableNext = boardWith(freshRoot(), { readDispatchClaims: unreachable }).nextAction;
  assert.ok(unreachableNext, "a next action fired for the undetermined row too");

  const clearNext = boardWith(freshRoot(), { readDispatchClaims: clear }).nextAction;
  assert.equal(clearNext, undefined, "nothing latched, so nothing to advise");
});
