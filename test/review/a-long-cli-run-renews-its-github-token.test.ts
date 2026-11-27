// W1-T15038: a long rmd CLI run renews its GitHub token, and a review post re-mints once on a 401.
import assert from "node:assert/strict";
import { test } from "node:test";
import { armCliTokenRenewal } from "#src/lib/cli-token-renewal.js";
import { startInstallationTokenRefresh } from "#src/lib/github-app.js";
import { postReviewStatus } from "#src/lib/review.js";

const APP_ENV = { GH_APP_ID: "1", GH_APP_INSTALLATION_ID: "2", GH_APP_PRIVATE_KEY_PATH: "/nonexistent/key.pem" };
const okRefresh = (env: NodeJS.ProcessEnv) => async () => { env.GH_TOKEN = "fresh"; return { ok: true as const, expiresAtMs: Date.now() + 3_600_000 }; };

test("W1-T15038 criterion 1 a cli verb arms token renewal", async () => {
  const env: NodeJS.ProcessEnv = { ...APP_ENV };
  const started: unknown[] = [];
  const result = await armCliTokenRenewal({ cmd: "review", env, log: () => {}, refresh: okRefresh(env),
    start: (opts) => { started.push(opts.refresh); return { armed: true, ready: Promise.resolve() }; } });
  assert.equal(result, "armed", "a review run arms the renewal loop");
  assert.equal(started.length, 1, "the shared renewal loop is started once");

  // The real loop with this env: the first mint is awaited, and the run is left with a renewing token.
  const live: NodeJS.ProcessEnv = { ...APP_ENV };
  let mints = 0;
  const real = await armCliTokenRenewal({ cmd: "review", env: live, log: () => {},
    refresh: async () => { mints += 1; live.GH_TOKEN = `t${mints}`; return { ok: true, expiresAtMs: Date.now() + 3_600_000 }; } });
  assert.equal(real, "armed");
  assert.equal(live.GH_TOKEN, "t1", "the first mint completes before the verb runs");
});

test("W1-T15038 criterion 2 a 401 review post re-mints once and retries", async () => {
  const opts = { owner: "o", repo: "r", sha: "abc", state: "success" as const };
  let posts = 0;
  let reauths = 0;
  await postReviewStatus(opts, { sleep: async () => {}, reauth: async () => { reauths += 1; return true; },
    exec: async () => { posts += 1; if (posts === 1) throw new Error("gh: Bad credentials (HTTP 401)"); } });
  assert.equal(reauths, 1, "the expired token is re-minted once");
  assert.equal(posts, 2, "the post is retried with the fresh token");

  let tries = 0;
  let again = 0;
  await assert.rejects(postReviewStatus(opts, { sleep: async () => {}, reauth: async () => { again += 1; return true; },
    exec: async () => { tries += 1; throw new Error("gh: Bad credentials (HTTP 401)"); } }), /Bad credentials/);
  assert.equal(again, 1, "a second 401 does not re-mint again");
  assert.equal(tries, 2, "a 401 after the re-mint is thrown, so the guarded post records it");
});

test("W1-T15038 criterion 3 the renewal never holds a short verb open", async () => {
  for (const cmd of ["daemon", "serve"]) {
    const env: NodeJS.ProcessEnv = { ...APP_ENV };
    let started = 0;
    const result = await armCliTokenRenewal({ cmd, env, log: () => {}, refresh: okRefresh(env),
      start: () => { started += 1; return { armed: true, ready: Promise.resolve() }; } });
    assert.equal(result, "minted-once", `${cmd} keeps its own loop and mints here once`);
    assert.equal(started, 0, `${cmd} never arms the CLI loop`);
  }
  const preset: NodeJS.ProcessEnv = { ...APP_ENV, GH_TOKEN: "given" };
  assert.equal(await armCliTokenRenewal({ cmd: "review", env: preset, log: () => {} }), "skipped", "a preset token is left alone");
  const bare: NodeJS.ProcessEnv = {};
  let mints = 0;
  const result = await armCliTokenRenewal({ cmd: "review", env: bare, log: () => {},
    refresh: async () => { mints += 1; return { ok: false, reason: "not configured" } as never; } });
  assert.equal(result, "minted-once", "with no GH_APP_* names the one-shot mint runs as before");
  assert.equal(mints, 1);

  // A normal short verb such as `review` does arm the production loop. Observe its real timer
  // handle so this proof fails if the loop stops unref'ing the renewal timer.
  const reviewEnv: NodeJS.ProcessEnv = { ...APP_ENV };
  let timerUnrefs = 0;
  const resultForReview = await armCliTokenRenewal({ cmd: "review", env: reviewEnv, log: () => {},
    refresh: okRefresh(reviewEnv),
    start: (opts) => startInstallationTokenRefresh({ ...opts,
      setTimer: () => ({ unref: () => { timerUnrefs += 1; } }) }) });
  assert.equal(resultForReview, "armed", "a short CLI verb uses the production renewal loop");
  assert.equal(reviewEnv.GH_TOKEN, "fresh", "the first mint completes before the short verb runs");
  assert.equal(timerUnrefs, 1, "the production renewal timer cannot keep a short verb open");
});
