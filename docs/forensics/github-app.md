# Forensics: src/lib/github-app.ts

Every measured fact, incident and design argument the comments in `src/lib/github-app.ts` used to
carry, archived VERBATIM when that file's comments were compacted to the plain-language standard
(`docs/comment-standard.md`).

Nothing here is a rule. `github-app.ts`'s behaviour lives in the code and its tests, and each block
below is quoted exactly as it stood on `origin/main` at `2d6b3cdae1c0ed50764cf33f0f94e42b6f49917b`,
under a heading naming the symbol or section it explained. The code keeps a one-line `// Why:`
pointer wherever that history still matters.

---

## Module header

`src/lib/github-app.ts:1-47` at `2d6b3cda`, 47 comment lines.

```
/**
 * THE FLEET AUTHENTICATES AS THE INSTALLED GITHUB APP (W1-T1024, MASTER-PLAN §9).
 *
 * THE INCIDENT. `daemon.quota` read `bucket: graphql, remaining: 0` while `core` read 4289 in
 * the SAME second — the two buckets are independent, and the exhausted one belonged to the
 * OPERATOR'S interactive session, not the fleet (the daemon's own graphql traffic in that window
 * was negligible against the 5,000 limit). Two seconds later the HARD_STOP escalation — `gh
 * issue create`, itself graphql — failed on the exact condition it exists to report. That shape
 * recurred on 2026-08-16, 2026-08-17 and 2026-08-19.
 *
 * THE FIX IS A SEPARATE POOL, NOT A HARDER LIMIT ON THE FLEET: an installation token minted
 * against the App reads its OWN `core`/`graphql` buckets, measured independent of whatever an
 * operator's shell is spending. This module mints that token in-process (`crypto.sign`, no
 * `openssl` shell-out, no new dependency — Node's `node:crypto` signs RS256 directly) and
 * refreshes {@link refreshInstallationToken}'s ONE seam: `process.env.GH_TOKEN`.
 *
 * WHY THE ENV VAR IS THE WHOLE FIX. Word-bounded, `GH_TOKEN` has exactly three runtime readers:
 *   - `src/lib/env.ts`'s `ALLOWLIST`     — copied into a worker's child env AT SPAWN
 *   - `src/lib/review.ts`'s env spread   — `{ ...process.env, GH_TOKEN: … }` AT CALL TIME
 *   - `deploy/entrypoint.sh`'s credential helper — stored with `$GH_TOKEN` UNEXPANDED, so git's
 *     own shell re-reads it AT CALL TIME, never written to disk
 * Refreshing `process.env.GH_TOKEN` in the daemon's own process reaches every `gh` spawn, every
 * `git` push and every worker with ZERO call-site change — see {@link refreshInstallationToken}.
 *
 * THE WORKER GAP (design iii), STATED PLAINLY. `env.ts`'s `ALLOWLIST` copies `GH_TOKEN` into a
 * worker's child env AT SPAWN, and that copy is held for the worker's whole run — refreshing
 * THIS process's `process.env.GH_TOKEN` cannot reach an already-spawned child. Runs here
 * routinely exceed the token's one-hour life, so a long worker can in principle outlive its own
 * copy. Of the three ways to close that (a fresh re-read inside the worker, a retry-once-on-401
 * in the push path, or accepting the gap for long runs), this task takes the THIRD: both other
 * options require editing `src/lib/worker.ts` or `src/lib/git-push.ts`, neither of which is in
 * this task's declared file list (a credential module with nothing supplying it to the process is
 * the ships-unwired shape this fleet has already measured once; widening scope to chase every
 * consumer is the OPPOSITE mistake). A long-running worker keeps whatever `GH_TOKEN` it was
 * spawned with for its entire run, exactly as it does today — this task does not make that case
 * worse, it just does not fix it either. Filed as a follow-up, not silently absorbed.
 *
 * FALLBACK IS THE DEFAULT (design iv). Missing config, an unreadable key, a signing failure or a
 * rejected exchange all leave `process.env.GH_TOKEN` EXACTLY as they found it and — for an
 * ATTEMPTED refresh that failed — ledger a named reason. Absent config (the App simply isn't
 * installed on this host yet) is not itself an attempt and logs nothing, mirroring `GH_TOKEN`'s
 * own optional shape today. Nothing here ever refuses to boot.
 *
 * NO SECRET EVER REACHES A LOG LINE OR LEDGER ROW — not the private key, not the minted token,
 * not even a prefix. Every `log(...)` call below carries only the installation id, the token's
 * `expires_at` and a fixed reason string.
 */
```

