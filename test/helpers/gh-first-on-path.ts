/**
 * test/helpers/gh-first-on-path.ts — an `--import` preload for a spawned `node --test` child.
 *
 * Loaded AFTER test/setup/tmp-hygiene.ts, it prepends `RMD_TEST_GH_FIRST_DIR` onto PATH so the
 * `gh` in that directory (a {@link import("./gh-shim.js").ghShim}) answers ahead of the shared
 * refusing stub — the same precedence a test's own shim gets when it prepends itself at run
 * time. A shim prepended later by the child's own tests still wins over this one. W1-T4226 uses
 * it to record every `gh` call a real test file makes. Unset, it does nothing.
 */
const dir = process.env.RMD_TEST_GH_FIRST_DIR;
if (dir) process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
