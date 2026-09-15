// test/feedback-record-monotonic.test.ts — W1-T3561.
//
// THE DEFECT. `landPending`'s `localUnlanded()` staged a record by blob INEQUALITY alone
// (`remoteSha !== localSha`) — "mine differs, therefore mine wins", with no notion of which copy
// was further along the §7B status lifecycle. Measured, not guessed: PR #5382 merged
// `fb-1789282068794-2f0b7d` at `status: grilling`; feedback-landing PR #5383 then landed a STALE
// local copy back over it, resetting the entry to `status: new` and breaking `POST /v1/feedback`'s
// `replyTo` route (it requires the target sit at `grilling`). `landContent`'s sibling check
// (`remoteSha === blobSha`) has the exact same hole.
//
// THIS FILE proves the fix two ways: (1) `mergeFeedbackRecord` (feedback-record-merge.ts) is
// exhaustively tested as a pure table over the six §7B statuses — no git, no fixture, just two
// byte strings; (2) both real writers (`landPending`'s disk scan, `landContent`'s console-decision
// sibling `landFeedbackStatusContent`) are driven end to end against a real local git remote (no
// network anywhere, only `gh` faked) to prove the predicate is actually WIRED, not just correct in
// isolation.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { FEEDBACK_STATUSES, type FeedbackStatus } from "../src/lib/feedback.js";
import { mergeFeedbackRecord } from "../src/lib/feedback-record-merge.js";
import { LANDING_BRANCH, landFeedback, landFeedbackStatusContent } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo } from "./helpers/git-repo.js";

// ── Section 1: mergeFeedbackRecord — a pure table over the six §7B statuses ─────────────────

/** A minimal, schema-shaped `plan/feedback/<id>.yaml` entry, serialized exactly the way
 *  `feedback.ts`'s `stringifyYaml(entry)` would. Extra fields are OPTIONAL history metadata. */
function entryYaml(fields: { status: FeedbackStatus; id?: string; raw?: string } & Record<string, unknown>): string {
  const { status, id = "fb-test", raw = "fixture text", ...rest } = fields;
  return stringifyYaml({
    id,
    ts: "2026-01-01T00:00:00.000Z",
    raw,
    attachments: [],
    origin: "cli",
    status,
    proposal_pr: null,
    ...rest,
  });
}

test("mergeFeedbackRecord: over all 36 (upstream, local) status pairs, a local rank EARLIER than upstream's is refused, never anything else", () => {
  for (const upstreamStatus of FEEDBACK_STATUSES) {
    for (const localStatus of FEEDBACK_STATUSES) {
      const upstreamRank = FEEDBACK_STATUSES.indexOf(upstreamStatus);
      const localRank = FEEDBACK_STATUSES.indexOf(localStatus);
      const decision = mergeFeedbackRecord(entryYaml({ status: upstreamStatus }), entryYaml({ status: localStatus }));
      if (localRank < upstreamRank) {
        assert.equal(
          decision.kind,
          "refuse",
          `upstream=${upstreamStatus} local=${localStatus}: a local status earlier in the §7B lifecycle must be refused, got ${decision.kind}`,
        );
        assert.match(decision.kind === "refuse" ? decision.reason : "", /earlier/i);
      } else {
        assert.notEqual(
          decision.kind,
          "refuse",
          `upstream=${upstreamStatus} local=${localStatus}: a local status AT or AFTER upstream's must never be refused, got refuse`,
        );
      }
    }
  }
});

test("mergeFeedbackRecord: a strictly later local status (new -> grilling) is take-local, exactly as before this task", () => {
  const decision = mergeFeedbackRecord(entryYaml({ status: "new" }), entryYaml({ status: "grilling" }));
  assert.deepEqual(decision, { kind: "take-local" });
});

test("mergeFeedbackRecord: no upstream record at all is take-local trivially — a brand-new capture", () => {
  const decision = mergeFeedbackRecord(undefined, entryYaml({ status: "new" }));
  assert.deepEqual(decision, { kind: "take-local" });
});

test("mergeFeedbackRecord: byte-identical copies are keep-upstream — nothing to gain by re-staging", () => {
  const bytes = entryYaml({ status: "proposed" });
  const decision = mergeFeedbackRecord(bytes, bytes);
  assert.deepEqual(decision, { kind: "keep-upstream" });
});

