# Forensics: src/lib/containment.ts

Every measured fact, incident and design argument the comments in `src/lib/containment.ts` used to
carry, archived VERBATIM when that file's comments were compacted to the plain-language standard
(`docs/comment-standard.md`).

Nothing here is a rule. The containment probe's behaviour lives in the code, and each block below is
quoted exactly as it stood on `origin/main` at `5c5e21aa`, under a heading naming the symbol it
explained. The code keeps a one-line `Why:` pointer wherever that history still matters.

Every comment block of six lines or more at that revision is archived below, in file order, except
the blocks PR #4143 added at the file's tail — those already follow the standard and stay in the
code unchanged.

---

## the `configPath` import

`src/lib/containment.ts:4-9` at `5c5e21aa`, 6 comment lines.

```
// W1-T2213: `configPath()` alongside `loadConfig`/`Config` — the SAME resolver
// the instance config file itself is read through, `<homedir()>/.config/remudero/
// config.json`, the live, mode-600 file rationale (2) measured. Called from the
// ORCHESTRATOR's own process (defaultExecutor runs before the worker's HOME is
// ever redirected), so `homedir()` here reads the REAL operator home, never the
// worker's scratch one.
```

## module header

`src/lib/containment.ts:16-36` at `5c5e21aa`, 21 comment lines.

```
/**
 * POST-SPAWN CONTAINMENT PROBE (WS-0 verdict 7; W1-T2 acceptance #2).
 *
 * The validate-before-spawn guard (settings.ts) proves the settings file is
 * WELL-FORMED. It does NOT prove the sandbox ENGAGED: `claude -p` SILENTLY IGNORES
 * a settings file it can't apply and runs unsandboxed (FF10a / LEARNINGS). Static
 * guard and empirical probe are two DIFFERENT guarantees — the schema check can
 * pass while containment is silently absent. This module is the empirical half:
 * spawn under the sandbox and confirm an attempted write OUTSIDE the working
 * directory is OS-DENIED. Containment unproven ⇒ FAIL CLOSED (Standing rule 11:
 * isolation is PROVEN PER RUN by probe, never assumed from configuration).
 *
 * GRANULARITY — once-per-run preflight, not per-spawn. Justification:
 *  - Standing rule 11 mandates "per run", and the settings file + host + CLI
 *    version (the tuple that determines whether the sandbox engages) are constant
 *    across every spawn in a run — the fact proven once holds for all of them.
 *  - Per-spawn would re-prove the same fact before recon AND implement AND resume
 *    AND review (4+ LLM probes/run) at no added assurance. Once-per-run is the
 *    floor: cheap, and it still catches a silently-dropped sandbox before any task
 *    worker writes a byte.
 */
```

## ContainmentError check and observed

`src/lib/containment.ts:40-54` at `5c5e21aa`, 15 comment lines.

```
  /**
   * STRUCTURED GUARD-CAUSE (W1-T91/P23, ratifies the design's part (i)) — the
   * containment sibling of {@link import("./isolation.js").IsolationError}'s same
   * fields. `check` names WHICH gate fired (`sandbox-enabled` for the static
   * config gate, `outside-cwd-denial` for the empirical probe); `observed`
   * preserves the three-state epistemology (proven-holding | proven-broken |
   * UNPROVEN) rather than collapsing it to a boolean — a data description when
   * the sandbox was PROVEN to have dropped (the outside write landed), a config
   * description for the static gate, or, for the UNPROVEN case, ONE OF FOUR
   * named sub-states from {@link classifyUnprovenState} (W1-T1281, extended by
   * W1-T2201): `"probe-never-ran"`, `"write-never-attempted"`,
   * `"no-denial-observed"`, or `"turns-exhausted"` — no longer the single literal
   * "unproven" that collapsed all of them and left an intermittent preflight
   * failure undiagnosable from any ledger row.
   */
```

## ContainmentError.childEnvKeys

`src/lib/containment.ts:58-64` at `5c5e21aa`, 7 comment lines.

```
  /**
   * W1-T268: the probe spawn's `WorkerResult.childEnvKeys` — `[]` when GATE 1
   * (the static config check) refused before any spawn ever ran. Carried so the
   * caller's `blocked_containment` verdict line can DERIVE `billing_mode`
   * (`billingMode(childEnvKeys)`, env.ts) instead of hardcoding a literal — a
   * blocked run is never free of a real billing mode just because it failed.
   */
```

## ContainmentEvidence.outsideWriteAttempted

`src/lib/containment.ts:86-98` at `5c5e21aa`, 13 comment lines.

```
  /**
   * W1-T1281: did the transcript even MENTION this run's token — i.e. did the
   * probe worker get far enough to report on the outside-cwd write step at all,
   * whether or not that report matched {@link OS_DENIAL_RE}? Split out of the
   * expression `osDenialSeen` already computes (`transcript.includes(token) &&
   * OS_DENIAL_RE.test(...)`) so the two halves of that AND are separately
   * readable: `osDenialSeen` false no longer conflates "attempted, but no
   * denial phrase" with "never attempted at all" — see
   * {@link classifyUnprovenState}. Optional — defaults falsy so pre-existing
   * evidence literals that predate this field read as not-attempted, which is
   * the conservative direction (it never manufactures a denial-adjacent state
   * that wasn't observed).
   */
```

## ContainmentEvidence.credentialFailure

`src/lib/containment.ts:100-111` at `5c5e21aa`, 12 comment lines.

```
  /**
   * W1-T237: did the probe worker die on a credential/auth failure (isError PLUS
   * the conservative `CREDENTIAL_RE` signature) rather than ever attempting a
   * write? A credential-dead worker makes NO writes and trips no OS-denial text,
   * so it is byte-identical to the genuine no-write/no-denial "unproven" case
   * unless named separately — that collapse is exactly the misdiagnosis that
   * cost the 2026-07-21 incident two days (a dead-auth worker and a compliant
   * sandbox read the same). Distinguish it FIRST, before the write/denial checks
   * below, since a credential-dead worker proves nothing about isolation either
   * way. Optional — defaults falsy so pre-existing evidence literals that never
   * saw a credential failure need not spell it out.
   */
```

## ContainmentEvidence.credentialExpired

`src/lib/containment.ts:113-123` at `5c5e21aa`, 11 comment lines.

```
  /**
   * W1-T292: did the probe worker die on an EXPIRED copied OAuth token (isError
   * PLUS the conservative `CREDENTIAL_EXPIRED_RE` + `CREDENTIAL_TOKEN_EXPIRED_RE`
   * signature) rather than the never-logged-in signature above? A DISTINCT field
   * (not folded into `credentialFailure`) so the recovery path can key on a
   * stable `spawn_credential_expired` symbol — "re-mint/refresh the token" is a
   * different operator action than "this host was never logged in at all" —
   * and so a locked/logged-out 'Not logged in' probe still reports the
   * unmodified W1-T237 `spawn_credential_failure` reason, never this one.
   * Optional — defaults falsy.
   */
```

## ContainmentEvidence.spawnTransportFailure

`src/lib/containment.ts:125-139` at `5c5e21aa`, 15 comment lines.

```
  /**
   * W1-T2249: did the probe worker die on a TRANSPORT or API-side failure (isError
   * PLUS the conservative `TRANSPORT_FAILURE_RE` signature — a `5xx` Anthropic-API
   * response such as "API Error: 529 Overloaded") rather than a credential failure
   * or a genuine containment observation? A probe whose own worker died on a 529 or
   * a dropped connection makes NO writes and trips no OS-denial text either — it is
   * byte-identical to the genuine no-write/no-denial "unproven" case unless named
   * separately, EXACTLY the collapse `credentialFailure`/`credentialExpired` above
   * were already split out to prevent, for a THIRD spawn-death shape those two
   * fields do not cover (an outage, not an auth problem). Checked in the SAME
   * position those two occupy — ahead of the unproven classifier — for the same
   * reason: a worker that never got far enough to attempt a write proves nothing
   * about isolation either way. Optional — defaults falsy so pre-existing evidence
   * literals that never saw a transport failure need not spell it out.
   */
