import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  OPENWEIGHT_PRICES,
  OPENWEIGHT_RESPONSE_FORMATS,
  openWeightUnfence,
  spawnOpenWeightWorker,
} from "../src/lib/worker-provider.js";
import type { Config } from "../src/lib/config-schema.js";

// OPENWEIGHT_OUTPUT_CONTRACT already tells the model to emit a raw document "without Markdown
// fences". That instruction is right, and it is not a guarantee. This adapter has less margin than
// most: it deliberately cannot lean on `response_format` for every deployment (gpt-oss-120b returns
// malformed JSON under json_object), so for those the prompt is the ONLY defence. Ask AND strip.

test("a fenced reply is unwrapped, with or without a language tag", () => {
  assert.equal(openWeightUnfence("```json\n{\"ok\":true}\n```"), '{"ok":true}');
  assert.equal(openWeightUnfence("```\n{\"ok\":true}\n```"), '{"ok":true}');
  assert.equal(openWeightUnfence("```yaml\nid: W1\n```"), "id: W1");
});

test("a reply that is ALREADY raw comes back byte-identical", () => {
  for (const raw of ['{"ok":true}', "id: W1\nname: x", "", "   ", "no fences here at all"]) {
    assert.equal(openWeightUnfence(raw), raw, `must not touch: ${JSON.stringify(raw)}`);
  }
});

test("it removes ONE wrapping fence and does not edit the payload inside", () => {
  // A nested fence is CONTENT of the document, not a second wrapper. Stripping it would corrupt
  // a reply that legitimately contains a code block.
  const inner = "text\n```js\nconst a = 1;\n```\nmore";
  assert.equal(openWeightUnfence("```md\n" + inner + "\n```"), inner);
});

test("a fence that does not wrap the WHOLE reply is left alone", () => {
  // Prose before or after means the fence is part of the answer, not a wrapper around it. A
  // cleverer extractor would start silently editing answers.
  assert.equal(openWeightUnfence("here you go:\n```\n{\"a\":1}\n```"), "here you go:\n```\n{\"a\":1}\n```");
  assert.equal(openWeightUnfence("```\n{\"a\":1}\n```\nhope that helps"), "```\n{\"a\":1}\n```\nhope that helps");
});

// ── and it is actually WIRED, only for a structured request ─────────────────────────────────────

const clock = (ms: number) => ({ now: () => ms, iso: () => new Date(ms).toISOString() });

// gpt-5-nano rather than luna: luna's price/window/temperature rows land in a sibling PR, and an
// unpriced deployment is REFUSED before transport — correctly, but it would make this test assert
// the wrong refusal.
async function replyWith(content: string, responseFormat?: string, model = "gpt-5-nano") {
  const root = mkdtempSync(join(tmpdir(), "rmd-fence-"));
  try {
    return await spawnOpenWeightWorker(
      {
        cwd: root,
        workerHome: join(root, "wh"),
        prompt: "x",
        ...(responseFormat === undefined ? {} : { responseFormat }),
        env: { RMD_OPENWEIGHT_API_KEY: "k" },
        clock: clock(Date.parse("2026-09-16T12:00:00.000Z")),
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ id: "t", usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ message: { content }, finish_reason: "stop" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      } as never,
      { claudeBin: "/u", root, dailyCapUsd: 5, workerProviders: { enabled: ["openweight"], openweightEndpoint: "https://example.test/" } } as Config,
      { model, effort: "low" } as never,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a STRUCTURED request unwraps a fenced reply on the real spawn path", async () => {
  // THE DEPLOYMENT MUST BE BOTH PRICED AND json_object-DECLARING, or this refuses before reaching
  // the unfencing it exists to check. It named gpt-5-mini, which #5791 REMOVED from
  // OPENWEIGHT_PRICES on the same day this suite merged: each PR green alone, main red together.
  // Resolved from the two tables rather than hardcoded, so the next ladder edit cannot silently
  // re-break it — a deployment leaving either table now fails the assert, not the spawn.
  const [deployment] = Object.keys(OPENWEIGHT_RESPONSE_FORMATS).filter((d) => d in OPENWEIGHT_PRICES);
  assert.ok(deployment, "no deployment is both priced and json_object-declaring — this test cannot run");
  const result = await replyWith('```json\n{"ok":true}\n```', "json_object", deployment);
  assert.equal(result.isError, false);
  assert.equal(result.text, '{"ok":true}', "the caller asked for a document and must receive one");
});

test("a PROSE request is left alone — a fenced block may be part of the answer", async () => {
  const fenced = '```json\n{"ok":true}\n```';
  const result = await replyWith(fenced);
  assert.equal(result.isError, false);
  assert.equal(result.text, fenced, "unwrapping a prose reply would corrupt a legitimate code block");
});
