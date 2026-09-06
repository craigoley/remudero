# Forensics: src/lib/feedback-landing.ts

Every measured fact, incident and design argument the comments in `src/lib/feedback-landing.ts`
used to carry, archived VERBATIM when that file's comments were compacted to the plain-language
standard (`docs/comment-standard.md`).

Nothing here is a rule. `feedback-landing.ts`'s behaviour lives in the code and its tests, and
each block below is quoted exactly as it stood on `origin/main` at `8945bb7`, under a heading
naming the symbol it explained. The code keeps a one-line `// Why:` (or an inline `Why:` sentence)
pointer wherever that history still matters.

---

## Module header

`src/lib/feedback-landing.ts:1-37` at `8945bb7`, 37 comment lines.

```
/**
 * lib/feedback-landing.ts — the durable-inbox COMMIT BRIDGE (W1-T243).
 *
 * `captureFeedback()` (feedback.ts) is a PURE FILESYSTEM WRITE — the entry lands only in
 * whatever checkout ran the capture. `rmd triage` deliberately reads the entry from a
 * FRESH origin/main worktree (never `repoRoot`, which may be stale) — so a captured entry
 * was invisible to triage until a human hand-landed it via `git add` + commit + PR (the
 * `chore(feedback): land ...` precedent: PRs #591/#609/#611). NO STEP BETWEEN CAPTURE AND
 * TRIAGE COMMITTED THE ENTRY — this module is that step.
 *
 * {@link landFeedback} is the ONE choke point `captureFeedback()` calls right after its
 * write (never per-caller), so all five call sites (cli, ops alerts, issues intake,
 * panel UI, panel grill) inherit it by construction — a sixth caller inherits it too, for
 * free, just by calling `captureFeedback()`.
 *
 * BEST-EFFORT, NEVER THROWS: the local write already satisfies §7B's durability promise
 * the instant `writeFileSync` returns (an entry survives a machine reboot, is diffable,
 * grep-able); landing merely gets it onto `origin/main` sooner so triage can act on it.
 * Any failure here — no git repo, no `origin` remote, no network, no/unauthenticated
 * `gh` — is swallowed: capture must never fail because landing is unavailable (W1-T243
 * acceptance claim 3). A later capture (or a manual `rmd feedback land`, not yet built)
 * retries the same unlanded files.
 *
 * MECHANISM — plumbing only. It NEVER touches the caller's index, tracked files, or local
 * branches (the W1-T60 rule: a background/library call must not mutate operator work). The one
 * narrow working-tree mutation is the W1-T2749 queue acknowledgement: after fetching
 * `origin/main`, an untracked `plan/feedback/**` copy is removed only when Git proves the same
 * bytes are already durable at that exact upstream path. It fetches `origin/main`,
 * diffs the local `plan/feedback/**` tree against it, and — only for files that actually
 * differ — builds one new commit against a SCRATCH index (`GIT_INDEX_FILE`, never the
 * repo's real index) via `hash-object`/`write-tree`/`commit-tree`, then force-pushes it to
 * ONE shared branch (`feedback-landing`) and opens (or reuses) ONE gated PR for it — never
 * a direct push to `main` (the §2 gate invariant: "the Architect proposes, merges
 * nothing"). Rebuilding the branch fresh from origin/main's CURRENT tip every call means
 * it can never conflict and never accumulates history — it is always exactly
 * "origin/main plus whatever plan/feedback/** content is still unlanded locally".
 */
```

## DECISIONS_REL_DIR

`src/lib/feedback-landing.ts:53-64` at `8945bb7`, 12 comment lines.

```
/**
 * `plan/decisions.d` — the decision-record sibling of `plan/feedback` (W1-T191). One file PER
 * RESOLUTION (`<taskId>-<runId>.md`), never a shared growing log: `decision.autochoose`
 * (run-task.ts) used to append every resolution straight into THIS checkout's own
 * `DECISIONS.md`, which no PR was ever cut from — the exact "capture lands locally, nothing
 * commits it" defect W1-T243 already fixed for feedback. Sharding (rather than moving the
 * shared-file append into a worker's worktree) is the deliberate choice: two concurrent
 * `run-task` orchestrators each appending a line to the SAME file's end, merged one after the
 * other, is a textbook git append-conflict (the exact class W1-T122 solved for
 * `plan/tasks.yaml` by sharding) — a per-decision file makes that structurally impossible
 * instead of retrying around it.
 */
