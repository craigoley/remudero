# Forensics: src/lib/github-event-wake.ts

Every measured fact, incident and design argument the comments in `src/lib/github-event-wake.ts`
used to carry, archived VERBATIM when that file's comments were compacted to the plain-language
standard (`docs/comment-standard.md`).

Nothing here is a rule. The webhook wake's behaviour lives in the code, and each block below is
quoted exactly as it stood on `origin/main` at `2d6b3cda`, under a heading naming the symbol it
explained. The code keeps a one-line `// Why:` pointer wherever that history still matters.

---

## module header

`src/lib/github-event-wake.ts:1-54` at `2d6b3cda`, 54 comment lines.

```
/**
 * lib/github-event-wake.ts — the signed GitHub-event wake (W1-T2568, MASTER-PLAN, plan_refs
 * W1-T463/W1-T473/W1-T526/W1-T1272/W1-T2430/W1-T2519).
 *
 * THE GAP THIS CLOSES: the daemon's full sweep (`runGatedSweep`/`deps.sweep`, lib/daemon.ts)
 * already classifies and acts on every open PR's disposition, but nothing outside the daemon's
 * own `pollIntervalMs` timer ever tells it GitHub state changed — a check completion, a review,
 * a push or a close is invisible until the next scheduled poll (up to 60s late) even when both
 * the daemon and the console are otherwise idle. This module is an EARLY WAKE for that SAME
 * level-triggered reconciliation, never a second one: it authenticates a GitHub repository
 * webhook delivery, writes ONE durable "a wake happened" marker, and gives the daemon a way to
 * skip the REMAINDER of its current poll wait — the ordinary timed poll, the full-sweep
 * retrigger and every existing STOP/PAUSE/headroom gate are completely untouched.
 *
 * THREE PIECES, each independently testable, composed by the two real callers:
 *
 * 1. `createGitHubEventWakeHandler` — a self-authenticated {@link Route} (see
 *    `service.ts`'s `Route.selfAuthenticated`) for `POST /v1/hooks/github`, mounted by
 *    `serve.ts` on the console/service process (`remudero-serve`). Verifies
 *    `X-Hub-Signature-256` (raw-body HMAC-SHA256, constant-time compare) BEFORE trusting
 *    anything else, bounds the body before buffering it, validates JSON/repository identity/
 *    event+action against a small allowlist/delivery id, deduplicates by `X-GitHub-Delivery`,
 *    and — on acceptance only — atomically writes ONE `state/SWEEP_WAKE_REQUESTED` marker. It
 *    NEVER calls GitHub, runs a sweep, or blocks on the daemon: every response is bounded by
 *    this handler's own synchronous-ish work, well inside GitHub's 10-second delivery timeout.
 *
 * 2. The marker primitives (`sweepWakeMarkerPath`/`readSweepWakeMarker`/
 *    `writeSweepWakeMarkerAtomic`/`consumeSweepWakeMarker`) — plain fs helpers over one JSON
 *    file, atomically written (temp file + rename) so a concurrent reader never observes a
 *    torn write. The file lives under the shared state directory both `remudero-daemon` and
 *    `remudero-serve` mount read-write (recon, 2026-09-01: a planted-file `fs.watch` probe
 *    across that exact container boundary fired immediately), which is the whole transport —
 *    no socket, no second listener, no signal.
 *
 * 3. The daemon-side wake mechanics (`createSweepWakeSignal`/`watchSweepWakeMarker`/
 *    `wireSweepWakeToDaemon`) — consumed by `run-task.ts`'s `daemonCommand`. `createSweepWakeSignal`
 *    is PURE (no fs) and does the one load-bearing thing: wrap `DaemonDeps.sleep` so it also
 *    resolves the moment a wake fires (or immediately, if one is already pending), racing
 *    alongside the ordinary timeout rather than replacing it. Every idle wait in `daemon.ts`'s
 *    poll loop already funnels through `deps.sleep` (the STOP/PAUSE branches, every "nothing
 *    runnable" idle branch, the backoff branches) — wrapping that ONE dependency wakes the
 *    SAME loop, through the SAME `runGatedSweep`/`deps.sweep` call, under the SAME cross-call
 *    mutex, wall-clock bound, ledger effects and STOP/PAUSE checks the timer already has, with
 *    ZERO changes to `daemon.ts` itself (which stays fs-free by its own header contract).
 *    `watchSweepWakeMarker` is the impure fs.watch half that turns a marker WRITE into a
 *    `signal.wake()` call; `wireSweepWakeToDaemon` composes both plus the boot-time marker
 *    check into the one `{ sleep, close }` pair `daemonCommand` swaps in for its own `sleep`.
 *
 * WHAT THIS MODULE DELIBERATELY NEVER DOES (design vi/viii): call GitHub, decide a PR's
 * disposition, select a merge method, bypass the durable merge hold, or replace the timer poll.
 * A missed/failed webhook is recovered by the very next ordinary poll — this module never
 * claims exactly-once delivery, and a marker it writes is read ONLY as "something may have
 * changed", never as the queue's actual state.
 */
```

