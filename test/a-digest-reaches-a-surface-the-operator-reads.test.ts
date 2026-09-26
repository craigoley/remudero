// test/a-digest-reaches-a-surface-the-operator-reads.test.ts - W1-T3156.
//
// The daily digest already writes state/inbox-digests.json. This suite proves GET /v1/inbox/digests
// reads that exact store, bounded, and degrades to an empty answer with a reason. W1-T4563 retired
// the daemon's own mailbox rendering; app.remudero.com's inbox renders these entries now.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CONSOLE_INBOX_DIGEST_LIMIT, buildInboxDigestsRoute, readConsoleInboxDigests } from "../src/lib/serve.js";
import { inboxDigestsPath } from "../src/lib/digest.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-inbox-digests-"));
}

function writeDigests(root: string, entries: Array<{ ts: string; text: string }>): void {
  const path = inboxDigestsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2));
}

async function routeBody(root: string, limit?: number): Promise<unknown> {
  let body = "";
  let status = 0;
  const route = buildInboxDigestsRoute({ root, limit });
  await route.handler(
    {} as never,
    {
      writeHead(code: number) {
        status = code;
      },
      end(payload: string) {
        body = payload;
      },
    } as never,
    {} as never,
  );
  assert.equal(status, 200);
  return JSON.parse(body) as unknown;
}

test("W1-T3156: the digest reader is bounded and states how many older reports it omitted", async () => {
  const root = tmpRoot();
  const entries = Array.from({ length: CONSOLE_INBOX_DIGEST_LIMIT + 2 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return { ts: `2026-09-${n}T00:00:00.000Z`, text: `daily digest ${n}` };
  });
  writeDigests(root, entries);

  assert.deepEqual(await routeBody(root), {
    entries: entries.slice(2),
    omitted: 2,
  });
});

test("W1-T3156: absent or unparseable digest storage renders no digests and throws nothing", async () => {
  const absentRoot = tmpRoot();
  assert.deepEqual(readConsoleInboxDigests(absentRoot), { entries: [], omitted: 0 });
  assert.deepEqual(await routeBody(absentRoot), { entries: [], omitted: 0 });

  const brokenRoot = tmpRoot();
  mkdirSync(dirname(inboxDigestsPath(brokenRoot)), { recursive: true });
  writeFileSync(inboxDigestsPath(brokenRoot), "{not json");
  const direct = readConsoleInboxDigests(brokenRoot);
  assert.deepEqual({ entries: direct.entries, omitted: direct.omitted }, { entries: [], omitted: 0 });
  assert.match(direct.reason ?? "", /JSON/);
  const routed = (await routeBody(brokenRoot)) as { entries: unknown[]; omitted: number; reason?: string };
  assert.deepEqual({ entries: routed.entries, omitted: routed.omitted }, { entries: [], omitted: 0 });
  assert.match(routed.reason ?? "", /JSON/);
});
