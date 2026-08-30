/**
 * lib/tty.ts — the semantic terminal layer (W1-T2475).
 *
 * THE PROBLEM THIS RETIRES: every render*Block in status-board.ts hand-typed its own
 * `"── NAME ─────...─"` divider (ten of them, all coincidentally 57 characters — a DRY defect,
 * not an inconsistency), and nothing anywhere read `NO_COLOR`/`FORCE_COLOR`/the terminal's
 * column count, so a crash-looping service, a starved queue and a healthy idle all rendered in
 * the same undifferentiated grey. This module is the one small helper that fixes both: a
 * `sectionRule` for the dividers, and `paint` for SIX SEMANTIC (never colour-named) wrappers a
 * renderer can apply to a state word it already prints — never a replacement for that word.
 *
 * COLOUR IS SECONDARY, NEVER LOAD-BEARING (the rule serve.ts's web console already worked out
 * and this module inherits wholesale): `paint.bad(text, enabled)` returns `text` UNCHANGED
 * when `enabled` is false, and even when true it only ever WRAPS the text a caller already
 * decided to print — it never substitutes a dot, a symbol, or a shorter word for it. Strip
 * every ANSI escape this module ever emits back out of a coloured string and you get back
 * byte-for-byte the string that went in.
 *
 * NO GLOBAL COLOUR STATE. `colourEnabled` and `terminalWidth` take the env/stream to read as
 * an explicit (defaulted) argument, and `paint`'s six wrappers take the enabled flag as an
 * explicit argument too — nothing in this module reads `process.env`/`process.stdout` except
 * at the one call site a caller chooses, and every function here is a plain value in, plain
 * value out (Rule 18), trivially testable without mutating global state.
 *
 * NO DEPENDENCY. chalk/picocolors/kleur are all refused for a module this size (task rationale)
 * — six SGR codes and a reset are the whole colour vocabulary this needs.
 */

/** The six SEMANTIC names a caller may paint text with — never a colour name (serve.ts's own
 *  rule: a renderer should never have to know or care that "bad" happens to render red). */
export type Semantic = "ok" | "warn" | "bad" | "dim" | "key" | "accent";

const RESET = "\x1b[0m";

/** SGR parameter for each semantic name. Exported so a test can assert "every escape sequence
 *  in coloured output comes from a semantic wrapper" by checking every code it finds against
 *  this table, rather than against a hand-copied duplicate of it. */
export const SEMANTIC_CODES: Readonly<Record<Semantic, string>> = Object.freeze({
  ok: "32", // green    — healthy / clear / running
  warn: "33", // yellow — degraded / stalled / refused, not yet a failure
  bad: "31", // red      — breached / stale / not running
  dim: "2", // faint     — unknown / nothing-to-report filler
  key: "36", // cyan     — a label the eye should anchor on
  accent: "35", // magenta — a value worth a second look, no severity implied
});

function wrap(code: string, text: string, enabled: boolean): string {
  if (!enabled || text.length === 0) return text;
  return `\x1b[${code}m${text}${RESET}`;
}

/**
 * `paint.<semantic>(text, enabled)` — wraps `text` in the SGR code for that semantic when
 * `enabled` is true; returns `text` completely unchanged (not even a zero-width marker) when
 * `enabled` is false or `text` is empty. `enabled` defaults to `false` (never `colourEnabled()`
 * read here) so a caller that forgets to pass it gets the SAFE, colour-off behaviour rather
 * than one that quietly depends on this process's own stdout/env at the moment it happens to
 * run — the one env read this layer performs lives in {@link colourEnabled}, at the ONE call
 * site a caller (status-board.ts's `renderStatusBoardText`) chooses to make it.
 */
export const paint: Readonly<Record<Semantic, (text: string, enabled?: boolean) => string>> = Object.freeze({
  ok: (text, enabled = false) => wrap(SEMANTIC_CODES.ok, text, enabled),
  warn: (text, enabled = false) => wrap(SEMANTIC_CODES.warn, text, enabled),
  bad: (text, enabled = false) => wrap(SEMANTIC_CODES.bad, text, enabled),
  dim: (text, enabled = false) => wrap(SEMANTIC_CODES.dim, text, enabled),
  key: (text, enabled = false) => wrap(SEMANTIC_CODES.key, text, enabled),
  accent: (text, enabled = false) => wrap(SEMANTIC_CODES.accent, text, enabled),
});

/**
 * Whether ANSI colour should be emitted, per the two env reads SURFACE 4 found nowhere in
 * `src`: an explicit `NO_COLOR` (any value, including `""` — https://no-color.org's own rule
 * is presence, not content) always WINS and disables colour even on a real terminal; failing
 * that, an explicit `FORCE_COLOR` always enables colour even when the stream is not a
 * terminal; failing both, colour follows whether the stream actually reports itself a TTY.
 * `env`/`stream` default to the real process globals but are accepted as plain arguments so a
 * test never has to mutate `process.env` to exercise any branch.
 */
export function colourEnabled(
  env: NodeJS.ProcessEnv = process.env,
  stream: { isTTY?: boolean } = process.stdout,
): boolean {
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) return true;
  return stream.isTTY === true;
}

/** Used when the stream reports no usable column count — chosen to match the width every one
 *  of status-board.ts's ten hand-typed section rules already had (see `tty-layer-and-status-
 *  board-rendering.test.ts`'s byte-identical assertion), not picked freshly by this module. */
export const DEFAULT_TERMINAL_WIDTH = 80;

/**
 * The terminal's column count, or `fallback` when the stream doesn't report a usable one
 * (piped output, a stream with no `columns` at all, or a non-finite/non-positive value) —
 * SURFACE 5's read, and the ONE place it happens. Never throws: an absent/malformed `columns`
 * is exactly the case this function exists to absorb into a stated default rather than let
 * propagate as a crash.
 */
export function terminalWidth(
  stream: { columns?: unknown } = process.stdout,
  fallback: number = DEFAULT_TERMINAL_WIDTH,
): number {
  const columns = stream?.columns;
  if (typeof columns === "number" && Number.isFinite(columns) && columns > 0) {
    return Math.floor(columns);
  }
  return fallback;
}

/**
 * One `"── NAME ────...─"` section divider, replacing the ten hand-typed literals
 * `renderStatusBoardText`'s block renderers used to carry (SURFACE 1/2: ten literals, one
 * true width). `width` defaults to {@link DEFAULT_TERMINAL_WIDTH} but every call this task
 * wires up passes the SAME `57` those ten literals were already measured at, so today's board
 * is byte-identical; a caller that instead wires this to {@link terminalWidth}'s real reading
 * gets a divider that never overruns a narrow terminal (this function CLAMPS: if `name` alone
 * would already meet or exceed `width`, the return value is truncated to exactly `width`
 * characters rather than overrunning it).
 */
export function sectionRule(name: string, width: number = DEFAULT_TERMINAL_WIDTH): string {
  const w = Math.max(0, Math.floor(width));
  const label = [...`── ${name} `];
  if (label.length >= w) return label.slice(0, w).join("");
  return label.join("") + "─".repeat(w - label.length);
}
