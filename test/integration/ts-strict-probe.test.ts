import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("../../fixtures/ts-strict-probe/violation.ts", import.meta.url));
// Invoke the LOCAL tsc binary directly, not `npx tsc` — `npx`'s own
// resolution is a needless extra layer of indirection this test doesn't
// need (it already knows exactly where the local binary lives).
const tsc = fileURLToPath(new URL("../../node_modules/.bin/tsc", import.meta.url));

// W1-T25 acceptance: "TypeScript strict is proven ACTIVE by a committed
// probe that MUST fail — a bare 0-violations is NOT accepted." / "a
// committed strict-only-probe fixture ... is REJECTED by typecheck when
// strict is on and would pass with it off; the doctrine '0-violations
// without the probe is not proof' (neon-drift) is encoded as this falsifier
// fixture, never a live paste."
//
// LIVES IN test/integration/, NOT test/, and is therefore excluded from
// "test:unit" (test/*.test.ts, non-recursive — see package.json) — the
// command stryker.conf.mjs's dry run runs. Verified empirically: this
// repo's `typescript` package is TypeScript 7's NATIVE-PORT preview —
// node_modules/typescript/lib/tsc.js is a thin shim that either
// `process.execve()`s a native binary (Node >=22.15 fast path) or falls
// back to `execFileSync(nativeBinary, ..., { stdio: "inherit" })`, NOT the
// classic pure-JS compiler. When invoked as a doubly-nested child (this
// test's spawnSync, itself inside `node --test`, itself inside Stryker's
// own `exec("npm test")` for its dry run) that native-binary delegation
// intermittently returned status 0 with completely empty stdout/stderr —
// a silent no-op indistinguishable, by output alone, from "compiled clean"
// — where the SAME invocation is 100% reliable standalone or under `npm
// test` run directly (not nested inside another process's own child-process
// tree). Since this test's entire PURPOSE is to fail loudly the moment
// "0 violations" ever means something other than "genuinely clean" for
// strict mode, retrying past that ambiguity would defeat the falsifier —
// so instead it is simply kept OUT of the one context proven to trigger it.
// The real per-PR gate (.github/workflows/quality.yml's ts-strict-probe
// job, package.json "ts-strict-probe" -> .github/scripts/ts-strict-probe.sh)
// is unaffected — it runs standalone, not nested, and this test still runs
// there via "npm test" (test/**/*.test.ts, recursive, includes this dir).
function compile(strict: boolean) {
  return spawnSync(
    tsc,
    [
      "--noEmit",
      // This repo's own tsconfig.json sits in cwd; TS7 refuses to mix a
      // project config with file-list-on-commandline mode (TS5112) unless
      // told to ignore it — verified empirically, not assumed. This probe
      // is deliberately an ISOLATED single-file compile (see file header),
      // not `-p tsconfig.json`, so it must ignore the ambient config.
      "--ignoreConfig",
      "--strict",
      String(strict),
      "--target",
      "ES2022",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      fixture,
    ],
    { encoding: "utf8" },
  );
}

test("ts-strict-probe fixture: REJECTED (non-zero exit, TS18047) when strict is ON — the falsifier", () => {
  const result = compile(true);
  assert.notEqual(result.status, 0, `expected tsc to reject the probe under strict mode\n${result.stdout}`);
  assert.match(result.stdout, /TS18047/, `expected the strictNullChecks-specific error code\n${result.stdout}`);
});

test("ts-strict-probe fixture: ACCEPTED (zero exit) when strict is OFF — proves the violation is strict-mode-specific, not a bare syntax error", () => {
  const result = compile(false);
  assert.equal(result.status, 0, `expected tsc to accept the probe with strict off\n${result.stdout}`);
});
