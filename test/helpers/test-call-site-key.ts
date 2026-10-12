// ── W1-T5622: a test call site's key, by enclosing test TITLE rather than line number ──────────
//
// test/operator-gated-default-reachability.test.ts keyed its witnesses and REACHABILITY_EXCLUSIONS
// as `name:file:line`, so every line inserted above a call site re-keyed it with no change in
// reachability (test/run-task.test.ts's two armIfVerdictPermits witnesses were re-derived in 16
// commits). A test title is what a reader already uses to name a call site, and it does not move
// when a diff lands above it. `#<ordinal>` separates two same-name calls inside one test.
//
// The census still reports `file:line` to humans; only the KEY drops the line.

/** Matches a `test(`/`it(` call whose first argument is a string literal, capturing the quote
 *  and the literal's raw body. Not preceded by `.`, `$` or a word character, so `re.test("x")`
 *  and `t.test(...)` are never read as a title. */
const TITLE_RE = /(?<![.\w$])(?:test|it)\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** The title of the nearest `test("...")`/`it("...")` that opens before `offset`, read raw (escape
 *  sequences intact), or `undefined` when no test opens before it (module scope). */
export function enclosingTestTitle(text: string, offset: number): string | undefined {
  const head = text.slice(0, offset);
  let title: string | undefined;
  for (const m of head.matchAll(TITLE_RE)) title = m[2];
  return title;
}

/** Attach each row's 1-based ordinal among rows sharing its name, file and title, in input order. */
export function numberCallSites<T extends { name: string; file: string; title: string | undefined }>(
  rows: readonly T[],
): Array<T & { ordinal: number }> {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const group = JSON.stringify([row.name, row.file, row.title ?? null]);
    const ordinal = (seen.get(group) ?? 0) + 1;
    seen.set(group, ordinal);
    return { ...row, ordinal };
  });
}

/** `name:file:<title>#<ordinal>` — no line number, so a line shift above the call cannot move it. */
export function callSiteKey(site: { name: string; file: string; title: string | undefined; ordinal: number }): string {
  return `${site.name}:${site.file}:${site.title ?? "<module>"}#${site.ordinal}`;
}
