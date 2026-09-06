import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshInstallationToken } from "../src/lib/github-app.js";

/**
 * THE GITHUB APP IS THE FLEET HOST'S ONLY CREDENTIAL. `gh auth login` is never run there and the
 * boot env deliberately carries no `GH_TOKEN` (deploy/recycle-container.sh; github-app.ts's own
 * header). Only `daemonCommand` and `serveCommand` minted from `GH_APP_*`, so every other verb that
 * shells to `gh` — 32 call sites in run-task.ts — failed on the one host the fleet runs on.
 *
 * MEASURED 2026-09-06: `rmd review <pr>` inside the daemon container died in `ghJson`, which is how
 * a CAPPED verdict's own documented remedy (`--override-capped-by`) became unrunnable exactly where
 * an operator would reach for it.
 *
 * These assert the PRIMITIVE's two guarantees that make minting safe at CLI entry. The wiring
 * itself is asserted by the source-level check at the bottom, the same shape
 * test/adhoc-lane-reap.test.ts uses for its own call site.
 */

test("absent GH_APP_* the mint is NOT AN ATTEMPT — it writes no token and reports nothing, so a dev machine is unchanged", async () => {
  const env: NodeJS.ProcessEnv = {}; // no GH_APP_ID / INSTALLATION_ID / PRIVATE_KEY_PATH
  const logged: string[] = [];
  const before = { ...env };
  await refreshInstallationToken({
    env,
    log: (step) => logged.push(step),
    fetchImpl: (() => {
      throw new Error("the network must not be reached when the app is not configured");
    }) as never,
  });
  assert.deepEqual(env, before, "no env key is written when the app is not configured");
  assert.equal(env.GH_TOKEN, undefined, "and GH_TOKEN specifically is left absent");
  assert.deepEqual(logged, [], "absent config is not an attempt, so it makes no ledger noise");
});

test("a failed exchange leaves GH_TOKEN untouched and NAMES the reason, rather than failing later inside gh", async () => {
  const env: NodeJS.ProcessEnv = {
    GH_APP_ID: "1",
    GH_APP_INSTALLATION_ID: "2",
    GH_APP_PRIVATE_KEY_PATH: "/nonexistent/key.pem",
  };
  const logged: string[] = [];
  await refreshInstallationToken({ env, log: (step) => logged.push(step) });
  assert.equal(env.GH_TOKEN, undefined, "a failed mint must never write a partial or bogus token");
  assert.ok(logged.length > 0, `an ATTEMPT that fails must name its reason — saw ${JSON.stringify(logged)}`);
});

test("CLI entry mints before dispatch, and only when GH_TOKEN is absent", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
  assert.match(
    code,
    /if \(!process\.env\.GH_TOKEN\) \{\s*await refreshInstallationToken\(/,
    "main() must mint when no token is present — unguarded it would clobber an operator's own exported GH_TOKEN",
  );
  const mintAt = code.indexOf("await refreshInstallationToken(");
  const dispatchAt = code.indexOf("const [cmd, ...rest] = stripRepoRootFlag(");
  assert.ok(mintAt > 0 && dispatchAt > 0, "sanity: both landmarks are present");
  assert.ok(mintAt < dispatchAt, "the mint must run BEFORE argv is dispatched, or the first gh call still has no token");
});
