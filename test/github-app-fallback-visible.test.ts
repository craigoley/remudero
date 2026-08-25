import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { TOKEN_REFRESHED_STEP, TOKEN_REFRESH_FAILED_STEP, refreshInstallationToken, EXCHANGE_TIMEOUT_MS } from "../src/lib/github-app.js";
import { buildStatusBoard, renderStatusBoardText, type StatusBoardDeps } from "../src/lib/status-board.js";
import type { GitHub } from "../src/lib/status.js";

// THE FALLBACK WAS SILENT. `refreshInstallationToken` leaves `process.env.GH_TOKEN` exactly as it
// found it when the exchange fails, so the fleet keeps running on the personal token's buckets with
// no alarm — measured 114 `token_refresh_failed` rows, every one `exchange timed out`, against 172
// successes, with nothing anywhere reading either. These assert the READER. The exchange itself is
// unchanged: this task does not remove the fallback, only makes a standing one visible.

const NOW_ISO = "2026-08-25T12:00:00.000Z";
const PLAN_YAML = `- id: W1-T1
  title: "t"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  status: queued
  attempts: 0
`;

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "gh-app-fallback-"));
}

function writeLedger(lines: Record<string, unknown>[]): string {
  const p = join(mkdtempSync(join(tmpdir(), "gh-app-fallback-ledger-")), "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

function fakeGithub(): GitHub {
  return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined, readFailed: () => false };
}

function baseDeps(): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => Date.parse(NOW_ISO),
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    plan: loadPlanFromYaml(PLAN_YAML, "fixture"),
    github: fakeGithub(),
    readPushedRunBranches: () => "",
  };
}

const ok = (ts: string) => ({ ts, step: TOKEN_REFRESHED_STEP, installation_id: "155256285" });
const fail = (ts: string, reason: string) => ({ ts, step: TOKEN_REFRESH_FAILED_STEP, reason });
const board = (lines: Record<string, unknown>[]) => buildStatusBoard(tmpRoot(), writeLedger(lines), baseDeps());

test("a failed exchange that is the LAST word stands the fallback up, carrying its reason and the last good refresh", () => {
  const n = board([ok("2026-08-25T10:00:00.000Z"), fail("2026-08-25T10:35:03.722Z", "exchange timed out")]).needsMe;
  assert.equal(n.tokenFallback?.reason, "exchange timed out");
  assert.equal(n.tokenFallback?.ts, "2026-08-25T10:35:03.722Z");
  assert.equal(n.tokenFallback?.lastOkTs, "2026-08-25T10:00:00.000Z");
});

test("a failure FOLLOWED by a success renders nothing — the exchange retries, and a retried one is the system working", () => {
  const n = board([fail("2026-08-25T10:35:03.722Z", "exchange timed out"), ok("2026-08-25T10:40:03.801Z")]).needsMe;
  assert.equal(n.tokenFallback, undefined);
});

test("a failure with no successful refresh ever on record still stands the fallback up", () => {
  const n = board([fail("2026-08-25T10:35:03.722Z", "exchange timed out")]).needsMe;
  assert.equal(n.tokenFallback?.reason, "exchange timed out");
  assert.equal(n.tokenFallback?.lastOkTs, undefined);
});

test("ledger ORDER does not decide it — the newest timestamp does", () => {
  const n = board([fail("2026-08-25T10:35:03.722Z", "exchange timed out"), ok("2026-08-25T09:00:00.000Z")]).needsMe;
  assert.equal(n.tokenFallback?.reason, "exchange timed out");
});

test("a healthy fleet still renders `nothing needs you` and no token row", () => {
  const text = renderStatusBoardText(board([ok("2026-08-25T10:40:03.801Z")]));
  assert.match(text, /nothing needs you/);
  assert.doesNotMatch(text, /token fallback/);
});

test("a standing fallback is rendered, naming the reason and the bucket the calls are billing", () => {
  const text = renderStatusBoardText(board([ok("2026-08-25T10:00:00.000Z"), fail("2026-08-25T10:35:03.722Z", "exchange rejected: 403")]));
  assert.match(text, /token fallback/);
  assert.match(text, /exchange rejected: 403/);
  assert.match(text, /personal token/);
  assert.doesNotMatch(text, /nothing needs you/);
});

// THE INVARIANT THIS TASK MUST NOT BREAK. A daemon that refuses to run on a failed exchange is worse
// than one that runs on the wrong bucket, so the fallback stays: a failed exchange leaves GH_TOKEN
// EXACTLY as it found it. Asserted here rather than left to prose, and driven through the real
// `refreshInstallationToken` with a socket that opens and never settles — the shape
// EXCHANGE_TIMEOUT_MS exists for.
test("a timed-out exchange leaves GH_TOKEN exactly as found — the fallback is not removed", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const env = {
    GH_APP_ID: "123456",
    GH_APP_INSTALLATION_ID: "155256285",
    GH_APP_PRIVATE_KEY_PATH: "/fake/key.pem",
    GH_TOKEN: "PERSONAL-PAT-SENTINEL",
  } as NodeJS.ProcessEnv;
  const rows: Array<Record<string, unknown>> = [];
  const hangingFetch: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      (init as RequestInit | undefined)?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });

  const result = await refreshInstallationToken({
    env,
    fetchImpl: hangingFetch,
    readKey: () => pem,
    log: (step, extra) => rows.push({ step, ...extra }),
  });

  assert.equal(result.ok, false);
  assert.equal((result as { reason?: string }).reason, "exchange timed out");
  assert.equal(rows.at(-1)?.step, TOKEN_REFRESH_FAILED_STEP);
  assert.equal(env.GH_TOKEN, "PERSONAL-PAT-SENTINEL");
  assert.ok(EXCHANGE_TIMEOUT_MS > 0);
});