```

## ContainmentEvidence.denyFloorProbeCreated

`src/lib/containment.ts:141-151` at `5c5e21aa`, 11 comment lines.

```
  /**
   * Did the deny-floor tripwire (`./FORBIDDEN_PROBE`, INSIDE cwd) get created?
   * `true` ⇒ the PreToolUse deny floor did NOT bind — the sandbox permits that
   * path by design, so only the hook could have stopped it.
   *
   * DELIBERATELY OPTIONAL AND DELIBERATELY THREE-STATE: `undefined` means the
   * probe executor never reported a tripwire outcome (every injected fake that
   * predates this field), and {@link assessDenyFloor} reads that as UNOBSERVED
   * rather than as engaged. Read ONLY by {@link assessDenyFloor} — never by
   * {@link assessContainment}, whose verdict is unchanged by this field.
   */
```

## ContainmentEvidence.egressBlockedReached

`src/lib/containment.ts:154-160` at `5c5e21aa`, 7 comment lines.

```
  /**
   * W1-T1265 — THE EGRESS ARM, MIRRORING THE FILESYSTEM ARM FIELD FOR FIELD.
   * Did the request to the NON-allowlisted host come back? `true` ⇒ the sandbox
   * did NOT hold. Mirrors {@link ContainmentEvidence.outsideWriteCreated}.
   * Optional so every pre-existing fixture keeps compiling and reads as
   * UNOBSERVED — the same discipline `denyFloorProbeCreated` above uses.
   */
```

## ContainmentEvidence.egressDenialSeen

`src/lib/containment.ts:162-167` at `5c5e21aa`, 6 comment lines.

```
  /**
   * Was a refusal observed for the blocked request? This is what separates
   * PROVEN-BROKEN from UNPROVEN on the egress side, exactly as `osDenialSeen`
   * does on the filesystem side — an absent response is not evidence of a
   * refusal, because the request may never have been attempted.
   */
```

## ContainmentEvidence.egressAllowedReached

`src/lib/containment.ts:169-174` at `5c5e21aa`, 6 comment lines.

```
  /**
   * Did the request to an ALLOWLISTED host succeed? The egress equivalent of
   * {@link ContainmentEvidence.insideWriteCreated}: without it, "the blocked
   * request failed" cannot be told from "this host has no network at all", and
   * an offline machine reads as a perfect sandbox.
   */
```

## ContainmentEvidence.egressBlockedRemoteIp

`src/lib/containment.ts:176-188` at `5c5e21aa`, 13 comment lines.

```
  /**
   * W1-T2271 — THE TRANSPORT-FACT DISCRIMINATOR (design note part (iv)): the
   * remote address curl actually connected to for the BLOCKED request, read
   * from `-w '%{remote_ip}'` on the SAME request the probe already makes — no
   * new destination, and the body stays discarded (`-o /dev/null` unchanged).
   * `undefined` when the request never came back (nothing to read) or the
   * executor predates this field. Compared against {@link
   * ContainmentEvidence.egressAllowedRemoteIp} by {@link
   * assessEgressContainment}: the SAME address on both requests means one
   * local interception proxy answered both, which is not evidence the
   * upstream was reached — precisely the fact rationale (6) shows the model
   * reconstructing by hand, expensively, before this field existed.
   */
```

## ContainmentEvidence.turnsExhausted

`src/lib/containment.ts:195-203` at `5c5e21aa`, 9 comment lines.

```
  /**
   * W1-T2201: did the probe spawn itself end on `error_max_turns` — i.e. did the
   * WORKER run out of its turn budget, as opposed to simply never attempting a
   * step? Carried verbatim from {@link ProbeExecResult.turnsExhausted}. Optional,
   * defaulting falsy so pre-existing evidence literals read as not-exhausted —
   * the conservative direction, since this field only ever ADDS a distinguishing
   * reason to an already-`contained: false` verdict, never flips one to `true`
   * (see {@link assessContainment}).
   */
```

## ContainmentEvidence.numTurns

`src/lib/containment.ts:205-218` at `5c5e21aa`, 14 comment lines.

```
  /**
   * W1-T2238 — THE COUNT `turnsExhausted` NEVER CARRIED. `WorkerResult.numTurns`
   * (the SDK's `num_turns` off the probe spawn's own result envelope), carried
   * verbatim from {@link ProbeExecResult.numTurns}. Recorded on BOTH the
   * exhausted AND the passing path — rationale (5): the passing path is the one
   * whose distribution would say whether the allowance is tight, and only
   * recording it on failure would throw that signal away. Optional so every
   * pre-existing evidence literal that predates this field keeps compiling.
   *
   * W1-T303 GROUND TRUTH APPLIES UNCHANGED HERE: `numTurns` alone cannot be
   * reasoned about against a cap unless the cap it actually ran under rides the
   * SAME row — see {@link ContainmentEvidence.maxTurns} below, ledgered beside
   * it for exactly that reason, never as a replacement.
   */
```

## ContainmentEvidence.maxTurns

`src/lib/containment.ts:220-228` at `5c5e21aa`, 9 comment lines.

```
  /**
   * W1-T2238: the `maxTurns` THIS probe call was CONFIGURED with — {@link
   * probeTurnBudget}'s own return value at spawn time, carried verbatim from
   * {@link ProbeExecResult.maxTurns} (an INPUT, never a read-back off the
   * envelope, mirroring `WorkerResult.maxTurns`'s own discipline, W1-T303).
   * Ledgered beside `numTurns`, never replacing it, so a row can be checked
   * against the cap it actually ran under without cross-referencing
   * `PROBE_TURN_ALLOWANCE`'s current value, which can move over time.
   */
```

## ContainmentEvidence.tokenReadSucceeded

`src/lib/containment.ts:231-239` at `5c5e21aa`, 9 comment lines.

```
  /**
   * W1-T2211 — THE READ ARM, MIRRORING THE EGRESS ARM FIELD FOR FIELD (itself
   * mirroring the filesystem WRITE arm). Did a read of the console's write-token
   * path (`<config.root>/state/service-tokens.json`) SUCCEED? `true` ⇒ the
   * `denyRead` entry named in design part (i) did NOT hold. Mirrors {@link
   * ContainmentEvidence.outsideWriteCreated} / {@link
   * ContainmentEvidence.egressBlockedReached}. Optional so every pre-existing
   * fixture keeps compiling and reads as UNOBSERVED, never as "denied".
   */
```

## ContainmentEvidence.tokenReadDenialSeen

`src/lib/containment.ts:241-246` at `5c5e21aa`, 6 comment lines.

```
  /**
   * Was a denial actually OBSERVED for that read? This is what separates
   * PROVEN-HOLDING from UNPROVEN, exactly as `osDenialSeen`/`egressDenialSeen`
   * do on the other two arms — an absent read outcome is not evidence of a
   * refusal, because the read may never have been attempted.
   */
```

## ContainmentEvidence.stateReadSucceeded

`src/lib/containment.ts:248-255` at `5c5e21aa`, 8 comment lines.

```
  /**
   * CONTROL: did a read of an ORDINARY state path — one a worker legitimately
   * uses, deliberately NOT the token — also SUCCEED? Mirrors
   * `egressAllowedReached`/`insideWriteCreated`: without it, "the token read
   * failed" cannot be told from "reads are broken generally" (or a deny drawn
   * too wide, e.g. a blanket `state/**`), and either would misread as a
   * perfect result. Acceptance criterion 3's own falsifier.
   */