## The W1-T2311 decision record

`src/lib/github-app.ts:49-78` at `2d6b3cda`, 30 comment lines.

```
// ── W1-T2311 DECISION RECORD: THE BOOT ENV CARRIED THE PAT, NOT THIS MODULE ─────────────────────
//
// MEASURED 2026-08-26: the container's boot env carried a 93-character personal token under
// GH_TOKEN (fingerprint 8d073b4c, user 4397075) from the moment the daemon process started, and
// `refreshInstallationToken` below only ever overwrites `process.env.GH_TOKEN` IN THIS PROCESS —
// so the personal token was never reached by falling back to it, it WAS the default, and the
// App-minted token was the thing that had to arrive to displace it. The root cause sat one layer
// out: `deploy/recycle-container.sh` reads a container's env through `docker inspect`, which
// reports only the STATIC config a container was started with, never a value this module mutates
// in a running process — so no amount of successful refreshing here was ever visible to the NEXT
// recycle, and every recycle re-booted the next container on the same standing personal token.
//
// REMEDY (a) TAKEN (see plan/tasks.d/W1-T2311-*.yaml's Q1): THE BOOT ENV NOW CARRIES NO GH_TOKEN.
// `deploy/recycle-container.sh` still captures the outgoing container's token — its own
// refusal-if-uncaptured guard is unchanged, so an operator never silently loses the only copy —
// but that value is no longer forwarded into the incoming container's own environment (see that
// script's own W1-T2311 section for exactly where, and for the operator read path this displaces:
// a `docker exec` invocation carries its own token per call rather than the fleet holding one on
// an operator's behalf). REMEDY (b) — having the fallback REFUSE on a failed exchange rather than
// degrade — was NOT taken: nothing in THIS module ever introduced a personal token to refuse
// around, and refusing here would still sit in tension with the retry loop's own "degrade, never
// refuse" contract (W1-T1068, REFRESH_MARGIN_MS below), which stays exactly as it was. A
// timed-out exchange still leaves the previous value untouched rather than clearing it — the same
// behaviour as before this task, on a boot value that is no longer a credential worth protecting.
// Nothing added here paces, throttles, sleeps or backs off a call (W1-T1066's own standing rule).
//
// THE SECOND-ORDER QUESTION IS UNINVESTIGATED, RECORDED HERE SO IT IS NOT RE-DERIVED OR GUESSED
// AT BY THE NEXT READER: why did roughly one exchange in three time out at EXCHANGE_TIMEOUT_MS
// when the same container reached GitHub's API in milliseconds unauthenticated? That is its own
// defect, on its own measurement, and closing this task must not be read as having explained it.
```

## EXCHANGE_TIMEOUT_MS

`src/lib/github-app.ts:106-118` at `2d6b3cda`, 12 comment lines.

```
// W1-T1068: NODE'S `fetch` HAS NO DEFAULT TIMEOUT, so a connection that opens and then hangs
// (a stalled socket, a proxy that swallows the response) never settles — the `await` below would
// never return, and because `tick()` in `startInstallationTokenRefresh` only arms its next timer
// AFTER this promise settles (see that function's doc), a hang here is not a slow refresh, it is
// a PERMANENTLY DEAD loop. Reasoned from a bound, not fitted to a measurement: this repo's own
// `board_gateway.fetch_bytes` ledger shape carries no duration field to fit against (10.9s bought
// 26.7 MB over 14 REST calls, but that figure is wall-clock observation, not a re-readable value),
// so 20s is chosen as roughly TWICE that ceiling for a call two orders of magnitude smaller (one
// POST, a tiny JSON body) — generous enough that a healthy-but-slow network never trips it. A
// failed scheduled refresh must not spend the whole five-minute margin again; the daemon retains
// the last successful expiry and schedules any failure retry early enough for another full bounded
// exchange to settle before that token expires. Exported so a test can advance a mocked clock by
// EXACTLY this amount rather than a magic number that would silently drift out of sync with it.
export const EXCHANGE_TIMEOUT_MS = 20 * 1000;
```

