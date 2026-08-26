// test/token-refresh-reason-provenance.test.ts — W1-T2319: ONE FAILURE LABEL COVERED THREE CAUSES.
//
// `refreshInstallationToken`'s catch used to decide its reason from `timeoutController.signal
// .aborted` alone — true for the WHOLE twenty seconds since the timer was armed, whether or not
// the network was ever touched — so a blocked event loop and a genuine network timeout read
// identically as `exchange timed out`. This file proves the replacement: the catch now binds its
// error and decides from IT first, consulting the abort only when the error identifies nothing
// (plan/tasks.d/W1-T2319-…yaml, design i/ii), and it proves the module's own recordability table
// (design v) is bidirectionally true of the source rather than an assertion nobody checks.
//
// Covers plan/tasks.d/W1-T2319-…yaml's nine acceptance criteria, one section per criterion.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mock, test } from "node:test";

import {
  EXCHANGE_TIMEOUT_MS,
  GH_APP_ID_ENV,
  GH_APP_INSTALLATION_ID_ENV,
  GH_APP_PRIVATE_KEY_PATH_ENV,
  TOKEN_REFRESH_FAILED_STEP,
  TOKEN_REFRESH_REASONS,
  refreshInstallationToken,
  startInstallationTokenRefresh,
} from "../src/lib/github-app.js";

function keyPair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

type LogRow = { step: string; extra: Record<string, unknown> };

const STARTING_TOKEN = "OLD-STATIC-TOKEN";

function baseOpts(env: NodeJS.ProcessEnv, privateKey: string, logs: LogRow[]) {
  return {
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env,
    readKey: () => privateKey,
    log: (step: string, extra: Record<string, unknown> = {}) => logs.push({ step, extra }),
  };
}

// ── (1) & (2): THE CATCH ARM BINDS ITS ERROR AND DECIDES FROM IT — IDENTITY FIRST ───────────────
//
// A rejection that is identity-equal to `timeoutController.signal.reason` is OUR OWN abort,
// exactly (design i): a spec-compliant `fetch` rejects with the SAME object passed to
// `AbortController.abort(reason)`, so the fixture below simulates that by rejecting with
// `init.signal.reason` itself once the abort event fires — not a fresh error, the object.

test("W1-T2319 (1)(2): a rejection identity-equal to the controller's own abort reason reads as a timeout", async () => {
  const { privateKey } = keyPair();
  const env: NodeJS.ProcessEnv = { GH_TOKEN: STARTING_TOKEN };
  const logs: LogRow[] = [];

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const identityFetch = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          // THE SAME OBJECT `timeoutController.abort(reason)` set — not a new Error, the exact
          // reference — which is what an identity check, not a shape check, is FOR.
          reject(init.signal!.reason);
        });
      })) as unknown as typeof fetch;

    const promise = refreshInstallationToken({ ...baseOpts(env, privateKey, logs), fetchImpl: identityFetch });
    mock.timers.tick(EXCHANGE_TIMEOUT_MS);
    const result = await promise;

    assert.equal(result.ok, false);
    assert.equal(result.reason, "exchange timed out");
    assert.equal(env.GH_TOKEN, STARTING_TOKEN, "identity-equal abort arm must leave GH_TOKEN untouched");
    const row = logs.find((l) => l.step === TOKEN_REFRESH_FAILED_STEP);
    assert.equal(row?.extra.reason, "exchange timed out");
  } finally {
    mock.timers.reset();
  }
});

// ── (3): A REJECTION CARRYING ITS OWN ERROR CODE NAMES THAT CODE, EVEN ON AN ALREADY-ABORTED
//         SIGNAL ────────────────────────────────────────────────────────────────────────────────

