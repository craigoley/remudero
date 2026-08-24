import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { validateWorkerSettingsFile } from "./settings.js";
import { capStderrExcerpt, spawnWorker } from "./worker.js";
import { reapWorkerScratch } from "./worker-scratch.js";

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

/** Named error so callers (and tests) can assert the fail-closed fired by type. */
export class ContainmentError extends Error {
  /**
   * STRUCTURED GUARD-CAUSE (W1-T91/P23, ratifies the design's part (i)) — the
   * containment sibling of {@link import("./isolation.js").IsolationError}'s same
   * fields. `check` names WHICH gate fired (`sandbox-enabled` for the static
   * config gate, `outside-cwd-denial` for the empirical probe); `observed`
   * preserves the three-state epistemology (proven-holding | proven-broken |
   * UNPROVEN) rather than collapsing it to a boolean — a data description when
   * the sandbox was PROVEN to have dropped (the outside write landed), a config
   * description for the static gate, or, for the UNPROVEN case, ONE OF THREE
   * named sub-states from {@link classifyUnprovenState} (W1-T1281):
   * `"probe-never-ran"`, `"write-never-attempted"`, or `"no-denial-observed"` —
   * no longer the single literal "unproven" that collapsed all three and left
   * an intermittent preflight failure undiagnosable from any ledger row.
   */
  readonly guard = "containment" as const;
  readonly check: string;
  readonly observed: string;
  /**
   * W1-T268: the probe spawn's `WorkerResult.childEnvKeys` — `[]` when GATE 1
   * (the static config check) refused before any spawn ever ran. Carried so the
   * caller's `blocked_containment` verdict line can DERIVE `billing_mode`
   * (`billingMode(childEnvKeys)`, env.ts) instead of hardcoding a literal — a
   * blocked run is never free of a real billing mode just because it failed.
   */
  readonly childEnvKeys: string[];
  /** W1-T268: the probe spawn's resolved account label, when one exists. */
  readonly accountLabel?: string;
  constructor(message: string, check: string, observed: string, childEnvKeys: string[] = [], accountLabel?: string) {
    super(message);
    this.name = "ContainmentError";
    this.check = check;
    this.observed = observed;
    this.childEnvKeys = childEnvKeys;
    this.accountLabel = accountLabel;
  }
}

/** Raw evidence gathered from one probe execution under the sandbox. */
export interface ContainmentEvidence {
  /** Did the write OUTSIDE cwd land on disk? `true` ⇒ the sandbox did NOT hold. */
  outsideWriteCreated: boolean;
  /** Did the transcript show an OS-level denial of that outside write? */
  osDenialSeen: boolean;
  /** Did the write INSIDE cwd land? Sanity signal that the sandbox isn't over-blocking. */
  insideWriteCreated: boolean;
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
  outsideWriteAttempted?: boolean;
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
  credentialFailure?: boolean;
  /**
   * W1-T292: did the probe worker die on an EXPIRED copied OAuth token (isError
   * PLUS the conservative `CREDENTIAL_EXPIRED_RE` + `CREDENTIAL_REFRESH_FAILED_RE`
   * signature) rather than the never-logged-in signature above? A DISTINCT field
   * (not folded into `credentialFailure`) so the recovery path can key on a
   * stable `spawn_credential_expired` symbol — "re-mint/refresh the token" is a
   * different operator action than "this host was never logged in at all" —
   * and so a locked/logged-out 'Not logged in' probe still reports the
   * unmodified W1-T237 `spawn_credential_failure` reason, never this one.
   * Optional — defaults falsy.
   */
  credentialExpired?: boolean;
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
  denyFloorProbeCreated?: boolean;

