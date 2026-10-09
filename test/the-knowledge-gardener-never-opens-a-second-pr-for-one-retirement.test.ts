/**
 * W1-T4927: a gardener pass that finds its own open knowledge-garden PR updates it
 * instead of opening another, and does not retire an entry that PR already retires.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runGardenPass, type GardenWorkspace, type OpenGardenPr } from "../src/lib/knowledge-gardener.js";
import { learningUsagePath } from "../src/lib/knowledge-value.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const entry = (id: string, fact: string) => [`- id: ${id}`, "  subsystem: t", "  lifecycle: active", "  files: [src/x.ts]", "  fact: >-", `    ${fact}`, "  src: t", ""].join("\n");

function corpus(): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4927-`));
  mkdirSync(join(root, "learnings"), { recursive: true });
  writeFileSync(
    join(root, "learnings", "core.yaml"),
    [entry("rarely-used", "The widget cache warms itself on first read."), entry("often-used", "A proof must match one physical line."), entry("also-used", "Gadgets are idempotent by construction.")].join("\n"),
  );
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(learningUsagePath(join(root, "state")), JSON.stringify({ "rarely-used": { offered: 200, used: 1 }, "often-used": { offered: 50, used: 40 }, "also-used": { offered: 40, used: 20 } }));
  for (const c of ["merge", "refresh"]) writeFileSync(join(root, "state", `KNOWLEDGE_OFF-${c}`), "");
  return root;
}

async function run(open: OpenGardenPr | undefined) {
  const root = corpus();
  const opened: string[] = [];
  const updated: Array<{ pr: string; paths: string[] }> = [];
  const result = await runGardenPass({
    stateDir: join(root, "state"),
    repoRoot: root,
    openWorkspace: (): GardenWorkspace => ({
      root,
      refreshAssertions: () => [],
      openGardenPr: () => open,
      updateGardenPr: (pr, o) => (updated.push({ pr: pr.url, paths: o.paths }), pr.url),
      land: () => (opened.push("new"), "https://github.com/acme/remudero/pull/2"),
      dispose: () => {},
    }),
    log: () => {},
    seed: 3,
  });
  return { root, opened, updated, result };
}

test("W1-T4927: a pass with an open gardener PR updates it instead of opening another", async () => {
  const url = "https://github.com/acme/remudero/pull/1";
  const { opened, updated, result } = await run({ url, handled: [] });
  assert.deepEqual(result.plan?.acting, ["retire"]);
  assert.deepEqual(opened, [], "no second PR is opened");
  assert.equal(updated.length, 1);
  assert.equal(updated[0]!.pr, url);
  assert.equal(result.prUrl, url);
  assert.ok(updated[0]!.paths.includes("learnings/core.yaml"));
  const fresh = await run(undefined);
  assert.deepEqual(fresh.opened, ["new"], "with no open PR the pass opens one");
});

test("W1-T4927: an entry already retired in the open PR is not retired again", async () => {
  const { root, opened, updated } = await run({ url: "https://github.com/acme/remudero/pull/1", handled: ["rarely-used"] });
  assert.deepEqual(opened, []);
  assert.deepEqual(updated, [], "nothing left to add, so nothing is pushed");
  assert.doesNotMatch(readFileSync(join(root, "learnings", "core.yaml"), "utf8"), /retire rarely-used/);
});
