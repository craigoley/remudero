import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unwrapLowPriority } from "../../src/lib/test-slot.js";
import type { TestSlotLease } from "../../src/lib/test-slot.js";
import type { PreflightSpawn } from "../../src/lib/commit-message.js";
import type { CoverageResourcePort } from "../../src/lib/ci-parity.js";
import { RMD_TMP_PREFIX } from "../../src/lib/tmp.js";
import { finishJudgedRun } from "./judged-pool-run.js";

export interface CoverageResourceFixture {
  root: string;
  scratchDir: string;
  lcovPath: string;
  events: string[];
  resources: CoverageResourcePort;
  cleanup(): void;
}

/** Real owned directories for fake children; neither host capacity nor a real slot is certified. */
export function coverageResourceFixture(): CoverageResourceFixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}parity-argv-`));
  const scratchDir = join(root, "scratch"), lcovPath = join(root, "artifacts", "lcov.info");
  const events: string[] = [];
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  const resources: CoverageResourcePort = (repoRoot) => {
    events.push(`acquire:${repoRoot}`);
    mkdirSync(scratchDir, { recursive: true });
    mkdirSync(join(root, "artifacts"), { recursive: true });
    const slot: TestSlotLease = { outcome: "acquired", executionAllowed: true, concurrency: 1, waitedMs: 0,
      note: "fake child slot; NOT measured host capacity",
      refresh: () => { events.push("refresh"); }, release: () => { events.push("slot-release"); } };
    return { ok: true, lease: {
      scratchDir, lcovPath, slot, note: "explicit argv fixture resources; NOT real coverage admission",
      release: () => { events.push("release"); slot.release(); cleanup(); },
    } };
  };
  return { root, scratchDir, lcovPath, events, resources, cleanup };
}

/** Materialize the artifacts a parity fixture's fake spawn claims its coverage child produced. */
export function coverageParitySpawnResult(
  file: string,
  args: string[],
  opts?: Parameters<PreflightSpawn>[2],
): ReturnType<PreflightSpawn> | undefined {
  // A coverage shard starts under nice/ionice (test-slot.ts); the node argv inside is what CI runs.
  ({ file, args } = unwrapLowPriority(file, args));
  if (file !== process.execPath) return undefined;
  if (args.includes("--experimental-test-coverage")) {
    const rawDir = opts?.env?.NODE_V8_COVERAGE;
    if (!rawDir) throw new Error("a fake coverage shard needs NODE_V8_COVERAGE");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "coverage-1-0000000000000-0.json"), "{}\n");
    // The shard is judged by its summary (scripts/pure-test-pool.mjs): a finished fake leaves one.
    finishJudgedRun(args, opts);
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
