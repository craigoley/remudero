/**
 * ONE ARGV ENTRY POINT, USED BY EVERY scripts/*.mjs CALLER.
 *
 * Audit recon-2026-09-05 R-59: every gate script hand-writes the same main-module guard —
 * `if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) { main(process.argv.slice(2)); }`
 * — with three independently-drifted spellings across the tree (`pathToFileURL(...).href`,
 * `` `file://${process.argv[1]}` ``, and an `.endsWith(<basename>)` suffix check). All three answer
 * the same question — "was THIS file run directly, not merely imported (e.g. by a test)?" — so
 * {@link isMainModule} answers it once.
 *
 * NO DEPENDENCY: this wraps only `node:util`'s built-in `parseArgs`, never an npm package — the
 * scripts it serves are the gates CI runs before `npm ci` has necessarily finished for anything
 * heavier. {@link parseArgv} adds exactly one thing `parseArgs` does not: a uniform `--help`.
 */
import { parseArgs as nodeParseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/**
 * Whether `moduleUrl` (a caller's own `import.meta.url`) names the process's entry script —
 * i.e. this file was invoked directly (`node scripts/foo.mjs`), not merely imported by another
 * module (a test, another script). `argv1` defaults to `process.argv[1]`, overridable so a test
 * can drive both arms without actually spawning a process.
 */
export function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  return moduleUrl === pathToFileURL(argv1).href;
}

/**
 * `node:util`'s `parseArgs`, plus a `--help` every caller gets for free instead of re-adding a
 * `{ help: { type: "boolean" } }` option by hand. The three flag shapes the scripts use are all
 * plain `node:util` option specs — a bare boolean (`{ type: "boolean" }`), a valued string
 * (`{ type: "string", default: ... }`), and a repeatable string (`{ type: "string", multiple:
 * true }`) — so this never reinterprets them; it only adds the one behaviour every caller was
 * re-deciding for itself: what `--help` does.
 *
 * `helpText`, when given, is printed (via `console.log`) and `helpRequested: true` is returned
 * whenever `--help`/`-h` is present, so a caller can `return` before touching any other flag
 * instead of hand-rolling that check. Omit `helpText` to opt out and let `values.help` alone.
 *
 * @param {string[]} argv
 * @param {Record<string, object>} options a `node:util` `parseArgs` options map
 * @param {{ helpText?: string, allowPositionals?: boolean }} [opts]
 */
export function parseArgv(argv, options, { helpText, allowPositionals = true } = {}) {
  const withHelp = {
    ...options,
    help: { type: "boolean", short: "h", ...(options.help ?? {}) },
  };
  const { values, positionals } = nodeParseArgs({ args: argv, options: withHelp, allowPositionals });
  const helpRequested = Boolean(values.help);
  if (helpRequested && helpText) {
    console.log(helpText);
  }
  return { values, positionals, helpRequested };
}