```

## LandFeedbackOpts.gh

`src/lib/feedback-landing.ts:80-86` at `8945bb7`, 7 comment lines.

```
  /**
   * Injectable `gh` exec (the W1-T119 `ghGateway` pattern, lib/status.ts) — real callers
   * omit it and get the actual `execFileSync("gh", ...)`; tests inject a fake so
   * PR-open/list/merge never hits real GitHub, while the `git` half above still runs for
   * real against a local bare "origin".
   */
```

## LandFeedbackOpts.ledgerLines

`src/lib/feedback-landing.ts:88-97` at `8945bb7`, 10 comment lines.

```
   * W1-T1000002 — the SAME hold reader the sweep's own arm path consults
   * ({@link import("./review.js").automergeHoldFromLedger}), so this file's inline
   * `gh pr merge --auto --squash` (the ONE arm-origin site {@link ensurePrOpen} owns — recon
   * question (3) of that task's rationale: this call bypasses `attemptArm`/`armAutoMerge`
   * entirely, reaching neither) honours a standing operator hold instead of arming around it.
   * Optional: omitted (every pre-existing caller/fixture), a landing PR arms exactly as it did
   * before this task — fail OPEN, matching every other optional evidence read in this codebase.
   * A hold engaged AFTER this PR was already created and armed is still caught by the sweep's
   * own converging disarm (lib/sweep.ts), which reconciles every open PR, including this one.
   */
```

## LandFeedbackResult.landed

`src/lib/feedback-landing.ts:102-106` at `8945bb7`, 5 comment lines.

```
  /** True iff the content is ON the landing branch — pushed by this call, or already there from
   *  an earlier one (see finishLanding's already-landed short-circuit). The one consumer renders
   *  this to an operator as "landed" vs "landing pending", and content sitting on the branch
   *  awaiting its gate is landed. */
```

## LandFeedbackResult.pushed

`src/lib/feedback-landing.ts:113-120` at `8945bb7`, 8 comment lines.

```
  /**
   * True iff THIS call actually force-pushed the landing branch (new or changed content).
   * False for every no-op path: nothing unlanded (`landed: false`), and the ALREADY-LANDED
   * short-circuit in {@link finishLanding} (`landed: true` with the same content already on
   * the branch, awaiting its gate). {@link sweepFeedbackLanding} uses this to tell an ACTING
   * pass (worth a detailed ledger line) from a QUIET one (worth a summary at most) — see its
   * own doc for why that split exists (W1-T530).
   */
```

## LandFeedbackResult.acknowledgement

`src/lib/feedback-landing.ts:122-126` at `8945bb7`, 5 comment lines.

```
  /**
   * Present only when this call removed one or more redundant, untracked queue copies after
   * fetched `origin/main` proved their bytes durable at the same paths. `count` is exact while
   * `paths` is deliberately bounded so one large inbox cannot create an unbounded ledger line.
   */
```

## LandingKind.ownedDir

`src/lib/feedback-landing.ts:219-223` at `8945bb7`, 5 comment lines.

```
  /**
   * The ONE repo-relative directory this kind owns. The carry-forward below is filtered to
   * it, so a landing can only ever re-stage its OWN records — never arbitrary repo content
   * that happens to differ between the stale landing branch and current origin/main.
   */
