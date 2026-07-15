/**
 * `rmd init` wizard — headless-safe first-run tier setup (MASTER-PLAN §9 "detect →
 * confirm, never silent" ladder; W1-T9c).
 *
 * W1-T9's original 'operator confirms' criterion was STRUCTURALLY UNFIT for a
 * headless worker: there is no TTY and no operator, and the run burned its last
 * ~15 turns writing readline-repro scripts trying to conjure one (LEARNINGS.md
 * no-live-operator-in-headless-worker). This module is redesigned per Standing
 * rule 18: an explicit `--tier` flag and `--yes` always win over any prompt; a
 * prompt fires ONLY when a real TTY is present; and a TTY-absent run NEVER
 * blocks — it falls back to a logged, safe default instead.
 *
 * Split as PURE resolution ({@link resolveInitTier}, no I/O, fixture-testable)
 * from the I/O that surrounds it ({@link readClaudeJsonKeys},
 * {@link writeTierIntoConfig}, {@link runInit}) — the same capture-vs-infer split
 * `detectTier` (tier.ts, W1-T9b) already established.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UsageSnapshot } from "./headroom.js";
import { detectTier, type ClaudeJsonKeys, type Tier, type TierDetection, type TierInput } from "./tier.js";

/** Thrown on a bad `--tier` flag value. Never thrown by detection/defaulting. */
export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

const KNOWN_TIERS: readonly Tier[] = ["pro", "max5x", "max20x"];

/**
 * The TTY-absent safe default (Standing rule 18): the LOWEST-limit known tier.
 * Assuming less headroom than the operator actually has just underpaces (a
 * missed-opportunity cost); assuming MORE headroom than they have risks a
 * mid-run rate-limit overrun. When evidence is unconfident and no human is
 * present to confirm, under-assuming is the safe direction.
 */
export const SAFE_DEFAULT_TIER: Tier = "pro";

/** Which resolution path {@link resolveInitTier} took — always logged, never silent. */
export type TierSource = "flag" | "detected" | "prompted" | "tty_absent_default";

export interface InitResolution {
  tier: Tier;
  source: TierSource;
  /** The underlying evidence-based detection this resolution was informed by. */
  detection: TierDetection;
  /** True only on the one path that actually asked a human something. */
  prompted: boolean;
  /** Human-readable explanation, safe to log/print. */
  detail: string;
}

/** Parse+validate a raw `--tier` flag value. `undefined` in ⇒ `undefined` out (flag absent). */
export function parseTierFlag(raw: string | undefined): Tier | undefined {
  if (raw === undefined) return undefined;
  const t = raw.toLowerCase();
  if ((KNOWN_TIERS as string[]).includes(t)) return t as Tier;
  throw new InitError(`--tier must be one of ${KNOWN_TIERS.join(", ")}; got "${raw}"`);
}

export interface ResolveInitTierInput {
  /** Raw `--tier` flag value, if given (validated here). */
  tierFlag?: string;
  /** `--yes`: accept the wizard's detected/default answer without prompting. */
  yes: boolean;
  /** `process.stdin.isTTY` (or an injected stand-in in tests) — the ONLY gate on prompting. */
  isTTY: boolean;
  /** Already-captured evidence (headroom.ts `/usage` + `~/.claude.json` keys) — pure input. */
  detectionInput: TierInput;
  /**
   * Interactive confirm hook. Only ever invoked when `isTTY && !yes` AND detection
   * was not already confident — i.e. only when a human is actually there AND
   * actually needed. Async because a real prompt reads stdin; tests must NEVER
   * need to supply this (Standing rule 18: test the non-interactive path via
   * injected input/flags, never a live human).
   */
  confirm?: (suggested: Tier, detection: TierDetection) => Tier | Promise<Tier>;
}

/**
 * PURE resolution: same inputs always produce the same output, no I/O, no
 * blocking. Resolution order:
 *
 *   1. `--tier` flag — explicit operator override, always wins, NEVER prompts.
 *   2. A confident {@link detectTier} result — written WITHOUT prompting whenever
 *      `!isTTY || yes` (the confirmation would be redundant: the evidence already
 *      resolved the tier unambiguously). This is what makes the "confident
 *      detection ⇒ no prompt" acceptance criterion true even with a TTY present
 *      once `--yes` is passed, and always true headless.
 *   3. TTY present, not confident (or ambiguous) and `--yes` not given ⇒ the ONLY
 *      path that prompts — the one case a human is actually there to answer.
 *   4. Otherwise (no TTY, or `--yes` with nothing confident to accept) ⇒ the
 *      TTY-ABSENT SAFE DEFAULT: never block, log the chosen value and why.
 */
