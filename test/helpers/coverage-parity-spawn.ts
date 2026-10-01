import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreflightSpawn } from "../../src/lib/commit-message.js";

/** Materialize the artifacts a parity fixture's fake spawn claims its coverage child produced. */
export function coverageParitySpawnResult(
  file: string,
  args: string[],
  opts?: Parameters<PreflightSpawn>[2],
): ReturnType<PreflightSpawn> | undefined {
  if (file !== process.execPath) return undefined;
  if (args.includes("--experimental-test-coverage")) {
    const rawDir = opts?.env?.NODE_V8_COVERAGE;
    if (!rawDir) throw new Error("a fake coverage shard needs NODE_V8_COVERAGE");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "coverage-1-0000000000000-0.json"), "{}\n");
    return { status: 0, stdout: "# tests 1\n# pass 1\n# fail 0\n", stderr: "" };
  }
  if (!args.some((arg) => arg.endsWith("coverage-merge-ratchet.mjs"))) return undefined;
  if (args.includes("--compact-output")) {
    const directory = args[args.indexOf("--compact-output") + 1];
    if (!directory) throw new Error("fake compaction needs an output directory");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "coverage-bundle-1-0000000000000-0.json"), "{}\n");
    return { status: 0, stdout: "rawBytes=10 compactBytes=5 peakBytes=15\n", stderr: "" };
  }
  if (args.includes("--output")) {
    return { status: 0, stdout: "inputBytes=20 stagingBytes=10 peakBytes=30\n", stderr: "" };
  }
  return undefined;
}
