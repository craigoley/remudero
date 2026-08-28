/**
 * lib/github-posture.ts — reads whether the repo's GITHUB-SIDE security posture is on (W1-T1040).
 *
 * THE GAP THIS CLOSES. `.github/workflows/` runs codeql/semgrep/osv-scanner/scorecard/
 * dependency-review/mutation-nightly, and nothing reads the capabilities that live in GitHub
 * itself rather than in a workflow file — `security_and_analysis` (`GET /repos/{owner}/{repo}`)
 * and `enforce_admins` (`GET .../branches/{branch}/protection/enforce_admins`). Measured
 * 2026-08-19: `dependabot_security_updates` reads `disabled` here while eight sibling repos in
 * the same org read `enabled` for it — an available-and-off capability, invisible until
 * something needed it.
 *
 * DETECTION ONLY (task rationale (3)). This module issues bare `gh api <path>` reads and NOTHING
 * ELSE — never a `-X`/`--method`/`-f`/`-F`/`--input` flag, which is what would turn a `gh api`
 * call into a write. The token 403s on the writes anyway, but the prohibition is about intent,
 * not outcome: a future token with more scope must not silently turn this into a remediator.
 * {@link ghPostureGateway}'s two calls are the ONLY network surface this module has.
 *
 * THREE STATES, AND THE API CANNOT TELL THEM APART (rationale (4)). Across 15 org repos / 122
 * status observations the vocabulary is exactly `enabled`/`disabled` — no `unavailable`, no
 * `not_set`. So (a) off-and-free, (b) off-and-paid, and (c) unavailable-on-this-tier cannot be
 * told apart from the read alone; {@link GITHUB_POSTURE_ALLOWLIST} is the allowlist that carries
 * that classification as DATA WITH REASONS (the `INSTRUMENT_SURFACE_EXCLUSIONS` discipline,
 * `lib/review.ts`), not a bare path list. (c) never flags; (b) flags once, carrying its cost;
 * everything else off is (a) and flags plainly. A check that reports an impossible setting daily
 * teaches the operator to ignore it — the failure the 63-item escalation backlog already had.
 *
 * CHANGE-ONLY, NEVER DAILY (rationale (v)). The baseline lives beside `last-seen.json`
 * (`state/github-posture.json`, gitignored, runtime state rather than a durable record —
 * {@link loadGithubPostureBaseline}/{@link saveGithubPostureBaseline} copy `last-seen.ts`'s
 * atomic-write idiom rather than editing it). {@link checkGithubPosture} emits only when the
 * read posture differs from the recorded baseline, or on the first read after the baseline is
 * absent; an unreadable read degrades to NO finding rather than a false all-clear (an outage
 * must never overwrite the baseline with a clean snapshot), and the read itself is throttled to
 * at most once a day via {@link decideGithubPostureCheck} — the SAME marker-plus-interval shape
 * `decideAlertPoll`/`decideAutoTriage` (`lib/daemon.ts`) already use, not a fourth clock.
 *
 * IT MUST NOT BLOCK. Every function here is a plain read/compare — no exceptions escape
 * {@link checkGithubPosture}, no write is ever issued, and nothing here can fail a check or
 * change a dispatch verdict. The finding is a ledger row + daemon summary line for THE OPERATOR
 * reading the ledger (`lib/daemon.ts`'s wiring) — deliberately NOT routed through `escalate()`,
 * whose `notify()` gates on `MANUAL || HARD_STOP` (`lib/escalate.ts`) and would make a posture
 * finding invisible on the BLOCKED tier where nine crash-loop issues sat unread for five days.
 */

import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

// ── The three-state allowlist: data with reasons, never a bare path list ───────────────────

export type GithubPostureAllowlistKind =
  /** State (c): the API cannot report this differently from an off toggle, but it is a
   *  tier-limited capability no repo in this org has ever had on — never flag it. */
  | "unavailable"
  /** State (b): genuinely available for purchase and genuinely off — flag it (once, via the
   *  change-only baseline below), but carrying its cost so it never reads as a free toggle. */
  | "paid";

export interface GithubPostureAllowlistEntry {
  kind: GithubPostureAllowlistKind;
  /** Why this capability earns a pass (kind "unavailable") or a paid-not-free flag (kind
   *  "paid") — refused if empty, same discipline as `INSTRUMENT_SURFACE_EXCLUSIONS`. */
  reason: string;
  /** Required (and only meaningful) when kind === "paid" — surfaced verbatim in the finding. */
  cost?: string;
}