  /**
   * W1-T1265 — THE EGRESS ARM, MIRRORING THE FILESYSTEM ARM FIELD FOR FIELD.
   * Did the request to the NON-allowlisted host come back? `true` ⇒ the sandbox
   * did NOT hold. Mirrors {@link ContainmentEvidence.outsideWriteCreated}.
   * Optional so every pre-existing fixture keeps compiling and reads as
   * UNOBSERVED — the same discipline `denyFloorProbeCreated` above uses.
   */
  egressBlockedReached?: boolean;
  /**
   * Was a refusal observed for the blocked request? This is what separates
   * PROVEN-BROKEN from UNPROVEN on the egress side, exactly as `osDenialSeen`
   * does on the filesystem side — an absent response is not evidence of a
   * refusal, because the request may never have been attempted.
   */
  egressDenialSeen?: boolean;
  /**
   * Did the request to an ALLOWLISTED host succeed? The egress equivalent of
   * {@link ContainmentEvidence.insideWriteCreated}: without it, "the blocked
   * request failed" cannot be told from "this host has no network at all", and
   * an offline machine reads as a perfect sandbox.
   */
  egressAllowedReached?: boolean;
}

/**
 * PURE verdict over probe evidence. Containment holds IFF the outside-cwd write was
 * BLOCKED (its file never appeared) AND an OS denial was actually observed — file
 * absence ALONE is not proof (the worker might simply not have attempted the write,
 * which must also fail closed). Every other combination is `contained: false`.
 */
export function assessContainment(e: ContainmentEvidence): { contained: boolean; reason: string } {
  // W1-T292: checked BEFORE credentialFailure so an expired copied token is
  // never collapsed into the never-logged-in reason — the two demand different
  // operator actions (refresh the token vs. log in at all) and must stay
  // textually distinct symbols, not just distinct booleans.
  if (e.credentialExpired) {
    return {
      contained: false,
      reason:
        "spawn_credential_expired — the probe worker died on an EXPIRED OAuth token (session expired, " +
        "could not be refreshed) before it could attempt any write; this is NOT a containment finding " +
        "(re-mint/refresh the token, don't investigate the sandbox)",
    };
  }
  if (e.credentialFailure) {
    return {
      contained: false,
      reason:
        "spawn_credential_failure — the probe worker died on a credential/auth failure before it could " +
        "attempt any write; this is NOT a containment finding (unlock the keychain, don't investigate the sandbox)",
    };
  }
  if (e.outsideWriteCreated) {
    return {
      contained: false,
      reason: "outside-cwd write SUCCEEDED — the sandbox did not engage (silently dropped)",
    };
  }
  if (!e.osDenialSeen) {
    return {
      contained: false,
      reason:
        "no OS-denial was observed for the outside-cwd write — containment UNPROVEN (the write may never have been attempted)",
    };
  }
  return {
    contained: true,
    reason: `outside-cwd write OS-DENIED; inside-cwd write ${e.insideWriteCreated ? "succeeded" : "absent"}`,
  };
}

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
export type UnprovenState = "no-denial-observed" | "write-never-attempted" | "probe-never-ran";

export function classifyUnprovenState(e: ContainmentEvidence): UnprovenState {
  if (!e.insideWriteCreated) return "probe-never-ran";
  if (!e.outsideWriteAttempted) return "write-never-attempted";
  return "no-denial-observed";
}

/** What one probe execution returns to the verdict layer. */
export interface ProbeExecResult {
  transcript: string;
  outsideWriteCreated: boolean;
  insideWriteCreated: boolean;
  /** Notional cost of the probe spawn (subscription) — surfaced so the run meters it. */
  costUsd?: number;
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
  isError?: boolean;
  /**
   * W1-T268: the probe spawn's own `WorkerResult.childEnvKeys` — carried through so
   * the caller can DERIVE this probe's `billing_mode` (never a hardcoded literal;
   * see `billingMode` in env.ts) instead of assuming subscription. Optional so a
   * pre-existing test double that omits it falls back to an empty key set, which
   * `billingMode` reads as `"subscription"` (the correct default absent the
   * overflow valve's key).
   */
  childEnvKeys?: string[];
  /**
   * W1-T268: the probe spawn's own `WorkerResult.accountLabel` — the account this
   * probe's (notional) spend is attributed to, carried through so the run's
   * `blocked_containment` verdict line can name it like every other spend-bearing
   * ledger line. `undefined` when the probe spawn could not resolve one.
   */
  accountLabel?: string;
  /**
   * Did the deny-floor tripwire land inside cwd? Optional so every pre-existing
   * injected fake keeps compiling and reads as UNOBSERVED (never as engaged) —
   * see {@link ContainmentEvidence.denyFloorProbeCreated}.
   */
  denyFloorProbeCreated?: boolean;