Note: `EXCHANGE_TIMEOUT_MS` is grandfathered, undeclared, in `scripts/bound-kind-baseline.json`
(`src/lib/github-app.ts:EXCHANGE_TIMEOUT_MS`) — this compaction adds neither `BACKSTOP` nor
`PRIMARY CONTROL` to its comment, matching that grandfathering.

## TOKEN_REFRESHED_STEP

`src/lib/github-app.ts:120-127` at `2d6b3cda`, 7 comment lines.

```
/**
 * THE TWO STEP NAMES THIS MODULE WRITES, OWNED HERE so there is exactly ONE spelling of each —
 * the same "small module owns its step constant" precedent `src/lib/cost-anomaly.ts`'s
 * `COST_ANOMALY_STEP` and `src/lib/image-drift.ts`'s `IMAGE_DRIFT_STEP` already set, and imported
 * by the reader (`deriveNeedsMe`, `src/lib/status-board.ts`) for the same reason: a second
 * hand-typed copy of a step name is how a reader and a writer silently stop agreeing.
 */
export const TOKEN_REFRESHED_STEP = "github_app.token_refreshed";
```

## TokenRefreshReasonForm and TokenRefreshReasonDeclaration

`src/lib/github-app.ts:164-183` at `2d6b3cda`, 20 comment lines.

```
/**
 * W1-T2319 design (v) — Q2, RECORDABILITY DECLARED IN CODE, CHECKED BY A TEST, NOT A NEW GATE.
 *
 * Every reason this module (or its sibling function below) can put on a `RefreshResult.reason` /
 * a `TOKEN_REFRESH_FAILED_STEP` ledger row, declared once so a later sweep can tell an
 * UNRECORDABLE zero (this member cannot fire) from a genuinely unobserved one, and a PREFIX form
 * (carries a variable suffix — matching it as a literal reads a false zero, rationale (4)) from a
 * LITERAL one.
 *
 *   - `recordable`: whether a `log(TOKEN_REFRESH_FAILED_STEP, ...)` call site exists that can
 *     produce this reason. `app not configured` is the one `false`: it RETURNS before any `log`
 *     call (design ii — absent config is not an attempt), so its zero is unrecordable by
 *     construction, never a measurement.
 *   - `form`: `"literal"` reasons match a ledger row's `reason` field exactly. `"prefix"` reasons
 *     are TEMPLATES — the string here is the fixed stem a real row's `reason` STARTS WITH, never
 *     the whole value (e.g. a row reads `exchange rejected: 403`, not `exchange rejected: `).
 *   - `writer`: which function's own `log` call can produce this reason. `refresh threw: ` is
 *     `startInstallationTokenRefresh`'s, not `refreshInstallationToken`'s — a sweep scoped to only
 *     one of the two silently misses the other (rationale (4)).
 */
```

## signAppJwt

`src/lib/github-app.ts:204-210` at `2d6b3cda`, 7 comment lines.

```
/**
 * Signs a GitHub App JWT with `crypto.sign` — an IN-PROCESS, ONE-SHOT call (Node's own
 * `node:crypto`, confirmed `typeof crypto.sign === "function"` under the fleet's own runtime) —
 * never an `openssl` shell-out and never a new dependency (design i). Exported so a test can
 * verify the signature round-trips against the matching public key without mocking the network
 * exchange at all.
 */
```

## fetchFailureIdentifier

`src/lib/github-app.ts:223-232` at `2d6b3cda`, 10 comment lines.

```
/**
 * W1-T2319 design (iv) — the error's OWN identifier, when it carries one: `err.cause.code` where
 * present (Node's `fetch` wraps a real connection failure — ECONNREFUSED, ENOTFOUND, a TLS
 * failure — in a `TypeError` whose `.cause` is the underlying `SystemError`/`AggregateError`
 * carrying `.code`), else `err.name` PROVIDED it is more specific than the bare `Error` a plain
 * `new Error(message)` carries by default. A bare `Error` — the shape "a test fixture's own
 * rejection once its signal fires" takes (design ii) — identifies nothing, so this returns
 * `undefined` for it rather than the uninformative literal string `"Error"`, which is what lets
 * the caller fall through to the abort-only branch instead of manufacturing a fake identity.
 */
```