test("W1-T2319 (3): a rejection carrying its own error code reads as a request failure naming that code, even when the signal has already aborted", async () => {
  const { privateKey } = keyPair();
  const env: NodeJS.ProcessEnv = { GH_TOKEN: STARTING_TOKEN };
  const logs: LogRow[] = [];

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const codedFetch = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          // NOT identity-equal to signal.reason — a distinct error that names its own cause, the
          // shape Node's own `fetch` gives a refused connection or a DNS failure.
          reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));
        });
      })) as unknown as typeof fetch;

    const promise = refreshInstallationToken({ ...baseOpts(env, privateKey, logs), fetchImpl: codedFetch });
    mock.timers.tick(EXCHANGE_TIMEOUT_MS); // the signal HAS already aborted by the time this rejects
    const result = await promise;

    assert.equal(result.ok, false);
    assert.equal(result.reason, "exchange request failed: ECONNREFUSED");
    assert.equal(env.GH_TOKEN, STARTING_TOKEN, "own-code request-failed arm must leave GH_TOKEN untouched");
  } finally {
    mock.timers.reset();
  }
});

test("W1-T2319 (3) control: the same own-code rejection is named identically when the signal has NOT aborted", async () => {
  // The signal-not-aborted case is reachable too (design 7: "unreachable in this deployment's
  // observed population, not by construction") — a refused connection rejects in milliseconds,
  // long before the 20s timer fires.
  const { privateKey } = keyPair();
  const env: NodeJS.ProcessEnv = { GH_TOKEN: STARTING_TOKEN };
  const logs: LogRow[] = [];

  const result = await refreshInstallationToken({
    ...baseOpts(env, privateKey, logs),
    fetchImpl: (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "exchange request failed: ECONNREFUSED");
  assert.equal(env.GH_TOKEN, STARTING_TOKEN);
});

// ── (4): AN UNINFORMATIVE ERROR AFTER THE SIGNAL FIRES STILL READS AS A TIMEOUT ─────────────────
//
// The exact seam the existing comment (and test suite) already relied on: a fixture that rejects
// with a bare `Error` once its signal fires, not the identity-equal reason object.

test("W1-T2319 (4): a fixture that rejects with an uninformative error after its signal fires still reads as a timeout", async () => {
  const { privateKey } = keyPair();
  const env: NodeJS.ProcessEnv = { GH_TOKEN: STARTING_TOKEN };
  const logs: LogRow[] = [];

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const bareFetch = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("hung socket abandoned on signal")));
      })) as unknown as typeof fetch;

    const promise = refreshInstallationToken({ ...baseOpts(env, privateKey, logs), fetchImpl: bareFetch });
    mock.timers.tick(EXCHANGE_TIMEOUT_MS);
    const result = await promise;

    assert.equal(result.ok, false);
    assert.equal(result.reason, "exchange timed out");
    assert.equal(env.GH_TOKEN, STARTING_TOKEN, "uninformative-fallback arm must leave GH_TOKEN untouched");
  } finally {
    mock.timers.reset();
  }
});

// ── (5): THE SEVEN REASONS OUTSIDE THE CATCH ARM ARE BYTE-IDENTICAL TO BEFORE ────────────────────