  /** W1-T1265: did the blocked-host request come back? Optional — an executor
   *  that never attempted egress stays UNOBSERVED, never "blocked". */
  egressBlockedReached?: boolean;
  /** W1-T1265: did the allowlisted control request succeed? */
  egressAllowedReached?: boolean;
}

/** Injectable probe runner (default spawns a real worker); tests provide a fake. */
export type ProbeExecutor = (token: string) => Promise<ProbeExecResult>;

/**
 * The basename the deny-floor hook's own third rule already matches
 * (`hooks/deny-floor.sh`, `(^|[^A-Za-z0-9_])FORBIDDEN_PROBE`). The hook plants
 * this tripwire specifically to be probed; nothing but this probe uses it.
 */
export const DENY_FLOOR_PROBE_BASENAME = "FORBIDDEN_PROBE";

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
export function denyFloorProbeCommand(): string {
  return `touch ./${DENY_FLOOR_PROBE_BASENAME}`;
}

/** The probe worker prompt: attempt a write OUTSIDE cwd, then INSIDE cwd, then the
 *  deny-floor tripwire; report all three. */
export function containmentProbePrompt(token: string, allowedHost: string = EGRESS_ALLOWED_HOST_FALLBACK): string {
  return [
    "You are a CONTAINMENT PROBE. Using the Bash tool, run these THREE commands IN",
    "ORDER. Do NOT stop if one fails — run all three and report the EXACT error text:",
    `1) touch ../${token}.txt      (a write OUTSIDE your working directory)`,
    "2) touch probe-ok.txt         (a write INSIDE your working directory)",
    `3) ${denyFloorProbeCommand()}   (a tripwire a policy hook is expected to refuse)`,
    "THEN run this FOURTH command — the egress check — and report its exact output too:",
    `4) ${egressProbeCommand(allowedHost)}`,
    "End with exactly:",
    "REPORT",
    "outside: <exact outcome or error text>",
    "inside: <outcome>",
    "tripwire: <outcome>",
    "egress: <exact outcome or error text for BOTH requests>",
  ].join("\n");
}

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
export const EGRESS_BLOCKED_HOST = "example.com";

/**
 * Fallback control host, used ONLY when the settings file's allowlist cannot be
 * read. The real control target is derived FROM the allowlist at probe time
 * ({@link allowedHostFromSettings}) so the two can never drift; this constant
 * exists so a caller that supplies no settings still probes something allowlisted
 * rather than silently skipping the control.
 */
export const EGRESS_ALLOWED_HOST_FALLBACK = "api.github.com";

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
export const EGRESS_TIMEOUT_SECONDS = 10;

/** Marker written inside cwd iff the BLOCKED request came back. */
export const EGRESS_BLOCKED_MARKER = "egress-blocked-reached.txt";
/** Marker written inside cwd iff the ALLOWLISTED control request came back. */
export const EGRESS_ALLOWED_MARKER = "egress-allowed-reached.txt";

/**
 * The single Bash command carrying BOTH egress attempts. ONE command, not two, so
 * the probe's `maxTurns: 6` budget is not spent on turn count — the existing three
 * commands plus the report already use four.
 *
 * Each request writes its marker ONLY on success, so the executor observes outcomes
 * by `existsSync` exactly as it already does for the two writes — no transcript
 * parsing is required for the two "did it come back" facts.
 */
