/**
 * The console operator's identity, read from a host file mounted read-only into the gateway
 * container (deploy/serve-container.sh). `config.json` lives in the container's writable layer and
 * is wiped by every `--replace`; this file survives it. Config's own `serve.operatorIdentity`
 * wins when present. A missing, unreadable or invalid file yields NO identity (logged by reason),
 * never a boot failure and never a partial config.
 */
import { readFileSync } from "node:fs";
import type { OperatorIdentityConfig } from "./service.js";

export const OPERATOR_IDENTITY_PATH_ENV = "RMD_OPERATOR_IDENTITY_PATH";

export interface OperatorIdentityFileIo {
  path?: string;
  readFile?: (path: string) => string;
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

type Parsed = { config: OperatorIdentityConfig } | { reason: string };

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    // Deliberate: an unparseable URL is simply not an https URL; the caller names the field.
    return false;
  }
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim() !== "");
}

export function parseOperatorIdentity(raw: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { reason: `not_json: ${(err as Error).message}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { reason: "not_an_object" };
  const record = value as Record<string, unknown>;
  if (!isHttpsUrl(record.issuer)) return { reason: "issuer_not_https_url" };
  if (!isNonEmptyStringArray(record.allowedOrigins)) return { reason: "allowed_origins_empty_or_not_strings" };
  if (!isNonEmptyStringArray(record.operatorUserIds)) return { reason: "operator_user_ids_empty_or_not_strings" };
  if (record.jwksUrl !== undefined && !isHttpsUrl(record.jwksUrl)) return { reason: "jwks_url_not_https_url" };
  const window = record.stepUpWindowMinutes;
  if (window !== undefined && !(typeof window === "number" && Number.isFinite(window) && window > 0)) {
    return { reason: "step_up_window_not_positive_number" };
  }
  const config: OperatorIdentityConfig = {
    issuer: record.issuer,
    allowedOrigins: record.allowedOrigins,
    operatorUserIds: record.operatorUserIds,
  };
  if (record.jwksUrl !== undefined) config.jwksUrl = record.jwksUrl;
  if (window !== undefined) config.stepUpWindowMinutes = window;
  return { config };
}

export function operatorIdentityFromFile(io: OperatorIdentityFileIo = {}): OperatorIdentityConfig | undefined {
  const path = io.path ?? process.env[OPERATOR_IDENTITY_PATH_ENV];
  if (!path) return undefined;
  let raw: string;
  try {
    raw = (io.readFile ?? ((p: string) => readFileSync(p, "utf8")))(path);
  } catch (err) {
    io.log?.("serve.operator_identity_file_invalid", { path, reason: `unreadable: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` });
    return undefined;
  }
  const parsed = parseOperatorIdentity(raw);
  if ("reason" in parsed) {
    io.log?.("serve.operator_identity_file_invalid", { path, reason: parsed.reason });
    return undefined;
  }
  io.log?.("serve.operator_identity_file_loaded", { path, operators: parsed.config.operatorUserIds.length });
  return parsed.config;
}