```

## ContainmentEvidence.operatorHomeReadSucceeded

`src/lib/containment.ts:258-270` at `5c5e21aa`, 13 comment lines.

```
  /**
   * W1-T2213 — THE RE-ANCHORING ARM, MIRRORING THE W1-T2211 TOKEN-READ ARM FIELD
   * FOR FIELD. That arm proves the token deny's `~/..` anchoring to config.root;
   * this one proves the SAME anchoring mechanism escaping one level further
   * (`~/../..`, design part (i)) to the operator's real home — one of the six
   * `~`-anchored denies rationale (1)/(2) found resolving inside the worker's own
   * scratch home instead. Did a read of the operator's real
   * `~/.config/remudero/config.json` — the live, sensitive file (mode 600)
   * rationale (2) measured that the un-anchored `~/.config/remudero/**` entry
   * never covered — SUCCEED? `true` ⇒ the re-anchored denyRead entry did NOT
   * hold. Optional so every pre-existing fixture keeps compiling and reads as
   * UNOBSERVED, never as "denied".
   */
```

## ContainmentEvidence.operatorHomeReadDenialSeen

`src/lib/containment.ts:272-280` at `5c5e21aa`, 9 comment lines.

```
  /**
   * Was a denial actually OBSERVED for that read? Mirrors `tokenReadDenialSeen`:
   * an absent read outcome is not evidence of a refusal, because the read may
   * never have been attempted. The CONTROL is deliberately the SAME
   * `stateReadSucceeded` the token-read arm already proves — one ordinary read
   * succeeding in the SAME probe run is the same fact regardless of which
   * denied path is under test, so this arm does not re-derive a second control
   * (design part (vi): workers keep ordinary read access to the state root).
   */
```

## assessContainment

`src/lib/containment.ts:284-289` at `5c5e21aa`, 6 comment lines.

```
/**
 * PURE verdict over probe evidence. Containment holds IFF the outside-cwd write was
 * BLOCKED (its file never appeared) AND an OS denial was actually observed — file
 * absence ALONE is not proof (the worker might simply not have attempted the write,
 * which must also fail closed). Every other combination is `contained: false`.
 */
```

## assessContainment, the turns-exhausted branch

`src/lib/containment.ts:333-338` at `5c5e21aa`, 6 comment lines.

```
    // W1-T2201: a turn-exhausted spawn gets its OWN reason text, distinct from
    // the generic "may never have been attempted" — the two are different facts
    // (the probe ran out of turns WHILE trying, vs. never attempting at all) and
    // must not share a string. `contained` stays `false` either way — this only
    // changes what gets RECORDED, exactly as `classifyUnprovenState` does for
    // the structured `observed` field.
```

## UnprovenState

`src/lib/containment.ts:359-386` at `5c5e21aa`, 28 comment lines.

```
/**
 * W1-T1281 — THE THREE STATES `assessContainment`'S `!osDenialSeen` BRANCH USED TO
 * COLLAPSE INTO THE LITERAL EIGHT CHARACTERS `"unproven"`, NOW NAMED SEPARATELY SO
 * A `blocked_containment` LEDGER ROW CAN SAY WHICH ONE FIRED.
 *
 * PURE, over the SAME evidence `assessContainment` already read — no new signal is
 * gathered, and NO VERDICT CHANGES: every state this returns still corresponds to
 * `contained: false` and still fails closed. This function only decides what gets
 * RECORDED alongside that unchanged decision (design part (i)).
 *
 * Checked in this order, per design part (iii):
 *  1. `!insideWriteCreated` ⇒ `"probe-never-ran"`. The probe MECHANISM itself did
 *     not run — not even the inside-cwd write, the sanity signal that the sandbox
 *     isn't over-blocking, landed. This is a DIFFERENT fault from an instrument
 *     that ran and simply observed nothing, and reporting it identically is the
 *     exact credential-failure collapse W1-T237 already fixed once for a
 *     different field (see `credentialFailure`/`credentialExpired` above) — this
 *     is that fix for the remaining two states.
 *  2. `!outsideWriteAttempted` ⇒ `"write-never-attempted"`. The instrument ran
 *     (inside write landed) but the transcript never even mentioned this run's
 *     token — the outside-cwd write step was never reached or never reported,
 *     so there is nothing for a denial phrase to have matched.
 *  3. otherwise ⇒ `"no-denial-observed"`. The instrument ran AND the outside-cwd
 *     write step was reported on, but nothing in that report matched
 *     {@link OS_DENIAL_RE} — the write may still not have been attempted (a
 *     worker can mention a step without actually running it), but this is now
 *     distinguishable from the two states above rather than sharing their string.
 */
```

## classifyUnprovenState

`src/lib/containment.ts:393-403` at `5c5e21aa`, 11 comment lines.

```
/**
 * W1-T2201: checked FIRST, ahead of the other three states. A turn-exhausted
 * spawn (`error_max_turns`) can ALSO look like `probe-never-ran` or
 * `write-never-attempted` on the raw evidence — the worker ran out of budget
 * before finishing, so later steps genuinely never happened — but "ran out of
 * turns trying" and "never attempted" are not the same fact (this task's whole
 * premise: three W1-T1281 transcripts collapsed them into the SAME reported
 * cause, `"(the write may never have been attempted)"`, which is true of both
 * and identifies neither). Naming the more specific, actually-observed cause
 * takes priority over guessing from its downstream symptoms.
 */
```

## ProbeExecResult.isError

`src/lib/containment.ts:418-430` at `5c5e21aa`, 13 comment lines.

```
  /**
   * W1-T237: `WorkerResult.isError` from the probe spawn's own result envelope —
   * the information was already in hand (worker.ts carries it) but the preflight
   * never looked at it, testing only the transcript for denial text. Optional so
   * a pre-existing test double that omits it defaults to `false` (no credential
   * verdict fires without an explicit error signal).
   *
   * W1-T238: also carried through so a failed probe spawn's stderr/error-result
   * text (already folded into `transcript`) can be persisted to the ledger,
   * capped, instead of dying with the process the way it did the incident this
   * task fixes. Omitted by fakes that never populate it ⇒ treated as a clean
   * spawn (no excerpt).
   */
```

## ProbeExecResult.childEnvKeys

`src/lib/containment.ts:432-439` at `5c5e21aa`, 8 comment lines.

```
  /**
   * W1-T268: the probe spawn's own `WorkerResult.childEnvKeys` — carried through so
   * the caller can DERIVE this probe's `billing_mode` (never a hardcoded literal;
   * see `billingMode` in env.ts) instead of assuming subscription. Optional so a
   * pre-existing test double that omits it falls back to an empty key set, which
   * `billingMode` reads as `"subscription"` (the correct default absent the
   * overflow valve's key).
   */
```

## ProbeExecResult.accountLabel

`src/lib/containment.ts:441-446` at `5c5e21aa`, 6 comment lines.

```
  /**
   * W1-T268: the probe spawn's own `WorkerResult.accountLabel` — the account this
   * probe's (notional) spend is attributed to, carried through so the run's
   * `blocked_containment` verdict line can name it like every other spend-bearing
   * ledger line. `undefined` when the probe spawn could not resolve one.
   */
```

## ProbeExecResult.turnsExhausted

`src/lib/containment.ts:465-472` at `5c5e21aa`, 8 comment lines.

```
  /**
   * W1-T2201: did the probe spawn itself end on the SDK's `error_max_turns`
   * subtype? Optional so every pre-existing injected fake keeps compiling and
   * reads as `false`/not-exhausted (the conservative default — it never invents
   * an exhaustion that was not observed). Carried through so a turn-exhausted
   * run can be distinguished from a probe that simply never attempted a step —
   * see {@link classifyUnprovenState}'s `"turns-exhausted"` state.
   */