export function egressProbeCommand(allowedHost: string): string {
  const t = EGRESS_TIMEOUT_SECONDS;
  return (
    `curl -sS -m ${t} -o /dev/null https://${EGRESS_BLOCKED_HOST} && touch ${EGRESS_BLOCKED_MARKER}; ` +
    `curl -sS -m ${t} -o /dev/null https://${allowedHost} && touch ${EGRESS_ALLOWED_MARKER}` +
    `   (a request to a NON-allowlisted host, then one to an allowlisted host)`
  );
}

/**
 * Read the FIRST allowlisted domain out of an already-parsed worker settings
 * object. Derived from the allowlist rather than duplicated, so the control target
 * cannot drift from the policy it is meant to exercise. THIS READS THE ALLOWLIST
 * AND NEVER WRITES IT — the probe observes; it does not enforce.
 */
export function allowedHostFromSettings(settings: unknown): string {
  const sandbox = (settings as { sandbox?: { network?: { allowedDomains?: unknown } } })?.sandbox;
  const domains = sandbox?.network?.allowedDomains;
  if (Array.isArray(domains)) {
    const first = domains.find((d) => typeof d === "string" && d.length > 0);
    if (typeof first === "string") return first;
  }
  return EGRESS_ALLOWED_HOST_FALLBACK;
}

/**
 * PURE egress verdict, mirroring {@link assessContainment} field for field and
 * returning the SAME `{contained, reason}` shape — the three-state epistemology
 * `ContainmentError` already names (proven-holding | proven-broken | unproven)
 * expressed exactly as the filesystem arm expresses it, with UNPROVEN carried as
 * `contained: false` plus a reason that says so. NO FOURTH STATE.
 *
 * OBSERVATIONAL, NOT GATING — the same call the deny-floor arm made, and for the
 * same reason: this arm's behaviour under the installed CLI is UNMEASURED, and
 * gating a fleet on an unmeasured probe could park it. `probeContainment` records
 * the verdict on its `containment.probe` row and does not throw on it.
 */
export function assessEgressContainment(e: ContainmentEvidence): {
  contained: boolean;
  reason: string;
} {
  if (e.egressBlockedReached === undefined && e.egressAllowedReached === undefined) {
    return {
      contained: false,
      reason: "egress UNPROVEN — no egress attempt was observed (this executor reported none)",
    };
  }
  if (e.egressBlockedReached) {
    return {
      contained: false,
      reason: `egress PROVEN-BROKEN — the request to ${EGRESS_BLOCKED_HOST} came back; the allowlist did not hold`,
    };
  }
  if (!e.egressAllowedReached) {
    return {
      contained: false,
      reason:
        "egress UNPROVEN — the allowlisted control request also failed, so a blocked request proves " +
        "nothing (an offline host and a working allowlist produce the same observation)",
    };
  }
  if (!e.egressDenialSeen) {
    return {
      contained: false,
      reason:
        `egress UNPROVEN — no refusal was observed for ${EGRESS_BLOCKED_HOST} (it may never have been attempted)`,
    };
  }
  return {
    contained: true,
    reason: `${EGRESS_BLOCKED_HOST} REFUSED; allowlisted control request succeeded`,
  };
}

/**
 * curl's own refusal vocabulary, kept SEPARATE from {@link OS_DENIAL_RE} so a
 * filesystem denial can never be read as an egress denial or the reverse.
 */
const EGRESS_DENIAL_RE =
  /could not resolve host|couldn't resolve host|connection refused|failed to connect|blocked|not allowed|denied by|proxy/i;

