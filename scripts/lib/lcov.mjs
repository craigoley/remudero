/**
 * ONE LCOV READ, USED BY BOTH COVERAGE CONSUMERS.
 *
 * Audit recon-2026-09-05 R-59: `coverage-ratchet.mjs` and `diff-coverage.mjs` each parsed an lcov
 * report with their own hand-written loop over `SF:`/`DA:`/`end_of_record` lines — the same text
 * format, split twice. A fix to one (W1-T2276's corrupted-merge handling, W1-T220's out-of-repo
 * `SF:` skip) does not reach the other unless someone remembers to port it by hand.
 *
 * ONE PARSE, TWO SHAPES ON TOP. `coverage-ratchet.mjs` wants aggregate `LF`/`LH`/`BRF`/`BRH`
 * totals; `diff-coverage.mjs` wants per-line `DA:`/`FN:`/`FNDA:` maps, keyed by file, with its own
 * duplicate-block merge policy (W1-T2276's "any-higher-wins"/"any-non-zero-wins", never
 * last-wins). Those two policies are NOT the same, so this module does not pick one for both
 * callers — it returns one record PER `SF:`/`end_of_record` BLOCK, unmerged, and leaves "what a
 * duplicate block means" to each caller, same as their pre-migration behaviour, byte for byte.
 */

/**
 * @typedef {object} LcovRecord
 * @property {string} sourceFile the raw `SF:` path, untouched (relative-or-absolute, as recorded)
 * @property {{ line: number, hits: number }[]} da `DA:` records, in file order
 * @property {{ line: number, names: string[] }[]} fn `FN:` records — one line can declare more
 *   than one name (W1-T481)
 * @property {{ name: string, hits: number }[]} fnda `FNDA:` records, in file order
 * @property {number} lf lines found
 * @property {number} lh lines hit
 * @property {number} brf branches found
 * @property {number} brh branches hit
 */

/**
 * Split raw lcov text into one {@link LcovRecord} per `SF:`/`end_of_record` block, in file order.
 * A block missing its `end_of_record` (a truncated or concatenated report) still yields its
 * record — everything up to the next `SF:` (or end of text) belongs to it. Text before the first
 * `SF:` is ignored (lcov has nothing to attribute it to).
 *
 * THE ONLY LOOP OVER LCOV TEXT IN THIS REPO. A caller that wants totals sums the fields it cares
 * about across the returned records (`coverage-ratchet.mjs`'s `parseLcovTotals`); a caller that
 * wants per-line hit maps folds `da`/`fn`/`fnda` across records sharing a `sourceFile`, applying
 * its own merge policy for a duplicate (`diff-coverage.mjs`'s `parseLcovHitsByFile`).
 *
 * @param {string} lcovText
 * @returns {LcovRecord[]}
 */
export function parseLcovRecords(lcovText) {
  /** @type {LcovRecord[]} */
  const records = [];
  /** @type {LcovRecord | null} */
  let current = null;
  for (const line of lcovText.split("\n")) {
    if (line.startsWith("SF:")) {
      current = { sourceFile: line.slice(3).trim(), da: [], fn: [], fnda: [], lf: 0, lh: 0, brf: 0, brh: 0 };
      records.push(current);
      continue;
    }
    if (!current) continue; // stray line before any SF: — nothing to attribute it to.
    if (line.startsWith("DA:")) {
      const [ln, hits] = line.slice(3).split(",");
      current.da.push({ line: Number(ln), hits: Number(hits) });
    } else if (line.startsWith("FN:")) {
      const [ln, name] = line.slice(3).split(",");
      current.fn.push({ line: Number(ln), names: [name] });
    } else if (line.startsWith("FNDA:")) {
      const [hits, name] = line.slice(5).split(",");
      current.fnda.push({ name, hits: Number(hits) });
    } else if (line.startsWith("LF:")) {
      current.lf = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      current.lh = Number(line.slice(3));
    } else if (line.startsWith("BRF:")) {
      current.brf = Number(line.slice(4));
    } else if (line.startsWith("BRH:")) {
      current.brh = Number(line.slice(4));
    } else if (line.startsWith("end_of_record")) {
      current = null;
    }
  }
  return records;
}