```

## ProbeExecResult.numTurns

`src/lib/containment.ts:474-479` at `5c5e21aa`, 6 comment lines.

```
  /**
   * W1-T2238: `WorkerResult.numTurns` off the probe spawn's own result envelope —
   * already on the envelope, just never carried past this point. Optional so
   * every pre-existing injected fake keeps compiling; a fake that omits it reads
   * as unrecorded (`undefined`), never a guessed `0`.
   */
```

## ProbeExecResult.maxTurns

`src/lib/containment.ts:481-486` at `5c5e21aa`, 6 comment lines.

```
  /**
   * W1-T2238: the `maxTurns` this spawn call was actually invoked with —
   * `probeTurnBudget(prompt)`'s own return value, carried through as an INPUT
   * rather than re-derived at the row-building site, so a historical row stays
   * checkable against the cap it ran under even if `PROBE_TURN_ALLOWANCE` moves.
   */
```

## denyFloorProbeCommand

`src/lib/containment.ts:510-529` at `5c5e21aa`, 20 comment lines.

```
/**
 * WHY THE DENY-FLOOR STEP TARGETS A PATH *INSIDE* CWD, AND WHY THAT IS THE WHOLE
 * POINT OF THE STEP.
 *
 * `src/spike.ts` probes `~/FORBIDDEN_PROBE` and feeds its existence to {@link
 * "./worker.js".evaluateDenyFloor}. Under a HEALTHY sandbox that observation is
 * DEGENERATE: the sandbox write scope is cwd + session $TMPDIR, so `~` is outside
 * it and the file never appears whether or not the hook ran at all. Absence there
 * proves the SANDBOX held; it says nothing about the deny floor. Deleting
 * `hooks/deny-floor.sh` entirely would leave that probe reporting
 * `heldUnderBypass: true, contained: true`.
 *
 * A path INSIDE cwd separates the two controls, because the two controls disagree
 * about it:
 *   - the SANDBOX permits it (it is the same scope `probe-ok.txt` proves writable);
 *   - the HOOK denies it (rule 3 matches the basename in `tool_input.command`),
 *     and PreToolUse fires BEFORE the command runs, so nothing is created.
 * So the file's presence is a one-way witness: PRESENT ⇒ the deny floor did not
 * bind. That is the only arrangement in which this probe carries information.
 */
```

## probeCommandCount

`src/lib/containment.ts:575-583` at `5c5e21aa`, 9 comment lines.

```
/**
 * Count of Bash commands a probe prompt instructs the worker to run — derived by
 * counting the prompt's own numbered command lines (`N) ...`), the SAME technique
 * `test/deny-floor-probe.test.ts`'s `parseProbeStepNarration` already uses to keep
 * the prompt's narrated counts honest. Deriving from the prompt TEXT itself,
 * rather than a hand-maintained constant kept beside it, is what makes a FIFTH
 * command added to {@link containmentProbePrompt} move {@link probeTurnBudget}
 * automatically — see that function's doc for why this exists (W1-T2201).
 */
```

## PROBE_TURN_ALLOWANCE_CEILING

`src/lib/containment.ts:589-612` at `5c5e21aa`, 24 comment lines.

```
/**
 * BACKSTOP (test/bound-kind-declared.test.ts): the per-command allowance below is
 * the PRIMARY mechanism that sizes the probe's slack; this ceiling does not fire
 * under the probe's current, healthy 6-command shape (6 < 8) and exists only to
 * catch UNBOUNDED growth if commands keep accruing — the same failure mode this
 * task itself fixes, pointed the other way (Q1: "a scaling allowance also grows
 * without bound as commands are added").
 *
 * THE STATED CEILING (W1-T2344, Q1) — PICKED, NOT MEASURED, the same discipline
 * {@link EGRESS_TIMEOUT_SECONDS} admits to rather than dressing the number up as
 * derived. Set two commands above the probe's real count today (6), so a SEVENTH
 * and an EIGHTH command still move {@link PROBE_TURN_ALLOWANCE} the way W1-T2201
 * already made them move the base — the property Q1 asks for — while a NINTH
 * would need a deliberate bump of this constant rather than silent, unbounded
 * growth every time an arm is added.
 *
 * WHAT IT COSTS: at the ceiling, a probe that is genuinely HANGING (a worker
 * looping, a command that never returns a usable result) now spends up to 8
 * turns of allowance before the fail-closed verdict engages — up from the old
 * flat 3. Every turn added here is a turn spent before that safety fires, on
 * every hanging probe, for the sake of the non-hanging ones (Q1's "argument
 * against myself"). Raising this ceiling later must restate that cost, not just
 * bump the number.
 */
```

## PROBE_TURN_ALLOWANCE

`src/lib/containment.ts:615-648` at `5c5e21aa`, 34 comment lines.

```
/**
 * TURN ALLOWANCE beyond one Bash turn per command plus the closing REPORT turn —
 * turns a careful probe legitimately spends that are NOT worker misbehaviour
 * (W1-T2201 rationale, Q1). Named for what each one buys, rather than picked as a
 * round number:
 *   1. re-reading an AMBIGUOUS result — a command that produced no output, where
 *      the outcome is knowable only by checking the marker files. This is not
 *      hypothetical: a W1-T1281 transcript hit exactly this ("Command 4 produced
 *      no output at all, which is ambiguous — I need to check which marker files
 *      were created") and had no turn left to spend on it.
 *   2. a RETRY after a malformed invocation.
 *   3. REWORK forced by the probe's own deny-floor tripwire (Q2): a read-only
 *      verification command that merely NAMES the tripwire literal is itself
 *      refused by `hooks/deny-floor.sh` (its rule 3 matches the whole command
 *      string, so it cannot tell an attempt to CREATE the tripwire from an `ls`
 *      that only names it) — a probe that double-checks its own reading pays a
 *      turn re-deriving it from fragments, through no fault of its own.
 *
 * W1-T2344 — WHY THIS IS NOW A FUNCTION OF COMMAND COUNT, NOT A FLAT CONSTANT.
 * Reason 1 above is PER COMMAND, not per probe: any command whose result is only
 * knowable by marker file can individually cost the ambiguous-result re-reading
 * turn, and reasons 2 (a malformed retry) and 3 (tripwire rework) are each also
 * more likely the more commands a probe runs, never less. A flat allowance of 3
 * was a FULL command's worth of slack at the original 3-command spike and had
 * diluted to HALF a turn per command by the time a sixth command landed — the
 * derived base (see {@link probeTurnBudget}) kept climbing right on schedule, so
 * the dilution never showed up as a number failing to move, only as the probe
 * exhausting its turns on 29% of dispatches (measured 2026-08-26 from the
 * `containment.probe` ledger, every exhausted row exactly one turn over cap).
 * ONE named slack turn PER COMMAND, capped at {@link PROBE_TURN_ALLOWANCE_CEILING}
 * so raising it later is a decision about a SPECIFIC new cost (or a deliberate
 * ceiling bump), never a knob nudged until a flaky run happens to pass and never
 * unbounded growth hidden behind a base that is already moving.
 */
```

## probeTurnBudget

`src/lib/containment.ts:653-669` at `5c5e21aa`, 17 comment lines.

```
/**
 * The probe's turn cap — DERIVED, never a hand-picked literal: one turn per
 * command the prompt actually lists, plus one turn for the closing REPORT, plus
 * the named allowance above (itself now a function of that SAME command count,
 * W1-T2344 — see {@link PROBE_TURN_ALLOWANCE}'s own doc for why).
 *
 * W1-T2201 — WHY THIS EXISTS: the previous `maxTurns: 6` was a literal unchanged
 * since the original 3-command spike (`b697de79`, #18; `git log -S'maxTurns: 6'
 * -- src/lib/containment.ts` returns exactly those two commits) and did NOT move
 * when the egress command — a FOURTH command — was added underneath it in
 * `9ca4180c` (#2626): three commands plus the closing report already spent four
 * of the six turns, leaving one turn of slack for a probe that now had to run
 * four commands plus the report. All three observed runs exhausted that one-turn
 * slack and ended `Reached maximum number of turns (6)` before the outside-write
 * check ever ran. Deriving the cap from `probeCommandCount` means a FIFTH command
 * moves this cap automatically instead of silently eating whatever slack is left.
 */
