/**
 * Bounded, redacted tail of a failed proof's own output (W1-T9301).
 *
 * A proof that fails prints the cause at the END of its output, so the executor keeps the tail. The tail is
 * tiered, never a single silent cut: under the bounds the whole output is kept; over them the newest lines are
 * kept and the first line says how many earlier lines were dropped (the omitted count), so a reader knows the
 * excerpt is partial. Every line is redacted BEFORE it is cut, so a secret is never sliced in half into
 * something that no longer matches a pattern but still leaks a fragment.
 */

/** Most non-blank lines a failure tail keeps. */
export const FAILURE_TAIL_MAX_LINES = 40;
/** Most characters a failure tail keeps, not counting the omitted-lines note. */
export const FAILURE_TAIL_MAX_CHARS = 3000;

const REDACTED = "<redacted>";

/** Secret shapes a proof's output can carry; each is replaced whole, applied in order. */
const REDACTIONS: readonly { pattern: RegExp; replacement: string }[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replacement: REDACTED },
  { pattern: /(https?:\/\/)[^\s/@]+@/gi, replacement: `$1${REDACTED}@` },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, replacement: REDACTED },
  { pattern: /\b(?:sk|pk|xox[abprs])-[A-Za-z0-9-]{16,}\b/g, replacement: REDACTED },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement: REDACTED },
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${REDACTED}` },
  {
    pattern: /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|credential|authorization)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;]+)/gi,
    replacement: `$1$2${REDACTED}`,
  },
];

/** `text` with every recognised secret shape replaced by `<redacted>`. */
export function redactProofOutput(text: string): string {
  return REDACTIONS.reduce((out, { pattern, replacement }) => out.replace(pattern, replacement), text);
}

/** The note that leads a tail which dropped earlier lines. */
function omittedNote(omitted: number): string {
  return `(${omitted} earlier ${omitted === 1 ? "line" : "lines"} omitted)`;
}

/**
 * The bounded, redacted tail of `stdout` then `stderr`: redacted, blank lines dropped, the last `maxLines` lines
 * kept and then trimmed from the front until at most `maxChars` characters remain. When anything was dropped the
 * first line is `(N earlier lines omitted)`, N being the exact omitted count. `""` when nothing was printed.
 */
export function formatTail(
  stdout: string,
  stderr = "",
  maxLines = FAILURE_TAIL_MAX_LINES,
  maxChars = FAILURE_TAIL_MAX_CHARS,
): string {
  const lines = redactProofOutput([stdout, stderr].join("\n"))
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  let kept = lines.slice(-maxLines);
  const size = (): number => kept.reduce((sum, line) => sum + line.length + 1, -1);
  while (kept.length > 1 && size() > maxChars) kept = kept.slice(1);
  const last = kept[kept.length - 1];
  if (last !== undefined && last.length > maxChars) kept = [`…${last.slice(-maxChars)}`];
  const omitted = lines.length - kept.length;
  const body = kept.join("\n");
  return omitted > 0 ? `${omittedNote(omitted)}\n${body}` : body;
}
