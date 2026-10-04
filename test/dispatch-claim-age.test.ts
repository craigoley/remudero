import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStatusBoard, renderStatusBoardText, type DispatchClaimsRead, type StatusBoardDeps } from "../src/lib/status-board.js";
import {
  DISPATCH_CLAIM_STALE_THRESHOLD_MS, dispatchClaimAgeMs, dispatchClaimRef,
  parseClaimAnchorMessage, readDispatchClaimAnchor, releaseDispatchClaim, staleDispatchClaimEscalations,
} from "../src/lib/dispatch-claim.js";
import { gitRepo } from "./helpers/git-repo.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const AGE = 48 * 60 * 60 * 1000;
const TASK = "W1-T5024";
const HOLDER = "a".repeat(40);

function identity(ageMs = AGE, host = "another-host") {
  return parseClaimAnchorMessage(`rmd-dispatch claim 42@${host} ${new Date(NOW - ageMs).toISOString()}`)!;
}

function boardWith(root: string, overrides: Partial<StatusBoardDeps> = {}) {
  return buildStatusBoard(root, join(root, "ledger.ndjson"), {
    repoDir: root,
    queryService: () => ({ running: false, pid: null }),
    now: () => NOW,
    resolveOriginMainSha: () => undefined,
    readSharedPauseState: () => "absent",
    readLedger: () => [],
    localHost: "this-host",
    ...overrides,
  });
}

test("W1-T5024: aged dispatch claim is visible and escalates once", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-claim-age-"));
  const identity = parseClaimAnchorMessage(`rmd-dispatch claim 42@another-host ${new Date(NOW - AGE).toISOString()}`)!;
  let claims: DispatchClaimsRead = {
    status: "held",
    claims: [{ taskId: TASK, holder: HOLDER, identity }, { taskId: TASK, holder: HOLDER, identity }],
  };
  let reads = 0;
  const board = () => boardWith(root, {
    readDispatchClaims: () => { reads++; return claims; },
  });
  const first = board();
  assert.equal(first.latches.rows.find((r) => r.name === `dispatch-claim:${TASK}`)?.ageMs, AGE);
  const escalations = first.needsMe.dispatchClaims!;
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0]!.holder, HOLDER);
  assert.equal(escalations[0]!.ageMs, AGE);
  assert.equal(escalations[0]!.options[0]!.kind!.type, "operator-only");
  assert.match(escalations[0]!.options[0]!.detail, /git push.*refs\/rmd-dispatch\/W1-T5024/);
  assert.match(renderStatusBoardText(first, { colourEnabled: false }), /stale dispatch claim/);
  const second = board();
  assert.equal(second.needsMe.dispatchClaims![0]!.id, escalations[0]!.id);
  assert.equal(reads, 2);
  let drops = 0;
  const release = releaseDispatchClaim(TASK, {
    mintAnchor: () => HOLDER,
    attempt: () => "taken",
    holder: () => HOLDER,
    drop: () => { drops++; return true; },
    anchorMessage: () => `rmd-dispatch claim 42@another-host ${identity.mintedAtIso}`,
  }, { livenessProbe: () => ({ localHost: "this-host", namespaceBootMs: NOW, namespaceBootIso: new Date(NOW).toISOString(), pidPresent: false }) });
  assert.equal(release.arm, "operator");
  assert.equal(release.dropped, false);
  assert.equal(drops, 0);
  claims = { status: "clear" };
  const cleared = board();
  assert.equal(cleared.latches.rows.some((r) => r.name === `dispatch-claim:${TASK}`), false);
  assert.deepEqual(cleared.needsMe.dispatchClaims, []);
  assert.doesNotMatch(renderStatusBoardText(cleared, { colourEnabled: false }), /stale dispatch claim/);
});

test("claim age handles the threshold, local holders, clock skew and unreadable identities", () => {
  for (const claimIdentity of [undefined, identity(0), identity(DISPATCH_CLAIM_STALE_THRESHOLD_MS), identity(AGE, "this-host"), identity(-1000)]) {
    const claim = { taskId: TASK, holder: HOLDER, identity: claimIdentity };
    assert.deepEqual(staleDispatchClaimEscalations([claim], NOW, "this-host"), []);
  }
  assert.equal(dispatchClaimAgeMs(identity(-1000), NOW), 0);
  assert.equal(dispatchClaimAgeMs(undefined, NOW), undefined);
  assert.equal(dispatchClaimAgeMs({ ...identity(), mintedAtMs: NaN }, NOW), undefined);
  assert.equal(dispatchClaimAgeMs(identity(), NaN), undefined);
  const atBound = { taskId: TASK, holder: HOLDER, identity: identity(DISPATCH_CLAIM_STALE_THRESHOLD_MS + 1) };
  assert.equal(staleDispatchClaimEscalations([atBound], NOW, "this-host").length, 1);
  const secondHolder = { ...atBound, holder: "b".repeat(40) };
  assert.notEqual(staleDispatchClaimEscalations([atBound], NOW, "this-host")[0]!.id,
    staleDispatchClaimEscalations([secondHolder], NOW, "this-host")[0]!.id);
});

