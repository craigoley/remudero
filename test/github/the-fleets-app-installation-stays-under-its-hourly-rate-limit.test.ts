import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { startDaemonInstallationBudget } from "#src/cli/commands/daemon.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import { GITHUB_WRITE_RESERVE_FRACTION } from "#src/lib/github-installation-budget.js";
import {
  configureGithubInstallationBudget, createGhCallPacer, ghJson, githubInstallationBudget, GhPaceFloorStandDownError, paceGhEntry,
} from "#src/lib/github-transport.js";

const INSTALLATION = "155256285";
const START_MS = 1_794_600_000_000;
const RESET_S = START_MS / 1000 + 3600;

/** The host registry's shape: three instances on one installation, one on another, one retired. */
const HOST_REGISTRY = [
  "instances:",
  "  core:", "    repo: remudero", "    github_repo: craigoley/remudero", `    gh_app_installation_id: "${INSTALLATION}"`,
  "  site:", "    repo: remudero-site", "    github_repo: craigoley/remudero-site", `    gh_app_installation_id: "${INSTALLATION}"`,
  "  console:", "    repo: remudero-console", "    github_repo: craigoley/remudero-console", `    gh_app_installation_id: "${INSTALLATION}"`,
  "  other:", "    repo: other", "    github_repo: someone/other", '    gh_app_installation_id: "999"',
  "  old:", "    repo: old", "    github_repo: craigoley/old", "    retired: true", `    gh_app_installation_id: "${INSTALLATION}"`,
  "",
].join("\n");

interface Harness {
  rows: Array<{ step: string; extra?: Record<string, unknown> }>;
  setNow(ms: number): void;
  slept: number[];
  pacer: ReturnType<typeof createGhCallPacer>;
  /** One GitHub response through the real transport parser, with these rate-limit headers. */
  read(remaining: number | undefined, limit?: number, reset?: number): void;
  write(): boolean;
}

function harness(registry: (() => { text: string; source: string } | undefined) = () => ({ text: HOST_REGISTRY, source: "host" }),
  env: NodeJS.ProcessEnv = { GH_APP_INSTALLATION_ID: INSTALLATION, RMD_INSTANCE_NAME: "core" }): Harness {
  let now = START_MS;
  const clock = clockFromMillisFn(() => now);
  const rows: Harness["rows"] = [];
  startDaemonInstallationBudget(registry, env, (step, extra) => rows.push({ step, extra }), clock);
  const slept: number[] = [];
  const pacer = createGhCallPacer({
    minGapMs: 0, rateLimitGapMs: 0, now: () => now, sleepSync: () => {}, sleep: async (ms) => { slept.push(ms); },
  });
  return {
    rows,
    slept,
    pacer,
    setNow: (ms) => { now = ms; },
    read(remaining, limit = 100, reset = RESET_S) {
      const headers = remaining === undefined ? "HTTP/2.0 200 OK" : [
        "HTTP/2.0 200 OK", `X-Ratelimit-Remaining: ${remaining}`, `X-Ratelimit-Limit: ${limit}`,
        `X-Ratelimit-Reset: ${reset}`, "X-Ratelimit-Resource: core",
      ].join("\r\n");
      ghJson(["api", "repos/craigoley/remudero/pulls"], undefined, () => `${headers}\r\n\r\n[]`);
    },
    write() {
      let ran = false;
      ghJson(["api", "-X", "POST", "repos/craigoley/remudero/issues/1/comments", "-f", "body=x"], undefined, () => {
        ran = true;
        return "HTTP/2.0 201 Created\r\n\r\n{}";
      });
      return ran;
    },
  };
}

/** Reads until the pacer stands down; the count of reads that went ahead. */
function readsUntilStandDown(h: Harness, max = 200): number {
  for (let n = 0; n < max; n++) {
    try {
      h.pacer.wait();
    } catch (err) {
      assert.ok(err instanceof GhPaceFloorStandDownError, String(err));
      return n;
    }
  }
  return max;
}

afterEach(() => configureGithubInstallationBudget(undefined));

test("W1-T12553 criterion 1: the allowance is the remaining count less the write reserve, shared by the instances and hand runs", () => {
  const h = harness();
  const configured = h.rows.find((row) => row.step === "github.budget.configured");
  // core, site and console share the installation; "other" is on another one and "old" is retired.
  assert.equal(configured?.extra?.consumers, 4);
  assert.equal(configured?.extra?.outcome, "configured");
  assert.equal(githubInstallationBudget().allowance(), undefined, "no reading yet: no allowance limit");
  h.read(50);
  // floor((50 - 10% of 100) / 4) = 10.
  assert.equal(GITHUB_WRITE_RESERVE_FRACTION, 0.1);
  assert.equal(githubInstallationBudget().allowance(), 10);
  h.read(90, 100);
  assert.equal(githubInstallationBudget().allowance(), 20, "each response's headers give a new reading");
});

