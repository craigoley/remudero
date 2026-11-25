/**
 * W1-T14855: the operator-approved Field Trials refresh of 2026-11-25 started at 14:33Z, its `rmd field-trials` child
 * minted one App token (expires_at 15:56:24Z), and from then every GitHub read failed "gh: Bad credentials (HTTP 401)".
 * The CLI mints one token per process and the verb armed no refresh loop, while W1-T14778 lets a pass read until its
 * work is done. Every paced read now renews a held token near its expiry first, and the verb holds one for its pass.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { buildFieldTrialsFlowSnapshot, fieldTrialsCommand } from "#src/lib/field-trials-flow.js";
import { pacedGhApiFetch, type GithubPageFetch } from "#src/lib/field-trials-github.js";
import {
  GH_APP_ID_ENV,
  GH_APP_INSTALLATION_ID_ENV,
  GH_APP_PRIVATE_KEY_PATH_ENV,
  INSTALLATION_TOKEN_LIFETIME_MS,
  startInstallationTokenRefresh,
} from "#src/lib/github-app.js";

const START = Date.parse("2026-11-25T14:56:24.000Z");
const MIN = 60_000;

/** A real refresh loop over a scripted exchange and clock: each mint writes a new token that lives one hour. */
function loop(clock: { ms: number }) {
  const env: Record<string, string | undefined> = { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" };
  let mints = 0;
  const renewal = startInstallationTokenRefresh({
    log: () => {}, env, now: () => clock.ms, setTimer: () => ({}), clearTimer: () => {},
    refresh: async (o) => {
      mints++;
      o.env!.GH_TOKEN = `ghs_minted_${mints}`;
      return { ok: true, expiresAtMs: clock.ms + INSTALLATION_TOKEN_LIFETIME_MS };
    },
  });
  return { renewal, env, mints: () => mints };
}

test("a Field Trials read after its token nears expiry renews the held token first", async () => {
  for (const [label, gap] of [["past its expiry", 97 * MIN], ["inside the five-minute margin", 57 * MIN], ["with time to spare", 30 * MIN]] as const) {
    const clock = { ms: START };
    const { renewal, env, mints } = loop(clock);
    try {
      await renewal.ready;
      const presented: { path: string; token: string | undefined }[] = [];
      const read = async (args: string[]): Promise<string> => {
        presented.push({ path: args[1]!, token: env.GH_TOKEN });
        // A full bucket: the pacer never waits.
        return args[1] === "rate_limit" ? JSON.stringify({ resources: { core: { limit: 5000, remaining: 5000, reset: 0 } } }) : "[]";
      };
      const fetch = pacedGhApiFetch(read, { clock: clockFromMillisFn(() => clock.ms), sleep: async () => {} });
      assert.deepEqual(await fetch("repos/acme/core/pulls?page=1"), { ok: true, items: [] });
      // The pass works between pages with no await, as a long scan does.
      clock.ms += gap;
      const afterGap = presented.length;
      assert.deepEqual(await fetch("repos/acme/core/pulls?page=2"), { ok: true, items: [] });
      const renewed = gap !== 30 * MIN;
      assert.equal(mints(), renewed ? 2 : 1, `${label}: ${renewed ? "renewed once" : "renewed nothing"}`);
      assert.ok(presented.length > afterGap);
      for (const { path, token } of presented.slice(afterGap)) {
        assert.equal(renewal.tokenState!(token), "fresh", `${label}: ${path} presented the held, unexpired token`);
      }
    } finally {
      renewal.stop!();
    }
  }
});

test("the field-trials verb holds a refreshed token for its whole GitHub pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-field-trials-token-"));
  try {
    const order: string[] = [];
    const fetch: GithubPageFetch = async (path) => { order.push(`read ${path.split("?")[0]}`); return { ok: true, items: [] }; };
    const startTokenRefresh = ((opts: Parameters<typeof startInstallationTokenRefresh>[0]) => {
      order.push("arm");
      assert.equal(typeof opts.log, "function");
      return { armed: true, ready: Promise.resolve().then(() => { order.push("ready"); }), stop: () => { order.push("stop"); } };
    }) as typeof startInstallationTokenRefresh;
    const code = await fieldTrialsCommand(["--source", "core=acme/core", "--out-dir", join(root, "out")], buildFieldTrialsFlowSnapshot,
      { fetch, startTokenRefresh, nowIso: "2026-11-25T16:00:00.000Z", print: () => {}, printError: () => {}, resolveConfig: () => ({ root }) });
    assert.ok(code === 0 || code === 1, `the verb ran to its end (exit ${code})`);
    const reads = order.filter((step) => step.startsWith("read "));
    assert.ok(reads.length > 0, "the pass read GitHub");
    assert.deepEqual(order.filter((step) => !step.startsWith("read ")), ["arm", "ready", "stop"]);
    assert.equal(order.indexOf("ready") < order.indexOf(reads[0]!), true, "the first read waits for the loop's first mint");
    assert.equal(order.lastIndexOf(reads.at(-1)!) < order.indexOf("stop"), true, "the loop stops only after the last read");

    // --offline reads nothing and arms nothing.
    order.length = 0;
    await fieldTrialsCommand(["--source", "core=acme/core", "--out-dir", join(root, "offline"), "--offline"], buildFieldTrialsFlowSnapshot,
      { fetch, startTokenRefresh, nowIso: "2026-11-25T16:00:00.000Z", print: () => {}, printError: () => {}, resolveConfig: () => ({ root }) });
    assert.deepEqual(order, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