test("mergeFeedbackRecord: same rank, upstream carries transition metadata the local copy lacks -> refused, naming the field", () => {
  const upstream = entryYaml({ status: "answered", answered_by: "fb-reply-1", reply_to: null });
  const local = entryYaml({ status: "answered" }); // no answered_by at all
  const decision = mergeFeedbackRecord(upstream, local);
  assert.equal(decision.kind, "refuse");
  assert.match(decision.kind === "refuse" ? decision.reason : "", /answered_by/);
});

test("mergeFeedbackRecord: same rank, LOCAL carries metadata upstream lacks -> take-local (the tie-break is explicit, not \"whichever ran last\")", () => {
  const upstream = entryYaml({ status: "proposed" });
  const local = entryYaml({ status: "proposed", summary: { headline: "h", what_happened: "w", decision: "d", options: [] } });
  const decision = mergeFeedbackRecord(upstream, local);
  assert.deepEqual(decision, { kind: "take-local" });
});

test("mergeFeedbackRecord: same rank, neither side ahead on history fields -> keep-upstream (stable, not left to caller order)", () => {
  const upstream = entryYaml({ status: "proposed", raw: "upstream's own raw text" });
  const local = entryYaml({ status: "proposed", raw: "a locally-edited raw text" });
  const decision = mergeFeedbackRecord(upstream, local);
  assert.deepEqual(decision, { kind: "keep-upstream" });
});

test("mergeFeedbackRecord: unparseable YAML on either side refuses rather than guessing a winner", () => {
  const valid = entryYaml({ status: "new" });
  assert.equal(mergeFeedbackRecord(valid, "not: [valid yaml").kind, "refuse");
  assert.equal(mergeFeedbackRecord("not: [valid yaml", valid).kind, "refuse");
});

test("mergeFeedbackRecord: a missing/unrecognised status on either side refuses — never orders against ts (the falsifier's own trap)", () => {
  // The falsifier explicitly forbids ordering off `ts` (capture time, never moves on a status
  // transition) — an entry with no recognisable status must refuse, not silently fall back to it.
  const decision = mergeFeedbackRecord("id: fb-x\nts: '2020-01-01T00:00:00.000Z'\n", "id: fb-x\nts: '2026-01-01T00:00:00.000Z'\n");
  assert.equal(decision.kind, "refuse");
});

// ── Section 2: the real writers, end to end — no stub over either mergeFeedbackRecord OR the ──
// ── git/gh plumbing; only `gh` is faked, exactly like every other feedback-landing*.test.ts. ──

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

/** A fake `gh` — no real GitHub call anywhere; tracks every invocation for assertions. */
function fakeGh(prUrl: string) {
  const calls: string[][] = [];
  let createCount = 0;
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return createCount > 0 ? JSON.stringify([{ url: prUrl }]) : JSON.stringify([]);
    }
    if (args[0] === "pr" && args[1] === "create") {
      createCount++;
      return `Creating pull request for ${LANDING_BRANCH} into main in o/r\n${prUrl}\n`;
    }
    if (args[0] === "pr" && args[1] === "merge") return "";
    throw new Error(`unexpected gh call in test fixture: ${JSON.stringify(args)}`);
  };
  return { gh, calls, createCount: () => createCount };
}

/** Fast-forward the bare origin's `main` to the landing branch's current tip — the same
 *  `simulateMerge` shape test/feedback-landing.test.ts already established, standing in for the
 *  gate actually merging the landing PR. */
function simulateMerge(bareOrigin: string): void {
  execFileSync("git", ["--git-dir", bareOrigin, "update-ref", "refs/heads/main", `refs/heads/${LANDING_BRANCH}`]);
}

function writeEntry(root: string, id: string, fields: Parameters<typeof entryYaml>[0]): void {
  mkdirSync(join(root, "plan", "feedback"), { recursive: true });
  writeFileSync(join(root, "plan", "feedback", `${id}.yaml`), entryYaml({ id, ...fields }));
}

function readOnBranch(bareOrigin: string, branch: string, relPath: string): string {
  return execFileSync("git", ["--git-dir", bareOrigin, "show", `${branch}:${relPath}`], { encoding: "utf8" });
}

// ── Acceptance criterion 2 (and 1, 3, 4): source A at new, source B advances to grilling and ──
// ── lands, A's later attempt is refused, origin keeps grilling + its metadata, nothing arms. ──

