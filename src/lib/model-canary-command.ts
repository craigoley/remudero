/** Offline CLI preparation and projection. Provider execution requires a separately admitted adapter. */
import { mkdirSync, writeFileSync, existsSync, realpathSync, openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canarySuiteDigest, commonCanarySuite, weeklyCanarySuite, MODEL_CANARY_VERSION } from "./model-canary-suite.js";
import { projectCanaryRuns, type CanaryRun } from "./model-canary-metrics.js";
import { renderCanaryReport } from "./model-canary-report.js";
import { retentionCanaryProtocol } from "./model-canary-retention.js";

function boundedInput(input: string): string {
  const limit = 8 * 1024 * 1024;
  const fd = openSync(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("canary-input-regular-file-required");
    if (info.size > limit) throw new Error("canary-input-bound");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw new Error("canary-input-bound");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function privateOutput(dir: string, name: string, data: string) {
  let parent = resolve(dir);
  // Resolve the first existing ancestor too: a new directory below a symlink is not private.
  while (!existsSync(parent)) parent = dirname(parent);
  parent = realpathSync(parent);
  while (true) {
    if (existsSync(join(parent, ".git"))) throw new Error("canary-output-inside-git");
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), data, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export function canaryCommand(argv: readonly string[]) {
  const [command, outDir, input] = argv;
  if (!outDir || !["prepare", "project"].includes(command ?? "")
    || argv.length !== (command === "prepare" ? 2 : 3))
    throw new Error("usage: model-canary-command prepare <private-out-dir> | project <private-out-dir> <run-array.json>");
  if (command === "prepare") {
    const daily = commonCanarySuite(), weekly = weeklyCanarySuite();
    const manifest = { version: MODEL_CANARY_VERSION, state: "prepared-not-activated", dailyCases: daily.length,
      weeklyCases: weekly.length, suiteHash: canarySuiteDigest([...daily, ...weekly]),
      tasks: [...daily, ...weekly].map(({ expected: _heldOut, ...task }) => task),
      limits: { concurrency: 1, maxCallsDailyCase: 3, wallMs: 60_000, maxOutputBytes: 16_384 },
      cash: { globalDailyCapUsd: 25, experimentDailyCapUsd: 0, premiumCashEligible: false },
      requires: ["published-source", "qualified-adapter", "capacity-admission", "shared-owner", "agreed-experiment-budget"],
      retentionProtocols: [25, 50].map(turns => {
        const p = retentionCanaryProtocol(turns as 25 | 50);
        return { turns, suiteHash: p.suiteHash, instruction: p.instruction,
          prompts: p.cases.map(c => ({ id: c.id, prompt: c.prompt })), sampleUnit: "whole-conversation" };
      }),
      deeperWeekly: { patchExecution: "pending-isolated-scorer", retention25And50Turns: "native-protocol-prepared-adapter-pending", cacheProfiles: "pending-real-transport-coverage" } };
    privateOutput(outDir, "model-canary-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    return { state: manifest.state, suiteHash: manifest.suiteHash };
  }
  if (!input) throw new Error("canary-input-bound");
  const value: unknown = JSON.parse(boundedInput(input));
  if (!Array.isArray(value)) throw new Error("canary-run-array-required");
  const runs = value as CanaryRun[], projection = projectCanaryRuns(runs);
  privateOutput(outDir, "model-canary-metrics.json", JSON.stringify(projection, null, 2) + "\n");
  privateOutput(outDir, "model-canary-report.html", renderCanaryReport(runs));
  return { state: "private-projection", runs: projection.uniqueRuns };
}

// diff-cov: process-boundary — standalone CLI stdout flush and exit; the native child control proves this entry.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = canaryCommand(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(0));
}