## describeExchangeCatch

`src/lib/github-app.ts:246-263` at `2d6b3cda`, 18 comment lines.

```
/**
 * W1-T2319 — THE ONE HELPER THE CATCH ARM CONSULTS, ORDER IS THE WHOLE FIX (design i).
 *
 *   1. IDENTITY FIRST. `AbortController.abort(reason)` sets `signal.reason` to that exact object
 *      and a spec-compliant `fetch` rejects with THAT SAME OBJECT, so `err === signal.reason`
 *      identifies OUR OWN abort with no string match and no `err.name` sniff (which a caller's
 *      unrelated signal could also satisfy) — see the abort call above, which always passes an
 *      explicit reason for exactly this.
 *   2. THE ERROR'S OWN IDENTIFIER SECOND, REACHABLE EVEN ON AN ALREADY-ABORTED SIGNAL (design
 *      iii/iv): a rejection that names its own cause — a refused connection, a DNS failure, a TLS
 *      failure — is named for what it is rather than folded into the timeout bucket just because
 *      the 20s budget happened to also have expired.
 *   3. THE ABORT-ONLY FALLBACK LAST, reached only when the error identifies nothing (design ii) —
 *      the seam the existing test suite already relies on: a fixture that rejects with a bare
 *      `Error` once its signal fires still reads as a timeout.
 *   4. Otherwise: a genuine, unidentified rejection that arrived before any abort — reachable in
 *      principle (design (7)), named without inventing a code that was never offered.
 */
```

## startInstallationTokenRefresh

`src/lib/github-app.ts:390-419` at `2d6b3cda`, 30 comment lines.

```
/**
 * Start the daemon's own installation-token refresh loop, and report whether it armed.
 *
 * EXTRACTED FROM `daemonCommand` SO THE LOOP IS TESTABLE AT ALL. Inline at the call site the whole
 * body sat behind a three-variable env gate that no test sets, so every line of it was added
 * source with zero covering tests — `diff-coverage` blocked the PR naming exactly those lines. The
 * gate itself is the only part a daemon-boot test can reach, so the body has to move somewhere a
 * test can call directly; the call site keeps one line and the behaviour is unchanged.
 *
 * GATED ON CONFIG PRESENCE, as before: an unconfigured host (the App not installed there yet) is
 * byte-identical to before this task — zero ledger lines, zero timers, `GH_TOKEN`'s own optional
 * shape preserved — and `armed: false` says so to the caller rather than silently doing nothing.
 *
 * W1-T2554 — `ready` IS THE FIX. The bare `tick()` this function used to end on discarded the
 * FIRST mint's promise, so `{ armed: true }` asserted only that a TIMER was scheduled, never that
 * `process.env.GH_TOKEN` had actually been written — the daemon's call site (`run-task.ts`) had
 * no reason to wait and proceeded straight into the first board read on a token nothing had
 * minted yet (MEASURED: the mint landed 1.899s after that read had already failed `auth`). The
 * FIRST mint is now started and its settlement handed back on `ready`; every later tick (the
 * recurring renewal loop) stays exactly as fire-and-forget as before — only the boot-time ordering
 * changes. `ready` NEVER REJECTS: a failed or throwing mint is caught, logged and rescheduled
 * exactly like today, so a caller that awaits `ready` can never hang or be taken down by it (see
 * the two `catch`/`.then` reject arms below, both terminal). Absent when `armed` is false — a host
 * with no `GH_APP_*` names has nothing to wait for.
 *
 * Every seam is injectable and defaults to the real thing, so a test drives the reschedule
 * arithmetic without a network call or a live timer: `refresh` mints, `setTimer` schedules, `now`
 * stamps. `setTimer` returns the timer so the caller can `unref` it — an armed refresher must
 * never hold the process open.
 */
```