test("W1-T2319 (5a): app not configured — unchanged, and unrecordable (no log call at all)", async () => {
  const env: NodeJS.ProcessEnv = { GH_TOKEN: STARTING_TOKEN };
  const logs: LogRow[] = [];
  const result = await refreshInstallationToken({ env, log: (step) => logs.push({ step, extra: {} }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "app not configured");
  assert.equal(env.GH_TOKEN, STARTING_TOKEN);
  assert.equal(logs.length, 0, "absent config is not an attempt — no ledger noise");
});

test("W1-T2319 (5b): private key unreadable — unchanged", async () => {
  const env: NodeJS.ProcessEnv = { GH_TOKEN: STARTING_TOKEN };
  const logs: LogRow[] = [];
  const result = await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env,
    readKey: () => {
      throw new Error("ENOENT");
    },
    log: (step, extra = {}) => logs.push({ step, extra }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "private key unreadable");
  assert.equal(env.GH_TOKEN, STARTING_TOKEN);
  assert.equal(logs.find((l) => l.step === TOKEN_REFRESH_FAILED_STEP)?.extra.reason, "private key unreadable");
});

test("W1-T2319 (5c): jwt signing failed — unchanged", async () => {
  const env: NodeJS.ProcessEnv = { GH_TOKEN: STARTING_TOKEN };
  const logs: LogRow[] = [];
  const result = await refreshInstallationToken({
    appId: "app-1",
    installationId: "inst-1",
    privateKeyPath: "/fake/key.pem",
    env,
    readKey: () => "not a real private key",
    log: (step, extra = {}) => logs.push({ step, extra }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "jwt signing failed");
  assert.equal(env.GH_TOKEN, STARTING_TOKEN);
  assert.equal(logs.find((l) => l.step === TOKEN_REFRESH_FAILED_STEP)?.extra.reason, "jwt signing failed");
});

test("W1-T2319 (5d): exchange rejected: <status> — unchanged", async () => {
  const { privateKey } = keyPair();
  const env: NodeJS.ProcessEnv = { GH_TOKEN: STARTING_TOKEN };
  const logs: LogRow[] = [];
  const result = await refreshInstallationToken({
    ...baseOpts(env, privateKey, logs),
    fetchImpl: (async () => fakeResponse(403, { message: "forbidden" })) as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "exchange rejected: 403");
  assert.equal(env.GH_TOKEN, STARTING_TOKEN);
});

test("W1-T2319 (5e): exchange response unparsable — unchanged", async () => {
  const { privateKey } = keyPair();
  const env: NodeJS.ProcessEnv = { GH_TOKEN: STARTING_TOKEN };
  const logs: LogRow[] = [];
  const result = await refreshInstallationToken({
    ...baseOpts(env, privateKey, logs),
    fetchImpl: (async () => ({
      ok: true,
      status: 201,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "exchange response unparsable");
  assert.equal(env.GH_TOKEN, STARTING_TOKEN);
});

test("W1-T2319 (5f): exchange response missing token — unchanged", async () => {
  const { privateKey } = keyPair();
  const env: NodeJS.ProcessEnv = { GH_TOKEN: STARTING_TOKEN };
  const logs: LogRow[] = [];
  const result = await refreshInstallationToken({
    ...baseOpts(env, privateKey, logs),
    fetchImpl: (async () => fakeResponse(201, { expires_at: "2026-08-20T13:00:00Z" })) as typeof fetch,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "exchange response missing token");
  assert.equal(env.GH_TOKEN, STARTING_TOKEN);
});

test("W1-T2319 (5g): refresh threw: <message> — unchanged, written by startInstallationTokenRefresh, not refreshInstallationToken", async () => {
  const logged: LogRow[] = [];
  const res = startInstallationTokenRefresh({
    log: (step, extra = {}) => logged.push({ step, extra }),
    env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
    refresh: async () => {
      throw new Error("ledger write failed: ENOSPC");
    },
    setTimer: (_fn) => ({}),
  });
  assert.equal(res.armed, true);
  await new Promise((r) => setImmediate(r));
  const row = logged.find((l) => l.step === TOKEN_REFRESH_FAILED_STEP);
  assert.ok(row, "a rejected refresh must ledger a named reason");
  assert.equal(row!.extra.reason, "refresh threw: ledger write failed: ENOSPC");
});

// ── (6) & (7): THE RECORDABILITY TABLE IS BIDIRECTIONALLY TRUE OF THE SOURCE ─────────────────────
//
// Every reason the source can log is declared recordable, every reason declared unrecordable has
// no logging call site (6), and every prefix-form reason really is a prefix — its exact value is
// NEVER produced bare, so a sweep matching it as a literal is a declared error (7).

test("W1-T2319 (6): the declared vocabulary is exactly the nine reasons the module can produce", () => {
  const declared = Object.keys(TOKEN_REFRESH_REASONS).sort();
  const expected = [
    "app not configured",
    "private key unreadable",
    "jwt signing failed",
    "exchange timed out",
    "exchange request failed: ",
    "exchange rejected: ",
    "exchange response unparsable",
    "exchange response missing token",
    "refresh threw: ",
  ].sort();
  assert.deepEqual(declared, expected);
});

test("W1-T2319 (6): app not configured is declared unrecordable, and no scenario ever logs it", async () => {
  const decl = TOKEN_REFRESH_REASONS["app not configured"];
  assert.equal(decl.recordable, false);
  const logs: LogRow[] = [];
  await refreshInstallationToken({ env: {}, log: (step, extra = {}) => logs.push({ step, extra }) });
  assert.equal(logs.length, 0, "the one unrecordable reason must never reach a log call");
});

test("W1-T2319 (6)(7): every OTHER declared reason is recordable, and each drives to a real log row matching its declared form", async () => {
  const scenarios: Record<string, () => Promise<LogRow[]>> = {
    "private key unreadable": async () => {
      const logs: LogRow[] = [];
      await refreshInstallationToken({
        appId: "app-1",
        installationId: "inst-1",
        privateKeyPath: "/k.pem",
        env: {},
        readKey: () => {
          throw new Error("ENOENT");
        },
        log: (step, extra = {}) => logs.push({ step, extra }),
      });
      return logs;
    },
    "jwt signing failed": async () => {
      const logs: LogRow[] = [];
      await refreshInstallationToken({
        appId: "app-1",
        installationId: "inst-1",
        privateKeyPath: "/k.pem",
        env: {},
        readKey: () => "not a real key",
        log: (step, extra = {}) => logs.push({ step, extra }),
      });
      return logs;
    },
    "exchange timed out": async () => {
      const { privateKey } = keyPair();
      const logs: LogRow[] = [];
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        const bareFetch = (async (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("bare")));
          })) as unknown as typeof fetch;
        const promise = refreshInstallationToken({ ...baseOpts({}, privateKey, logs), fetchImpl: bareFetch });
        mock.timers.tick(EXCHANGE_TIMEOUT_MS);
        await promise;
      } finally {
        mock.timers.reset();
      }
      return logs;
    },
    "exchange request failed: ": async () => {
      const { privateKey } = keyPair();
      const logs: LogRow[] = [];
      await refreshInstallationToken({
        ...baseOpts({}, privateKey, logs),
        fetchImpl: (async () => {
          throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
        }) as unknown as typeof fetch,
      });
      return logs;
    },
    "exchange rejected: ": async () => {
      const { privateKey } = keyPair();
      const logs: LogRow[] = [];
      await refreshInstallationToken({
        ...baseOpts({}, privateKey, logs),
        fetchImpl: (async () => fakeResponse(403, {})) as typeof fetch,
      });
      return logs;
    },
    "exchange response unparsable": async () => {
      const { privateKey } = keyPair();
      const logs: LogRow[] = [];
      await refreshInstallationToken({
        ...baseOpts({}, privateKey, logs),
        fetchImpl: (async () => ({
          ok: true,
          status: 201,
          json: async () => {
            throw new Error("bad json");
          },
        })) as unknown as typeof fetch,
      });
      return logs;
    },
    "exchange response missing token": async () => {
      const { privateKey } = keyPair();
      const logs: LogRow[] = [];
      await refreshInstallationToken({
        ...baseOpts({}, privateKey, logs),
        fetchImpl: (async () => fakeResponse(201, {})) as typeof fetch,
      });
      return logs;
    },
    "refresh threw: ": async () => {
      const logged: LogRow[] = [];
      startInstallationTokenRefresh({
        log: (step, extra = {}) => logged.push({ step, extra }),
        env: { [GH_APP_ID_ENV]: "1", [GH_APP_INSTALLATION_ID_ENV]: "2", [GH_APP_PRIVATE_KEY_PATH_ENV]: "/k.pem" },
        refresh: async () => {
          throw new Error("boom");
        },
        setTimer: () => ({}),
      });
      await new Promise((r) => setImmediate(r));
      return logged;
    },
  };

  for (const [key, decl] of Object.entries(TOKEN_REFRESH_REASONS)) {
    if (key === "app not configured") continue; // covered separately — the one unrecordable member
    assert.equal(decl.recordable, true, `${key} must be declared recordable`);
    const driver = scenarios[key];
    assert.ok(driver, `no driving scenario registered for declared reason ${JSON.stringify(key)}`);
    const logs = await driver();
    const row = logs.find((l) => l.step === TOKEN_REFRESH_FAILED_STEP);
    assert.ok(row, `${key} must actually reach a log(TOKEN_REFRESH_FAILED_STEP, ...) call site`);
    const reason = String(row!.extra.reason);
    if (decl.form === "literal") {
      assert.equal(reason, key, `${key} is declared LITERAL, so the logged reason must match it exactly`);
    } else {
      assert.ok(reason.startsWith(key), `${key} is declared PREFIX, so the logged reason must start with it`);
      assert.notEqual(
        reason,
        key,
        `${key} is a PREFIX form — matching it bare (with nothing after) as a literal would read a false zero`,
      );
    }
  }
});

// ── (8): A FAILED REFRESH LEAVES THE ENVIRONMENT TOKEN EXACTLY AS IT FOUND IT, ON EVERY ARM ──────
//
// Asserted per arm above (tests (1)(2), (3), (3) control, (4), and each of (5a)-(5f)) rather than
// once — a decision that grew branches is exactly where a single end-to-end assertion stops
// covering every one of them. This test is the roll-up: every non-ok result across every arm
// leaves GH_TOKEN untouched, driven from one shared starting value.

test("W1-T2319 (8): every failure arm of the new decision leaves GH_TOKEN exactly as it found it", async () => {
  const { privateKey } = keyPair();

  async function assertUntouched(fetchImpl: typeof fetch, tickTimeout: boolean): Promise<void> {
    const env: NodeJS.ProcessEnv = { GH_TOKEN: STARTING_TOKEN };
    if (tickTimeout) mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const promise = refreshInstallationToken({ ...baseOpts(env, privateKey, []), fetchImpl });
      if (tickTimeout) mock.timers.tick(EXCHANGE_TIMEOUT_MS);
      const result = await promise;
      assert.equal(result.ok, false);
      assert.equal(env.GH_TOKEN, STARTING_TOKEN);
    } finally {
      if (tickTimeout) mock.timers.reset();
    }
  }

  // identity-equal abort arm
  await assertUntouched(
    (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch,
    true,
  );

  // own-error-code arm, signal already aborted
  await assertUntouched(
    (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })));
      })) as unknown as typeof fetch,
    true,
  );

  // own-error-code arm, signal never aborts
  await assertUntouched(
    (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    }) as unknown as typeof fetch,
    false,
  );

  // uninformative-error fallback arm
  await assertUntouched(
    (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("bare")));
      })) as unknown as typeof fetch,
    true,
  );
});

// ── (9): EXCHANGE_TIMEOUT_MS IS UNCHANGED AND THE ABORT IS STILL ARMED BEFORE THE FETCH IS ISSUED ─

test("W1-T2319 (9): EXCHANGE_TIMEOUT_MS stays 20s and the timer is armed before the fetch is issued", async () => {
  assert.equal(EXCHANGE_TIMEOUT_MS, 20 * 1000);

  // Driven behaviourally, not by reading source order: a hung socket that never settles on its
  // own is abandoned only if the abort was armed BEFORE the fetch call had any chance to run —
  // exactly the property W1-T1068 already pins, re-asserted here as this task's own boundary.
  const { privateKey } = keyPair();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let aborted = false;
    const hungFetch = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("hung socket abandoned on signal"));
        });
      })) as unknown as typeof fetch;

    const promise = refreshInstallationToken({ ...baseOpts({}, privateKey, []), fetchImpl: hungFetch });
    mock.timers.tick(EXCHANGE_TIMEOUT_MS);
    const result = await promise;

    assert.equal(aborted, true, "the timer must have been armed before/at fetch issuance to abort a hung socket");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "exchange timed out");
  } finally {
    mock.timers.reset();
  }
});