## ALLOWLISTED_PULL_REQUEST_ACTIONS

`src/lib/github-event-wake.ts:71-74` at `2d6b3cda`, 4 comment lines.

```
/** GitHub's real `pull_request` webhook `action` strings this daemon's sweep can act on — an
 *  open/reopen, a synchronize (new commits), an edit (title/body), a ready/draft transition, or
 *  a close. Every OTHER `pull_request` action (labeled, assigned, review_requested, …) changes
 *  nothing the sweep's disposition rules read, so it is deliberately NOT here. */
```

## isAllowlistedGithubEvent

`src/lib/github-event-wake.ts:85-93` at `2d6b3cda`, 9 comment lines.

```
/**
 * True iff `event`+`action` is one this daemon's sweep can actually act on differently as a
 * result — design (ii)'s minimum event set. `check_run` only in its terminal `completed` state
 * (an in-progress run changes nothing a disposition reads); `status` carries no `action` field
 * at all (GitHub's Status API predates the actions convention), so its mere presence, already
 * gated by the event-name allowlist below, is the whole signal; `pull_request_review` on all
 * three actions GitHub documents: `submitted`, `edited`, and `dismissed`. Each can change the
 * review evidence the next level-triggered sweep reads.
 */
```

## verifyGithubSignature

`src/lib/github-event-wake.ts:113-119` at `2d6b3cda`, 7 comment lines.

```
/**
 * GitHub's documented `X-Hub-Signature-256` check: HMAC-SHA256 of the RAW body (never the
 * parsed/re-serialized JSON, which could reorder or drop bytes) under the configured secret,
 * compared constant-time against the header's `sha256=<hex>` value. Any malformed header
 * (missing prefix, non-hex, wrong length) is a plain `false` — never a throw, so a probe with a
 * garbage header degrades to an ordinary refusal like any other invalid signature.
 */
```

## DeliveryDedupStore

`src/lib/github-event-wake.ts:157-160` at `2d6b3cda`, 4 comment lines.

```
/** One recent-delivery dedup window, capacity-bounded (design iv: "the debounce is a bounded
 *  `plan/policy.yaml` row, not a literal beside `fs.watch`" — see policy.ts's
 *  `githubEventWake.dedupCapacity`). FIFO eviction: this is a REPLAY/redelivery guard, not an
 *  audit log, so the oldest-remembered delivery id is the correct one to forget first. */
```

## githubDeliveryDedupPath

`src/lib/github-event-wake.ts:196-197` at `2d6b3cda`, 2 comment lines.

```
/** The serve process's durable, bounded replay window. Separate from the coalesced wake marker
 * because accepted ids must survive marker consumption and a serve-container restart. */
```

## createPersistentDeliveryDedupStore

`src/lib/github-event-wake.ts:202-208` at `2d6b3cda`, 7 comment lines.

