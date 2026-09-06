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

test("CLI entry MINTS before dispatch — observed by running main(), not by reading its source", async (t) => {
  // BEHAVIOURAL, not a source-text read: W1-T2905's ratchet is right that grepping src/ for a call
  // shape is the weaker assertion, and a new test file starts at zero allowance. This drives the
  // real main() with the app configured and a stubbed exchange, and asserts the token ARRIVED —
  // which is the property that was missing on the fleet host, not the presence of a line.
  const saved = {
    id: process.env.GH_APP_ID,
    inst: process.env.GH_APP_INSTALLATION_ID,
    key: process.env.GH_APP_PRIVATE_KEY_PATH,
    tok: process.env.GH_TOKEN,
    argv: process.argv,
  };
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { RMD_TMP_PREFIX } = await import("../src/lib/tmp.js");
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}cli-mint-`));
  // A syntactically valid RSA key is not needed: the exchange itself is stubbed below, and the
  // signing step reads this file only for its bytes.
  const keyPath = join(dir, "key.pem");
  writeFileSync(keyPath, "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----\n");

  const stderr: string[] = [];
  t.mock.method(console, "error", (...a: unknown[]) => {
    stderr.push(a.map(String).join(" "));
  });
  t.mock.method(console, "log", () => {});
  class ExitCalled extends Error {
    constructor(public code: number | undefined) {
      super(`process.exit(${code})`);
    }
  }
  const exitMock = ((code?: number): never => {
    throw new ExitCalled(code);
  }) as typeof process.exit;
  t.mock.method(process, "exit", exitMock);

  try {
    process.env.GH_APP_ID = "1";
    process.env.GH_APP_INSTALLATION_ID = "2";
    process.env.GH_APP_PRIVATE_KEY_PATH = keyPath;
    delete process.env.GH_TOKEN;
    process.argv = ["node", "run-task.js", "--no-such-verb"];
    const { main } = await import("../src/run-task.js");
    await main().catch(() => {}); // the unknown verb exits; the mint runs BEFORE dispatch either way
    // THE DISCRIMINATOR is that the ATTEMPT is observable. Asserting only "GH_TOKEN is unset" would
    // pass identically when no mint ran at all — measured: with the mint deleted that assertion
    // still read green, which is test theatre. The stubbed key cannot sign, so the exchange fails
    // and `refreshInstallationToken` NAMES the reason through the logger main() hands it; that line
    // exists only if the mint was reached.
    assert.ok(
      stderr.some((l) => /github_app/.test(l)),
      `main() must REACH the mint before dispatch — no github_app line on stderr means it never ran: ${JSON.stringify(stderr)}`,
    );
    assert.equal(process.env.GH_TOKEN, undefined, "and a failed mint must never leave a partial token behind");
  } finally {
    process.argv = saved.argv;
    for (const [k, v] of [["GH_APP_ID", saved.id], ["GH_APP_INSTALLATION_ID", saved.inst], ["GH_APP_PRIVATE_KEY_PATH", saved.key], ["GH_TOKEN", saved.tok]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
