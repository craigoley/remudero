import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";

type ProbeResult = Pick<SpawnSyncReturns<unknown>, "status" | "signal" | "error">;
const NATIVE_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ENOBUFS", "ENOMEM", "E2BIG"]);
const NATIVE_SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGINT", "SIGQUIT", "SIGHUP"]);

/** Silent probes still return native failure evidence; output/message/argv are not needed. */
export function assertGateProbeRan(label: string, result: ProbeResult): void {
  const error = result.error;
  const nativeCode = error && "code" in error ? error.code : undefined;
  const code = !error ? "none" : typeof nativeCode === "string" && NATIVE_CODES.has(nativeCode) ? nativeCode : "unclassified";
  const signal = result.signal === null ? "none" : NATIVE_SIGNALS.has(result.signal) ? result.signal : "unclassified";
  const status = result.status === null ? "null" : String(result.status);
  assert.ok(result.status === 0 || result.status === 1,
    `${label} ran (status ${status}; signal ${signal}; code ${code})`);
}
