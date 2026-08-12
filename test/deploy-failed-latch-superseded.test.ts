/**
 * A `DEPLOY_FAILED` LATCH MUST STOP INSTRUCTING ONCE ITS DEPLOY HAS BEEN OVERTAKEN.
 *
 * THE DEFECT. Nothing ever removes `state/DEPLOY_FAILED`. `deployer.ts` writes it at two failure
 * sites (`deployFailedAlertPath`), and the only `unlinkSync` calls in that module target the deploy
 * marker and the idle-deferred clock — never the alert. So the latch is permanent until an operator
 * deletes the file by hand, and its next action kept saying "inspect state/DEPLOY_FAILED and
 * re-deploy once fixed" long after the failure stopped being actionable.
 *
 * MEASURED ON THE MINI: a latch 1h52m old, naming `failedHead 86f3955` after a
 * `dirty-tree-conflict` on `src/lib/status.ts` — by then an ancestor of both the running sha and
 * origin/main, on a clean checkout, with `head vs origin/main` reading FRESH. The deploy it named
 * had been overtaken by events, and the fleet had auto-deployed twice since.
 *
 * THE PREDICATE IS THE DEPLOYER'S OWN, REUSED. `decideDeployTrigger` refuses an auto-retry only
 * while `originMain === lastFailedHead` (its `alreadyFailed`). So the instruction is exactly as
 * live as that comparison, and asking the same question here — through the same `sameCommit` —
 * means the advice and the machinery cannot disagree about whether a retry is pending. It costs one
 * sha comparison the board already holds; no git call and no ancestry walk.
 *
 * THE RECORD IS KEPT. A deploy that failed is a fact worth having; only the advice is dropped, and
 * a `superseded` note says why. That is #1639's shape for LAST CLOSED CYCLE, applied one block down.
 *
 * BOTH DIRECTIONS, and the second is the one that matters: a GENUINELY failed deploy — origin/main
 * still sitting on the head that failed — must still instruct. A fix that suppressed the advice
 * whenever the head moved would hide a real failure the moment anything else merged.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatusBoard, type StatusBoardDeps } from "../src/lib/status-board.js";

const NOW_ISO = "2026-08-12T16:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

const FAILED_HEAD = "86f3955dd1ac9c2d1610863dce7fbb65645bdcf7";
const MOVED_ON = "1fe45504aa11bb22cc33dd44ee55ff6677889900";

/** The marker `deployer.ts` actually writes, field for field. */
const MARKER = {
  message: "deploy aborted: locally-modified files conflict with the fast-forward: src/lib/status.ts",
  failedHead: FAILED_HEAD,
  kind: "dirty-tree-conflict",
  at: "2026-08-12T13:54:41.452Z",
};

/**
 * A root carrying a real `state/DEPLOY_FAILED`, read through the REAL board. `originMainSha` is
 * what the supersession turns on.
 */
function boardWith(marker: Record<string, unknown> | undefined, originMainSha: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), "deploy-failed-latch-"));
  mkdirSync(join(root, "state"), { recursive: true });
  if (marker) writeFileSync(join(root, "state", "DEPLOY_FAILED"), JSON.stringify(marker));
  const deps: StatusBoardDeps = {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => originMainSha,
    isPidAlive: () => true,
  } as never;
  return buildStatusBoard(root, join(tmpdir(), "no-such-ledger.ndjson"), deps).latches;
}

const deployRow = (l: ReturnType<typeof boardWith>) => l.rows.find((r) => r.name === "DEPLOY_FAILED");

// ── THE FIXTURE REACHES THE RUNG ──────────────────────────────────────────────────────────────

test("the marker is actually read — the row exists and carries the deployer's own message", () => {
  // Guards the trap that inverted several fixtures this week: a test whose marker never reached
  // the rung would pass every assertion below vacuously.
  const l = boardWith(MARKER, FAILED_HEAD);
  const row = deployRow(l);
  assert.ok(row, "a DEPLOY_FAILED row was produced from the marker on disk");
  assert.match(row.consequence, /locally-modified files conflict with the fast-forward/);
  assert.match(row.consequence, /failed head 86f3955dd1ac/);
});

