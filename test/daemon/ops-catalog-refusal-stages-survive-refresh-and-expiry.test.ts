import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { opsCatalogShadowFeed, OPS_DISPATCH_SOURCE_MAX_AGE_MS } from "#src/cli/commands/daemon.js";
import { clockFromMillisFn } from "#src/lib/clock.js";
import type { OpsCatalogShadowInput } from "#src/lib/ops-catalog-source.js";

test("W13319: timed feed retains safe failure evidence without extending healthy snapshot age", async () => {
  let ms=1000,throwing=false;
  let next={outcome:"malformed",refusalStage:"strict_parse"} as OpsCatalogShadowInput;
  const feed=opsCatalogShadowFeed({refresh:async()=>{if(throwing)throw new Error("PRIVATE_BODY_SENTINEL");return next;}},clockFromMillisFn(()=>ms));
  const read=async()=>{feed.current();await delay(0);return feed.forDispatch();};
  try{
    const failure=await read();assert.equal(failure?.outcome,"malformed");assert.equal((failure as unknown as {refusalStage?:unknown}).refusalStage,"strict_parse");
    next={outcome:"ok"};const healthy=await read();assert.equal(healthy?.outcome,"ok");assert.equal((healthy as unknown as {refusalStage?:unknown}).refusalStage,undefined);
    // W1-T14564 (operator ruling 2026-11-23): with a good snapshot, an expired or failed refresh serves it, naming the
    // refusal and the snapshot's age; the stage survives on lastGood, and nothing private reaches it.
    ms+=OPS_DISPATCH_SOURCE_MAX_AGE_MS;const expired=feed.forDispatch();assert.equal(expired?.outcome,"ok");
    assert.deepEqual(expired?.lastGood,{refusal:"stale",refusalStage:"snapshot_age",snapshotAgeMs:OPS_DISPATCH_SOURCE_MAX_AGE_MS});
    throwing=true;const rejected=await read();assert.equal(rejected?.outcome,"ok");
    assert.deepEqual(rejected?.lastGood,{refusal:"unreadable",refusalStage:"source_refresh",snapshotAgeMs:OPS_DISPATCH_SOURCE_MAX_AGE_MS});assert.doesNotMatch(JSON.stringify(rejected),/PRIVATE_BODY_SENTINEL/);
  }finally{feed.stop();}
});
