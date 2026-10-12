import test from "node:test";
import assert from "node:assert/strict";
import { startReadPlane } from "../src/lib/read-plane.js";

// 2026-10-04: the read-plane worker kept the GH_TOKEN it was spawned with, so an hour after a daemon
// boot every worker GitHub read failed with 401 (read_plane.open_failed / board_gateway.fetch_failed
// "auth" from 20:10:41Z, the 19:09:30Z boot token's expiry) and sweeps stopped, although the parent had
// already refreshed its own token at 19:49Z.
test("a read-plane worker reads the parent's refreshed GH_TOKEN, not the one it was spawned with", async () => {
  const entry = new URL("../src/lib/read-plane.worker.ts", import.meta.url).href;
  const source = `const { runReadPlaneWorker } = await import(${JSON.stringify(entry)});
    runReadPlaneWorker(() => ({ token: process.env.GH_TOKEN ?? null })); // .ts`;
  const saved = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "token-minted-at-boot";
  const plane = startReadPlane({ workerUrl: new URL(`data:text/javascript,${encodeURIComponent(source)}`),
    workerInput: {}, inline: (): { token: string | null } => { throw new Error("unexpected fallback"); }, log: () => {} });
  try {
    const first = await plane.read({});
    assert.equal(first.source, "worker");
    assert.equal(first.facts.token, "token-minted-at-boot");
    process.env.GH_TOKEN = "token-refreshed-an-hour-later";
    const second = await plane.read({});
    assert.equal(second.source, "worker");
    assert.equal(second.facts.token, "token-refreshed-an-hour-later");
  } finally {
    await plane.stop();
    if (saved === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = saved;
  }
});
