// W1-T14807: a GitHub read's call site names the repository code that made it, never a Node internal frame.
import assert from "node:assert/strict";
import test from "node:test";
import { ghCallSiteFromStack } from "#src/lib/github-transport.js";

const ROOT = "/app";
const TRANSPORT = "/app/src/lib/github-transport.ts";

test("W1-T14807: a GitHub read's call site skips Node internal frames", () => {
  const stack = [
    "Error",
    "    at ghCallSiteOutsideTransport (file:///app/src/lib/github-transport.ts:944:17)",
    "    at ghJson (/app/src/lib/github-transport.ts:1200:5)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
    "    at async Promise.all (index 0)",
    "    at async pullFoldDebtEntries (file:///app/src/lib/fold-debt-pull.ts:126:23)",
  ].join("\n");
  assert.equal(ghCallSiteFromStack(stack, TRANSPORT, ROOT), "src/lib/fold-debt-pull.ts:126");
});

test("W1-T14807: a GitHub read with no repository caller is unknown", () => {
  const stack = [
    "Error",
    "    at ghJson (/app/src/lib/github-transport.ts:1200:5)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:65:5)",
    "    at async run (/app/node_modules/some-lib/index.js:10:3)",
    "    at async elsewhere (/opt/other/tool.js:3:1)",
  ].join("\n");
  assert.equal(ghCallSiteFromStack(stack, TRANSPORT, ROOT), "unknown");
});