```

## finishLanding (orphaned tail doc)

`src/lib/feedback-landing.ts:302-309` at `8945bb7`, 8 comment lines. This doc sat 80+ lines above
`finishLanding` itself (before `landingPrNumberFromUrl` and `remoteBranchTree`), separated from
its symbol by an earlier refactor — the same orphaned-prose shape `docs/comment-standard.md`
calls out for `ledger.ts`. Relocated to sit directly above `finishLanding` and folded into its doc.

```
/**
 * The commit/push/open-or-reuse-PR/arm-auto-merge tail every landing call shares, regardless
 * of how its tree was built (a real working-tree scan for {@link landPending}, or purely
 * in-memory content for {@link landContent}). NEVER throws on its own — callers already run
 * inside a try/catch that folds any error into `{ landed: false, error }`, except the
 * `gh pr create` failure below, which still counts as `landed: true` (the push already
 * succeeded).
 */
```

## remoteBranchTree (orphaned doc)

`src/lib/feedback-landing.ts:310-314` at `8945bb7`, 5 comment lines. Same displacement as the
block above — sat before `landingPrNumberFromUrl` rather than before `remoteBranchTree`, the
function it actually describes. Relocated to sit directly above `remoteBranchTree`.

```
/**
 * The tree the landing branch currently carries on the remote, or `null` when that cannot be
 * determined. `null` means "push" — never "skip" — so an unreadable ref degrades to the previous
 * unconditional-push behaviour rather than silently withholding a landing.
 */
```

## landingPrNumberFromUrl

`src/lib/feedback-landing.ts:315-321` at `8945bb7`, 7 comment lines.

```
/**
 * W1-T1000002 — ANCHORED ON `/pull/<n>`, mirroring run-task.ts's own `prUrlTarget` /
 * review.ts's own `prLifecycleUrlTarget` — duplicated locally rather than imported (this file
 * must not import run-task.ts, and review.ts's own copy is private) so each consumer reads the
 * URL on its own terms, the SAME "each file reads on its own terms" idiom review.ts's own copy
 * already documents. Returns `undefined` — never a guess — on anything that is not a PR URL.
 */
```

## ensurePrOpen

`src/lib/feedback-landing.ts:335-347` at `8945bb7`, 13 comment lines.

```
/**
 * Open (or reuse) the ONE shared PR for `kind.branch`'s CURRENT tip. Shared by both
 * `finishLanding` branches below (W1-T530): the fresh-push path (content just changed) and the
 * ALREADY-LANDED short-circuit (content unchanged but no PR was ever successfully opened for it
 * — the "pushed fine, `gh pr create` failed" retry gap this split closes). Never pushes anything
 * itself — the caller already decided whether a push was needed.
 *
 * ALREADY-OPEN IS A ONE-CALL NO-OP (`gh pr list` only, no create/merge): auto-merge is armed
 * only in the SAME call that actually creates the PR, never re-armed on a later call that finds
 * it already open. Without this, EVERY quiet pass over an already-open PR would re-issue
 * `gh pr merge` — a repeated `gh` MUTATION call on a pass this task's own acceptance requires do
 * nothing observable (criterion 3).
 */
```

## ensurePrOpen — auto-merge hold consult

`src/lib/feedback-landing.ts:369-372` at `8945bb7`, 4 comment lines. Restated the same
W1-T1000002/recon-question-3 fact already carried by `LandFeedbackOpts.ledgerLines`'s own doc
above; compacted to a one-line pointer at the call site instead of repeating it.

```
    // W1-T1000002 — THE SAME HOLD READER THE SWEEP'S ARM PATH CONSULTS, at the ONE site this
    // file ever arms auto-merge (recon question (3): this call reaches neither `attemptArm` nor
    // `armAutoMerge`, so it needed its own consult rather than inheriting one). Omitted
    // `ledgerLines` fails OPEN — arms exactly as before this task.
