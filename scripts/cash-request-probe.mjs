#!/usr/bin/env node
// W1-T12413: send ONE budgeted cash request and print what happened as one JSON line.
//
// The operator runs it inside the daemon container, where the cash keys are, for example to see
// whether a deployment serves a path (`openai/v1/decisions`) after a deployment changes:
//
//   node --import tsx scripts/cash-request-probe.mjs --deployment <name> --path <path> \
//     --body-file <file.json> --output-tokens <n>
//
// The request reserves against the normal daily cash cap before it is sent and settles from the
// usage in the reply. The line names the status, the reason, the latency, the served model and the
// dollars, and the reply. It never names the key or the request body.
import { readFileSync } from "node:fs";

import { isMainModule } from "./lib/argv.mjs";
import { loadConfig } from "../src/lib/config.ts";
import { sendCashRequest } from "../src/lib/worker-provider.ts";

const USAGE = "usage: cash-request-probe --deployment <name> --path <path> --body-file <file> --output-tokens <n>";

/** Parse the four required flags. Returns `{ error }` for a missing or malformed one. */
function parseCashProbeArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!["--deployment", "--path", "--body-file", "--output-tokens"].includes(name) || argv[i + 1] === undefined) {
      return { error: `${USAGE} (bad argument ${JSON.stringify(name)})` };
    }
    flags[name.slice(2)] = argv[i + 1];
  }
  for (const name of ["deployment", "path", "body-file", "output-tokens"]) {
    if (!flags[name]) return { error: `${USAGE} (missing --${name})` };
  }
  const outputTokens = Number(flags["output-tokens"]);
  if (!Number.isInteger(outputTokens) || outputTokens < 0) return { error: `${USAGE} (--output-tokens must be a whole number)` };
  return { deployment: flags.deployment, path: flags.path, bodyFile: flags["body-file"], outputTokens };
}

/** One probe against the real config, environment, fetch and stdout. Returns the exit code. */
async function runCashRequestProbe(argv) {
  const write = (line) => process.stdout.write(`${line}\n`);
  const parsed = parseCashProbeArgs(argv);
  if (parsed.error) {
    write(JSON.stringify({ ok: false, reason: "usage", detail: parsed.error }));
    return 2;
  }
  const outcome = await sendCashRequest(loadConfig(), {
    deployment: parsed.deployment, path: parsed.path, body: readFileSync(parsed.bodyFile, "utf8"),
    source: "cash-request-probe", outputTokenCeiling: parsed.outputTokens,
  });
  const { envelope, ...summary } = outcome;
  write(JSON.stringify({ deployment: parsed.deployment, path: parsed.path, ...summary,
    ...(outcome.ok ? { reply: envelope } : {}) }));
  return outcome.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) process.exitCode = await runCashRequestProbe(process.argv.slice(2));