// ── DIRECTION 1: overtaken ⇒ record kept, instruction dropped ──────────────────────────────────

test("origin/main has moved past the failed head — the row stays, the instruction goes", () => {
  const l = boardWith(MARKER, MOVED_ON);
  const row = deployRow(l);
  assert.ok(row, "the RECORD is kept — a deploy that failed is still a fact");
  assert.match(row.superseded ?? "", /moved past the failed head/);
  assert.notEqual(l.nextAction, "inspect state/DEPLOY_FAILED and re-deploy once fixed (`rmd deploy`)");
});

test("a superseded latch alone leaves the section with no next action at all", () => {
  const l = boardWith(MARKER, MOVED_ON);
  assert.equal(l.nextAction, undefined, "nothing else was latched, so there is nothing to advise");
});

// ── DIRECTION 2 (THE TRAP): a genuinely failed deploy still instructs ─────────────────────────

test("THE OTHER DIRECTION: origin/main still ON the failed head — the instruction STANDS", () => {
  // FALSIFIER for "suppress whenever the head moved". If this ever stops instructing, the change
  // has hidden a real, current failure.
  const l = boardWith(MARKER, FAILED_HEAD);
  const row = deployRow(l);
  assert.equal(row?.superseded, undefined, "not superseded — this deploy is still the pending one");
  assert.equal(l.nextAction, "inspect state/DEPLOY_FAILED and re-deploy once fixed (`rmd deploy`)");
});

test("THE OTHER DIRECTION: a SHORT origin/main sha still matching the failed head does not supersede", () => {
  // `sameCommit` accepts a >=7-char prefix, and the deployer's own retry test uses it. The advice
  // must not flip merely because the board resolved a short sha this cycle.
  const l = boardWith(MARKER, FAILED_HEAD.slice(0, 12));
  assert.equal(deployRow(l)?.superseded, undefined);
  assert.match(l.nextAction ?? "", /re-deploy once fixed/);
});

// ── UNKNOWN IS NOT SUPERSEDED — the fail-closed direction ─────────────────────────────────────

test("origin/main unresolvable (offline, no remote) ⇒ no supersession claimed, instruction stands", () => {
  const l = boardWith(MARKER, undefined);
  assert.equal(deployRow(l)?.superseded, undefined, "an unreadable answer must never silence a failure");
  assert.match(l.nextAction ?? "", /re-deploy once fixed/);
});

test("a marker carrying no failedHead ⇒ nothing to compare, instruction stands", () => {
  const { failedHead: _omitted, ...noHead } = MARKER;
  const l = boardWith(noHead, MOVED_ON);
  assert.ok(deployRow(l), "the row still renders");
  assert.equal(deployRow(l)?.superseded, undefined);
  assert.match(l.nextAction ?? "", /re-deploy once fixed/);
});

// ── THE OTHER LATCHES ARE UNTOUCHED ───────────────────────────────────────────────────────────

test("no DEPLOY_FAILED marker at all ⇒ no row and no advice, exactly as before", () => {
  const l = boardWith(undefined, MOVED_ON);
  assert.equal(deployRow(l), undefined);
  assert.equal(l.nextAction, undefined);
});

test("a superseded DEPLOY_FAILED does not suppress a LATER latch's advice — PAUSE still speaks", () => {
  // The rules are ordered and DEPLOY_FAILED is first; a superseded row must step aside rather than
  // consume the section's one next action.
  const root = mkdtempSync(join(tmpdir(), "deploy-failed-latch-"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "DEPLOY_FAILED"), JSON.stringify(MARKER));
  writeFileSync(join(root, "state", "PAUSE"), JSON.stringify({ at: NOW_ISO, reason: "operator" }));
  const l = buildStatusBoard(root, join(tmpdir(), "no-such-ledger.ndjson"), {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => MOVED_ON,
    isPidAlive: () => true,
  } as never).latches;
  assert.match(deployRow(l)?.superseded ?? "", /moved past/);
  assert.match(l.nextAction ?? "", /rmd resume/, "PAUSE's advice is reached instead");
});