```

## finishLanding — already-landed short-circuit

`src/lib/feedback-landing.ts:398-425` at `8945bb7`, 28 comment lines.

```
  // ── ALREADY-LANDED SHORT-CIRCUIT: push only when the CONTENT differs. ────────────────────────
  // The tree is deterministic — `read-tree origin/main` plus the same blobs yields the same
  // `treeSha` on every call for unchanged content. The COMMIT is not: `commit-tree` stamps the
  // current time, so an unchanged landing minted a fresh sha and force-pushed it EVERY call.
  //
  // MEASURED ON PR #1113, and it is a deadlock rather than mere noise. The daemon calls this each
  // poll, so the branch head moved every ~60s (`02e270a4 → 187cf42f → 379c4160 → fa15cc73` in four
  // minutes, one commit each, identical message). Every push cancelled the in-flight CI run —
  // `CI gate 16:28:37 -> CANCELLED 16:29:51`, superseded before it could finish — so `ci-gate`, a
  // REQUIRED context, could never complete and `remudero-review` never posted (`count=0`, no
  // settled sha to post against). The PR therefore could not merge, which kept the files unlanded,
  // which kept this function pushing. Self-sustaining.
  //
  // Comparing the TREE and not the commit is the whole point: the commit sha is guaranteed to
  // differ, the tree is guaranteed not to. A parent-only difference (origin/main moved under an
  // unchanged landing) deliberately does NOT force a push either — protection is `strict: false`,
  // so a behind-but-mergeable branch is fine, and re-pushing to advance the parent is exactly the
  // churn this removes.
  //
  // FAILS OPEN: an unreadable/absent remote ref (the first landing for this branch, or no
  // remote-tracking ref configured) falls through to the push, i.e. to the previous behaviour.
  //
  // W1-T530: unchanged content does not mean nothing is left to do — a PRIOR call may have
  // pushed this exact tree and then had its OWN `gh pr create` fail (offline `gh`, no auth).
  // Without retrying the PR here, that entry sits on the branch forever with no open PR and no
  // further push ever fires again for IDENTICAL content — exactly the retry gap this task's
  // level-triggered sweep exists to close. `ensurePrOpen` is a no-op besides one `gh pr list`
  // when a PR is already open (the common case), so this costs nothing on a truly quiet pass.
```

## finishLanding — force-push guard (#954)

`src/lib/feedback-landing.ts:448-453` at `8945bb7`, 6 comment lines.

```
  // ONE shared branch per kind, always rebuilt from origin/main's CURRENT tip — force-push
  // is safe (and required) because this branch is bot-owned and never diverges by history,
  // only by content, so it can never actually conflict.
  // #954 GUARD, CARRIED ACROSS THE finishLanding REFACTOR: main added this inline to the body
  // this function replaced, so the merge had to move it WITH the code — resolving to either
  // side alone would have silently dropped it and reopened the hole #954 closed.
```

## landPending (orphaned doc, above LandPendingOpts)

`src/lib/feedback-landing.ts:467-475` at `8945bb7`, 9 comment lines. Sat above the
`LandPendingOpts` interface rather than the `landPending` function it describes — another
instance of the orphaned-prose displacement noted above. Relocated to sit directly above
`landPending`.

```
/**
 * Best-effort acknowledge any byte-identical, untracked queue copy already on fetched
 * `origin/main`, then land every remaining `plan/feedback/**` file present in `root`'s REAL
 * working tree but absent or changed upstream onto the shared `feedback-landing` PR. NEVER throws:
 * every failure — not a git checkout, no `origin` remote, offline, `gh`
 * unavailable/unauthenticated — resolves to `{ landed: false, files: [], error }` instead.
 * Scans disk because `captureFeedback`'s local copy is the durable buffer §7B promises even
 * offline — unlike {@link landContent}, this one legitimately needs a real file to read.
 */
```

## landPending — scratch-index discipline

`src/lib/feedback-landing.ts:506-508` at `8945bb7`, 3 comment lines.

```
    // Build the new commit against a SCRATCH index — never the caller's real index or tracked
    // work. W1-T2749's proved-redundant untracked queue acknowledgement above is the sole narrow
    // working-tree mutation; the landing commit itself retains W1-T60's isolation.