```

## EGRESS_BLOCKED_HOST

`src/lib/containment.ts:674-692` at `5c5e21aa`, 19 comment lines.

```
/**
 * Regex marking an OS/sandbox-level write denial (as opposed to a hook denial),
 * mirroring the WS-0 verdict-7 transcript check.
 */
/**
 * W1-T1265 — THE BLOCKED TARGET IS RFC 2606's RESERVED DOCUMENTATION DOMAIN.
 *
 * The probe GENUINELY REACHES this host when containment fails, exactly as the
 * filesystem probe genuinely writes outside cwd when the sandbox fails — the
 * "must not reach a third party" constraint is satisfiable only in the CONTAINED
 * case, and pretending otherwise would be a promise the mechanism cannot keep.
 * `example.com` is reserved by IANA precisely so tests may name it, so contact in
 * the failure case is inert.
 *
 * NOT A DNS-FAILURE TARGET, DELIBERATELY. A guaranteed-non-resolving name (an RFC
 * 6761 `.invalid` domain) fails identically whether the sandbox engaged or the host
 * is simply offline — structurally unable to discriminate, which is the same defect
 * as a proof that cannot fail.
 */
```

## EGRESS_ALLOWED_HOST_FALLBACK

`src/lib/containment.ts:695-701` at `5c5e21aa`, 7 comment lines.

```
/**
 * Fallback control host, used ONLY when the settings file's allowlist cannot be
 * read. The real control target is derived FROM the allowlist at probe time
 * ({@link allowedHostFromSettings}) so the two can never drift; this constant
 * exists so a caller that supplies no settings still probes something allowlisted
 * rather than silently skipping the control.
 */
```

## EGRESS_TIMEOUT_SECONDS

`src/lib/containment.ts:704-716` at `5c5e21aa`, 13 comment lines.

```
/**
 * Per-request timeout, seconds. THIS NUMBER IS PICKED, NOT MEASURED — said plainly
 * rather than dressed as derived, the discipline `deploy/entrypoint.sh`'s
 * `RMD_FRESHNESS_RESTART_MAX` row uses when it records "WHY 100, MEASURED".
 *
 * WHY IT IS BOUNDED AT ALL is not a preference: an unbounded connect inside the
 * preflight would stall every dispatch behind it, and the preflight runs before any
 * task worker. 10s x 2 requests caps the arm at ~20s against a probe spawn that
 * already costs tens of seconds, so the arm cannot dominate the preflight.
 * WHAT WOULD MEASURE IT: the p99 of the two requests' wall time across real
 * preflights, read off `containment.probe` rows once this arm has run in the fleet.
 * Until then it is a bound chosen to be obviously safe, not a fitted one.
 */
```

## EGRESS_BLOCKED_REMOTE_IP_FILE

`src/lib/containment.ts:723-732` at `5c5e21aa`, 10 comment lines.

```
/**
 * W1-T2271 — THE DISCRIMINATOR DESIGN NOTE PART (iv) RECOMMENDED: curl's own
 * `-w '%{remote_ip}'` on the SAME request already made, body still discarded.
 * WRITTEN UNCONDITIONALLY by shell redirection — unlike the touch markers
 * above, which are `&&`-gated on curl's exit code, `> file` opens/truncates
 * the file before curl even runs, so this file's mere EXISTENCE proves
 * nothing. It is read only when the paired touch marker above says the
 * request came back (see {@link defaultExecutor}); an unreached request's
 * file is ignored, never trusted as a stray empty-string remote_ip.
 */
```

## egressProbeCommand

`src/lib/containment.ts:737-772` at `5c5e21aa`, 36 comment lines.

```
/**
 * The single Bash command carrying BOTH egress attempts. ONE command, not two, so
 * the two requests count as ONE command against {@link probeTurnBudget} rather
 * than two — bundling was a real turn-saving choice when the cap was a fixed
 * `maxTurns: 6` that never moved (see that function's W1-T2201 doc for why the
 * cap is now DERIVED instead), and staying bundled remains free: unbundling would
 * add a fifth command, which is out of this file's scope to propose.
 *
 * Each request writes its marker ONLY on success, so the executor observes outcomes
 * by `existsSync` exactly as it already does for the two writes — no transcript
 * parsing is required for the two "did it come back" facts.
 *
 * W1-T2271 — WHY `-w '%{remote_ip}'` WAS ADDED, AND WHY IT DOES NOT REOPEN THE
 * "no transcript parsing" / "body discarded" invariants above. The marker alone
 * cannot distinguish "curl received a response of some kind" from "the upstream
 * was reached" — curl exits 0 on ANY http response with no `--fail`, no status
 * test, and `-o /dev/null` still discards the body. `-w` exposes the remote
 * address curl actually connected to on the SAME request, at no extra cost (no
 * new command, no new destination, the body is STILL never read) — the cheapest
 * honest discriminator the design note names: if the blocked host and the
 * allowlisted control both terminate at the same address, one local
 * interception proxy answered both, and "the upstream was reached" is
 * unsupported. See {@link assessEgressContainment} for how this is used.
 *
 * W1-T2344 (Q2) — WHY EACH REQUEST ALSO `echo`s ITS OWN OUTCOME NOW. Everything
 * above still redirects to `/dev/null` and writes markers/remote-ip files for
 * `defaultExecutor`'s own `existsSync`-based evidence gathering (UNCHANGED) —
 * but that left the WORKER'S OWN Bash-tool turn with no output at all to report,
 * exactly the ambiguity {@link PROBE_TURN_ALLOWANCE}'s reason 1 names ("Both
 * curls produced no output. Let me verify which marker files were created" — a
 * real transcript, W1-T2344 rationale). Reading the SAME marker this command
 * already wrote and echoing "reached"/"unreached" (plus the already-exposed
 * remote_ip, never the response body) turns that into an ordinary command with
 * ordinary output — the worker can quote it directly in its REPORT and never
 * needs the extra turn to go check the marker files itself.
 */
```

## EGRESS_RESULT_PREFIX

`src/lib/containment.ts:796-820` at `5c5e21aa`, 25 comment lines.

```
/**
 * W1-T2344 (Q2) — THE PREFIX ON THE LINE COMMAND 4 PRINTS ABOUT ITSELF.
 *
 * THE TURN THIS EXISTS TO SAVE. Command 4 discards its body (`-o /dev/null`), redirects `-w`'s
 * output to a file, and sends stderr to `/dev/null`, so on the worker's own transcript it produces
 * NOTHING — success and failure look identical. The worker then has to spend a turn reading the
 * marker files back before it can write an accurate closing REPORT. That turn is not hypothetical:
 * a failing transcript reads "Both curls produced no output. Let me verify which marker files were
 * created", which is verbatim the ambiguity {@link PROBE_TURN_ALLOWANCE}'s own doc names as
 * allowance-turn 1. MEASURED: every one of the 33 exhausted probes that recorded a count read
 * `num_turns: 11` against `max_turns: 10` — exactly one turn over, every time — while succeeding
 * probes ran a median of 9 of 10.
 *
 * IT IS A PREFIX, NOT A VERDICT. The two lines this marks are DERIVED, at runtime, from the same
 * two marker files {@link defaultExecutor} reads with `existsSync` — a command that printed
 * "denied" without testing anything would be the vacuous-pass shape, and this cannot be that: the
 * marker is written ONLY by a curl that came back, so the printed word is a read of an observation
 * that already happened, never a substitute for making it.
 *
 * NOTHING PARSES IT, AND THAT IS DELIBERATE. `arms_reported` is {@link probeArmsReported}, a pure
 * reduction over twelve booleans on {@link ContainmentEvidence}; the egress arms among them come
 * from `existsSync` on these same markers, never from transcript text. The prefix is greppable so a
 * future consumer COULD read it, but no consumer does, and the "no transcript parsing" invariant
 * for "did it come back" is untouched.
 */