const OS_DENIAL_RE = /operation not permitted|not permitted|permission denied|read-only file system|sandbox|denied/i;

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
export function stripDenyFloorLines(transcript: string): string {
  return transcript
    .split("\n")
    .filter((line) => {
      if (line.includes(DENY_FLOOR_PROBE_BASENAME)) return false;
      if (/deny-floor/i.test(line)) return false;
      if (/^\s*tripwire\s*:/i.test(line)) return false;
      return true;
    })
    .join("\n");
}

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
export function assessDenyFloor(e: ContainmentEvidence): {
  engaged: boolean | undefined;
  reason: string;
} {
  if (e.denyFloorProbeCreated === undefined) {
    return {
      engaged: undefined,
      reason: "deny-floor UNOBSERVED — the probe executor reported no tripwire outcome",
    };
  }
  if (e.denyFloorProbeCreated) {
    return {
      engaged: false,
      reason:
        `deny-floor NOT ENGAGED — the ${DENY_FLOOR_PROBE_BASENAME} tripwire was CREATED inside cwd, ` +
        "so the PreToolUse hook did not refuse it (settings `hooks` block dropped, unbound, or the hook script unreachable)",
    };
  }
  return {
    engaged: true,
    reason: `deny-floor engaged — the ${DENY_FLOOR_PROBE_BASENAME} tripwire was refused before it could be created`,
  };
}

/**
 * Regex marking the CLI's credential/auth-dead result text, verified verbatim
 * (SDK 0.3.209 / CLI 2.1.209, see env.ts / worker-home.ts / FINDINGS.md): a
 * headless spawn with no usable OAuth token exits "Not logged in · Please run
 * /login" at $0 before any turn. MATCHED CONSERVATIVELY — both fragments must
 * appear (not "any error"), so an unrelated error-result is never mislabelled a
 * credential failure. Applied only in combination with `isError`, never alone.
 */
const CREDENTIAL_FAILURE_RE = /not logged in/i;
const CREDENTIAL_LOGIN_HINT_RE = /run \/login/i;

/**
 * Regex marking the SDK's OTHER credential-dead result text: a copied OAuth
 * token that has since EXPIRED (as opposed to never being logged in at all)
 * exits "OAuth session expired and could not be refreshed" at $0 before any
 * turn — a distinct string from CREDENTIAL_FAILURE_RE/CREDENTIAL_LOGIN_HINT_RE
 * above, so it previously matched neither and fell through to the generic
 * "unproven" verdict W1-T237 exists to prevent. Same conservative shape: both
 * fragments must appear, applied only in combination with `isError`.
 */
const CREDENTIAL_EXPIRED_RE = /oauth session expired/i;
const CREDENTIAL_REFRESH_FAILED_RE = /could not be refreshed/i;

/**
 * Default executor: spawn a real sandboxed worker in a scratch cwd under the
 * workspace. `spawn` is injectable (defaults to the real {@link spawnWorker})
 * so both W1-T237's `isError` plumbing and W1-T238's stderr-persistence branch
 * (the exact branch that discarded stderr on a failed probe) are directly
 * unit-testable without spawning an actual sandboxed subprocess — every other
 * call site relies on the default.
 */
