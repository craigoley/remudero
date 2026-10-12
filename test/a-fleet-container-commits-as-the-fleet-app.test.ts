// 2026-10-08/09: every fleet commit in remudero-site and remudero-console was authored
// remudero-worker@users.noreply.github.com, which maps to no GitHub account, so Vercel blocked every
// preview ("Deployment was blocked") on site #189 and console #2030/#2032. The containers had no
// RMD_GIT_AUTHOR_* (nothing durable supplies them; a recycle only carries what the old container had),
// so deploy/entrypoint.sh fell back to the unmappable identity. Under App auth it now falls back to the
// fleet App's bot identity, the one Vercel and GitHub recognise (as src/lib/feedback-landing.ts uses).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const ENTRYPOINT = join(process.cwd(), "deploy", "entrypoint.sh");

function identity(extra: Record<string, string>): { name: string; email: string } {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}entry-identity-`));
  try {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, RMD_SKIP_BOOTSTRAP: "1", GIT_CONFIG_NOSYSTEM: "1", ...extra };
    const run = spawnSync("bash", [ENTRYPOINT, "true"], { encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);
    const get = (key: string) => spawnSync("git", ["-C", "/", "config", "--global", "--get", key], { encoding: "utf8", env }).stdout.trim();
    return { name: get("user.name"), email: get("user.email") };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("a fleet container under App auth commits as the fleet App's bot, never the unmappable remudero-worker", () => {
  assert.deepEqual(identity({ GH_APP_ID: "123" }),
    { name: "remudero-fleet[bot]", email: "318611788+remudero-fleet[bot]@users.noreply.github.com" });
  assert.deepEqual(identity({ GH_APP_ID: "123", RMD_GIT_AUTHOR_NAME: "Op", RMD_GIT_AUTHOR_EMAIL: "op@example.com" }),
    { name: "Op", email: "op@example.com" }, "an explicit override still wins");
  assert.deepEqual(identity({}), { name: "remudero-worker", email: "remudero-worker@users.noreply.github.com" },
    "a container with no App auth keeps the old fallback");
});
