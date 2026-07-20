/**
 * lib/commit-message.ts — Conventional-Commits shaping for MACHINE-BUILT commit
 * messages (MASTER-PLAN §6A, the W1-T136/W1-T137 class).
 *
 * WHY THIS EXISTS. `commitlint` runs ONLY in CI (.github/workflows/ci.yml), over the
 * whole `origin/main..HEAD` range, and it is a REQUIRED check (ci-gate.yml). There is
 * no husky, no `core.hooksPath`, no `commit-msg` hook — so nothing local ever tells a
 * committer their message is malformed. The first signal is a red required check on an
 * already-open PR, at which point the W1-T76 fix rung has no move for a CI-check failure
 * and escalates a SPEC question instead (issues #304/#306, and #406 on 2026-07-20).
 *
 * Observed failures, all the same class:
 *   - PR #405 header 124 chars (cap 100) AND `FIND layer …` tripping `subject-case`
 *   - PRs #303/#305 headers at 108 and 114 chars
 *   - operator-authored plan PRs #399 (header-max-length) and #403 (subject-case)
 * Machine and human trip the identical rules, which is why the shaping belongs in one
 * tested place rather than in per-site discipline.
 *
 * SCOPE — this module shapes messages the HARNESS builds. It cannot police a message a
 * worker LLM authors inside its own worktree; that half is addressed by stating the rule
 * in the worker OUTPUT CONTRACT (lib/compaction.ts). Both halves are needed: this one is
 * deterministic, that one is instructional.
 *
 * The limits are NOT hard-coded here — {@link CONVENTIONAL_LIMITS} mirrors
 * `@commitlint/config-conventional`, and `test/commit-message.test.ts` proves every
 * output of this module against the REAL `commitlint` CLI, so a config bump that changes
 * a limit fails the test rather than silently diverging.
 */

/** Limits mirroring `@commitlint/config-conventional` (see commitlint.config.mjs). */
export const CONVENTIONAL_LIMITS = {
  headerMaxLength: 100,
  bodyMaxLineLength: 100,
} as const;

/** Marker appended to a header whose subject had to be trimmed. */
const ELLIPSIS = "…";

/**
 * Lower-case the start of a subject so it cannot trip `subject-case`.
 *
 * MEASURED against the real CLI, not assumed — an earlier draft of this function
 * exempted a leading acronym on the theory that commitlint tests the subject's overall
 * case. It does not. Every one of these is REJECTED by the project's own config:
 *   `FIND layer — fuzzy search`      FAIL
 *   `SSE stream severed`             FAIL
 *   `URL round-trips on reload`      FAIL
 *   `Add a thing`                    FAIL
 * and the lower-cased forms all pass. There is no acronym exemption, so preserving one
 * would emit a message the gate rejects — the exact failure this module exists to stop.
 *
 * An all-caps leading word is lower-cased WHOLE (`SSE …` -> `sse …`) rather than by its
 * first character alone (`sSE …`). Both pass the gate — verified — but only one reads
 * like English, and a shaper that emits `sSE` teaches nothing to the humans reading the
 * log. A mixed-case word is lower-cased at its first character only, which is the
 * minimal reversible edit.
 */
export function normalizeSubjectCase(subject: string): string {
  const trimmed = subject.trimStart();
  const firstWord = trimmed.split(/\s+/, 1)[0] ?? "";
  const alpha = firstWord.replace(/[^A-Za-z]/g, "");
  if (alpha.length >= 2 && alpha === alpha.toUpperCase()) {
    return firstWord.toLowerCase() + trimmed.slice(firstWord.length);
  }
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/** Wrap `text` so no line exceeds `max` chars, breaking on whitespace only. */
export function wrapBodyLines(text: string, max: number = CONVENTIONAL_LIMITS.bodyMaxLineLength): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line === "") {
        line = word;
      } else if (line.length + 1 + word.length <= max) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line !== "") out.push(line);
  }
  return out;
}

export interface ShapedMessage {
  /** The full message: header, blank line, then the wrapped body (if any). */
  message: string;
  /** The header alone, guaranteed <= headerMaxLength CHARACTERS. */
  header: string;
  /** True when the subject was trimmed to fit (overflow moved into the body). */
  trimmed: boolean;
}

/**
 * Shape a machine-built commit message so it passes commitlint.
 *
 * Guarantees, each covered by a test against the real CLI:
 *  - the header is <= `headerMaxLength` CHARACTERS (not bytes — an em-dash is 3 bytes
 *    and 1 character, and commitlint counts characters; measuring bytes is how a
 *    "100-char" header lands at 102 and still passes, or a 98-char one is wrongly cut)
 *  - the subject does not trip `subject-case`
 *  - no body line exceeds `bodyMaxLineLength`
 *  - overflow from a trimmed subject is PRESERVED in the body, never discarded
 *
 * `prefix` is the conventional `type(scope):` part and is never trimmed — if the prefix
 * alone cannot fit, that is a caller bug and throws rather than emitting a message that
 * silently fails the gate later.
 */
export function shapeCommitMessage(
  prefix: string,
  subject: string,
  body = "",
  limits: { headerMaxLength: number; bodyMaxLineLength: number } = CONVENTIONAL_LIMITS,
): ShapedMessage {
  const cleanPrefix = prefix.trim().replace(/:$/, "") + ":";
  const cleanSubject = normalizeSubjectCase(subject.trim().replace(/\.$/, ""));

  const room = limits.headerMaxLength - cleanPrefix.length - 1; // -1 for the space
  if (room <= ELLIPSIS.length) {
    throw new Error(
      `shapeCommitMessage: prefix ${JSON.stringify(cleanPrefix)} leaves no room for a subject ` +
        `within header-max-length ${limits.headerMaxLength}`,
    );
  }

  let header: string;
  let overflow = "";
  let trimmed = false;

  if (cleanSubject.length <= room) {
    header = `${cleanPrefix} ${cleanSubject}`;
  } else {
    trimmed = true;
    const budget = room - ELLIPSIS.length;
    // Break on a word boundary so the header never ends mid-word.
    let cut = cleanSubject.lastIndexOf(" ", budget);
    if (cut <= 0) cut = budget;
    header = `${cleanPrefix} ${cleanSubject.slice(0, cut).trimEnd()}${ELLIPSIS}`;
    overflow = cleanSubject.slice(cut).trim();
  }

  const bodyParts: string[] = [];
  if (overflow !== "") bodyParts.push(overflow);
  if (body.trim() !== "") bodyParts.push(body.trim());

  const wrapped = bodyParts.length > 0 ? wrapBodyLines(bodyParts.join("\n\n"), limits.bodyMaxLineLength) : [];
  const message = wrapped.length > 0 ? `${header}\n\n${wrapped.join("\n")}\n` : `${header}\n`;

  return { message, header, trimmed };
}
