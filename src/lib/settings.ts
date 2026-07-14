import { readFileSync } from "node:fs";

/**
 * Validate-before-spawn guard for worker settings (WS-0 FIELD FINDING 10a).
 *
 * `claude -p` SILENTLY IGNORES a settings file that fails validation — a typo
 * does not error, it DROPS containment. Worse, the installed SDK's
 * `SandboxSettingsSchema` is `$loose`: it STRIPS unknown keys rather than
 * rejecting them. So validating against the SDK schema alone would NOT catch the
 * exact WS-0 hazard — `allowedDomains` placed at the sandbox root (instead of
 * under `network`) is silently discarded, and the worker runs with no domain
 * allowlist. This guard is therefore deliberately STRICTER than the SDK schema:
 * it rejects any unknown or MISPLACED key with a named error, before spawn.
 *
 * Key sets are PINNED to the installed version (SDK 0.3.209 / CLI 2.1.209). When
 * the platform is bumped (WS-7 release watcher), re-pin from the schema dump.
 */

/** Named error so callers (and tests) can assert the guard fired by type. */
export class WorkerSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerSettingsError";
  }
}

// Pinned from SandboxSettingsSchema (SDK 0.3.209).
const SANDBOX_KEYS = new Set([
  "enabled",
  "failIfUnavailable",
  "autoAllowBashIfSandboxed",
  "allowUnsandboxedCommands",
  "network",
  "filesystem",
  "credentials",
  "ignoreViolations",
  "enableWeakerNestedSandbox",
  "enableWeakerNetworkIsolation",
  "allowAppleEvents",
  "excludedCommands",
  "ripgrep",
  "bwrapPath",
  "socatPath",
]);
const NETWORK_KEYS = new Set([
  "allowedDomains",
  "deniedDomains",
  "allowManagedDomainsOnly",
  "allowUnixSockets",
  "allowAllUnixSockets",
  "allowLocalBinding",
  "allowMachLookup",
  "httpProxyPort",
  "socksProxyPort",
  "tlsTerminate",
]);
const FILESYSTEM_KEYS = new Set([
  "allowWrite",
  "denyWrite",
  "denyRead",
  "allowRead",
  "allowManagedReadPathsOnly",
]);

/** Where a misplaced key actually belongs — powers a helpful named error. */
function homeOf(key: string): string | null {
  if (NETWORK_KEYS.has(key)) return "network";
  if (FILESYSTEM_KEYS.has(key)) return "filesystem";
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkKeys(obj: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) continue;
    const belongs = homeOf(key);
    if (belongs && path === "sandbox") {
      throw new WorkerSettingsError(
        `sandbox.${key} is not a valid top-level sandbox key; ` +
          `'${key}' belongs under sandbox.${belongs} (silent-drop hazard — WS-0 FF10a, pinned SDK 0.3.209).`,
      );
    }
    throw new WorkerSettingsError(
      `unknown key '${key}' in ${path} (pinned SDK 0.3.209 SandboxSettingsSchema).`,
    );
  }
}

/**
 * Validate a parsed worker-settings object. Throws {@link WorkerSettingsError}
 * with a named, actionable message on the first problem. Returns nothing on
 * success. Callers MUST invoke this before every worker spawn.
 */
export function validateWorkerSettings(settings: unknown): void {
  if (!isObject(settings)) {
    throw new WorkerSettingsError("worker settings must be a JSON object.");
  }
  const sandbox = settings.sandbox;
  if (sandbox === undefined) {
    throw new WorkerSettingsError("worker settings must define `sandbox` (containment is not optional).");
  }
  if (!isObject(sandbox)) {
    throw new WorkerSettingsError("`sandbox` must be an object.");
  }
  checkKeys(sandbox, SANDBOX_KEYS, "sandbox");

  if (sandbox.enabled !== true) {
    throw new WorkerSettingsError("`sandbox.enabled` must be true (workers are never unsandboxed).");
  }
  if (sandbox.failIfUnavailable !== true) {
    throw new WorkerSettingsError(
      "`sandbox.failIfUnavailable` must be true (never silently run unsandboxed).",
    );
  }

  if (sandbox.network !== undefined) {
    if (!isObject(sandbox.network)) throw new WorkerSettingsError("`sandbox.network` must be an object.");
    checkKeys(sandbox.network, NETWORK_KEYS, "sandbox.network");
  }
  if (sandbox.filesystem !== undefined) {
    if (!isObject(sandbox.filesystem))
      throw new WorkerSettingsError("`sandbox.filesystem` must be an object.");
    checkKeys(sandbox.filesystem, FILESYSTEM_KEYS, "sandbox.filesystem");
  }

  // Zero ask rules is load-bearing (a headless worker would hang on a prompt).
  const permissions = settings.permissions;
  if (isObject(permissions) && Array.isArray(permissions.ask) && permissions.ask.length > 0) {
    throw new WorkerSettingsError(
      "`permissions.ask` must be empty (ask rules prompt even under bypass → headless hang).",
    );
  }
}

/** Read, JSON-parse, and validate a worker-settings file. Returns the parsed object. */
export function validateWorkerSettingsFile(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new WorkerSettingsError(`worker settings file is not valid JSON (${path}): ${String(err)}`);
  }
  validateWorkerSettings(parsed);
  return parsed as Record<string, unknown>;
}