test("W1-T3561: source A stuck at `new` cannot overwrite origin/main once source B has landed it at `grilling` with reply metadata — refused, reported, never armed", () => {
  const bareOrigin = gitRepo({ bare: true, kind: "monotonic-origin" });
  const seed = gitRepo({ kind: "monotonic-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed");
  seed.addRemote("origin", bareOrigin.dir);
  seed.git("push", "--quiet", "origin", "main");

  const id = "fb-1789300000000-regress";
  const rootA = gitRepo({ cloneFrom: bareOrigin.dir, kind: "monotonic-root-a" });
  writeEntry(rootA.dir, id, { status: "new" });

  // A lands its brand-new capture first — nothing upstream yet, take-local trivially.
  const { gh: ghA } = fakeGh("https://github.com/o/r/pull/601");
  const a1 = withLiveWritesAllowed(() => landFeedback(rootA.dir, { gh: ghA }));
  assert.equal(a1.landed, true, "sanity: A's own fresh capture lands normally");
  simulateMerge(bareOrigin.dir); // the gate merges — origin/main now really holds `status: new`

  // B clones the now-advanced origin/main (so its local copy of the SAME record starts at `new`,
  // matching upstream) and advances it to `grilling` with reply-thread metadata attached — the
  // exact shape PR #5382/#5383 lost.
  const rootB = gitRepo({ cloneFrom: bareOrigin.dir, kind: "monotonic-root-b" });
  writeEntry(rootB.dir, id, { status: "grilling", thread_id: "thread-42" });
  const { gh: ghB } = fakeGh("https://github.com/o/r/pull/602");
  const b1 = withLiveWritesAllowed(() => landFeedback(rootB.dir, { gh: ghB }));
  assert.equal(b1.landed, true, "sanity: B's genuine advance lands normally");
  simulateMerge(bareOrigin.dir); // origin/main now really holds `status: grilling` + thread_id

  assert.match(readOnBranch(bareOrigin.dir, "main", `plan/feedback/${id}.yaml`), /status: grilling/);

  // A NEVER updated its own local copy — it is still sitting at `new` on disk, exactly the
  // "stale local copy" the rationale measures. A later poll/capture on A's host attempts to land
  // that same stale file again.
  const branchTipBeforeA2 = execFileSync("git", ["--git-dir", bareOrigin.dir, "rev-parse", `refs/heads/${LANDING_BRANCH}`], {
    encoding: "utf8",
  }).trim();
  const { gh: ghA2, calls: ghA2Calls } = fakeGh("https://github.com/o/r/pull/603");
  const a2 = withLiveWritesAllowed(() => landFeedback(rootA.dir, { gh: ghA2 }));

  // Criterion 1 & 2: refused, not merged — origin/main still holds `grilling` and its metadata.
  assert.equal(a2.landed, false, "A's stale, backward-moving landing must not be reported as landed");
  const onMain = readOnBranch(bareOrigin.dir, "main", `plan/feedback/${id}.yaml`);
  assert.match(onMain, /status: grilling/, "origin/main must still hold `grilling` after A's refused attempt");
  assert.match(onMain, /thread_id: thread-42/, "the reply-thread metadata B's landing attached must survive A's refused attempt");

  // Criterion 3: the refusal is reported on the RESULT, never swallowed.
  assert.ok(a2.refused && a2.refused.length === 1, `expected exactly one refused record, got: ${JSON.stringify(a2.refused)}`);
  assert.equal(a2.refused![0].path, `plan/feedback/${id}.yaml`);
  assert.match(a2.refused![0].reason, /earlier/i);

  // Criterion 4: nothing about A's refused attempt ever reached `gh` at all — no `pr create`, no
  // `pr merge`, and the landing branch's tip did not move (it can never be re-armed on this tree).
  assert.equal(ghA2Calls.length, 0, "a wholly-refused landing must never even ask gh anything");
  const branchTipAfterA2 = execFileSync("git", ["--git-dir", bareOrigin.dir, "rev-parse", `refs/heads/${LANDING_BRANCH}`], {
    encoding: "utf8",
  }).trim();
  assert.equal(branchTipAfterA2, branchTipBeforeA2, "the landing branch must not move on a wholly-refused attempt");
});

// ── Acceptance criterion 5: a genuinely newer local record still lands exactly as before ─────

test("W1-T3561: a genuinely newer local record (new -> grilling, same root) still lands exactly as it did before this task", () => {
  const bareOrigin = gitRepo({ bare: true, kind: "monotonic-fwd-origin" });
  const seed = gitRepo({ kind: "monotonic-fwd-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed");
  seed.addRemote("origin", bareOrigin.dir);
  seed.git("push", "--quiet", "origin", "main");

  const id = "fb-1789300000001-advance";
  const root = gitRepo({ cloneFrom: bareOrigin.dir, kind: "monotonic-fwd-root" });
  writeEntry(root.dir, id, { status: "new" });

  const { gh: gh1 } = fakeGh("https://github.com/o/r/pull/604");
  const first = withLiveWritesAllowed(() => landFeedback(root.dir, { gh: gh1 }));
  assert.equal(first.landed, true);
  simulateMerge(bareOrigin.dir);

  // The SAME root now genuinely advances its own record.
  writeEntry(root.dir, id, { status: "grilling" });
  const { gh: gh2, createCount } = fakeGh("https://github.com/o/r/pull/605");
  const second = withLiveWritesAllowed(() => landFeedback(root.dir, { gh: gh2 }));

  assert.equal(second.landed, true, "a genuine advance must still land");
  assert.equal(second.refused, undefined, "a genuine advance is never reported as refused");
  assert.equal(createCount(), 1, "the advance opened its own landing PR normally");
  simulateMerge(bareOrigin.dir);
  assert.match(readOnBranch(bareOrigin.dir, "main", `plan/feedback/${id}.yaml`), /status: grilling/);
});

// ── Acceptance criterion 6: the console decision write path (landFeedbackStatusContent) obeys ──
// ── the SAME predicate as the disk-scanning path, not a separate, unguarded inequality check. ──

test("W1-T3561: landFeedbackStatusContent (the console POST /v1/feedback/decision path) refuses a regressing write the same way landPending does", () => {
  const bareOrigin = gitRepo({ bare: true, kind: "monotonic-console-origin" });
  const seed = gitRepo({ kind: "monotonic-console-seed" });
  const id = "fb-1789300000002-console";
  mkdirSync(join(seed.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "feedback", `${id}.yaml`), entryYaml({ id, status: "grilling" }));
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed a grilling entry");
  seed.addRemote("origin", bareOrigin.dir);
  seed.git("push", "--quiet", "origin", "main");

  const root = gitRepo({ cloneFrom: bareOrigin.dir, kind: "monotonic-console-root" });

  // The console attempts to write this SAME record back at `new` — the exact regression shape
  // `landContent`'s old `remoteSha === blobSha` check could not see (the blobs plainly differ).
  const { gh, calls } = fakeGh("https://github.com/o/r/pull/606");
  const relPath = `plan/feedback/${id}.yaml`;
  const result = withLiveWritesAllowed(() =>
    landFeedbackStatusContent(root.dir, relPath, entryYaml({ id, status: "new" }), { gh }),
  );

  assert.equal(result.landed, false, "a regressing console write must not be reported as landed");
  assert.ok(result.refused && result.refused.length === 1, `expected one refused record, got: ${JSON.stringify(result.refused)}`);
  assert.equal(result.refused![0].path, relPath);
  assert.equal(calls.length, 0, "a wholly-refused console write must never reach gh");
  assert.match(readOnBranch(bareOrigin.dir, "main", relPath), /status: grilling/, "origin/main is untouched by the refused write");

  // The FORWARD case through the exact same call still works — proposed -> accepted, same as
  // test/feedback-landing.test.ts's own W1-T191 acceptance 5 coverage, pinned here too so this
  // file's own regression lock does not accidentally block every console write.
  const id2 = "fb-1789300000003-console-fwd";
  const seed2 = gitRepo({ kind: "monotonic-console-seed-fwd" });
  const bareOrigin2 = gitRepo({ bare: true, kind: "monotonic-console-origin-fwd" });
  mkdirSync(join(seed2.dir, "plan", "feedback"), { recursive: true });
  writeFileSync(join(seed2.dir, "plan", "feedback", `${id2}.yaml`), entryYaml({ id: id2, status: "proposed" }));
  seed2.git("add", "-A");
  seed2.git("commit", "--quiet", "-m", "chore: seed a proposed entry");
  seed2.addRemote("origin", bareOrigin2.dir);
  seed2.git("push", "--quiet", "origin", "main");
  const root2 = gitRepo({ cloneFrom: bareOrigin2.dir, kind: "monotonic-console-root-fwd" });
  const { gh: gh2 } = fakeGh("https://github.com/o/r/pull/607");
  const relPath2 = `plan/feedback/${id2}.yaml`;
  const forward = withLiveWritesAllowed(() =>
    landFeedbackStatusContent(root2.dir, relPath2, entryYaml({ id: id2, status: "accepted" }), { gh: gh2 }),
  );
  assert.equal(forward.landed, true, "a forward console write must still land normally");
  assert.equal(forward.refused, undefined);
  assert.match(readOnBranch(bareOrigin2.dir, LANDING_BRANCH, relPath2), /status: accepted/);
});
