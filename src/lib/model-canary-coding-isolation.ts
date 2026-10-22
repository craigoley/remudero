import { isAbsolute, join, normalize } from "node:path";

/** PRIMARY CONTROL — hard per-attempt ceilings in the intended isolated runtime and CLI.
 * Admission must qualify their real enforcement; settings and fixtures alone never do so. */
export const CODING_ISOLATION_LIMITS = Object.freeze({ cpus: 1, memoryBytes: 256 * 1024 ** 2,
  pids: 32, wallMs: 5_000, outputBytes: 65_536, tmpBytes: 8 * 1024 ** 2 });

/** Preparation only. A plan or fabricated inspect fixture never qualifies arbitrary execution.
 * The real executor must prove the runsc runtime, actual settings and containment controls on
 * admitted Linux before this plan can consume any model submission. No Docker/default-Node fallback.
 */
export function codingIsolationPlan(image: string, directory: string, nonce: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new TypeError("immutable cached image identity required");
  if (!isAbsolute(directory) || normalize(directory) !== directory || directory.includes(",") || directory.includes("\0")
      || !/^rmd-coding-isolated-[a-f0-9]{32}$/.test(directory.split("/").at(-1)!))
    throw new TypeError("owned private coding scratch directory required");
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new TypeError("fresh coding invocation nonce required");
  const name = `rmd-author-canary-coding-${nonce}`;
  const solution = join(directory, "solution.mjs"), harness = join(directory, "harness.mjs");
  const create = ["create", "--pull=never", "--name", name, "--runtime=runsc", "--network=none",
    "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges=true",
    "--cpus=1", "--memory=256m", "--memory-swap=256m", "--pids-limit=32", "--ulimit=nofile=64:64",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=8m,mode=1777", "--ipc=none",
    "--mount", `type=bind,src=${solution},dst=/input/solution.mjs,readonly`,
    "--mount", `type=bind,src=${harness},dst=/input/harness.mjs,readonly`,
    "--entrypoint=node", image, "--max-old-space-size=64", "/input/harness.mjs"];
  return { name, image, nonce, directory, solution, harness, create,
    limits: CODING_ISOLATION_LIMITS, executorQualified: false as const,
    requiredBeforeExecution: ["actual-linux-admission", "actual-runsc-runtime-and-container-inspection",
      "native-network-filesystem-process-resource-and-grader-escape-controls", "exclusive-durable-trial-owner"] };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Refuse a contradictory actual Docker inspection. This validates settings, not isolation efficacy. */
export function codingIsolationInspectionMatches(plan: ReturnType<typeof codingIsolationPlan>, value: unknown): boolean {
  const row = object(value), config = object(row?.Config), host = object(row?.HostConfig);
  if (!row || !config || !host || row.Image !== plan.image || row.Name !== `/${plan.name}`) return false;
  if (host.Runtime !== "runsc" || host.NetworkMode !== "none" || host.ReadonlyRootfs !== true
      || host.Privileged !== false || host.NanoCpus !== 1_000_000_000 || host.Memory !== plan.limits.memoryBytes
      || host.MemorySwap !== plan.limits.memoryBytes || host.PidsLimit !== plan.limits.pids || host.IpcMode !== "none"
      || (host.PidMode !== "" && host.PidMode !== undefined)) return false;
  if (config.User !== "65534:65534" || JSON.stringify(config.Entrypoint) !== '["node"]'
      || JSON.stringify(config.Cmd) !== '["--max-old-space-size=64","/input/harness.mjs"]') return false;
  if (JSON.stringify(host.CapDrop) !== '["ALL"]' || (Array.isArray(host.CapAdd) && host.CapAdd.length > 0)
      || JSON.stringify(host.SecurityOpt) !== '["no-new-privileges=true"]') return false;
  if (!Array.isArray(config.Env) || config.Env.some(v => typeof v !== "string" || !/^(PATH|NODE_VERSION|YARN_VERSION)=/.test(v))) return false;
  if (!Array.isArray(row.Mounts) || row.Mounts.length !== 2) return false;
  const expected = new Map([["/input/solution.mjs", plan.solution], ["/input/harness.mjs", plan.harness]]);
  for (const value of row.Mounts) {
    const mount = object(value);
    if (!mount || mount.Type !== "bind" || mount.RW !== false || expected.get(String(mount.Destination)) !== mount.Source) return false;
    expected.delete(String(mount.Destination));
  }
  const tmpfs = object(host.Tmpfs);
  if (!tmpfs || JSON.stringify(tmpfs) !== '{"/tmp":"rw,noexec,nosuid,nodev,size=8m,mode=1777"}'
      || (Array.isArray(host.Devices) && host.Devices.length > 0)
      || (Array.isArray(host.DeviceRequests) && host.DeviceRequests.length > 0)) return false;
  const ulimits = host.Ulimits;
  return expected.size === 0 && Array.isArray(ulimits) && ulimits.length === 1
    && JSON.stringify(ulimits[0]) === '{"Name":"nofile","Hard":64,"Soft":64}';
}

/** Host-side grading never accepts a TAP/pass claim printed by model code. These are untrusted
 * behavior samples only: the host owns expected values, ids and invocation nonce. No container
 * output establishes that hidden tests ran, resource bounds held, or an executor was qualified.
 */
export function gradeCodingSandboxValues(nonce: string, expected: ReadonlyMap<string, unknown>, raw: string) {
  const unavailable = { state: "unavailable" as const, passed: null, reason: "coding-sandbox-result-unverifiable" };
  if (!/^[a-f0-9]{32}$/.test(nonce) || expected.size === 0 || expected.size > 32
      || Buffer.byteLength(raw) > CODING_ISOLATION_LIMITS.outputBytes) return unavailable;
  let result: unknown;
  try { result = JSON.parse(raw); } catch { return unavailable; }
  const envelope = object(result);
  if (!envelope || envelope.nonce !== nonce || envelope.protocol !== "coding-values-v1"
      || Object.keys(envelope).sort().join(",") !== "nonce,protocol,results" || !Array.isArray(envelope.results)
      || envelope.results.length !== expected.size) return unavailable;
  const observed = new Map<string, unknown>();
  for (const value of envelope.results) {
    const row = object(value);
    if (!row || typeof row.id !== "string" || !expected.has(row.id) || observed.has(row.id)
        || Object.keys(row).sort().join(",") !== "id,value") return unavailable;
    observed.set(row.id, row.value);
  }
  const passed = [...expected].every(([id, value]) => JSON.stringify(observed.get(id)) === JSON.stringify(value));
  return { state: "complete" as const, passed, reason: passed ? "coding-behavior-values-match" : "coding-behavior-values-differ",
    samples: observed.size, executorQualified: false as const, resourceEvidence: null };
}