function assertNonEmpty(key: string, entry: GithubPostureAllowlistEntry): GithubPostureAllowlistEntry {
  if (!entry.reason.trim()) throw new Error(`GITHUB_POSTURE_ALLOWLIST["${key}"] carries an empty reason`);
  if (entry.kind === "paid" && !entry.cost?.trim()) {
    throw new Error(`GITHUB_POSTURE_ALLOWLIST["${key}"] is kind "paid" but carries no cost`);
  }
  return entry;
}

/**
 * TODAY'S ALLOWLIST (task rationale (5)/(7)), derived from the same 15-repo/122-observation
 * sweep the task's rationale measured — never a guess. `secret_scanning_delegated_alert_dismissal`
 * and `secret_scanning_delegated_bypass` read `disabled` on ALL 14 org repos that carry them: no
 * repo this account owns has ever had either on, the signature of a tier-limited capability
 * rather than a toggle. `code_quality` has NO API surface at all (`repos/{o}/{r}/code-quality`
 * and `.../quality` both 404 against positive 200 controls on sibling endpoints in the same call
 * sequence) — it is annotated here rather than read live, carrying the cost GitHub states for it
 * (Team/Enterprise Cloud, per-committer billing, AI credits + Actions minutes) so a purchase
 * decision never reads the same as a free toggle.
 */
export const GITHUB_POSTURE_ALLOWLIST: Readonly<Record<string, GithubPostureAllowlistEntry>> = {
  secret_scanning_delegated_alert_dismissal: assertNonEmpty("secret_scanning_delegated_alert_dismissal", {
    kind: "unavailable",
    reason: "0 of 14 org repos carrying this key have ever read it enabled — tier-limited, not a toggle (W1-T1040 rationale 5)",
  }),
  secret_scanning_delegated_bypass: assertNonEmpty("secret_scanning_delegated_bypass", {
    kind: "unavailable",
    reason: "0 of 14 org repos carrying this key have ever read it enabled — tier-limited, not a toggle (W1-T1040 rationale 5)",
  }),
  code_quality: assertNonEmpty("code_quality", {
    kind: "paid",
    reason: "no API surface exists for it (repos/{o}/{r}/code-quality and .../quality both 404, W1-T1040 rationale 7) — annotated, never read live",
    cost:
      "requires GitHub Team or Enterprise Cloud, bills per active committer, adds AI credits for autofixes " +
      "plus Actions minutes for its own CodeQL scans (W1-T1040 rationale (ii))",
  }),
};

// ── The read: `security_and_analysis` + `enforce_admins` + the repo-root merge settings, GET
// ── only ─────────────────────────────────────────────────────────────────────────────────────

/** Every capability this module reads or annotates, and where its status comes from. */
export type GithubPostureCapabilitySource = "security_and_analysis" | "enforce_admins" | "merge_settings" | "static";

export interface GithubPostureCapabilityDescriptor {
  key: string;
  source: GithubPostureCapabilitySource;
}

/**
 * The eight `security_and_analysis` keys (task rationale (2)) + `enforce_admins` (branch
 * protection, read separately — GitHub does not fold it into the repo payload) + `code_quality`
 * (a `"static"` entry: never read live, see {@link GITHUB_POSTURE_ALLOWLIST}) +
 * `squash_merge_commit_message` (W1-T2448: a `"merge_settings"` entry read off the SAME repo-root
 * payload `security_and_analysis` already reads — no new GET). It is the only reason 611 anchored
 * commit trailers exist on `main` (`buildCommitTrailerIndex`, `status.ts`), named nowhere under
 * `src/`/`test/`/`.github/`/`scripts/`/`docs/` before this, and a UI flip away from
 * `COMMIT_MESSAGES` would otherwise be invisible: the commit index FAILS CLOSED rather than
 * erroring, so the symptom is silent queue noise days later, not a red check.
 */
export const GITHUB_POSTURE_CAPABILITIES: readonly GithubPostureCapabilityDescriptor[] = [
  { key: "secret_scanning", source: "security_and_analysis" },
  { key: "secret_scanning_push_protection", source: "security_and_analysis" },
  { key: "dependabot_security_updates", source: "security_and_analysis" },
  { key: "secret_scanning_ai_detection", source: "security_and_analysis" },
  { key: "secret_scanning_non_provider_patterns", source: "security_and_analysis" },
  { key: "secret_scanning_validity_checks", source: "security_and_analysis" },
  { key: "secret_scanning_delegated_alert_dismissal", source: "security_and_analysis" },
  { key: "secret_scanning_delegated_bypass", source: "security_and_analysis" },
  { key: "enforce_admins", source: "enforce_admins" },
  { key: "code_quality", source: "static" },
  { key: "squash_merge_commit_message", source: "merge_settings" },
];

