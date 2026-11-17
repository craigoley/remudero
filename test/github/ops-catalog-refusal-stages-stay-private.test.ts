import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { createGhCallPacer } from "#src/lib/github-transport.js";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { createOpsCatalogShadowSource, defaultOpsCatalogApi, readOpsCatalogSnapshotAsync, type OpsCatalogApi } from "#src/lib/ops-catalog-source.js";

const REPO = "acme-private/ops-secret-slug";
const target = { repository: REPO };
const SENTINELS = ["PRIVATE_TITLE_SENTINEL", "PRIVATE_PATH_SENTINEL", "PRIVATE_BODY_SENTINEL", "private-shard.yaml", REPO, "ops-secret-slug", "ghp_SECRET_TOKEN_SENTINEL", "tasks.d", "plan/tasks"];

function sweep(label: string, value: unknown): void {
  const text = [JSON.stringify(value), inspect(value), inspect(value, { showHidden: true, depth: null })].join("\n");
  for (const s of SENTINELS) assert.equal(text.includes(s), false, `${label} carries ${s}`);
}

test("W13319: stage evidence stays redacted through snapshot and shadow inspection", async () => {
  const secret=new Error(`PRIVATE_BODY_SENTINEL ${REPO} ghp_SECRET_TOKEN_SENTINEL`);
  const api:OpsCatalogApi=async()=>{throw secret;};
  const snap=await readOpsCatalogSnapshotAsync(target,api),shadow=await createOpsCatalogShadowSource(target,api).refresh();
  for(const value of [snap,shadow]){
    assert.equal(value.outcome,"unreadable");assert.equal((value as unknown as {refusalStage?:unknown}).refusalStage,"repository_identity");
    sweep("safe failure stage",value);
    assert.equal(JSON.parse(JSON.stringify(value)).refusalStage,"repository_identity");
  }
});

test("W13319: real failed child output cannot leak through safe stage serialization", async () => {
  await withGhShim([{ when: `repos/${REPO}`, stderr: `HTTP 500 ${REPO} PRIVATE_BODY_SENTINEL ghp_SECRET_TOKEN_SENTINEL`, exit: 1 }], async shim => {
    const api = defaultOpsCatalogApi({ pacer: createGhCallPacer() });
    const result = await readOpsCatalogSnapshotAsync(target, api);
    assert.equal(result.outcome, "unreadable");
    assert.equal((result as unknown as { refusalStage?: unknown }).refusalStage, "repository_identity");
    sweep("cold child refusal", result);
    assert.equal(shim.calls().length, 1, "the actual default child supplied the failure");
    assert.ok(shim.calls().every(call => call.startsWith("api repos/")));
  });
});
