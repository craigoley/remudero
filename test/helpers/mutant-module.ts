import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE ONE way a suite writes a MUTATED COPY of a `src/lib` module and imports it.
 *
 * WHY THIS EXISTS, AND IT IS NOT TIDINESS. Both mutant-importing suites used to write their copy
 * into `os.tmpdir()`. MEASURED over 14 bisect runs, that one choice silently destroyed the coverage
 * record of unrelated modules: `src/lib/commit-message.ts` read `LH:533 LF:534` in every run
 * without a tmpdir mutant and `LH:109` in every run with one — 424 lines losing their attribution
 * at once, CONSTANT at 14, 48, 63, 208 and 402 test files. Those 424 lines are indistinguishable,
 * to `scripts/diff-coverage.mjs`, from code nobody tested, which is how PR #1553 was blocked on ten
 * pre-existing lines its diff never touched.
 *
 * THE MECHANISM, ISOLATED RATHER THAN INFERRED. Three runs over the same 14 files, differing only
 * in what the falsifier does with its copy:
 *
 *   - write the copy to tmpdir and NEVER import it        -> LH:533, clean
 *   - write a SELF-CONTAINED module to tmpdir and import  -> LH:533, clean
 *   - write the real copy to tmpdir and import it         -> LH:109, destroyed
 *
 * So neither the temp file nor a temp import is the problem: it is a module OUTSIDE the project
 * root re-entering the real `src/lib` graph. `review.ts` and `status.ts` each reach 30 sibling
 * modules, two of which (`policy.ts`, `worker.ts`) use `import.meta` — and a run in the destroyed
 * state carries one extra lcov record that a clean run never has:
 *
 *     SF:src/lib/<define:import.meta>
 *
 * a synthetic transform artifact named INSIDE `src/lib/`. Its presence correlates with the collapse
 * 12 runs out of 12. That name is also why the obvious remedy fails: excluding `**\/tmp\/**` from
 * coverage removes the copy's own record and leaves this one, and the collapse survives untouched
 * (MEASURED — `LH:109` with every tmp record gone).
 *
 * THE FIX IS THE DESTINATION, and nothing else. The copy is written under `test/`, inside the
 * project root, and the rest of the construction is unchanged — the mutant still resolves its
 * siblings to the REAL modules, so the falsifier keeps testing the real collaborators rather than
 * stubs. Same 14 files, same 317 assertions, `LH:533` and no `<define:import.meta>` record.
 *
 * THE DIRECTORY NAME MUST NOT START WITH A DOT. `.mutant-XXXXXX` also restores the record, but
 * ci.yml's `--test-coverage-exclude="test/**"` does not match a dotted path segment, so the copy
 * appears in the lcov as a barely-covered `src` sibling and drags the aggregate ratchet. With
 * `mutants-XXXXXX` the existing exclude applies and the copy contributes NO record at all
 * (MEASURED: `grep -c '^SF:test/mutants-'` is 0). The name is also not `*.test.ts`, so ci.yml's
 * `test/**\/*.test.ts` glob never tries to run it.
 */

/** `test/` — the copy's home. Inside the project root, and already coverage-excluded. */
const TEST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `src/lib/` with a trailing separator, for absolutising the copy's sibling specifiers. */
const LIB_DIR = join(TEST_DIR, "..", "src", "lib") + "/";

const created: string[] = [];

// Cleanup runs on EXIT rather than in each caller's `finally`, so a failing assertion — the normal
// outcome while a falsifier is being written — does not leave the tree dirty. `.gitignore` carries
// `test/mutants-*/` as the backstop for a run killed outright.
process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/**
 * Write `mutatedSource` as `<fileName>` in a fresh `test/mutants-XXXXXX/` directory and return the
 * path to `await import()`.
 *
 * `mutatedSource` is the caller's already-mutated text of a `src/lib` module. Its same-directory
 * specifiers are absolutised here, because the copy no longer sits beside its siblings.
 */
export function writeMutantModule(fileName: string, mutatedSource: string): string {
  const rewritten = mutatedSource.replace(
    /from "\.\/([A-Za-z0-9._-]+)\.js"/g,
    (_m, name: string) => `from "${LIB_DIR}${name}.js"`,
  );
  const dir = mkdtempSync(join(TEST_DIR, "mutants-"));
  created.push(dir);
  const path = join(dir, fileName);
  writeFileSync(path, rewritten);
  return path;
}