```

## sweepFeedbackLanding

`src/lib/feedback-landing.ts:544-571` at `8945bb7`, 28 comment lines.

```
/**
 * THE LEVEL-TRIGGERED BACKSTOP OVER {@link landFeedback} (W1-T530, ratifies P22 the same way
 * `sweep.credit_backfill` already did for merge credit). `landFeedback` is the bridge's
 * mechanism and it is already correct and idempotent (see its own doc); the ONE thing missing
 * is a caller that runs it when no capture is happening at all — `captureFeedback` (feedback.ts)
 * is its only call site, so an entry captured while landing was unavailable (offline, no `gh`,
 * `gh pr create` refused — all swallowed by contract) or on a host that never captures again is
 * stranded off `origin/main` forever, and `rmd triage` refuses it as not-on-origin because it
 * deliberately reads from a fresh origin/main worktree, never `root`.
 *
 * A THIN WRAPPER, NOT A REWRITE: this re-runs the same whole-inbox scan/reconcile and reports
 * W1-T2749's exact-byte queue acknowledgements — nothing about the scratch-index discipline
 * (W1-T60), the
 * rebuild-from-current-origin/main force-push, or the shared `feedback-landing` branch/PR
 * changes. Calling it twice over unchanged state is safe by the SAME idempotence
 * `findPendingLandingPr` + the tree-compare short-circuit in {@link finishLanding} already give
 * `landFeedback` — see {@link LandFeedbackResult.pushed}. Best-effort like every other rung
 * beside it (`sweep`/`sweepOrphans`/`alertPoll`, daemon.ts): a throw here never reaches the
 * caller, resolving instead to `landFeedback`'s own `{ landed: false, files: [], error }`.
 *
 * OBSERVABILITY IS THE ACTING/QUIET SPLIT `sweep.credit_backfill` already uses (sweep.ts): a
 * pass that actually force-pushed new/changed content (`pushed: true`) names the files landed
 * and the PR url — that is the one line worth reading. A pass that pushed nothing — nothing
 * unlanded at all, OR the same content already sitting on the branch awaiting its gate — logs a
 * count-only summary instead, so the daemon's own poll cadence (as low as tens of seconds)
 * cannot flood the ledger with a repeated file list for content that has not changed since the
 * last time this ran.
 */
```

## landContent

`src/lib/feedback-landing.ts:611-625` at `8945bb7`, 15 comment lines.

```
/**
 * The IN-MEMORY sibling of {@link landPending}: lands explicit `(path, content)` pairs that
 * are NEVER written to `root`'s real working tree — not merely "untouched after writing"
 * (landPending's guarantee for feedback's own local durable copy) but literally never written
 * there at all. This is the piece that makes W1-T191 actually work: a real local write of an
 * ALREADY-TRACKED file (a status flip) or a brand-new one (a decision record) would itself
 * count as dirt in `checkCliFreshness`'s `git status --porcelain` the instant it lands on
 * disk — landing it via a bridge afterward doesn't undo that, since the bridge (by design,
 * the W1-T60 rule) never touches the working tree either. So the fix is to never put it there
 * to begin with: content is staged into a scratch tmp file OUTSIDE `root` (under `os.tmpdir()`)
 * purely so `git hash-object -w` has a path to read bytes from — the blob it writes goes to
 * the repo's OBJECT DATABASE (`root/.git/objects`), never to `root`'s working tree. Same
 * skip-if-already-identical-upstream idempotence and NEVER-THROWS contract as
 * {@link landPending}.
 */
```

## landContent — carry-forward rationale

`src/lib/feedback-landing.ts:647-653` at `8945bb7`, 7 comment lines.

```
    // CARRY FORWARD whatever an EARLIER, still-unmerged call already pushed to this shared
    // branch (W1-T191 acceptance criterion 2): unlike {@link landPending} (which naturally
    // re-includes an earlier call's still-pending files on every re-scan of `root`'s real
    // disk), this content-only path has no disk to re-scan — without this, a second call
    // landing before the first call's PR merges would force-push a tree missing the first
    // call's content entirely, silently discarding it. Anything already merged into
    // origin/main is skipped (no need to carry forward what's already landed for real).
