/**
 * Runbook coverage check (W1-T217, RECON R-25 / the runbook half of R-30).
 *
 * The gap this closes: none of the procedures an operator actually needs mid-crisis —
 * restarting the supervised daemon, rotating the service tokens, first-run setup on a new
 * machine, where the ANTHROPIC_* billing boundary sits — were checked anywhere. They existed
 * only as tribal knowledge in session notes, so they could (and did) rot silently.
 *
 * DERIVE COVERAGE FROM A NAMED LIST, AND CHECK IT (the task's own design note) — same shape as
 * the CLI verb-coverage check derives its obligation from the `COMMANDS` registry: a single
 * source of truth ({@link REQUIRED_PROCEDURES}) that a later-added procedure is appended to,
 * rather than re-deriving the check by hand each time. `checkRunbookCoverage` is pure (a string
 * in, a verdict array out) so it is fixture-testable without touching the filesystem; the only
 * I/O is the caller reading `docs/operator-guide.md` once.
 */

/** Minimum non-whitespace word count for a section to count as "documented", not a stub heading. */
const MIN_WORDS = 25;

export interface RequiredProcedure {
  /** Stable slug, printed in a coverage failure — never reused for a different procedure. */
  id: string;
  /** Human-readable name of the crisis procedure. */
  label: string;
  /** Matches the markdown heading (`#`-`######`) that introduces this procedure's section. */
  headingPattern: RegExp;
  /**
   * A real heading string that satisfies `headingPattern` (minus the leading `#`s), used by
   * `checkRunbookCoverage`'s own fixture tests so they never have to guess doc wording from
   * `label` — this is the one place doc wording and pattern are kept in lockstep.
   */
  exampleHeading: string;
}

/**
 * The crisis procedures a runbook-coverage check must find a real entry for. Append here —
 * never edit `checkRunbookCoverage` itself — when a later procedure needs the same guarantee;
 * a procedure missing from this list is invisible to the check by construction, so the list is
 * the whole obligation.
 */
export const REQUIRED_PROCEDURES: readonly RequiredProcedure[] = [
  {
    id: "supervisor-restart",
    label: "restarting the supervised daemon",
    headingPattern: /^#{1,6}\s*restarting the supervised daemon/im,
    exampleHeading: "Restarting the supervised daemon",
  },
  {
    id: "token-rotation",
    label: "rotating the service tokens",
    headingPattern: /^#{1,6}\s*rotating the (service )?tokens/im,
    exampleHeading: "Rotating the service tokens",
  },
  {
    id: "first-run-setup",
    label: "first-run setup on a new machine",
    headingPattern: /^#{1,6}\s*first-run setup/im,
    exampleHeading: "First-run setup on a new machine",
  },
  {
    id: "billing-boundary",
    label: "the billing environment boundary (ANTHROPIC_*)",
    headingPattern: /^#{1,6}\s*the billing boundary/im,
    exampleHeading: "The billing boundary: where ANTHROPIC_* stops",
  },
];

export interface RunbookCoverageResult {
  id: string;
  label: string;
  /** True iff a matching heading was found AND its section body is non-trivial. */
  covered: boolean;
  /** Why `covered` is false; undefined when covered. */
  reason?: "heading-not-found" | "section-too-short";
}

/** Count non-whitespace-delimited words — cheap, no locale-aware tokenizing needed here. */
function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Given the FULL body text starting right after a matched heading line, return the text up to
 * (but not including) the next markdown heading at the SAME OR SHALLOWER level — i.e. just this
 * section's own content, not a subsequent section's.
 */
function sectionBody(afterHeading: string, headingLevel: number): string {
  const nextHeadingRe = new RegExp(`^#{1,${headingLevel}}\\s+\\S`, "m");
  const match = nextHeadingRe.exec(afterHeading);
  return match ? afterHeading.slice(0, match.index) : afterHeading;
}

/**
 * Check `guideText` (the operator guide's markdown) against {@link REQUIRED_PROCEDURES}. A
 * procedure with no matching heading, or whose section is shorter than {@link MIN_WORDS}, comes
 * back `covered: false` — a heading that exists but says nothing is the same failure mode as a
 * heading that never shipped: a reader trusts the title and gets nothing underneath it.
 */
export function checkRunbookCoverage(guideText: string): RunbookCoverageResult[] {
  return REQUIRED_PROCEDURES.map(({ id, label, headingPattern }) => {
    const re = new RegExp(headingPattern.source, headingPattern.flags.includes("g") ? headingPattern.flags : headingPattern.flags + "g");
    re.lastIndex = 0;
    const match = re.exec(guideText);
    if (!match) return { id, label, covered: false, reason: "heading-not-found" };

    const headingLine = match[0];
    const headingLevel = /^#+/.exec(headingLine)?.[0].length ?? 1;
    const afterHeading = guideText.slice(match.index + headingLine.length);
    const body = sectionBody(afterHeading, headingLevel);

    if (wordCount(body) < MIN_WORDS) return { id, label, covered: false, reason: "section-too-short" };
    return { id, label, covered: true };
  });
}

/** True iff every required procedure is covered — the single boolean a gate checks. */
export function isRunbookFullyCovered(guideText: string): boolean {
  return checkRunbookCoverage(guideText).every((r) => r.covered);
}
