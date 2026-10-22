/** Whole-project native compilation shares the box with its parent and other workers. */
import { availableParallelism } from "node:os";

/** The isolated validation lane already grants two CPUs; project compilers use that same ceiling. */
export const PROJECT_COMPILER_CPUS = 2;

/** Go's documented byte syntax, including its explicit unlimited setting. Invalid values stay errors. */
export function goMemoryBytes(value: string): bigint | null {
  if (value === "off") return null;
  const match = /^(\d+)(B|KiB|MiB|GiB|TiB)?$/.exec(value);
  if (!match) throw new Error("invalid inherited GOMEMLIMIT");
  const scale = { B: 1n, KiB: 1024n, MiB: 1024n ** 2n, GiB: 1024n ** 3n, TiB: 1024n ** 4n };
  const bytes = BigInt(match[1]) * scale[(match[2] ?? "B") as keyof typeof scale];
  if (bytes > 9223372036854775807n) throw new Error("inherited GOMEMLIMIT exceeds Go's byte range");
  return bytes;
}

/** Child-only overlays; no hard memory bound or successful native compile is claimed here.
 * Target three quarters of an actual OS constraint; this does not reserve memory for other processes.
 * Unknown/unconstrained memory is left to the operator/runtime, rather than imposing a CLI limit.
 * Explicitly smaller operator targets are retained. No invalid setting is repaired into success. */
export function compilerEnvironment(
  parent: NodeJS.ProcessEnv = process.env,
  memoryConstraint: number = process.constrainedMemory(),
  parallelism: number = availableParallelism(),
): NodeJS.ProcessEnv {
  if (!Number.isSafeInteger(memoryConstraint) || memoryConstraint < 0 ||
      !Number.isSafeInteger(parallelism) || parallelism < 1) throw new Error("compiler OS resource facts unavailable");
  const env: NodeJS.ProcessEnv = {};
  let cpus = Math.min(PROJECT_COMPILER_CPUS, parallelism);
  const inheritedCpu = parent.GOMAXPROCS;
  if (inheritedCpu !== undefined && inheritedCpu !== "") {
    if (!/^-?\d+$/.test(inheritedCpu) || !Number.isSafeInteger(Number(inheritedCpu)))
      throw new Error("invalid inherited GOMAXPROCS");
    if (Number(inheritedCpu) > 0) cpus = Math.min(cpus, Number(inheritedCpu));
  }
  env.GOMAXPROCS = String(cpus);
  if (memoryConstraint > 0) {
    const target = BigInt(Math.floor(memoryConstraint * 0.75));
    if (target <= 0n) throw new Error("compiler OS memory constraint is too small");
    const inherited = parent.GOMEMLIMIT;
    const bytes = inherited === undefined || inherited === "" ? null : goMemoryBytes(inherited);
    if (bytes === null || bytes > target) env.GOMEMLIMIT = `${target}B`;
  }
  return env;
}
