import assert from "node:assert/strict";
// The DEFAULT export -- a plain, mutable object -- so a test's `t.mock.method` can
// actually intercept the calls `writeDraftAttemptPair` makes: named bindings off
// `node:fs` are non-configurable and mock.method/defineProperty against them throws
// "Cannot redefine property" instead of installing a spy. Same import-shape comment as
// test/inbox-registry-atomic.test.ts (the W1-T240 precedent this file's claim 1 mirrors)
// and src/lib/inbox.ts's own `import fs from "node:fs"` comment.
import fsDefault from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  draftAttemptKey,
  draftsDueOnDaemon,
  isDraftStale,
  parseDraftAttemptCache,
  parseDraftCache,
  proposalsNeedingDraft,
  writeDraftAttemptPair,
  type DraftAttemptCache,
  type DraftCache,
  type DraftedCandidate,
  type Proposal,
} from "../src/lib/inbox.js";

// ── W1-T241 ──────────────────────────────────────────────────────────────────────────────
//
// buildInboxDraftHook (run-task.ts) used to write state/inbox-drafts.json and
// state/inbox-draft-attempts.json as two independent plain readFileSync + JSON.parse +
// writeFileSync round trips -- no atomicity WITHIN either write (a reader could observe a
// truncated/partial blob) and no atomicity ACROSS the pair (a crash between the two calls
// could leave one file reflecting this poll's outcome while the other still reflected the
// previous one). writeDraftAttemptPair (src/lib/inbox.ts) fixes both: each file lands via a
// sibling temp file + rename (claim 1), and the two renames commit in a FIXED, safe order --
// drafts before attempts -- so a crash between them can only ever land the self-healing
// one-sided state, never the one that would silently wedge the daemon's throttle forever
// (claim 2). Claim 3 sweeps every distinct crash point across the whole write, not merely
// the one claim 2 targets, and proves the "never attempt without a matching fresh draft"
// invariant holds at every one of them.

function tmpPair(): { dir: string; draftsPath: string; attemptsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-inbox-draft-pair-atomic-"));
  return { dir, draftsPath: join(dir, "inbox-drafts.json"), attemptsPath: join(dir, "inbox-draft-attempts.json") };
}

function proposal(id: string): Proposal {
  return { id, summary: `proposal ${id}`, evidenceAnchors: [] };
}

function candidate(id: string): DraftedCandidate {
  return { proposalId: id, fragmentYaml: `- id: ${id}-TASK\n  title: fixture\n`, stampLine: `- ${id} (plan) — RATIFIED -> ${id}-TASK.`, anchorFingerprint: "" };
}

// ── Claim 1: a reader interleaved with a drafts or attempts writer never observes a
// partial file ──────────────────────────────────────────────────────────────────────────
//
// Mirrors test/inbox-registry-atomic.test.ts's own W1-T240 claim 1 proof verbatim in shape:
// seed a known-good, complete pair (cycle 1) with real calls, then intercept the SECOND
// write's fs.writeFileSync/fs.renameSync calls and fire a "concurrent reader" (a genuine,
// separate readFileSync + parse call) at the exact instant either target path is about to
// become visible with new bytes. Under the FIXED implementation only the
// renameSync(tmp, target) branch ever fires (pre-swap, while the target still holds cycle
// 1's content untouched); the writeFileSync(target) branch is dead code under the fix and
// only reachable again if writeDraftAttemptPair is reverted to write drafts/attempts
// DIRECTLY -- exactly the FALSIFIER the acceptance claim asks for.