```
/**
 * Persist the recent-delivery FIFO as one atomically replaced JSON file. The disk write completes
 * before the in-memory store changes, so a failed persistence attempt cannot poison an id and
 * turn a legitimate retry into a false duplicate. A missing or malformed old file starts with an
 * empty window; HMAC remains the authentication boundary and losing this secondary replay cache
 * can cause only an extra level-triggered wake.
 */
```

## sweepWakeMarkerPath

`src/lib/github-event-wake.ts:245-247` at `2d6b3cda`, 3 comment lines.

```
/** `state/SWEEP_WAKE_REQUESTED`, under `root` — a sibling of `state/STOP`/`state/PAUSE`
 *  (`fleet-control.ts`) and `state/service-tokens.json` (`serve.ts`), the same shared-state
 *  directory both `remudero-daemon` and `remudero-serve` mount read-write. */
```

## writeSweepWakeMarkerAtomic

`src/lib/github-event-wake.ts:252-258` at `2d6b3cda`, 7 comment lines.

```
/**
 * Write `record` atomically — a temp file in the SAME directory (so the rename is same-
 * filesystem and therefore atomic) followed by `renameSync` over the real path. A concurrent
 * reader/watcher never observes a partially-written marker; a new delivery simply COALESCES
 * with whatever was there (design iv: a burst of distinct check completions collapses to one
 * pending wake, never a queue of markers).
 */
```

## readSweepWakeMarker

`src/lib/github-event-wake.ts:264-265` at `2d6b3cda`, 2 comment lines.

```
/** `undefined` on any read/parse failure (absent, mid-write elsewhere, corrupt) — never throws;
 *  an unreadable marker is treated exactly like an absent one (design vi's fail-soft contract). */
```

## consumeSweepWakeMarker

`src/lib/github-event-wake.ts:276-278` at `2d6b3cda`, 3 comment lines.

```
/** Atomically CLAIM the current path by renaming it, then read + delete only that claimed inode.
 * A writer that installs a newer marker before or after the claim leaves a path this consumer
 * never unlinks, closing the read-then-unlink race that could otherwise erase a later delivery. */
```

## DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES

`src/lib/github-event-wake.ts:305-310` at `2d6b3cda`, 6 comment lines.

```
/** Bytes, not characters — GitHub's own guidance sizes real payloads in the tens of KB; 1 MiB is
 *  comfortably above any legitimate delivery and far below a DoS-shaped body. Bounded BEFORE
 *  buffering (design i), never after.
 *
 *  BACKSTOP (W1-T1266): no legitimate GitHub delivery approaches this, so it fires only once
 *  something abnormal is already on the wire. It is not what paces or bounds ordinary traffic. */
```

## GithubEventWakeOptions

`src/lib/github-event-wake.ts:313-332` at `2d6b3cda`, 10 comment lines (field docs).

```
export interface GithubEventWakeOptions {
  /** The configured webhook secret, or `undefined` when none is configured — design (vii)'s
   *  "ship dark": `undefined` makes every request a named, harmless 503 refusal, never a 404
   *  (a 404 looks like a routing typo; a named unavailable reason is honest about WHY). */
  secret: string | undefined;
  /** This daemon's OWN `owner/repo` — a payload naming any other repository is a refusal
   *  (design ii), never silently ignored, so a shared/misconfigured secret cannot wake a
   *  process that has no business reacting to it. */
  repository: string;
  /** Where {@link writeSweepWakeMarkerAtomic} persists the coalesced wake — see
   *  {@link sweepWakeMarkerPath}. */
  markerPath: string;
  /** Bounded recent-delivery dedup — see {@link createDeliveryDedupStore}. */
  dedup: DeliveryDedupStore;
  maxBodyBytes?: number;
  now?: () => Date;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Injectable ONLY for a test — production always gets {@link writeSweepWakeMarkerAtomic}. */
  writeMarker?: (path: string, record: SweepWakeMarker) => void;
}
```

## createGitHubEventWakeHandler

`src/lib/github-event-wake.ts:334-356` at `2d6b3cda`, 23 comment lines.