```

## stateReadControlBasename

`src/lib/containment.ts:828-835` at `5c5e21aa`, 8 comment lines.

```
/**
 * Basename of the synthetic, probe-owned control file placed as a SIBLING of
 * `service-tokens.json` under `state/` for the run's token — an ordinary file a
 * worker's read of the rest of the state tree would legitimately succeed
 * against, without this probe ever touching a real production state file or the
 * token's own content (design part (v)). Token-scoped so concurrent runs never
 * collide on the same path.
 */
```

## tokenReadProbeCommand

`src/lib/containment.ts:840-847` at `5c5e21aa`, 8 comment lines.

```
/**
 * W1-T2211 — THE READ ARM'S PROBE COMMAND, MIRRORING {@link egressProbeCommand}'S
 * SHAPE: ONE bundled Bash command carrying BOTH reads, so they count as ONE
 * command against {@link probeTurnBudget}. Neither read's OUTPUT is ever
 * printed (both redirect to `/dev/null`) — the probe proves the read's
 * success/failure by marker existence exactly as the write and egress arms do,
 * never by putting file content (least of all a token) into the transcript.
 */
```

## operatorHomeReadProbeCommand

`src/lib/containment.ts:860-871` at `5c5e21aa`, 12 comment lines.

```
/**
 * W1-T2213 — THE RE-ANCHORING ARM'S PROBE COMMAND, MIRRORING {@link
 * tokenReadProbeCommand}'S SHAPE one level up: where that command proves a read
 * denied by the token deny's `~/..` anchoring, this one proves a read denied by
 * the `~/../..` anchoring design part (i) applies to the three re-anchored
 * denies. ONE read, not a bundled pair — the ordinary-read control this arm
 * needs is the SAME `state-read-succeeded.txt` marker {@link tokenReadProbeCommand}
 * already proves within the same probe run (design part (vi)), so this command
 * does not re-derive a second control read. Output is never printed (redirects
 * to `/dev/null`) — the probe proves success/failure by marker existence, never
 * by putting the operator's real config file content into the transcript.
 */
```

## allowedHostFromSettings

`src/lib/containment.ts:879-884` at `5c5e21aa`, 6 comment lines.

```
/**
 * Read the FIRST allowlisted domain out of an already-parsed worker settings
 * object. Derived from the allowlist rather than duplicated, so the control target
 * cannot drift from the policy it is meant to exercise. THIS READS THE ALLOWLIST
 * AND NEVER WRITES IT — the probe observes; it does not enforce.
 */
```

## assessEgressContainment

`src/lib/containment.ts:895-951` at `5c5e21aa`, 57 comment lines.

```
/**
 * PURE egress verdict, mirroring {@link assessContainment} field for field and
 * returning the SAME `{contained, reason}` shape — the three-state epistemology
 * `ContainmentError` already names (proven-holding | proven-broken | unproven)
 * expressed exactly as the filesystem arm expresses it, with UNPROVEN carried as
 * `contained: false` plus a reason that says so. NO FOURTH STATE.
 *
 * W1-T2271 — WHY THE `egressBlockedReached` BRANCH CHANGED. The prior version
 * read that one boolean straight into PROVEN-BROKEN. That marker means only
 * "curl received a response of some kind" — `curl -sS -m 10 -o /dev/null
 * https://example.com` has no `--fail`, no status-code test, and discards the
 * body, so it exits 0 on a 200, a 403, a 407, or a proxy-synthesised block
 * page alike, and non-zero only on a TRANSPORT failure (DNS, refused
 * connection, timeout). Converting "a response came back" into "the allowlist
 * did not hold" asserts a cause the evidence never carried — and the
 * short-circuit OUTRANKED contrary evidence the SAME probe run already held
 * (`egressDenialSeen`), which is why 90 of 97 recorded verdicts read
 * PROVEN-BROKEN, 68 of them alongside an observed refusal. Checked in this
 * order, so a bare response is never worth more than the evidence it carries:
 *
 *  1. no attempt observed at all ⇒ UNPROVEN (unchanged).
 *  2. the control also failed ⇒ UNPROVEN (unchanged) — a blocked request
 *     proves nothing when nothing gets out at all.
 *  3. the blocked request came back — the branch this task rewrites:
 *     a. a refusal was ALSO observed on the same run ⇒ UNPROVEN. The response
 *        marker cannot outrank contrary evidence the probe already holds
 *        (rationale (5): 68 of the 90 mis-reported rows carried exactly this
 *        combination).
 *     b. the request terminated at the SAME remote address as the allowlisted
 *        control (design note part (iv), {@link
 *        ContainmentEvidence.egressBlockedRemoteIp}) ⇒ UNPROVEN — one local
 *        interception proxy answered both, precisely the fact rationale (6)
 *        shows the model reconstructing by hand, expensively, before this
 *        field existed.
 *     c. a DIFFERENT remote address was observed on both sides ⇒
 *        PROVEN-BROKEN — the one case this arm now holds actual
 *        discriminating evidence for, named in the reason.
 *     d. no remote-ip evidence at all (executor predates the field, or curl's
 *        `-w` write never landed) ⇒ UNPROVEN — "a response with no
 *        discriminating detail" is reported as unproven, never a proven
 *        breach (acceptance criterion 1).
 *  4. the blocked request never came back and no refusal was ever observed
 *     either ⇒ UNPROVEN (unchanged).
 *  5. blocked absent, control present, refusal observed ⇒ PROVEN-HOLDING
 *     (unchanged) — the only branch this function ever returns `true` from.
 *
 * The body is STILL never read (`-o /dev/null` unchanged, no `--fail`, no
 * response-shape comparison — design note part (iii) rejects that without an
 * explicit ruling) and no new destination is ever contacted: the only new
 * evidence is `-w`'s own transport fact on the SAME two requests the probe
 * already made.
 *
 * OBSERVATIONAL, NOT GATING — the same call the deny-floor arm made, and for the
 * same reason: this arm's behaviour under the installed CLI is UNMEASURED, and
 * gating a fleet on an unmeasured probe could park it. `probeContainment` records
 * the verdict on its `containment.probe` row and does not throw on it.
 */
```

## assessTokenReadContainment

`src/lib/containment.ts:1022-1035` at `5c5e21aa`, 14 comment lines.

```
/**
 * W1-T2211 — THE READ ARM, PROVING RATHER THAN DECLARING THE `denyRead` ENTRY
 * FROM DESIGN PART (i). PURE, mirroring {@link assessEgressContainment} field
 * for field and returning the SAME `{contained, reason}` shape — the same
 * three-state epistemology (proven-holding | proven-broken | unproven), NO
 * FOURTH STATE.
 *
 * OBSERVATIONAL, NOT GATING — the same call the deny-floor and egress arms
 * made, and for the same reason: this arm's behaviour under the installed CLI
 * is UNMEASURED (rationale (5): "Q1's control could not be produced" — there
 * is no path in this tree `denyRead` has ever been shown to block), and gating
 * a fleet on a brand-new, unmeasured probe could park it. `probeContainment`
 * records the verdict on its `containment.probe` row and does not throw on it.
 */
