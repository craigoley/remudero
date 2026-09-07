/**
 * DUPLICATE-KEY DETECTION FOR A RATCHET BASELINE.
 *
 * `JSON.parse` does not error on a document that names one key twice inside an object — it takes
 * the LAST occurrence, silently. For a ratchet baseline that is a disarmed ceiling: the gate goes
 * on measuring against a number nobody chose, and prints a growth that did not happen.
 *
 * MEASURED 2026-09-07. Resolving a `scripts/comment-load-baseline.json` rebase conflict by taking
 * the UNION of both sides — the obvious move for a flat sorted map, and what a merge tool suggests
 * — put "src/run-task.ts" in the file twice. Last-wins picked the stale 16253 over main's 16432,
 * and the ratchet reported a +181 growth against a ceiling 179 too low to record. That conflict
 * arose four times in one session; each was caught by eye.
 *
 * THE PARSE MUST BE ITS OWN, which is the whole reason this is not three lines inside a caller:
 * every standard JSON reader has already discarded the duplicate by the time it returns, so a
 * check built on one cannot see what it is looking for. This reads the TEXT.
 */

/**
 * Every key appearing more than once within a single JSON object, in encounter order.
 *
 * A scanner, not a parser. It tracks string state with escapes so a brace, quote or colon inside a
 * VALUE cannot desynchronise it, and keeps a container stack so sibling objects in an array that
 * share a field name are NOT reported — that is normal, and a file-wide name count (the naive
 * version of this) flags four legitimate baselines in this repo for it.
 *
 * @param {string} text raw JSON
 * @returns {string[]} duplicated key names
 */
export function duplicateKeys(text) {
  const dups = [];
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      let raw = "";
      while (j < text.length) {
        if (text[j] === "\\") {
          raw += text[j + 1];
          j += 2;
          continue;
        }
        if (text[j] === '"') break;
        raw += text[j];
        j++;
      }
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      const top = stack[stack.length - 1];
      if (text[k] === ":" && top?.isObject) {
        if (top.seen.has(raw)) dups.push(raw);
        top.seen.add(raw);
      }
      i = j + 1;
      continue;
    }
    if (c === "{") stack.push({ isObject: true, seen: new Set() });
    else if (c === "[") stack.push({ isObject: false, seen: new Set() });
    else if (c === "}" || c === "]") stack.pop();
    i++;
  }
  return dups;
}

/** Throw naming the file, the keys and the remedy. `tool` prefixes the message like its siblings. */
export function assertNoDuplicateKeys(text, path, tool) {
  const dups = [...new Set(duplicateKeys(text))].sort();
  if (dups.length === 0) return;
  throw new Error(
    `${tool}: ${path} names ${dups.length === 1 ? "a key" : "keys"} twice (${dups.join(", ")}). ` +
      `JSON.parse takes the LAST one silently, so this ceiling is measuring against a number nobody ` +
      `chose — the signature of a rebase conflict resolved by unioning both sides. Take the file from ` +
      `the merge base and re-run this script, which prints the value to record.`,
  );
}