test("an unreadable claim read never claims escalation recovery or fabricates a zero age", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-claim-age-unknown-"));
  const unreachable = boardWith(root, { readDispatchClaims: () => ({ status: "unreachable" }) });
  assert.match(unreachable.needsMe.dispatchClaimsUnknownReason!, /recovery is unconfirmed/);
  assert.match(renderStatusBoardText(unreachable, { colourEnabled: false }), /dispatch claims : unknown/);
  const unreadable = boardWith(root, { readDispatchClaims: () => ({ status: "held", claims: [
    { taskId: TASK, holder: HOLDER, metadataError: "permission denied" },
  ] }) });
  assert.equal(unreadable.latches.rows[0]!.ageMs, undefined);
  assert.match(unreadable.latches.rows[0]!.consequence, /age unknown: permission denied/);
  assert.deepEqual(unreadable.needsMe.dispatchClaims, []);
  assert.match(unreadable.needsMe.dispatchClaimsUnknownReason!, /age is unknown/);
});

test("anchor reads stay pinned to the listed holder and name fetch, object and parse failures", () => {
  const calls: string[][] = [];
  const read = readDispatchClaimAnchor(HOLDER, { run: (args) => {
    calls.push(args);
    return { status: 0, stderr: "", stdout: args[0] === "cat-file" ?
      `tree xyz\n\nrmd-dispatch claim 42@another-host ${identity().mintedAtIso}\n` : "" };
  } });
  assert.deepEqual(read.identity, identity());
  assert.deepEqual(calls, [["fetch", "--quiet", "--no-write-fetch-head", "origin", HOLDER], ["cat-file", "-p", HOLDER]]);
  const fetchFailure = readDispatchClaimAnchor(HOLDER, { run: () => ({ status: 1, stdout: "", stderr: "denied" }) });
  assert.match(fetchFailure.metadataError!, /fetch failed: denied/);
  const objectFailure = readDispatchClaimAnchor(HOLDER, { run: (args) => ({ status: args[0] === "cat-file" ? 1 : 0, stdout: "", stderr: "missing" }) });
  assert.match(objectFailure.metadataError!, /read failed: missing/);
  for (const stdout of ["no headers", "tree xyz\n\nnot a claim"]) {
    const invalid = readDispatchClaimAnchor(HOLDER, { run: () => ({ status: 0, stdout, stderr: "" }) });
    assert.equal(invalid.identity, undefined);
    assert.equal(invalid.metadataError, "claim anchor identity is unparseable");
  }
});

test("the real board reader fetches an uncloned claim anchor and never deletes its remote ref", () => {
  const origin = gitRepo({ bare: true, kind: "claim-age-origin" });
  const writer = gitRepo({ kind: "claim-age-writer" });
  writer.addRemote("origin", origin.dir);
  writer.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const reader = gitRepo({ cloneFrom: origin.dir, kind: "claim-age-reader" });
  const tree = writer.git("rev-parse", "HEAD^{tree}");
  const holder = writer.git("commit-tree", tree, "-m", `rmd-dispatch claim 42@another-host ${identity().mintedAtIso}`);
  writer.git("push", "--quiet", "origin", `${holder}:${dispatchClaimRef(TASK)}`);
  assert.throws(() => reader.git("cat-file", "-p", holder));
  const first = boardWith(reader.dir);
  assert.equal(first.latches.rows[0]!.ageMs, AGE);
  assert.equal(first.needsMe.dispatchClaims![0]!.holder, holder);
  assert.equal(boardWith(reader.dir).needsMe.dispatchClaims!.length, 1);
  assert.equal(origin.git("rev-parse", dispatchClaimRef(TASK)), holder);
  origin.git("update-ref", "-d", dispatchClaimRef(TASK));
  assert.deepEqual(boardWith(reader.dir).needsMe.dispatchClaims, []);

  origin.git("update-ref", dispatchClaimRef(TASK), origin.git("rev-parse", "main"));
  const invalid = boardWith(reader.dir);
  assert.match(invalid.latches.rows[0]!.consequence, /identity is unparseable/);
  assert.deepEqual(invalid.needsMe.dispatchClaims, []);
  mkdirSync(join(origin.dir, "refs/rmd-dispatch"), { recursive: true });
  writeFileSync(join(origin.dir, "refs/rmd-dispatch", TASK), `${HOLDER}\n`);
  const broken = boardWith(reader.dir);
  assert.equal(broken.latches.rows[0]!.ageMs, undefined);
  assert.match(broken.latches.rows[0]!.consequence, /fetch failed/);
  assert.match(broken.needsMe.dispatchClaimsUnknownReason!, /age is unknown/);
});