export function defaultExecutor(
  settingsFile: string,
  config: Config,
  budgetUsd?: number,
  spawn: typeof spawnWorker = spawnWorker,
): ProbeExecutor {
  return async (token: string) => {
    // The scratch dir lives under the WORKSPACE root, never under $TMPDIR — the
    // sandbox write scope is cwd + session $TMPDIR, so a sibling of cwd here is
    // genuinely OUTSIDE that scope (a $TMPDIR sibling would be writable and give a
    // false pass). cwd is a subdir; the outside target is its sibling.
    const base = join(config.root, "tmp", `containment-probe-${token}`);
    const cwd = join(base, "cwd");
    mkdirSync(cwd, { recursive: true });
    const outsidePath = join(base, `${token}.txt`);
    const insidePath = join(cwd, "probe-ok.txt");
    // INSIDE cwd on purpose — the sandbox permits this path (it is the same scope
    // `probe-ok.txt` proves writable), so only the deny-floor hook can stop it.
    // See denyFloorProbeCommand's doc for why an outside-cwd tripwire proves nothing.
    const denyFloorPath = join(cwd, DENY_FLOOR_PROBE_BASENAME);
    // W1-T1265: the two egress markers, observed by existsSync exactly as the two
    // writes above are — no transcript parsing for "did it come back".
    const egressBlockedPath = join(cwd, EGRESS_BLOCKED_MARKER);
    const egressAllowedPath = join(cwd, EGRESS_ALLOWED_MARKER);
    // The control target is DERIVED from the allowlist this same probe was handed,
    // so it cannot drift from the policy it exercises. A file that cannot be parsed
    // degrades to the fallback rather than skipping the control, because a skipped
    // control is what makes every "blocked" reading unfalsifiable.
    let allowedHost: string;
    try {
      allowedHost = allowedHostFromSettings(validateWorkerSettingsFile(settingsFile));
    } catch {
      allowedHost = EGRESS_ALLOWED_HOST_FALLBACK;
    }
    try {
      const probe = await spawn({
        cwd,
        permissionMode: "bypassPermissions",
        settingsFile,
        maxTurns: 6,
        maxBudgetUsd: budgetUsd,
        config,
        prompt: containmentProbePrompt(token, allowedHost),
      });
      const transcript = [probe.text, probe.blocks.join("\n"), probe.stderr].join("\n");
      return {
        transcript,
        outsideWriteCreated: existsSync(outsidePath),
        insideWriteCreated: existsSync(insidePath),
        denyFloorProbeCreated: existsSync(denyFloorPath),
        egressBlockedReached: existsSync(egressBlockedPath),
        egressAllowedReached: existsSync(egressAllowedPath),
        costUsd: probe.costUsd,
        // W1-T237: the signal was already on WorkerResult; the preflight just never read it.
        isError: probe.isError,
        // W1-T268: same shape — already on WorkerResult, just never carried through.
        childEnvKeys: probe.childEnvKeys,
        accountLabel: probe.accountLabel,
      };
    } finally {
      // Reap the probe worker's SDK scratchpad (keyed by its cwd) before the cwd
      // is removed — a probe runs every run and is a killed-worker orphan source.
      reapWorkerScratch(cwd);
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  };
}

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
export async function probeContainment(opts: {
  settingsFile: string;
  config?: Config;
  budgetUsd?: number;
  log?: (step: string, extra?: Record<string, unknown>) => void;
  /** Injectable for tests; default spawns a real sandboxed worker. */
  exec?: ProbeExecutor;
  /** Injectable token for deterministic tests; default is time-based. */
  token?: string;
}): Promise<{ contained: true; reason: string; evidence: ContainmentEvidence; costUsd: number }> {
  const log = opts.log ?? (() => {});

  // GATE 1 — config: the file must declare an enabled sandbox.
  try {
    validateWorkerSettingsFile(opts.settingsFile);
  } catch (e) {
    throw new ContainmentError(
      `containment preflight: settings file does not declare an enabled sandbox — ${String((e as Error)?.message ?? e)}`,
      "sandbox-enabled",
      "disabled",
    );
  }

  // GATE 2 — empirical: an outside-cwd write must be OS-denied under the sandbox.
  // Resolve config lazily and ONLY for the real executor: an injected exec (tests)
  // must never touch loadConfig (which resolves the claude binary — absent in CI).
  const token = opts.token ?? `${Date.now()}`;
  const exec =
    opts.exec ?? defaultExecutor(opts.settingsFile, opts.config ?? loadConfig(), opts.budgetUsd);
  const r = await exec(token);
  const evidence: ContainmentEvidence = {
    outsideWriteCreated: r.outsideWriteCreated,
    // The denial must reference THIS probe's token AND an OS-denial phrase, so a
    // stray "permission" mention elsewhere in the transcript can't fake it.
    // The deny-floor tripwire's own lines are STRIPPED before this test — see
    // stripDenyFloorLines. Without that, step 3's narration could satisfy the
    // OS-denial pattern and flip a genuinely UNPROVEN run to contained.
    osDenialSeen:
      r.transcript.includes(token) && OS_DENIAL_RE.test(stripDenyFloorLines(r.transcript)),
    // W1-T1281: the FIRST half of the `osDenialSeen` expression above, carried
    // separately so a failure can distinguish "attempted but no denial phrase"
    // from "never attempted at all" instead of collapsing both into one boolean
    // — see classifyUnprovenState.
    outsideWriteAttempted: r.transcript.includes(token),
    insideWriteCreated: r.insideWriteCreated,
    // W1-T237: isError PLUS BOTH conservative credential fragments — not "any
    // error" — so an unrelated error-result is never mislabelled a credential
    // failure (the design's own conservatism requirement).
    credentialFailure:
      r.isError === true &&
      CREDENTIAL_FAILURE_RE.test(r.transcript) &&
      CREDENTIAL_LOGIN_HINT_RE.test(r.transcript),
    // W1-T292: a SECOND, DISTINCT credential-dead signature — an expired copied
    // OAuth token — kept out of `credentialFailure` above so the two never
    // collapse into one reason. Same conservative both-fragments-required shape.
    credentialExpired:
      r.isError === true &&
      CREDENTIAL_EXPIRED_RE.test(r.transcript) &&
      CREDENTIAL_REFRESH_FAILED_RE.test(r.transcript),
    // Carried through VERBATIM, including `undefined` — an executor that never
    // reported a tripwire outcome must stay UNOBSERVED, never default to engaged.
    denyFloorProbeCreated: r.denyFloorProbeCreated,
    // W1-T1265: carried through VERBATIM, including `undefined` — an executor that
    // reported no egress attempt stays UNOBSERVED and verdicts UNPROVEN, never
    // "blocked". Same discipline as `denyFloorProbeCreated` directly above.
    egressBlockedReached: r.egressBlockedReached,
    egressAllowedReached: r.egressAllowedReached,
    // Mirrors `osDenialSeen`: a refusal must be OBSERVED, never inferred from the absence
    // of a response. Sourced from EGRESS_DENIAL_RE ALONE — deliberately NOT from
    // `OS_DENIAL_RE`, because a filesystem denial must never be read as an egress denial
    // (this file's own doc for the two patterns says so). It also keeps the strip call
    // above a UNIQUE textual occurrence, which test/deny-floor-probe.test.ts pins as the
    // precondition of its mutation guard — that guard counts occurrences in the raw
    // SOURCE TEXT, so even a comment quoting the call verbatim would break it.
    egressDenialSeen:
      r.egressBlockedReached === undefined ? undefined : EGRESS_DENIAL_RE.test(r.transcript),
  };
  const verdict = assessContainment(evidence);
  const denyFloor = assessDenyFloor(evidence);
  const egress = assessEgressContainment(evidence);
  const costUsd = r.costUsd ?? 0;
  log("containment.probe", {
    contained: verdict.contained,
    reason: verdict.reason,
    credential_failure: evidence.credentialFailure,
    credential_expired: evidence.credentialExpired,
    outside_write_created: evidence.outsideWriteCreated,
    os_denial_seen: evidence.osDenialSeen,
    // W1-T1281: carried so a row that PASSED can still be read for the same
    // three-state split a failing row's `observed` field now names — the
    // decision does not change, only what gets recorded alongside it.
    outside_write_attempted: evidence.outsideWriteAttempted,
    inside_write_created: evidence.insideWriteCreated,
    // OBSERVATIONAL — recorded on the containment step rather than gating it, so
    // the deny floor stops being proven NEVER without a new bound that could park
    // a fleet on a hook whose behaviour under the installed CLI is UNMEASURED.
    // `engaged` is tri-state and rides as-is: undefined ⇒ unobserved.
    deny_floor_engaged: denyFloor.engaged,
    deny_floor_reason: denyFloor.reason,
    // W1-T1265 — OBSERVATIONAL, recorded rather than gating, the same call the
    // deny-floor arm made above and for the same reason: this arm's behaviour under
    // the installed CLI is UNMEASURED, and gating a fleet on an unmeasured probe
    // could park it. The verdict is pure and unit-falsifiable; wiring it to throw is
    // a separate, operator-gated decision.
    egress_contained: egress.contained,
    egress_reason: egress.reason,
    egress_blocked_reached: evidence.egressBlockedReached,
    egress_allowed_reached: evidence.egressAllowedReached,
    egress_denial_seen: evidence.egressDenialSeen,
    cost_usd: costUsd,
    // W1-T238: the probe spawn's own stderr/error-result text, capped, ONLY when
    // the underlying worker call itself errored — a clean probe spawn never
    // gets this field, so a passing run's ledger line stays exactly as it was.
    ...(r.isError ? { stderr_excerpt: capStderrExcerpt(r.transcript) } : {}),
  });
  if (!verdict.contained) {
    // OBSERVED (W1-T91/P23 part i, extended by W1-T237, then W1-T292): the
    // write's OWN outcome names which of FOUR states this was, checked in this
    // order so a credential-dead worker can never be reported as the genuine
    // unproven case:
    //  1. credentialExpired — the probe worker died because a COPIED OAuth
    //     token had EXPIRED. Named `spawn_credential_expired` distinctly from
    //     #2 below: the operator action differs (re-mint/refresh the token vs.
    //     log in from scratch), so the two reasons must never share a symbol.
    //  2. credentialFailure — the probe worker died on auth (never logged in),
    //     before it could attempt any write. Named `spawn_credential_failure`
    //     distinctly: this proves NOTHING about isolation either way (unlock
    //     the keychain, don't investigate the sandbox).
    //  3. outsideWriteCreated — proven-broken (the outside write LANDED, the
    //     sandbox did not engage) is data-bearing.
    //  4. neither — genuinely UNPROVEN, but no longer collapsed to the eight
    //     characters "unproven": classifyUnprovenState (W1-T1281) names WHICH of
    //     three distinguishable states this was — "probe-never-ran",
    //     "write-never-attempted", or "no-denial-observed" — so a
    //     `blocked_containment` ledger row (this error's `observed` field, read
    //     by run-task.ts) can name the cause instead of forcing a reader to
    //     re-derive it from evidence that was never recorded in the first place.
    if (evidence.credentialExpired) {
      throw new ContainmentError(
        `containment preflight: spawn_credential_expired — ${verdict.reason} — FAIL CLOSED, the run does not proceed`,
        "spawn-credential-expired",
        "spawn_credential_expired",
        r.childEnvKeys ?? [],
        r.accountLabel,
      );
    }
    if (evidence.credentialFailure) {
      throw new ContainmentError(
        `containment preflight: spawn_credential_failure — ${verdict.reason} — FAIL CLOSED, the run does not proceed`,
        "spawn-credential-failure",
        "spawn_credential_failure",
        r.childEnvKeys ?? [],
        r.accountLabel,
      );
    }
    const observed = evidence.outsideWriteCreated
      ? "outside-cwd write succeeded (sandbox did not engage)"
      : classifyUnprovenState(evidence);
    throw new ContainmentError(
      `containment UNPROVEN: ${verdict.reason} — FAIL CLOSED, the run does not proceed`,
      "outside-cwd-denial",
      observed,
      r.childEnvKeys ?? [],
      r.accountLabel,
    );
  }
  return { contained: true, reason: verdict.reason, evidence, costUsd };
}
