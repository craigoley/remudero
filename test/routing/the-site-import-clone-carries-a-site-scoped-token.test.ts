/**
 * W1-T14779: the daily site import cloned the private remudero-site with no credential, so it failed
 * at "could not read Username" and never reached the stage step. The clone now carries a token minted
 * for the site, in the child's env only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appCloneToken, syncFieldNoteSiteImport, type SiteCloneToken } from "#src/lib/field-trials-site-import.js";

const TOKEN = "ghs_siteCloneTokenFixture0123456789";
type Call = { file: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined };

async function cloneOnce(cloneToken: SiteCloneToken | undefined, stderr = "") {
  const workRoot = mkdtempSync(join(tmpdir(), "rmd-site-clone-token-"));
  const calls: Call[] = [];
  try {
    const outcome = await syncFieldNoteSiteImport({ workRoot, nowIso: "2026-11-25T02:00:00.000Z",
      exportCandidate: () => { throw new Error("the clone fails before any export"); } }, {
      spawn: (file, args, opts) => { calls.push({ file, args, env: opts?.env }); return { status: 128, stdout: "", stderr }; },
      ...(cloneToken === undefined ? {} : { cloneToken }),
    });
    return { outcome, calls };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

function configEntries(env: NodeJS.ProcessEnv | undefined): Map<string, string> {
  const entries = new Map<string, string>();
  for (let i = 0; i < Number(env?.GIT_CONFIG_COUNT ?? 0); i++) entries.set(String(env?.[`GIT_CONFIG_KEY_${i}`]), String(env?.[`GIT_CONFIG_VALUE_${i}`]));
  return entries;
}

test("W1-T14779: the site import clone carries a site scoped token in its env only", async () => {
  const asked: string[] = [];
  const { calls } = await cloneOnce(async (repo) => { asked.push(repo); return { ok: true, token: TOKEN }; });
  assert.deepEqual(asked, ["craigoley/remudero-site"]);
  assert.equal(calls.length, 1);
  const [clone] = calls;
  assert.equal(clone!.file, "git");
  assert.ok(clone!.args.every((arg) => !arg.includes(TOKEN)), "the token never enters argv");
  assert.equal(clone!.env?.GIT_TERMINAL_PROMPT, "0");
  const header = configEntries(clone!.env).get("http.https://github.com/.extraheader");
  assert.equal(header, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
});

test("W1-T14779: the site import names a failed clone token mint", async () => {
  const { outcome, calls } = await cloneOnce(async () => ({ ok: false, reason: "app not configured" }));
  assert.deepEqual(outcome, { state: "site-checkout-failed", reason: "site-clone-token-unavailable: app not configured" });
  assert.equal(calls.length, 0, "git is never spawned without a token");
});

test("W1-T14779: the site import outcome never contains the clone token", async () => {
  const { outcome } = await cloneOnce(async () => ({ ok: true, token: TOKEN }), `fatal: unable to access with ${TOKEN}`);
  assert.equal(outcome.state, "site-checkout-failed");
  assert.ok(!JSON.stringify(outcome).includes(TOKEN), JSON.stringify(outcome));
});

test("W1-T14779: the production clone mints through the App identity by default", async () => {
  const saved = { id: process.env.GH_APP_ID, inst: process.env.GH_APP_INSTALLATION_ID, key: process.env.GH_APP_PRIVATE_KEY_PATH };
  delete process.env.GH_APP_ID; delete process.env.GH_APP_INSTALLATION_ID; delete process.env.GH_APP_PRIVATE_KEY_PATH;
  try {
    const { outcome, calls } = await cloneOnce(undefined);
    assert.deepEqual(outcome, { state: "site-checkout-failed", reason: "site-clone-token-unavailable: app not configured" });
    assert.equal(calls.length, 0);
  } finally {
    for (const [name, value] of [["GH_APP_ID", saved.id], ["GH_APP_INSTALLATION_ID", saved.inst], ["GH_APP_PRIVATE_KEY_PATH", saved.key]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("W1-T14779: the App clone token seam reports a minted token, a refusal and a throw", async () => {
  const env = { GH_APP_ID: "1" };
  assert.deepEqual(await appCloneToken(env, async () => ({ ok: true, token: TOKEN }))("craigoley/remudero-site"), { ok: true, token: TOKEN });
  assert.deepEqual(await appCloneToken(env, async () => ({ ok: false, reason: "denied" }))("craigoley/remudero-site"), { ok: false, reason: "denied" });
  assert.deepEqual(await appCloneToken(env, async () => ({ ok: true }))("craigoley/remudero-site"), { ok: false, reason: "no token returned" });
  const thrown = await appCloneToken(env, async () => { throw new Error("network down"); })("craigoley/remudero-site");
  assert.equal(thrown.ok, false);
  assert.match(thrown.ok ? "" : thrown.reason, /network down/);
});