test("W1-T12553 criterion 2: an instance that spent its share waits for the reset, and a larger reading gives a new allowance", async () => {
  const h = harness();
  h.read(50);
  // One instance never spends the installation: 10 reads of the 40 above the reserve, then it stands down.
  assert.equal(readsUntilStandDown(h), 10);
  assert.throws(() => h.pacer.wait(), GhPaceFloorStandDownError, "the synchronous path keeps refusing until the reset");

  await h.pacer.waitAsync!();
  assert.deepEqual(h.slept, [RESET_S * 1000 - START_MS], "the async path awaits a timer to the reset");

  h.read(90);
  assert.equal(readsUntilStandDown(h), 20, "a newer reading with a larger remaining count gives a new allowance");

  h.setNow(RESET_S * 1000 + 1);
  assert.equal(readsUntilStandDown(h), 200, "after the reset the old reading limits nothing");
});

test("W1-T12553 criterion 3: reads stop in the write reserve, and a write never waits on the budget", () => {
  const h = harness();
  h.read(10);
  assert.equal(readsUntilStandDown(h), 0, "remaining 10 of 100 is the reserve: no read goes");
  assert.equal(h.write(), true, "a comment write goes while reads are held back");
  assert.equal(h.write(), true);
  h.read(11);
  assert.equal(readsUntilStandDown(h), 0, "one above the reserve shares to zero reads");
  const throttled = h.rows.filter((row) => row.step === "github.budget.throttled");
  assert.deepEqual(throttled.map((row) => row.extra?.reason), ["reserve"], "one row for the window");
});

test("W1-T12553 criterion 4: one throttle row per consumer and reset window, and a GitHub refusal writes one too", () => {
  const h = harness();
  h.read(50);
  readsUntilStandDown(h);
  assert.throws(() => h.pacer.wait(), GhPaceFloorStandDownError);
  assert.throws(() => h.pacer.wait(), GhPaceFloorStandDownError);
  const throttled = h.rows.filter((row) => row.step === "github.budget.throttled");
  assert.equal(throttled.length, 1, "three refusals in one window write one row");
  assert.deepEqual(throttled[0].extra, {
    instance: "core", reason: "share", remaining: 50, limit: 100, reset: "2026-11-13T21:00:00.000Z", allowance: 10, consumers: 4,
  });

  const fresh = harness();
  const limited = new Error("API rate limit exceeded for installation ID 155256285");
  for (let n = 0; n < 2; n++) {
    assert.throws(() => paceGhEntry(fresh.pacer, () => true, () => { throw limited; }, { maxAttempts: 1 }), /rate limit exceeded/);
  }
  const refused = fresh.rows.filter((row) => row.step === "github.budget.throttled");
  assert.deepEqual(refused.map((row) => row.extra), [{ instance: "core", reason: "refused", consumers: 4 }],
    "two refusals in one window write one row");
});

test("W1-T12553 criterion 5: with no reading, no headers or no registry the pacer behaves as before; the daemon start sets the budget", () => {
  const noReading = harness();
  assert.equal(readsUntilStandDown(noReading), 200, "no reading yet: no allowance limit");
  noReading.read(undefined);
  assert.equal(readsUntilStandDown(noReading), 200, "no rate-limit headers: no allowance limit");

  const unreadable = harness(() => { throw new Error("EACCES: permission denied"); });
  assert.deepEqual(unreadable.rows.find((row) => row.step === "github.budget.configured")?.extra,
    { outcome: "unconfigured", instance: "core", reason: "registry_unreadable", installation_id: INSTALLATION, error: "EACCES: permission denied" });
  unreadable.read(50);
  assert.equal(readsUntilStandDown(unreadable), 200, "an unreadable registry sets no budget");

  const missing = harness(() => undefined);
  assert.equal(missing.rows.find((row) => row.step === "github.budget.configured")?.extra?.reason, "registry_unreadable");
  const noInstallation = harness(undefined, { RMD_INSTANCE_NAME: "core" });
  assert.equal(noInstallation.rows.find((row) => row.step === "github.budget.configured")?.extra?.reason, "no_installation_id");
  const elsewhere = harness(undefined, { GH_APP_INSTALLATION_ID: "123", RMD_INSTANCE_NAME: "core" });
  assert.equal(elsewhere.rows.find((row) => row.step === "github.budget.configured")?.extra?.reason, "no_instance_on_installation");

  // A checkout registry that names no installation: each live row runs on the host's default one.
  const checkout = harness(() => ({
    text: HOST_REGISTRY.replace(/^ {4}gh_app_installation_id: .*\n/gm, ""), source: "checkout",
  }));
  assert.equal(checkout.rows.find((row) => row.step === "github.budget.configured")?.extra?.consumers, 5);

  // The daemon start sets the budget; a pacer made anywhere in the process reads it.
  harness();
  const elsewherePacer = createGhCallPacer({ minGapMs: 0, sleepSync: () => {} });
  ghJson(["api", "rate_limit"], undefined, () =>
    `HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 14\r\nX-Ratelimit-Limit: 100\r\nX-Ratelimit-Reset: ${RESET_S}\r\nX-Ratelimit-Resource: core\r\n\r\n{}`);
  elsewherePacer.wait();
  assert.throws(() => elsewherePacer.wait(), GhPaceFloorStandDownError, "floor((14 - 10) / 4) = 1 read");
});