```
/**
 * `POST /v1/hooks/github` — design (iii): validates, then writes/coalesces ONE durable marker
 * and returns. NEVER calls GitHub, NEVER runs a sweep, NEVER touches the merge hold (design
 * viii) — the daemon side (`wireSweepWakeToDaemon`) is the only consumer of what this writes,
 * and it consumes through the SAME gated sweep path the timer already uses.
 *
 * Order of checks, exactly design (i)/(ii)'s own ordering — signature BEFORE anything else is
 * trusted, repository identity BEFORE event/action, delivery id (for dedup) LAST, so nothing
 * before it can be skipped by a caller racing to land a duplicate:
 *   1. no secret configured -> 503, refused, ships dark (design vii).
 *   2. body over {@link GithubEventWakeOptions.maxBodyBytes} -> 413, refused, nothing buffered.
 *   3. missing/malformed `X-Hub-Signature-256` -> 401, refused.
 *   4. invalid JSON -> 400, refused.
 *   5. `repository.full_name` != configured repository -> 403, refused (a refusal, not silence
 *      — design ii: "a supported event for another repository is a refusal").
 *   6. `X-GitHub-Event`/action not in {@link isAllowlistedGithubEvent} -> 202 ignored (a 2xx, so
 *      GitHub never marks a legitimately-uninteresting delivery "failed" and retries it; design
 *      ii: "an attacker cannot use that response to create a marker" — nothing is written here).
 *   7. missing `X-GitHub-Delivery` -> 400, refused (dedup needs it).
 *   8. a delivery id already recorded -> 202 duplicate, nothing re-written.
 *   9. accepted -> marker written/coalesced, delivery id recorded,
 *      `github.wake.accepted` ledgered, 202. A failed marker write records nothing.
 */
```

## createGitHubEventWakeHandler, the route's tier/selfAuthenticated fields

`src/lib/github-event-wake.ts:366-373` at `2d6b3cda`, 6 comment lines. These two comments sit
between the properties of the returned `Route` object literal and are preserved verbatim in the
source rather than only here — a comment in that position survives even a byte-for-byte
comment-only diff, so shortening it would be a behavior-invisible but text-visible change the
compaction proof could not distinguish from a real edit.

```
    // W1-T404: declared for `assertWriteTiersComplete`'s completeness check even though
    // `selfAuthenticated` (below) means `enforceWriteTiers` never actually consults it — this
    // route writes only a durable "recheck GitHub" marker, the same bookkeeping-grade
    // consequence `POST /v1/confirm` (serve.ts) already claims LOW for.
    tier: "low",
    // W1-T2568 (design i): see service.ts's Route.selfAuthenticated doc — GitHub's HMAC replaces
    // the bearer token entirely for this one route.
    selfAuthenticated: true,
```

## SweepWakeSignal

`src/lib/github-event-wake.ts:453-462` at `2d6b3cda`, 10 comment lines.

```
/**
 * The pure, fs-free core of the daemon-side wake — see this module's header, piece 3.
 * `wake()` marks a wake pending; `sleep` resolves the moment
 * a wake is pending (immediately, if one already was — this is what makes a boot-time pending
 * marker and a live `fs.watch` fire behave identically) while STILL retaining the real timeout
 * underneath, so `pollIntervalMs` recovery is never removed, only ever shortened (design vi:
 * "polling is the recovery contract"). An early wake clears that timeout, so no abandoned
 * 60-second timer delays a later normal shutdown. Consuming zero filesystem state — see
 * `wireSweepWakeToDaemon` for the impure half that connects this to an actual marker file.
 */
```

## watchSweepWakeMarker

`src/lib/github-event-wake.ts:528-539` at `2d6b3cda`, 12 comment lines.

```
/**
 * The impure half: turn a marker-file WRITE into a {@link SweepWakeSignal.wake} call. Watches
 * the marker's PARENT directory (not the file itself — a file that does not exist yet has
 * nothing to watch, and the marker is unlinked/recreated across its life) and fires only on the
 * exact filename, only while the file actually exists at the moment of the event (so this
 * process's OWN `consumeSweepWakeMarker` unlink — which also raises a `fs.watch` event — never
 * causes a spurious second wake).
 *
 * FAILS SOFT (design vi): any construction/watch error is ledgered ONCE
 * (`github.wake.watch_failed`) and degrades to a no-op watcher — the daemon keeps polling on
 * `pollIntervalMs` exactly as it always has, never crashes, never keeps retrying a broken watch.
 */
```

