import { createRequire } from "node:module";
import { join } from "node:path";

export interface TestTierManifest {
  thresholdMs?: number;
  files?: Record<string, number>;
}
interface NativeTimeoutPolicy {
  loadManifest(path: string): TestTierManifest;
  derivedNodeTestTimeoutMs(files: readonly string[], manifest?: TestTierManifest | null, root?: string): number;
  boundedNodeTestArgs(args: readonly string[], root?: string, manifest?: TestTierManifest, files?: readonly string[]): string[];
}

// Like review.ts's proof judge, load only when a Node proof runs. A src-only sandbox can import us.
function nativeTimeoutPolicy(): NativeTimeoutPolicy {
  return createRequire(import.meta.url)("../../scripts/test-tier-manifest.mjs") as NativeTimeoutPolicy;
}

export function derivedNodeTestTimeoutMs(files: readonly string[], manifest: TestTierManifest | null | undefined): number {
  return nativeTimeoutPolicy().derivedNodeTestTimeoutMs(files, manifest);
}

/** Missing metadata uses the established floor; corrupt or unreadable metadata remains an error. */
export function readTestTierManifest(root: string): TestTierManifest {
  return nativeTimeoutPolicy().loadManifest(join(root, "scripts/test-tier-manifest.json"));
}

const stdoutDrainSetup = 'if (process.env.NODE_TEST_CONTEXT === "child-v8") process.stdout._handle?.setBlocking?.(true);';
const stdoutDrainImport = `--import=data:text/javascript,${encodeURIComponent(stdoutDrainSetup)}`;
function afterReporter(args: readonly string[], testAt: number): number {
  const at = testAt + 1;
  if (args[at] === "--test-reporter") return at + 2;
  return args[at]?.startsWith("--test-reporter=") ? at + 1 : at;
}

/** Bound real targets once, retain explicit positive policy, and let finished summaries drain and exit. */
export function boundedNodeTestArgs(args: readonly string[], files: readonly string[],
  manifest: TestTierManifest | null | undefined, root = "."): string[] {
  const testAt = args.indexOf("--test");
  if (testAt < 0) return [...args];
  const policy = nativeTimeoutPolicy();
  const timed = policy.boundedNodeTestArgs(args, root, manifest ?? {}, files);
  const additions = [
    ...(!timed.includes("--test-force-exit") ? ["--test-force-exit"] : []),
    ...(!timed.includes(stdoutDrainImport) ? [stdoutDrainImport] : []),
  ];
  const insertion = afterReporter(timed, timed.indexOf("--test"));
  return [...timed.slice(0, insertion), ...additions, ...timed.slice(insertion)];
}

export function authorTestRunnerArgs(args: readonly string[], files: readonly string[],
  manifest: TestTierManifest | null | undefined): string[] {
  return boundedNodeTestArgs(args, files, manifest);
}

export function proofTestRunnerArgs(args: readonly string[], cwd: string, files: readonly string[]): string[] {
  if (!args.includes("--test")) return [...args];
  return boundedNodeTestArgs(args, files, readTestTierManifest(cwd), cwd);
}