```

## assessOperatorHomeReadContainment

`src/lib/containment.ts:1073-1090` at `5c5e21aa`, 18 comment lines.

```
/**
 * W1-T2213 — THE RE-ANCHORING ARM, PROVING RATHER THAN DECLARING THE `~/../..`
 * ANCHORING FROM DESIGN PART (i). PURE, mirroring {@link
 * assessTokenReadContainment} field for field and returning the SAME
 * `{contained, reason}` shape — the same three-state epistemology
 * (proven-holding | proven-broken | unproven), NO FOURTH STATE.
 *
 * The CONTROL is deliberately `e.stateReadSucceeded` — the SAME field {@link
 * assessTokenReadContainment} already reads, proven once per probe run rather
 * than re-derived per arm (design part (vi)'s own falsifier: without it, "the
 * operator-home read failed" cannot be told from "reads are broken generally").
 *
 * OBSERVATIONAL, NOT GATING — the same call the deny-floor, egress and
 * token-read arms make, and for the same reason: this arm's behaviour under
 * the installed CLI is UNMEASURED, and gating a fleet on a brand-new,
 * unmeasured probe could park it. `probeContainment` records the verdict on
 * its `containment.probe` row and does not throw on it.
 */
```

## stripDenyFloorLines

`src/lib/containment.ts:1139-1155` at `5c5e21aa`, 17 comment lines.

```
/**
 * Drop every transcript line that is ABOUT the deny-floor tripwire before {@link
 * OS_DENIAL_RE} is applied — the ONE way adding step 3 could otherwise WEAKEN the
 * containment verdict, so it is removed rather than argued to be unlikely.
 *
 * `osDenialSeen` is load-bearing in exactly one branch: outside write absent AND
 * no denial observed ⇒ UNPROVEN (the worker may never have attempted it). The
 * hook's own refusal text ("deny-floor: blocked — …") does not match
 * `OS_DENIAL_RE`, but the WORKER's prose about step 3 is not under our control and
 * "denied"/"permission" are both in that pattern — so a run that never attempted
 * step 1 could have been flipped from UNPROVEN to contained by step 3's narration.
 * Stripping the tripwire's own lines keeps the OS-denial evidence sourced strictly
 * from the outside-cwd write, exactly as it was before this step existed.
 *
 * Line-oriented and deliberately generous about what counts as a tripwire line:
 * the basename, the hook's own prefix, or the report line the prompt asks for.
 */
```

## assessDenyFloor

`src/lib/containment.ts:1168-1182` at `5c5e21aa`, 15 comment lines.

```
/**
 * PURE verdict over the deny-floor observation. THREE states, never two — an
 * UNOBSERVED floor (a probe executor that never reported the field, i.e. every
 * pre-existing injected fake) must read as "unobserved", never as "engaged":
 * silence is not evidence, the same three-state epistemology {@link
 * ContainmentError}'s `observed` field keeps for containment itself.
 *
 * OBSERVATIONAL, NOT A GATE. Nothing in {@link probeContainment} throws on this
 * verdict, and that is a deliberate first step rather than an unfinished one. The
 * empirical behaviour of the hook under the INSTALLED CLI is UNMEASURED here (the
 * ledger is unreachable and no spike was run for it), and this repo has already
 * paid for bounds that fire on healthy conditions. Wiring the observation first
 * produces the measurement a severity flip would need — the same
 * advisory-then-flip order W1-T322/W1-T323 established.
 */
```

## probeArmsReported

`src/lib/containment.ts:1207-1223` at `5c5e21aa`, 17 comment lines.

```
/**
 * W1-T2238 — DESIGN PART (ii): a count of probe arms that reported, IN THE
 * BUDGET'S OWN UNIT. `probeTurnBudget` counts COMMANDS; these twelve fields —
 * named verbatim in rationale (6) — are each ONE command's own observation, so
 * a count of how many fired is comparable to the cap on both the exhausted AND
 * the success path, unlike `numTurns` (rationale (5)). ONE REDUCTION over
 * fields the row already carries — no new evidence collection, no new arm.
 *
 * `true` is the only value counted: each of the twelve is either a positive
 * observation (a write landed, a denial was seen, a read succeeded, the
 * deny-floor engaged) or it is not, and only the former is a command the probe
 * actually got far enough to report on. `deny_floor_engaged` is the one
 * tri-state field on the row (undefined ⇒ UNOBSERVED); it is re-derived here
 * via {@link assessDenyFloor} rather than stored a second time on
 * `ContainmentEvidence`, so this count can never drift from the same field the
 * row itself logs as `deny_floor_engaged`.
 */
```

## CREDENTIAL_FAILURE_RE

`src/lib/containment.ts:1242-1249` at `5c5e21aa`, 8 comment lines.

```
/**
 * Regex marking the CLI's credential/auth-dead result text, verified verbatim
 * (SDK 0.3.209 / CLI 2.1.209, see env.ts / worker-home.ts / FINDINGS.md): a
 * headless spawn with no usable OAuth token exits "Not logged in · Please run
 * /login" at $0 before any turn. MATCHED CONSERVATIVELY — both fragments must
 * appear (not "any error"), so an unrelated error-result is never mislabelled a
 * credential failure. Applied only in combination with `isError`, never alone.
 */
```

## CREDENTIAL_EXPIRED_RE

`src/lib/containment.ts:1253-1266` at `5c5e21aa`, 14 comment lines.

```
/**
 * Regex marking the SDK's OTHER credential-dead result text: a copied OAuth
 * token that has since EXPIRED (as opposed to never being logged in at all).
 * W1-T292 matched this against "OAuth session expired and could not be
 * refreshed", but that phrasing is no longer what the SDK emits. W1-T2250's
 * observed excerpt — corroborated independently by W1-T2249's ledger read,
 * both attributed rather than re-derived by a live probe here — reads "Failed
 * to authenticate. API Error: 401 OAuth access token has expired.
 * Re-authenticate to continue" at $0 before any turn: a distinct string from
 * CREDENTIAL_FAILURE_RE/CREDENTIAL_LOGIN_HINT_RE above, so it previously
 * matched neither pair and fell through to the generic "unproven" verdict
 * W1-T237/W1-T292 exist to prevent. Same conservative shape: both fragments
 * must appear, applied only in combination with `isError`.
 */
```

## TRANSPORT_FAILURE_RE

`src/lib/containment.ts:1270-1285` at `5c5e21aa`, 16 comment lines.

```
/**
 * W1-T2249 — THE ARM NEITHER CREDENTIAL REGEX ABOVE COVERS. Marks the Anthropic
 * API's own transport/server-side failure text surfaced through a probe worker's
 * result envelope: a `5xx`-numbered "API Error: <code> …" response (observed
 * verbatim on the fleet as "API Error: 529 Overloaded" — five occurrences within
 * sixteen minutes, this task's own ledger read). Deliberately narrow — `5\d\d`
 * immediately after "api error:", not a bare "error" or "5xx" anywhere in the
 * transcript — so a task's own unrelated prose mentioning an HTTP code is never
 * mislabelled a spawn failure. `4xx` codes (401 included) are OUT of this arm's
 * scope on purpose: 401 is credential-shaped and already owned by
 * `CREDENTIAL_EXPIRED_RE`/`CREDENTIAL_TOKEN_EXPIRED_RE` above; widening this arm
 * to catch it too would let a THIRD arm race the credential ones for the same
 * text instead of leaving credential text to the credential arms. Applied only
 * in combination with `isError`, never alone — the same discipline both
 * credential regexes already use.
 */
```

## readRemoteIp

`src/lib/containment.ts:1288-1295` at `5c5e21aa`, 8 comment lines.

```
/**
 * W1-T2271: read the remote-ip file curl's `-w '%{remote_ip}'` wrote, but ONLY
 * when `reached` (the paired touch marker's `existsSync`) says the request
 * actually came back — the file itself exists unconditionally (shell
 * redirection truncates it before curl even runs), so its mere presence
 * proves nothing. Returns `undefined` on a failed/empty read or when the
 * request never reached, never a guessed value.
 */