```

## landContent — scoped carry-forward incident (PR #1025)

`src/lib/feedback-landing.ts:660-668` at `8945bb7`, 9 comment lines.

```
        // SCOPED TO THE DIRECTORY THIS KIND OWNS. `ls-tree -r` lists the branch's ENTIRE repo
        // tree, and the branch was built from an OLDER origin/main, so every file that changed
        // on main since carries a differing blob. Unfiltered, the loop below re-staged each of
        // them at its STALE value -- a silent revert of merged work with a correct parent, which
        // is exactly what commit e8443ad (PR #1025) shipped on 2026-07-31: it reverted 6 src/
        // and 2 test/ files (-515 lines, undoing PRs #1020/#1008/#1017) plus 274 lines of the
        // append-only DECISIONS.md, and was caught only because the deletions happened not to
        // compile. Carrying forward anything outside this directory is never correct: the bridge
        // owns these records and nothing else.
```

## decisionRecordRelPath

`src/lib/feedback-landing.ts:725-730` at `8945bb7`, 5 comment lines.

```
/**
 * `<root>/plan/decisions.d/<taskId>-<runId>.md` — one file per decision.autochoose resolution
 * (never a shared growing log), so concurrent `run-task` runs across different tasks/runs can
 * never collide on the same path. Never actually written to disk (see {@link recordDecision})
 * — this is the path it lands at on `origin/main`, via the `decisions-landing` bridge.
 */
```

## recordDecision

`src/lib/feedback-landing.ts:760-771` at `8945bb7`, 12 comment lines.

```
/**
 * Land one decision-record shard (harness-owned, deterministic — never delegated to the
 * worker's own commit, which the resume prompt never even mentions) via {@link landContent}.
 * DELIBERATELY never writes `plan/decisions.d/**` to `root`'s real working tree at all — see
 * {@link landContent}'s own doc for why a real local write would itself be the dirt this task
 * removes. Best-effort like every other write in this module: a landing failure (offline, no
 * `gh`) means the record exists ONLY as the `decision.autochoose` ledger line (already
 * ledgered regardless — the RECEIPT half of standing rule 22's receipt/claim split) until a
 * later resolution's call retries; there is no local file for a human to grep in the meantime,
 * which is the one durability property this trades away in exchange for never dirtying the
 * checkout (out of scope here — see the accompanying follow-up).
 */
```

## landFeedbackStatusContent

`src/lib/feedback-landing.ts:781-793` at `8945bb7`, 13 comment lines.

```
/**
 * Land one feedback entry's already-serialized YAML content via {@link landContent} — the
 * write-site-2 (console `POST /v1/feedback/decision`) sibling of {@link recordDecision}.
 * DELIBERATELY never writes to `root`'s real working tree: `setFeedbackStatus` calls this
 * INSTEAD OF its normal `writeFileSync` when `opts.land` is set, because writing the flip to
 * an ALREADY-TRACKED file locally would leave it `M`-modified in `checkCliFreshness`'s `git
 * status --porcelain` — the exact dirt W1-T191 removes — even though `landFeedback`'s bridge
 * would separately get it onto `origin/main`. The trade: a caller that reads `root`'s own
 * `plan/feedback/<id>.yaml` again right after (e.g. the console's own feedback list) won't see
 * the flip until this checkout's next self-sync past the landing PR's merge — out of scope for
 * this task's acceptance bar (a clean working tree, not read-your-own-write), noted as a
 * follow-up.
 */
```

## findPendingLandingPr

`src/lib/feedback-landing.ts:803-810` at `8945bb7`, 8 comment lines.

```
/**
 * The URL of the currently-open shared landing PR for `opts.branch` (default
 * {@link LANDING_BRANCH}), if any — best-effort, never throws (a missing/unauthenticated `gh`
 * resolves to `undefined`, same as "no PR yet"). Used by {@link landFeedback}/
 * {@link landDecisions} (to reuse rather than duplicate an open PR) and by `rmd triage`'s
 * exit-2 branch (to name the pending feedback-landing PR instead of the misleading "no such
 * feedback entry" — W1-T243 acceptance claim 4).
 */
```