/** The only value of `squash_merge_commit_message` under which a squash merge's commit body
 *  carries the trailers `buildCommitTrailerIndex` anchors on (W1-T2448 rationale, Q1/Q3) — a
 *  live read of anything else is the flip that would otherwise go unasserted. */
export const GITHUB_POSTURE_SQUASH_MERGE_COMMIT_MESSAGE_EXPECTED = "COMMIT_MESSAGES";

export type GithubPostureCapabilityStatus = "enabled" | "disabled";

/** capability key -> its read status. Only capabilities this read could actually resolve are
 *  present — a key the live payload omits or malforms is simply absent, never defaulted. */
export type GithubPostureSnapshot = Record<string, GithubPostureCapabilityStatus>;

/** The two GET calls this module ever issues — see the module header's DETECTION ONLY note. */
export interface GithubPostureGateway {
  /** `gh api repos/{owner}/{repo}` — carries `security_and_analysis`. */
  getRepo(owner: string, repo: string): unknown;
  /** `gh api repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins`. */
  getEnforceAdmins(owner: string, repo: string, branch: string): unknown;
}

/**
 * The real gateway: bare `gh api <path>` reads, mirroring `lib/ops.ts`'s `ghAlertGateway` — no
 * `-X`/`--method`/`-f`/`-F`/`--input` flag is ever passed, which is what would turn a `gh api`
 * call into anything other than a GET. A failed/unreachable read degrades to `undefined`, never
 * throws — the caller ({@link readGithubPosture}) is the one place that turns that into "no
 * finding rather than a false all-clear" (task rationale (vii)).
 */
export function ghPostureGateway(execFileFn: (args: string[]) => string = defaultExec): GithubPostureGateway {
  function tryGet(args: string[]): unknown {
    try {
      return JSON.parse(execFileFn(args));
    } catch {
      return undefined;
    }
  }
  return {
    getRepo: (owner, repo) => tryGet(["api", `repos/${owner}/${repo}`]),
    getEnforceAdmins: (owner, repo, branch) => tryGet(["api", `repos/${owner}/${repo}/branches/${branch}/protection/enforce_admins`]),
  };
}