export async function resolveInitTier(input: ResolveInitTierInput): Promise<InitResolution> {
  const detection = detectTier(input.detectionInput);

  const flagTier = parseTierFlag(input.tierFlag);
  if (flagTier) {
    return {
      tier: flagTier,
      source: "flag",
      detection,
      prompted: false,
      detail: `--tier ${flagTier} (explicit operator override; detection evidence, unused: ${detection.detail})`,
    };
  }

  if (detection.confident) {
    return {
      tier: detection.tier,
      source: "detected",
      detection,
      prompted: false,
      detail: `confident detection, written without prompting: ${detection.detail}`,
    };
  }

  if (input.isTTY && !input.yes && input.confirm) {
    const suggested = detection.tier === "unknown" ? SAFE_DEFAULT_TIER : detection.tier;
    const chosen = await input.confirm(suggested, detection);
    return {
      tier: chosen,
      source: "prompted",
      detection,
      prompted: true,
      detail: `operator confirmed via interactive prompt (TTY present, suggested "${suggested}"): ${detection.detail}`,
    };
  }

  return {
    tier: SAFE_DEFAULT_TIER,
    source: "tty_absent_default",
    detection,
    prompted: false,
    detail:
      `no TTY (or --yes) with no confident detection ⇒ TTY-ABSENT SAFE DEFAULT "${SAFE_DEFAULT_TIER}" ` +
      `(the lowest-limit known tier — under-assuming headroom never causes a rate-limit overrun; ` +
      `over-assuming it would). Evidence: ${detection.detail}`,
  };
}

/**
 * Best-effort read of the `~/.claude.json` keys {@link detectTier} rung 2 wants
 * (MASTER-PLAN §9(h) / LEARNINGS.md claude-json-tier-keys). Absent file, unparsable
 * JSON, or a shape that doesn't match ⇒ `undefined` (detection degrades gracefully
 * to a lower rung — this is best-effort, never fatal to the wizard).
 */
export function readClaudeJsonKeys(path: string): ClaudeJsonKeys | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const oauth = parsed?.oauthAccount as Record<string, unknown> | undefined;
    return {
      hasAvailableSubscription: (parsed?.hasAvailableSubscription as boolean | null | undefined) ?? null,
      oauthAccount: oauth
        ? {
            userRateLimitTier: (oauth.userRateLimitTier as string | null | undefined) ?? null,
            organizationRateLimitTier: (oauth.organizationRateLimitTier as string | null | undefined) ?? null,
            organizationType: (oauth.organizationType as string | null | undefined) ?? null,
          }
        : undefined,
    };
  } catch {
    return undefined;
  }
}

export interface WriteTierConfigResult {
  path: string;
  /** True when no config file existed at `path` before this write. */
  createdFile: boolean;
}

/**
 * Merge `tier`/`tierSource` into the instance config at `path`, preserving every
 * other existing key (claudeBin/root/etc. — config.ts owns those; this never
 * clobbers them). Creates the file (and its directory) on first run, matching
 * `loadConfig`'s own bootstrap behavior (config.ts) — mode 0600, same as there.
 */
export function writeTierIntoConfig(path: string, tier: Tier, source: TierSource): WriteTierConfigResult {
  const createdFile = !existsSync(path);
  const existing = createdFile ? {} : (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
  const next = { ...existing, tier, tierSource: source };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return { path, createdFile };
}

export interface RunInitOpts {
  tierFlag?: string;
  yes: boolean;
  isTTY: boolean;
  /** Path to the instance config file to write `tier`/`tierSource` into. */
  configPath: string;
  /** Pre-captured `~/.claude.json` keys (rung 2). Injectable for tests. */
  claudeJson?: ClaudeJsonKeys;
  /** Pre-captured `/usage` snapshot (rung 3). Injectable for tests. */
  usage?: UsageSnapshot;
  /** Only ever wired up (and only ever called) when a real TTY is present. */
  confirm?: (suggested: Tier, detection: TierDetection) => Tier | Promise<Tier>;
  /** Progress line sink. Defaults to a no-op (tests don't need console noise). */
  log?: (line: string) => void;
}

/**
 * Resolve + write in one call — the function `rmd init` (run-task.ts) and its
 * tests both drive. Takes ALREADY-CAPTURED evidence (opts.claudeJson/opts.usage)
 * rather than doing its own I/O capture, so a no-TTY, no-operator, no-live-call
 * test can exercise the exact same path the CLI takes (Standing rule 18: test the
 * non-interactive path via injected input/flags, never a live human).
 */
export async function runInit(
  opts: RunInitOpts,
): Promise<InitResolution & { configPath: string; createdFile: boolean }> {
  const log = opts.log ?? (() => {});
  const resolution = await resolveInitTier({
    tierFlag: opts.tierFlag,
    yes: opts.yes,
    isTTY: opts.isTTY,
    detectionInput: { usage: opts.usage, claudeJson: opts.claudeJson },
    // The confirm hook is only ever meaningful with a real TTY; dropping it here
    // when isTTY is false is a second guarantee (on top of resolveInitTier's own
    // gate) that a headless run can never end up invoking it.
    confirm: opts.isTTY ? opts.confirm : undefined,
  });
  const written = writeTierIntoConfig(opts.configPath, resolution.tier, resolution.source);
  log(`rmd init — tier resolved: ${resolution.tier} (source: ${resolution.source})`);
  log(resolution.detail);
  log(`config written: ${written.path}${written.createdFile ? " (created)" : ""}`);
  return { ...resolution, configPath: written.path, createdFile: written.createdFile };
}