test(
  "W1-T241 claim 1: a reader interleaved with a drafts or attempts writer never observes a partial file -- " +
    "FALSIFIER: reverting writeDraftAttemptPair to a direct writeFileSync(target) makes this fail",
  (t: TestContext) => {
    const { dir, draftsPath, attemptsPath } = tmpPair();
    try {
      // Cycle 1: seed a known-good, complete pair with real fs calls.
      writeDraftAttemptPair(draftsPath, attemptsPath, { P1: candidate("P1") }, { P1: "cause-1" });
      const draftsContent1 = fsDefault.readFileSync(draftsPath, "utf8");
      const attemptsContent1 = fsDefault.readFileSync(attemptsPath, "utf8");
      assert.ok(draftsContent1.length > 0, "sanity: cycle 1 actually produced a non-empty drafts file");
      assert.ok(attemptsContent1.length > 0, "sanity: cycle 1 actually produced a non-empty attempts file");
      JSON.parse(draftsContent1); // sanity: valid JSON
      JSON.parse(attemptsContent1); // sanity: valid JSON

      const realWriteFileSync = fsDefault.writeFileSync.bind(fsDefault);
      const realRenameSync = fsDefault.renameSync.bind(fsDefault);
      const realReadFileSync = fsDefault.readFileSync.bind(fsDefault);
      const realExistsSync = fsDefault.existsSync.bind(fsDefault);

      const observations: Array<{ label: string; path: string; content: string | undefined }> = [];
      let probeFired = false;
      let probeArmed = true; // guards against the nested reader's own read re-firing this

      function probe(label: string, path: string) {
        if (!probeArmed) return;
        probeArmed = false;
        probeFired = true;
        const content = realExistsSync(path) ? realReadFileSync(path, "utf8") : undefined;
        observations.push({ label, path, content });
        probeArmed = true;
      }

      t.mock.method(fsDefault, "writeFileSync", (target: unknown, content: unknown, ...rest: unknown[]) => {
        if (target === draftsPath || target === attemptsPath) {
          const which = target === draftsPath ? "draftsPath" : "attemptsPath";
          // Reproduce a plain truncating writeFileSync's observable two-phase window --
          // only reachable if writeDraftAttemptPair is reverted to write the TARGET path
          // directly instead of a sibling temp file.
          realWriteFileSync(target as string, "");
          probe(`direct writeFileSync(${which}) -- pre-fix shape, post-truncate pre-fill`, target as string);
          return realWriteFileSync(target as string, content as string, ...(rest as []));
        }
        return realWriteFileSync(target as string, content as string, ...(rest as []));
      });
      t.mock.method(fsDefault, "renameSync", (from: unknown, to: unknown) => {
        if (to === draftsPath || to === attemptsPath) {
          const which = to === draftsPath ? "draftsPath" : "attemptsPath";
          probe(`renameSync(tmp, ${which}) -- pre-swap`, to as string);
        }
        return realRenameSync(from as string, to as string);
      });

      // Cycle 2: a genuinely different pair (new proposal ids), so a torn read would be
      // observably distinguishable from cycle 1's content.
      writeDraftAttemptPair(draftsPath, attemptsPath, { P1: candidate("P1"), P2: candidate("P2") }, { P1: "cause-1", P2: "cause-2" });

      assert.ok(probeFired, "sanity: the interleave probe must actually have fired at least once");

      for (const obs of observations) {
        assert.ok(obs.content !== undefined, `${obs.label}: the file must already exist by cycle 2`);
        assert.ok(obs.content!.length > 0, `${obs.label}: reader observed a ZERO-LENGTH file`);
        assert.doesNotThrow(() => JSON.parse(obs.content!), `${obs.label}: reader observed unparseable (torn) JSON`);
        const expected = obs.path === draftsPath ? draftsContent1 : attemptsContent1;
        assert.equal(obs.content, expected, `${obs.label}: reader observed something other than the complete, untouched cycle-1 file`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── Claim 2: a crash between the pair's two writes can no longer persist an attempt whose
// draft never landed -- the surviving one-sided state self-heals, asserted on write order ─

test(
  "W1-T241 claim 2: a crash between the pair's two writes can no longer persist an attempt whose draft " +
    "never landed -- the surviving one-sided state self-heals (a fresh draft with a stale attempts entry), " +
    "never the reverse, asserted on write order",
  (t: TestContext) => {
    const { dir, draftsPath, attemptsPath } = tmpPair();
    try {
      // P-OK's attempt this poll SUCCEEDED; P-FAIL's FAILED -- mirrors buildInboxDraftHook's
      // own nextDrafts/nextAttempts construction (attempts always records the cause, drafts
      // only gains an entry when outcome.ok).
      const proposals = [proposal("P-OK"), proposal("P-FAIL")];
      const priorDrafts: DraftCache = {};
      const priorAttempts: DraftAttemptCache = {};
      const nextDrafts: DraftCache = { ...priorDrafts, "P-OK": candidate("P-OK") };
      const nextAttempts: DraftAttemptCache = { ...priorAttempts, "P-OK": draftAttemptKey(proposals[0]), "P-FAIL": draftAttemptKey(proposals[1]) };

      const realRenameSync = fsDefault.renameSync.bind(fsDefault);
      t.mock.method(fsDefault, "renameSync", (from: unknown, to: unknown) => {
        if (to === attemptsPath) throw new Error("simulated crash: process killed between the drafts and attempts renames");
        return realRenameSync(from as string, to as string);
      });

      assert.throws(() => writeDraftAttemptPair(draftsPath, attemptsPath, nextDrafts, nextAttempts), /simulated crash/);

      // Survived state: the drafts rename ran to completion (it commits FIRST); the attempts
      // rename never ran.
      const draftsOnDisk = parseDraftCache(fsDefault.existsSync(draftsPath) ? fsDefault.readFileSync(draftsPath, "utf8") : undefined);
      const attemptsOnDisk = parseDraftAttemptCache(fsDefault.existsSync(attemptsPath) ? fsDefault.readFileSync(attemptsPath, "utf8") : undefined);
      assert.deepEqual(draftsOnDisk, nextDrafts, "the drafts cache DID commit before the simulated crash");
      assert.deepEqual(attemptsOnDisk, priorAttempts, "the attempts cache must NOT have committed -- it still reflects the pre-poll state");

      // Self-heals: P-OK's fresh, un-stale draft means the daemon never re-attempts it, even
      // though attempts never recorded the cause. P-FAIL is legitimately retried next poll --
      // a redundant redraft, never a permanent stall.
      assert.deepEqual(
        draftsDueOnDaemon(proposals, draftsOnDisk, attemptsOnDisk),
        [proposals[1]],
        "P-OK must be excluded (its draft already landed and is fresh); P-FAIL is due again",
      );
      assert.ok(draftsOnDisk["P-OK"] !== undefined, "the REAL (drafts-before-attempts) commit order left P-OK's draft actually on disk");

      // The FALSIFIER this claim is asserted against: had the pair committed in the OPPOSITE
      // order (attempts before drafts), this SAME crash point would instead WEDGE P-OK
      // forever -- attempts would already mark its cause attempted, but its draft never
      // landed, and nothing would ever redraft it again outside a manual `rmd inbox` force.
      const wedgedDrafts: DraftCache = { ...priorDrafts }; // P-OK's draft never committed under this hypothetical order
      const wedgedAttempts: DraftAttemptCache = { ...priorAttempts, "P-OK": draftAttemptKey(proposals[0]) }; // but attempts already committed
      assert.ok(wedgedDrafts["P-OK"] === undefined, "hypothetical reversed order: P-OK's draft never landed");
      assert.deepEqual(
        proposalsNeedingDraft(proposals, wedgedDrafts),
        proposals,
        "hypothetical reversed order: P-OK genuinely still needs a draft (none is cached)",
      );
      assert.deepEqual(
        draftsDueOnDaemon(proposals, wedgedDrafts, wedgedAttempts),
        [proposals[1]],
        "hypothetical reversed order: P-OK is silently DROPPED from `due` forever (its cause is already marked attempted) despite " +
          "having no draft to show for it -- exactly the idempotence violation the drafts-before-attempts commit order avoids",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── Claim 3: the W1-T192 idempotence property holds across a simulated crash at EVERY
// point in the pair write, not only the happy path ────────────────────────────────────────

/** Never "attempt without a matching fresh draft" -- but ONLY for a proposal whose outcome
 *  THIS poll genuinely succeeded (`successfulIds`): a genuinely FAILED outcome legitimately
 *  marks its cause attempted with no draft to show for it (W1-T192's own documented
 *  "throttle failed attempts too" design, not a defect). The property under test is
 *  narrower and precise: a crash can never turn a SUCCESSFUL draft into an attempts entry
 *  with nothing behind it. */
function assertNeverAttemptWithoutDraft(label: string, proposals: Proposal[], drafts: DraftCache, attempts: DraftAttemptCache, successfulIds: Set<string>): void {
  for (const p of proposals) {
    if (!successfulIds.has(p.id)) continue; // a failed (or untouched) cause has no such guarantee
    if (attempts[p.id] !== draftAttemptKey(p)) continue; // this cause isn't marked attempted at all -- nothing to check
    const cached = drafts[p.id];
    assert.ok(
      cached && !isDraftStale(cached, p.evidenceAnchors),
      `${label}: ${p.id}'s current cause is marked attempted but no fresh draft exists for it -- the exact idempotence ` +
        "violation W1-T241 closes (draftsDueOnDaemon would throttle it forever with nothing ever landing)",
    );
  }
}

/** A file that exists after a crash must be COMPLETE -- non-empty, valid JSON, and equal to
 *  either the pre-poll ("prior") or the post-poll ("next") full state verbatim, never
 *  something torn/partial in between. */
function assertWholeOrPrior(label: string, path: string, prior: unknown, next: unknown): void {
  if (!fsDefault.existsSync(path)) return; // never written yet is fine -- that is not torn
  const raw = fsDefault.readFileSync(path, "utf8");
  assert.ok(raw.length > 0, `${label}: ${path} exists but is EMPTY -- a torn file`);
  let parsed: unknown;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(raw);
  }, `${label}: ${path} is not valid JSON -- a torn file`);
  const asText = JSON.stringify(parsed);
  const matchesPrior = asText === JSON.stringify(prior);
  const matchesNext = asText === JSON.stringify(next);
  assert.ok(matchesPrior || matchesNext, `${label}: ${path}'s content matches NEITHER the prior nor the next full state -- a torn/partial write`);
}

const crashPoints: Array<{ label: string; install: (t: TestContext) => void; expectThrow: boolean }> = [
  {
    label: "crash before any write starts",
    expectThrow: true,
    install: (t) => {
      t.mock.method(fsDefault, "writeFileSync", () => {
        throw new Error("simulated crash: killed before any tmp write");
      });
    },
  },
  {
    label: "crash after the drafts tmp write, before the attempts tmp write",
    expectThrow: true,
    install: (t) => {
      let calls = 0;
      const real = fsDefault.writeFileSync.bind(fsDefault);
      t.mock.method(fsDefault, "writeFileSync", (path: unknown, content: unknown, ...rest: unknown[]) => {
        calls += 1;
        if (calls === 2) throw new Error("simulated crash: killed after the drafts tmp write, before the attempts tmp write");
        return real(path as string, content as string, ...(rest as []));
      });
    },
  },
  {
    label: "crash after both tmp writes, before the drafts rename",
    expectThrow: true,
    install: (t) => {
      t.mock.method(fsDefault, "renameSync", () => {
        throw new Error("simulated crash: killed before the drafts rename");
      });
    },
  },
  {
    label: "crash after the drafts rename, before the attempts rename",
    expectThrow: true,
    install: (t) => {
      let calls = 0;
      const real = fsDefault.renameSync.bind(fsDefault);
      t.mock.method(fsDefault, "renameSync", (from: unknown, to: unknown) => {
        calls += 1;
        if (calls === 2) throw new Error("simulated crash: killed after the drafts rename, before the attempts rename");
        return real(from as string, to as string);
      });
    },
  },
  {
    label: "no crash -- the happy path",
    expectThrow: false,
    install: () => {
      // no interception -- both renames run to completion
    },
  },
];

for (const cp of crashPoints) {
  test(`W1-T241 claim 3: idempotence holds when the pair write is interrupted -- ${cp.label}`, (t: TestContext) => {
    const { dir, draftsPath, attemptsPath } = tmpPair();
    try {
      const proposals = [proposal("P-EXISTING"), proposal("P-OK"), proposal("P-FAIL")];
      // Seed a pre-existing, unrelated proposal's already-successful draft -- every crash
      // point must leave IT untouched too, not merely the two this poll actually touches.
      const priorDrafts: DraftCache = { "P-EXISTING": candidate("P-EXISTING") };
      const priorAttempts: DraftAttemptCache = { "P-EXISTING": draftAttemptKey(proposals[0]) };
      writeDraftAttemptPair(draftsPath, attemptsPath, priorDrafts, priorAttempts);
      const priorDraftsRaw = fsDefault.readFileSync(draftsPath, "utf8");
      const priorAttemptsRaw = fsDefault.readFileSync(attemptsPath, "utf8");

      // This poll: P-OK's attempt succeeds, P-FAIL's fails, P-EXISTING is carried over
      // unchanged (spread), matching buildInboxDraftHook's own nextDrafts/nextAttempts shape.
      const nextDrafts: DraftCache = { ...priorDrafts, "P-OK": candidate("P-OK") };
      const nextAttempts: DraftAttemptCache = { ...priorAttempts, "P-OK": draftAttemptKey(proposals[1]), "P-FAIL": draftAttemptKey(proposals[2]) };

      cp.install(t);

      if (cp.expectThrow) {
        assert.throws(() => writeDraftAttemptPair(draftsPath, attemptsPath, nextDrafts, nextAttempts));
      } else {
        assert.doesNotThrow(() => writeDraftAttemptPair(draftsPath, attemptsPath, nextDrafts, nextAttempts));
      }

      assertWholeOrPrior(cp.label, draftsPath, JSON.parse(priorDraftsRaw), nextDrafts);
      assertWholeOrPrior(cp.label, attemptsPath, JSON.parse(priorAttemptsRaw), nextAttempts);

      const draftsOnDisk = parseDraftCache(fsDefault.existsSync(draftsPath) ? fsDefault.readFileSync(draftsPath, "utf8") : undefined);
      const attemptsOnDisk = parseDraftAttemptCache(fsDefault.existsSync(attemptsPath) ? fsDefault.readFileSync(attemptsPath, "utf8") : undefined);
      assertNeverAttemptWithoutDraft(cp.label, proposals, draftsOnDisk, attemptsOnDisk, new Set(["P-EXISTING", "P-OK"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The happy path is a meaningful positive control, not merely a vacuous pass: P-OK's cause
// really is marked attempted AND really does have a fresh draft once nothing interrupts it.
test("W1-T241 claim 3: sanity -- the happy path's invariant check is non-vacuous (a genuinely successful attempt actually satisfies it)", () => {
  const { dir, draftsPath, attemptsPath } = tmpPair();
  try {
    const proposals = [proposal("P-OK")];
    writeDraftAttemptPair(draftsPath, attemptsPath, { "P-OK": candidate("P-OK") }, { "P-OK": draftAttemptKey(proposals[0]) });
    const drafts = parseDraftCache(fsDefault.readFileSync(draftsPath, "utf8"));
    const attempts = parseDraftAttemptCache(fsDefault.readFileSync(attemptsPath, "utf8"));
    assert.equal(attempts["P-OK"], draftAttemptKey(proposals[0]), "sanity: attempts genuinely marks P-OK's cause attempted");
    assert.ok(drafts["P-OK"] && !isDraftStale(drafts["P-OK"], proposals[0].evidenceAnchors), "sanity: a fresh draft genuinely exists for it");
    assertNeverAttemptWithoutDraft("happy path", proposals, drafts, attempts, new Set(["P-OK"]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