function defaultExec(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function statusFrom(raw: unknown, descriptor: GithubPostureCapabilityDescriptor): GithubPostureCapabilityStatus | undefined {
  if (descriptor.source === "static") return "disabled"; // code_quality: annotated, never read live.
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  if (descriptor.source === "enforce_admins") {
    const enabled = (raw as { enabled?: unknown }).enabled;
    return typeof enabled === "boolean" ? (enabled ? "enabled" : "disabled") : undefined;
  }
  if (descriptor.source === "merge_settings") {
    // Read straight off the repo-root payload `security_and_analysis` already reads (no new
    // GET) — "enabled" means "still the value 611 anchored trailers depend on", "disabled"
    // means it has flipped to anything else, the exact drift that is otherwise invisible.
    const value = (raw as Record<string, unknown>)[descriptor.key];
    if (typeof value !== "string") return undefined;
    return value === GITHUB_POSTURE_SQUASH_MERGE_COMMIT_MESSAGE_EXPECTED ? "enabled" : "disabled";
  }
  const block = (raw as { security_and_analysis?: unknown }).security_and_analysis;
  if (block === undefined || block === null || typeof block !== "object") return undefined;
  const entry = (block as Record<string, unknown>)[descriptor.key];
  if (entry === undefined || entry === null || typeof entry !== "object") return undefined;
  const status = (entry as { status?: unknown }).status;
  return status === "enabled" || status === "disabled" ? status : undefined;
}

/**
 * The read (task rationale (i)): `GET /repos/{owner}/{repo}` + `GET .../branches/{branch}/
 * protection/enforce_admins`, folded into a {@link GithubPostureSnapshot}. Returns `undefined`
 * when the repo read itself is unreadable — the primary source for 10 of 11 capabilities,
 * `squash_merge_commit_message` (W1-T2448) included — so a caller degrades to "no finding"
 * rather than manufacturing a false all-clear from a half read. `enforce_admins` alone being
 * unreadable just omits that one key from the snapshot; every other capability the repo read
 * resolved is still reported.
 */
export function readGithubPosture(
  owner: string,
  repo: string,
  deps: { gateway?: GithubPostureGateway; branch?: string } = {},
): GithubPostureSnapshot | undefined {
  const gateway = deps.gateway ?? ghPostureGateway();
  const branch = deps.branch ?? "main";
  const repoRaw = gateway.getRepo(owner, repo);
  if (repoRaw === undefined) return undefined;
  const enforceAdminsRaw = gateway.getEnforceAdmins(owner, repo, branch);
  const snapshot: Record<string, GithubPostureCapabilityStatus> = {};
  for (const descriptor of GITHUB_POSTURE_CAPABILITIES) {
    const raw = descriptor.source === "enforce_admins" ? enforceAdminsRaw : repoRaw;
    const status = statusFrom(raw, descriptor);
    if (status !== undefined) snapshot[descriptor.key] = status;
  }
  return snapshot;
}

// ── Classification: the three states, over an already-read snapshot ────────────────────────

export type GithubPostureFindingKind = "free" | "paid";

export interface GithubPostureFinding {
  capability: string;
  kind: GithubPostureFindingKind;
  /** Present only for kind === "paid" — see {@link GITHUB_POSTURE_ALLOWLIST}. */
  cost?: string;
}

/**
 * Folds a snapshot into findings: `enabled` never flags; `disabled` flags UNLESS
 * {@link GITHUB_POSTURE_ALLOWLIST} marks it `"unavailable"` (state c, never flagged) — an entry
 * marked `"paid"` still flags, carrying its cost (state b); anything disabled and unlisted flags
 * plainly (state a). Sorted by capability name for a deterministic finding order.
 */
export function classifyGithubPosture(snapshot: GithubPostureSnapshot): GithubPostureFinding[] {
  const findings: GithubPostureFinding[] = [];
  for (const [capability, status] of Object.entries(snapshot)) {
    if (status === "enabled") continue;
    const allow = GITHUB_POSTURE_ALLOWLIST[capability];
    if (allow?.kind === "unavailable") continue;
    if (allow?.kind === "paid") {
      findings.push({ capability, kind: "paid", cost: allow.cost });
      continue;
    }
    findings.push({ capability, kind: "free" });
  }
  return findings.sort((a, b) => a.capability.localeCompare(b.capability));
}

// ── The baseline: state/github-posture.json, sibling to last-seen.json ─────────────────────

/** `<configRoot>/state/github-posture.json` — sibling to `last-seen.json`/`last-retro.json`.
 *  `state/` is gitignored (correct and load-bearing, task rationale (iv)): the baseline is
 *  runtime state, never a committed record. */
export function githubPosturePath(configRoot: string): string {
  return join(configRoot, "state", "github-posture.json");
}

export interface GithubPostureBaseline {
  /** ISO-8601 of the read this baseline was captured from — also the cadence marker
   *  {@link decideGithubPostureCheck} throttles against. */
  checkedAt: string;
  snapshot: GithubPostureSnapshot;
}

function isSnapshot(v: unknown): v is GithubPostureSnapshot {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => x === "enabled" || x === "disabled")
  );
}

function isBaseline(v: unknown): v is GithubPostureBaseline {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { checkedAt?: unknown }).checkedAt === "string" &&
    isSnapshot((v as { snapshot?: unknown }).snapshot)
  );
}

/** Read `path`; absent, unreadable, or malformed all degrade to `undefined` — same fail-OPEN
 *  discipline as `last-seen.ts`'s `loadLastSeen` (a missing/corrupt baseline just means the next
 *  read treats itself as the first one, rather than 500ing a daemon tick). */
export function loadGithubPostureBaseline(path: string): GithubPostureBaseline | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isBaseline(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Atomic write — the SAME temp-file-then-`renameSync` swap as `last-seen.ts`'s `saveLastSeen`,
 *  so a concurrent reader never observes a torn file. */
export function saveGithubPostureBaseline(path: string, baseline: GithubPostureBaseline): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const buf = Buffer.from(JSON.stringify(baseline, null, 2) + "\n", "utf8");
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, buf, 0, buf.length);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

function sameSnapshot(a: GithubPostureSnapshot, b: GithubPostureSnapshot): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k, i) => k === bKeys[i] && a[k] === b[k]);
}