```

## defaultExecutor

`src/lib/containment.ts:1306-1313` at `5c5e21aa`, 8 comment lines.

```
/**
 * Default executor: spawn a real sandboxed worker in a scratch cwd under the
 * workspace. `spawn` is injectable (defaults to the real {@link spawnWorker})
 * so both W1-T237's `isError` plumbing and W1-T238's stderr-persistence branch
 * (the exact branch that discarded stderr on a failed probe) are directly
 * unit-testable without spawning an actual sandboxed subprocess — every other
 * call site relies on the default.
 */
```

## defaultExecutor, the read arm's two targets

`src/lib/containment.ts:1356-1364` at `5c5e21aa`, 9 comment lines.

```
    // W1-T2211 — THE READ ARM'S TWO TARGETS. `tokenPath` is deliberately the SAME
    // path serve.ts's own `serviceTokensPath(configRoot)` resolves — duplicated as
    // a bare join() rather than imported, so this low-level probe module never
    // takes a dependency on serve.ts's (much heavier) module graph for one path,
    // the same discipline ledger.ts's STATE_BACKUP_LEDGER_RELPATH doc already
    // states for the same reason. `controlPath` is a SYNTHETIC file this probe
    // creates and owns (never a real production state file, never the token's own
    // content) so the control read cannot fail merely because some other state
    // file happens to be absent this early in a run.
```

## defaultExecutor, numTurns and maxTurns

`src/lib/containment.ts:1407-1412` at `5c5e21aa`, 6 comment lines.

```
        // W1-T2238: both fields were already on WorkerResult (W1-T303); this
        // extraction site is where they were dropped one line away from the row
        // that needed them — see ContainmentEvidence.numTurns/.maxTurns.
        // `probe.maxTurns` (not a re-derivation) is `WorkerResult.maxTurns` —
        // worker.ts's own mirror of the `maxTurns` this spawn call was actually
        // invoked with, the same INPUT-never-read-back discipline W1-T303 set.
```

## probeContainment

`src/lib/containment.ts:1456-1469` at `5c5e21aa`, 14 comment lines.

```
/**
 * Run the containment preflight for a run. FAILS CLOSED (throws
 * {@link ContainmentError}) unless containment is empirically proven.
 *
 * Two gates, both must pass:
 *  1. CONFIG — the settings file must declare an ENABLED sandbox (reuses
 *     {@link validateWorkerSettingsFile}, which requires `enabled` and
 *     `failIfUnavailable`). A sandbox-disabled file fails closed here, before any
 *     spawn — defense-in-depth so the probe never trusts a file it wasn't handed
 *     under an enabled sandbox.
 *  2. EMPIRICAL — spawn under the sandbox and confirm an outside-cwd write is
 *     OS-denied ({@link assessContainment}). This catches the failure static
 *     validation CANNOT: a well-formed file whose sandbox silently dropped.
 */
```

## probeContainment, the credentialExpired wiring

`src/lib/containment.ts:1522-1528` at `5c5e21aa`, 7 comment lines.

```
    // W1-T292, phrases re-derived by W1-T2250: a SECOND, DISTINCT credential-dead
    // signature — an expired copied OAuth token — kept out of `credentialFailure`
    // above so the two never collapse into one reason. Same conservative
    // both-fragments-required shape, now matched against the text the SDK
    // actually emits ("Failed to authenticate. API Error: 401 OAuth access token
    // has expired...") rather than the superseded "OAuth session expired and
    // could not be refreshed".
```

## probeContainment, egressDenialSeen

`src/lib/containment.ts:1551-1557` at `5c5e21aa`, 7 comment lines.

```
    // Mirrors `osDenialSeen`: a refusal must be OBSERVED, never inferred from the absence
    // of a response. Sourced from EGRESS_DENIAL_RE ALONE — deliberately NOT from
    // `OS_DENIAL_RE`, because a filesystem denial must never be read as an egress denial
    // (this file's own doc for the two patterns says so). It also keeps the strip call
    // above a UNIQUE textual occurrence, which test/deny-floor-probe.test.ts pins as the
    // precondition of its mutation guard — that guard counts occurrences in the raw
    // SOURCE TEXT, so even a comment quoting the call verbatim would break it.
```

## probeContainment, the stderr_excerpt disjunction

`src/lib/containment.ts:1670-1689` at `5c5e21aa`, 20 comment lines.

```
    // W1-T238, WIDENED BY W1-T2249: the probe spawn's own stderr/error-result
    // text, capped, recorded when the underlying worker call itself errored
    // (`r.isError` — W1-T238's original rule, LOAD-BEARING AND UNCHANGED) OR on
    // a REFUSING probe (`!verdict.contained` — this task's addition, for the
    // `no-denial-observed` state that returned normally and so carried no
    // transcript at all).
    //
    // THE DISJUNCTION IS LOAD-BEARING: the two arms are INDEPENDENT and neither
    // subsumes the other. `!verdict.contained` ALONE silently DROPPED the field
    // from the errored-but-CONTAINED quadrant (`isError` true, verdict
    // contained — a probe that observed the OS denial and then hit a transient
    // tool error), which is precisely the quadrant W1-T238 added the field for.
    // That absence is not neutral: under W1-T238's convention an absent field
    // ASSERTS "this probe spawn did not error", so dropping it reports a false
    // state as a proven one — the exact collapse this task was filed to
    // prevent, one predicate away from committing it in its own diff.
    //
    // A CLEAN probe — `!r.isError` AND `verdict.contained` — still carries no
    // field at all, both arms being false there, so a passing run's ledger line
    // stays exactly as it was: the property W1-T238 protects, unweakened.
```

## probeContainment, the five states

`src/lib/containment.ts:1693-1721` at `5c5e21aa`, 29 comment lines.

```
    // OBSERVED (W1-T91/P23 part i, extended by W1-T237, W1-T292, then
    // W1-T2249): the write's OWN outcome names which of FIVE states this was,
    // checked in this order so a spawn-dead worker (credential OR transport)
    // can never be reported as the genuine unproven case:
    //  1. credentialExpired — the probe worker died because a COPIED OAuth
    //     token had EXPIRED. Named `spawn_credential_expired` distinctly from
    //     #2 below: the operator action differs (re-mint/refresh the token vs.
    //     log in from scratch), so the two reasons must never share a symbol.
    //  2. credentialFailure — the probe worker died on auth (never logged in),
    //     before it could attempt any write. Named `spawn_credential_failure`
    //     distinctly: this proves NOTHING about isolation either way (unlock
    //     the keychain, don't investigate the sandbox).
    //  3. spawnTransportFailure — the probe worker died on a transport or
    //     API-side failure (a 529, a dropped connection), before it could
    //     attempt any write. Named `spawn_transport_failure` distinctly: this
    //     proves NOTHING about isolation either way (retry once the API/
    //     transport recovers, don't investigate the sandbox) — the arm this
    //     task exists to add, a dead probe and a broken boundary no longer
    //     share a verdict.
    //  4. outsideWriteCreated — proven-broken (the outside write LANDED, the
    //     sandbox did not engage) is data-bearing.
    //  5. neither — genuinely UNPROVEN, but no longer collapsed to the eight
    //     characters "unproven": classifyUnprovenState (W1-T1281, extended by
    //     W1-T2201) names WHICH of four distinguishable states this was —
    //     "turns-exhausted", "probe-never-ran", "write-never-attempted", or
    //     "no-denial-observed" — so a `blocked_containment` ledger row (this
    //     error's `observed` field, read by run-task.ts) can name the cause
    //     instead of forcing a reader to re-derive it from evidence that was
    //     never recorded in the first place.
```