## SweepWakeWiring

`src/lib/github-event-wake.ts:568-569` at `2d6b3cda`, 2 comment lines.

```
/** What `wireSweepWakeToDaemon` hands `run-task.ts`'s `daemonCommand` — a drop-in replacement
 *  for `DaemonDeps.sleep` plus the one cleanup hook daemon shutdown must call. */
```

## SweepWakeWireOptions

`src/lib/github-event-wake.ts:580-597` at `2d6b3cda`, 14 comment lines (incl. field docs).

```
/** W1-T2741: daemon-side scheduling policy and clock seams for high-fanout event settlement. */
export interface SweepWakeWireOptions {
  /** Trailing-edge quiet period for `check_run:completed` and `status`; zero preserves the
   * pre-W1-T2741 immediate-wake behavior for callers that do not supply committed policy. */
  checkSettleMs?: number;
  /** One injected timer family owns both the ordinary poll race and the trailing settle clock. */
  timers?: SweepWakeTimerDeps;
  /** Wall clock used only to avoid re-waiting a full settle period for a boot-pending marker. */
  now?: () => number;
  /**
   * W1-T2787: observe default-branch health when a high-fanout check/status burst settles,
   * independently of whether the ordinary full-sweep liveness gate can accept the resulting
   * wake. This runs in the daemon-side marker watcher, never in Serve. Structural PR/review
   * events do not call it. A callback failure is named and swallowed so it cannot suppress the
   * wake that still drives ordinary reconciliation.
   */
  onCheckBurstSettled?: () => void;
}
```

## wireSweepWakeToDaemon

`src/lib/github-event-wake.ts:604-617` at `2d6b3cda`, 14 comment lines.

```
/**
 * Compose the marker primitives + {@link createSweepWakeSignal} + {@link watchSweepWakeMarker}
 * into the one `{ sleep, close }` pair `daemonCommand` (`run-task.ts`) swaps in for its own
 * `sleep` dependency. This is the ENTIRE production wiring on the daemon side — design (v)'s
 * "production wiring watches the shared state directory and also checks the marker at boot":
 * boot detection happens here, once, before the daemon's first poll wait ever runs; the marker
 * itself remains durable until {@link SweepWakeWiring.acknowledge} is called immediately before
 * the ordinary full-sweep gate. The live watch is armed immediately after.
 *
 * The boot-time marker is READ but not consumed here. STOP/PAUSE are checked by `runDaemon`
 * before acknowledgement, so a held daemon cannot erase a wake it has not reconciled. The wake
 * seeds `createSweepWakeSignal`'s initial pending state so a paused loop notices promptly, while
 * the durable file remains the recovery source across a stop or restart.
 */
```

## resolveGithubWebhookSecretFilePath

`src/lib/github-event-wake.ts:745-747` at `2d6b3cda`, 3 comment lines.

```
/** `explicit ?? env[RMD_GITHUB_WEBHOOK_SECRET_FILE]` — the same precedence
 *  `resolveAccountFilePath` (serve.ts) already uses for an optional mounted file. `undefined`
 *  (no override, no env var) is the shipped-dark default: no secret path, no configured route. */
```

## readGithubWebhookSecret

`src/lib/github-event-wake.ts:755-761` at `2d6b3cda`, 7 comment lines.

```
/**
 * Read the secret file's content (trimmed — a trailing newline from `echo >file` must not
 * become part of the HMAC key), or `undefined` on any read failure (absent file, permission
 * error, `secretFilePath` itself `undefined`). NEVER throws, NEVER logs the content — only
 * presence/absence is ever observable from the caller's side (design vii: "report presence
 * without printing contents").
 */
```