// ── Cadence: at most once a day, the SAME marker-plus-interval shape decideAlertPoll/ ──────
// ── decideAutoTriage (lib/daemon.ts) already use — not a fourth clock (task rationale viii) ─

export interface GithubPostureCadenceInputs {
  now: Date;
  /** The recorded baseline's `checkedAt`, or `undefined` if none is recorded yet. */
  lastCheckedIso: string | undefined;
  minIntervalMinutes: number;
}

export interface GithubPostureCadenceDecision {
  fire: boolean;
  reason: string;
}

export function decideGithubPostureCheck(i: GithubPostureCadenceInputs): GithubPostureCadenceDecision {
  if (i.lastCheckedIso === undefined) return { fire: true, reason: "no recorded baseline — first run" };
  const last = Date.parse(i.lastCheckedIso);
  // A marker we cannot parse FAILS CLOSED, exactly as decideAlertPoll/decideAutoTriage do on a
  // corrupt marker: firing on an unreadable timestamp would read every tick, the noise this
  // cadence exists to prevent.
  if (Number.isNaN(last)) return { fire: false, reason: "recorded checkedAt unreadable — failing closed" };
  const sinceMin = (i.now.getTime() - last) / 60_000;
  if (sinceMin < i.minIntervalMinutes) {
    return { fire: false, reason: `checked ${sinceMin.toFixed(1)}m ago — under the ${i.minIntervalMinutes}m interval` };
  }
  return { fire: true, reason: `last checked ${sinceMin.toFixed(1)}m ago — interval elapsed` };
}

/** Once a day (task rationale (viii)) — a per-dispatch call would be waste against a budget
 *  already exhausted six times in the day the task's rationale was measured. */
export const GITHUB_POSTURE_DEFAULT_MIN_INTERVAL_MINUTES = 24 * 60;

// ── The orchestration: cadence-gated read, change-only diff against the baseline ───────────

export interface GithubPostureCheckDeps {
  owner: string;
  repo: string;
  configRoot: string;
  now?: Date;
  minIntervalMinutes?: number;
  branch?: string;
  /** Defaults to {@link readGithubPosture} — a test seam, and the seam `run-task.ts`'s wiring
   *  threads its own `readGithubPosture(...)` call through (see that file's own doc). */
  read?: (owner: string, repo: string, opts: { gateway?: GithubPostureGateway; branch?: string }) => GithubPostureSnapshot | undefined;
  gateway?: GithubPostureGateway;
  loadBaseline?: (path: string) => GithubPostureBaseline | undefined;
  saveBaseline?: (path: string, baseline: GithubPostureBaseline) => void;
}

/**
 * The single entry point the daemon's cadence rung calls (task rationale (vi)/(vii)/(viii)):
 * cadence-gates the read to at most once a day, degrades an unreadable read to NO finding
 * without touching the baseline (an outage must never manufacture a false all-clear), and emits
 * findings ONLY when the posture differs from the recorded baseline or none is recorded yet —
 * otherwise returns `[]`. Never throws: every failure mode here is a value, not an exception, so
 * a caller wrapping this in a best-effort `try/catch` (as `lib/daemon.ts` does for every other
 * sweep hook) never actually needs the catch branch for this hook's OWN logic — only for a
 * caller-supplied `deps.read`/`deps.gateway` that itself misbehaves.
 */
export function checkGithubPosture(deps: GithubPostureCheckDeps): GithubPostureFinding[] {
  const now = deps.now ?? new Date();
  const path = githubPosturePath(deps.configRoot);
  const load = deps.loadBaseline ?? loadGithubPostureBaseline;
  const save = deps.saveBaseline ?? saveGithubPostureBaseline;
  const minIntervalMinutes = deps.minIntervalMinutes ?? GITHUB_POSTURE_DEFAULT_MIN_INTERVAL_MINUTES;
  const read = deps.read ?? readGithubPosture;

  const baseline = load(path);
  const cadence = decideGithubPostureCheck({ now, lastCheckedIso: baseline?.checkedAt, minIntervalMinutes });
  if (!cadence.fire) return [];

  const snapshot = read(deps.owner, deps.repo, { gateway: deps.gateway, branch: deps.branch });
  if (snapshot === undefined) return []; // unreadable — no finding, baseline left untouched.

  const changed = baseline === undefined || !sameSnapshot(baseline.snapshot, snapshot);
  save(path, { checkedAt: now.toISOString(), snapshot });
  if (!changed) return [];
  return classifyGithubPosture(snapshot);
}
