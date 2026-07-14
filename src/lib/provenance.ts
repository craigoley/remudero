/**
 * Provenance linter (MASTER-PLAN §2, Standing rule 1):
 *
 *   PROVENANCE OR IT DOESN'T GO IN A PROMPT.
 *
 * Every claim in a rendered prompt's CONTEXT block must carry a citation
 * `[src: recon#… | plan#… | PR#… | <commit> | learnings#… | <url>]`. An uncited
 * claim BLOCKS dispatch — deterministically, before any worker spawns. This is
 * the mechanized version of the provenance gate: not discipline, a predicate.
 */

export class ProvenanceError extends Error {
  public readonly violations: string[];
  constructor(violations: string[]) {
    super(
      `provenance gate blocked dispatch — ${violations.length} uncited CONTEXT claim(s):\n` +
        violations.map((v) => `  • ${v}`).join("\n"),
    );
    this.name = "ProvenanceError";
    this.violations = violations;
  }
}

/** A `[src: …]` whose payload is one of the accepted provenance kinds. */
const CITATION = /\[src:\s*([^\]]+?)\s*\]/i;
const ACCEPTED_KIND =
  /^(recon#|plan#|PR#|learnings#|commit#|https?:\/\/|[0-9a-f]{7,40}$)/i;

/** Build a citation token for a source id (e.g. `citation("recon#SB-HELLO")`). */
export function citation(src: string): string {
  return `[src: ${src}]`;
}

/**
 * Extract the CONTEXT block from a rendered prompt: the lines after a
 * `CONTEXT` heading, up to the next markdown-style heading (`## …`) or EOF.
 */
export function extractContext(prompt: string): string[] {
  const lines = prompt.split("\n");
  const start = lines.findIndex((l) => /^#{0,6}\s*CONTEXT\b/i.test(l.trim()));
  if (start === -1) return [];
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s+\S/.test(line.trim())) break; // next section heading
    body.push(line);
  }
  return body;
}

/** A list-item marker: `-`, `*`, `+`, or an ordered marker like `1.` / `2)`. */
const BULLET = /^\s*([-*+]|\d+[.)])\s+/;

/**
 * Group a CONTEXT block into claim BLOCKS. The linter is BLOCK-oriented, not
 * line-oriented (W1-T1 open question): a single claim may wrap across several
 * lines, and one `[src:]` anywhere in the block — canonically on its last
 * line — cites the whole claim.
 *
 * A block begins at a list-item marker (or a prose line with no open block)
 * and absorbs subsequent CONTINUATION lines (non-blank, non-heading, and not a
 * new list item) until a blank line, a new bullet, a sub-heading, or EOF. This
 * keeps sibling bullets as SEPARATE blocks — an uncited neighbour still blocks
 * on its own — while a wrapped claim counts once.
 */
export function contextBlocks(prompt: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  const close = (): void => {
    if (current && current.length > 0) blocks.push(current);
    current = null;
  };
  for (const line of extractContext(prompt)) {
    const t = line.trim();
    if (t === "" || /^#{1,6}\s/.test(t)) {
      close(); // blank line or sub-heading ends the current claim
      continue;
    }
    if (current === null || BULLET.test(line)) {
      close();
      current = [line];
    } else {
      current.push(line); // continuation of the open claim
    }
  }
  close();
  return blocks;
}

export interface LintResult {
  ok: boolean;
  violations: string[];
}

/** Lint a rendered prompt. Returns every uncited CONTEXT claim BLOCK. */
export function lintPrompt(prompt: string): LintResult {
  const violations: string[] = [];
  for (const block of contextBlocks(prompt)) {
    const head = block[0].trim();
    let cite: RegExpMatchArray | null = null;
    for (const line of block) {
      const m = line.match(CITATION);
      if (m) {
        cite = m;
        break;
      }
    }
    if (!cite) {
      violations.push(`uncited: ${head}`);
      continue;
    }
    if (!ACCEPTED_KIND.test(cite[1].trim())) {
      violations.push(`unrecognized source kind '${cite[1].trim()}': ${head}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Throw {@link ProvenanceError} unless every CONTEXT claim is cited. */
export function assertProvenance(prompt: string): void {
  const { ok, violations } = lintPrompt(prompt);
  if (!ok) throw new ProvenanceError(violations);
}
