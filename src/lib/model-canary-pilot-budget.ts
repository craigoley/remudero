/** Private, process-local authority for the bounded one-shot cash-canary sublimit. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cashIdentityMatches, validCashIdentity, type CashRequestIdentity, type CashReservation } from "./cash-accounting.js";

const PILOT_DB_SUFFIX = ".model-canary-pilot.sqlite";
const PILOT_TABLE = "canary_pilot_reservations_v1";
const SCHEMA_VERSION = 1;
const LIFETIME_CAP_MICROS = 10_000_000;
const SMOKE_CAP_MICROS = 2_000_000;
const MAX_RESERVATIONS = 1024;
const MAX_SHARED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_IDENTITY_JSON_BYTES = 4096;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export type CanaryPilotBudgetPhase = "smoke" | "post-smoke";
declare const capabilityBrand: unique symbol;
export type CanaryPilotBudgetCapability = { readonly [capabilityBrand]: true };

type CapabilityBinding = { phase: CanaryPilotBudgetPhase; sharedAllowancePath: string };
type OwnedRequest = {
  requestId: string;
  identityJson: string;
  phase: CanaryPilotBudgetPhase;
  invocationNonce: string;
  reservedUsd: number;
  reservedMicros: number;
  settledActualUsd?: number;
};
type Scope = { capability: object; binding: CapabilityBinding; closed: boolean; requests: Map<string, OwnedRequest> };
export type CanaryPilotBudgetAccountingSnapshot = Readonly<{
  requestCount: number;
  settledCount: number;
  heldCount: number;
}>;

const capabilityBindings = new WeakMap<object, CapabilityBinding>();
const pilotBudgetScope = new AsyncLocalStorage<Scope>();

/** Issued only by the native one-shot owner after its private approval and durable run claim. */
export function issueCanaryPilotBudgetCapability(input: {
  phase: CanaryPilotBudgetPhase;
  sharedAllowancePath: string;
}): CanaryPilotBudgetCapability {
  if ((input.phase !== "smoke" && input.phase !== "post-smoke") || typeof input.sharedAllowancePath !== "string"
    || !isAbsolute(input.sharedAllowancePath) || !input.sharedAllowancePath.endsWith(".json")
    || resolve(input.sharedAllowancePath) !== input.sharedAllowancePath || input.sharedAllowancePath.includes("\0"))
    throw new Error("canary-pilot-budget-capability-invalid");
  const capability = Object.freeze(Object.create(null)) as CanaryPilotBudgetCapability;
  capabilityBindings.set(capability, Object.freeze({ phase: input.phase, sharedAllowancePath: input.sharedAllowancePath }));
  return capability;
}

/** Async-only scope. Detached work inherits the closed marker and cannot start a new paid request. */
export async function withCanaryPilotBudget<T>(
  capability: CanaryPilotBudgetCapability,
  operation: () => Promise<T>,
): Promise<T> {
  const binding = capabilityBindings.get(capability);
  if (!binding || typeof operation !== "function" || pilotBudgetScope.getStore() !== undefined)
    throw new Error("canary-pilot-budget-scope-invalid");
  const scope: Scope = { capability, binding, closed: false, requests: new Map() };
  try {
    const result = pilotBudgetScope.run(scope, operation);
    if (result === null || typeof result !== "object" || typeof (result as Promise<T>).then !== "function")
      throw new Error("canary-pilot-budget-scope-must-return-promise");
    return await result;
  } finally {
    scope.closed = true;
  }
}

/** True only for the exact branded capability in its current, open async owner scope. */
export function isCurrentCanaryPilotBudget(capability: CanaryPilotBudgetCapability): boolean {
  const binding = capabilityBindings.get(capability);
  const scope = pilotBudgetScope.getStore();
  return binding !== undefined && scope !== undefined && !scope.closed && scope.capability === capability
    && scope.binding === binding;
}

/** Read aggregate completion evidence only inside the matching active native owner scope. */
export function readCurrentCanaryPilotBudgetAccounting(
  capability: CanaryPilotBudgetCapability,
): CanaryPilotBudgetAccountingSnapshot | null {
  if (!isCurrentCanaryPilotBudget(capability)) return null;
  const scope = pilotBudgetScope.getStore()!;
  const requestCount = scope.requests.size;
  let settledCount = 0;
  for (const request of scope.requests.values()) {
    if (request.settledActualUsd !== undefined) settledCount += 1;
  }
  return Object.freeze({ requestCount, settledCount, heldCount: requestCount - settledCount });
}

/** Fail before touching either allowance when a pilot scope is detached, misbound or lacks identity. */
export function assertCurrentCanaryPilotReservation(input: {
  sharedAllowancePath: string | undefined;
  identity: CashRequestIdentity | undefined;
  requestId: string;
  deployment: string;
  squeezed: boolean;
}): void {
  const scope = pilotBudgetScope.getStore();
  if (!scope) return;
  if (scope.closed) throw new Error("canary-pilot-budget-scope-closed");
  if (!input.sharedAllowancePath || input.sharedAllowancePath !== scope.binding.sharedAllowancePath)
    throw new Error("canary-pilot-budget-shared-path-mismatch");
  if (input.squeezed) throw new Error("canary-pilot-budget-squeezed-cap-forbidden");
  if (!boundedIdentity(input.identity) || input.identity.requestId !== input.requestId
    || input.identity.deployment !== input.deployment)
    throw new Error("canary-pilot-budget-request-identity-required");
}

/** Settlement may arrive late, but only for an exact request reserved in this inherited scope. */
export function assertCurrentCanaryPilotSettlement(input: {
  sharedAllowancePath: string | undefined;
  requestId: string;
  identity: CashRequestIdentity | undefined;
}): void {
  const scope = pilotBudgetScope.getStore();
  if (!scope) return;
  if (!input.sharedAllowancePath || input.sharedAllowancePath !== scope.binding.sharedAllowancePath)
    throw new Error("canary-pilot-budget-shared-path-mismatch");
  const owned = scope.requests.get(input.requestId);
  if (!owned || !boundedIdentity(input.identity) || identityKey(input.identity) !== owned.identityJson)
    throw new Error("canary-pilot-budget-settlement-not-owned");
}

/** Called inside the existing global allowance mutation, after its ordinary limits validate. */
export function reserveCurrentCanaryPilotRequest(input: {
  sharedAllowancePath: string | undefined;
  requestId: string;
  identity: CashRequestIdentity | undefined;
  reservedUsd: number;
  invocationNonce: string;
}): void {
  const scope = pilotBudgetScope.getStore();
  if (!scope) return;
  if (scope.closed) throw new Error("canary-pilot-budget-scope-closed");
  if (!input.sharedAllowancePath || input.sharedAllowancePath !== scope.binding.sharedAllowancePath)
    throw new Error("canary-pilot-budget-shared-path-mismatch");
  if (!boundedIdentity(input.identity) || input.identity.requestId !== input.requestId
    || typeof input.invocationNonce !== "string" || !/^[a-f0-9-]{36}$/i.test(input.invocationNonce))
    throw new Error("canary-pilot-budget-request-identity-required");
  const reservedMicros = usdToMicros(input.reservedUsd, "reservation");
  if (reservedMicros <= 0 || reservedMicros > LIFETIME_CAP_MICROS)
    throw new Error("canary-pilot-budget-reservation-invalid");
  const identityJson = identityKey(input.identity);
  const prior = scope.requests.get(input.requestId);
  if (prior && (prior.identityJson !== identityJson || prior.phase !== scope.binding.phase
    || prior.invocationNonce !== input.invocationNonce || prior.reservedMicros !== reservedMicros))
    throw new Error("canary-pilot-budget-invocation-mismatch");

  const db = openPilotDatabase(input.sharedAllowancePath);
  let begun = false;
  try {
    db.exec("BEGIN IMMEDIATE"); begun = true;
    const rows = readValidatedRows(db);
    const row = db.prepare(`SELECT request_id, identity_json, phase, invocation_nonce, reserved_micros,
      committed_micros, state, settlement_actual_usd FROM ${PILOT_TABLE} WHERE request_id=?`).get(input.requestId) as PilotRow | undefined;
    if (row) {
      if (!prior || row.invocation_nonce !== input.invocationNonce || row.identity_json !== identityJson
        || row.phase !== scope.binding.phase || row.reserved_micros !== reservedMicros
        || row.state !== "held" || row.committed_micros !== reservedMicros || row.settlement_actual_usd !== null)
        throw new Error("canary-pilot-budget-request-duplicate");
      db.exec("COMMIT"); begun = false;
      return;
    }
    if (prior) throw new Error("canary-pilot-budget-request-row-missing");
    if (rows.length >= MAX_RESERVATIONS) throw new Error("canary-pilot-budget-reservation-capacity");
    const lifetime = rows.reduce((sum, row) => sum + row.committed_micros, 0);
    if (!Number.isSafeInteger(lifetime) || lifetime + reservedMicros > LIFETIME_CAP_MICROS)
      throw new Error("canary-pilot-budget-lifetime-cap-exhausted");
    if (scope.binding.phase === "smoke") {
      const smoke = rows.reduce((sum, row) => sum + (row.phase === "smoke" ? row.committed_micros : 0), 0);
      if (!Number.isSafeInteger(smoke) || smoke + reservedMicros > SMOKE_CAP_MICROS)
        throw new Error("canary-pilot-budget-smoke-cap-exhausted");
    }
    db.prepare(`INSERT INTO ${PILOT_TABLE}
      (request_id,identity_json,phase,invocation_nonce,reserved_micros,committed_micros,state,settlement_actual_usd)
      VALUES (?,?,?,?,?,?,?,NULL)`).run(input.requestId, identityJson, scope.binding.phase, input.invocationNonce,
      reservedMicros, reservedMicros, "held");
    db.exec("COMMIT"); begun = false;
    scope.requests.set(input.requestId, { requestId: input.requestId, identityJson, phase: scope.binding.phase,
      invocationNonce: input.invocationNonce, reservedUsd: input.reservedUsd, reservedMicros });
  } catch (error) {
    if (begun) { try { db.exec("ROLLBACK"); } catch { /* preserve the originating refusal */ } }
    throw error;
  } finally { db.close(); }
}

/** Exact known settlement only. Missing or suspicious evidence leaves the full reservation held. */
export function settleCurrentCanaryPilotRequest(input: {
  sharedAllowancePath: string | undefined;
  requestId: string;
  identity: CashRequestIdentity | undefined;
  originalActualUsd: number | undefined;
  globalSettlement: CashReservation | undefined;
}): void {
  const scope = pilotBudgetScope.getStore();
  if (!scope || input.originalActualUsd === undefined || !Number.isFinite(input.originalActualUsd)
    || input.originalActualUsd < 0 || !input.globalSettlement || input.globalSettlement.settledUsd !== input.originalActualUsd)
    return;
  if (!input.sharedAllowancePath || input.sharedAllowancePath !== scope.binding.sharedAllowancePath)
    return;
  const owned = scope.requests.get(input.requestId);
  if (!owned || !boundedIdentity(input.identity) || identityKey(input.identity) !== owned.identityJson
    || !cashIdentityMatches(input.identity, input.globalSettlement.identity)) return;
  if (input.originalActualUsd > owned.reservedUsd) return;
  const settledMicros = usdToMicros(input.originalActualUsd, "settlement");
  if (settledMicros > owned.reservedMicros) return;

  const db = openPilotDatabase(input.sharedAllowancePath);
  let begun = false;
  try {
    db.exec("BEGIN IMMEDIATE"); begun = true;
    readValidatedRows(db);
    const row = db.prepare(`SELECT request_id, identity_json, phase, invocation_nonce, reserved_micros,
      committed_micros, state, settlement_actual_usd FROM ${PILOT_TABLE} WHERE request_id=?`).get(input.requestId) as PilotRow | undefined;
    if (!row || row.identity_json !== owned.identityJson || row.phase !== owned.phase
      || row.invocation_nonce !== owned.invocationNonce || row.reserved_micros !== owned.reservedMicros)
      throw new Error("canary-pilot-budget-settlement-identity-mismatch");
    const actualText = String(input.originalActualUsd);
    if (row.state === "settled") {
      if (row.settlement_actual_usd !== actualText || row.committed_micros !== settledMicros)
        throw new Error("canary-pilot-budget-conflicting-settlement");
      db.exec("COMMIT"); begun = false;
      owned.settledActualUsd = input.originalActualUsd;
      return;
    }
    if (row.state !== "held" || row.committed_micros !== row.reserved_micros || row.settlement_actual_usd !== null)
      throw new Error("canary-pilot-budget-held-state-invalid");
    db.prepare(`UPDATE ${PILOT_TABLE} SET committed_micros=?,state='settled',settlement_actual_usd=?
      WHERE request_id=? AND state='held' AND invocation_nonce=?`).run(settledMicros, actualText, input.requestId, owned.invocationNonce);
    db.exec("COMMIT"); begun = false;
    owned.settledActualUsd = input.originalActualUsd;
  } catch (error) {
    if (begun) { try { db.exec("ROLLBACK"); } catch { /* preserve the originating refusal */ } }
    throw error;
  } finally { db.close(); }
}

type PilotRow = {
  request_id: string;
  identity_json: string;
  phase: string;
  invocation_nonce: string;
  reserved_micros: number;
  committed_micros: number;
  state: string;
  settlement_actual_usd: string | null;
};

function identityKey(identity: CashRequestIdentity): string {
  return JSON.stringify([identity.requestId, identity.attemptId, identity.provider, identity.deployment, identity.endpoint]);
}

function boundedIdentity(value: unknown): value is CashRequestIdentity {
  if (!validCashIdentity(value)) return false;
  const identity = value as CashRequestIdentity;
  return identity.requestId.length <= 256 && identity.attemptId.length <= 256
    && identity.deployment.length <= 256 && identity.endpoint.length <= 2048
    && Buffer.byteLength(identityKey(identity), "utf8") <= MAX_IDENTITY_JSON_BYTES;
}

function usdToMicros(usd: number, label: string): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`canary-pilot-budget-${label}-invalid`);
  const micros = Math.ceil(usd * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw new Error(`canary-pilot-budget-${label}-invalid`);
  return micros;
}

function pilotDatabasePath(sharedAllowancePath: string): string {
  return `${sharedAllowancePath}${PILOT_DB_SUFFIX}`;
}

function ensureSharedPathIsPrivate(sharedAllowancePath: string): void {
  if (!isAbsolute(sharedAllowancePath) || !sharedAllowancePath.endsWith(".json")
    || resolve(sharedAllowancePath) !== sharedAllowancePath || typeof process.geteuid !== "function")
    throw new Error("canary-pilot-budget-shared-path-invalid");
  let parent = dirname(sharedAllowancePath);
  const pathInfo = lstatSync(sharedAllowancePath);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.uid !== process.geteuid()
    || (pathInfo.mode & 0o077) !== 0 || realpathSync(sharedAllowancePath) !== sharedAllowancePath)
    throw new Error("canary-pilot-budget-shared-file-not-private-owned-regular");
  const parentInfo = lstatSync(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.geteuid()
    || (parentInfo.mode & 0o077) !== 0 || realpathSync(parent) !== parent)
    throw new Error("canary-pilot-budget-shared-parent-not-private-owned-directory");
  for (;;) {
    if (existsSync(join(parent, ".git"))) throw new Error("canary-pilot-budget-path-inside-git");
    const next = dirname(parent);
    if (next === parent) break;
    const ancestor = lstatSync(next);
    if (ancestor.isSymbolicLink() || !ancestor.isDirectory()) throw new Error("canary-pilot-budget-symlink-ancestor");
    parent = next;
  }
}

function openPilotDatabase(sharedAllowancePath: string): DatabaseSync {
  ensureSharedPathIsPrivate(sharedAllowancePath);
  const path = pilotDatabasePath(sharedAllowancePath);
  let existed = false;
  try {
    const info = lstatSync(path);
    existed = true;
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== effectiveUid() || (info.mode & 0o077) !== 0
      || info.size > MAX_SHARED_FILE_BYTES
      || realpathSync(path) !== path) throw new Error("canary-pilot-budget-database-not-private-owned-regular");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const db = new DatabaseSync(path, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    if (!existed) {
      chmodSync(path, 0o600);
      db.exec("PRAGMA journal_mode=DELETE");
      db.exec("PRAGMA synchronous=EXTRA");
      if (pragmaString(db, "journal_mode") !== "delete" || pragmaNumber(db, "synchronous") !== 3)
        throw new Error("canary-pilot-budget-sqlite-pragmas-unavailable");
      db.exec(`CREATE TABLE ${PILOT_TABLE} (
        request_id TEXT NOT NULL PRIMARY KEY,
        identity_json TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('smoke','post-smoke')),
        invocation_nonce TEXT NOT NULL,
        reserved_micros INTEGER NOT NULL CHECK(reserved_micros > 0),
        committed_micros INTEGER NOT NULL CHECK(committed_micros >= 0 AND committed_micros <= reserved_micros),
        state TEXT NOT NULL CHECK(state IN ('held','settled')),
        settlement_actual_usd TEXT
      ); PRAGMA user_version=${SCHEMA_VERSION};`);
    } else {
      if (pragmaString(db, "journal_mode") !== "delete") throw new Error("canary-pilot-budget-sqlite-journal-mode-invalid");
      db.exec("PRAGMA synchronous=EXTRA");
      if (pragmaNumber(db, "synchronous") !== 3) throw new Error("canary-pilot-budget-sqlite-synchronous-invalid");
      assertSchema(db);
    }
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== effectiveUid() || (info.mode & 0o777) !== 0o600)
      throw new Error("canary-pilot-budget-database-mode-invalid");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function effectiveUid(): number {
  if (typeof process.geteuid !== "function") throw new Error("canary-pilot-budget-effective-uid-unavailable");
  return process.geteuid();
}

function pragmaString(db: DatabaseSync, name: "journal_mode"): string | undefined {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return typeof row?.[name] === "string" ? row[name] as string : undefined;
}

function pragmaNumber(db: DatabaseSync, name: "synchronous" | "user_version"): number | undefined {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  return typeof row?.[name] === "number" ? row[name] as number : undefined;
}

function assertSchema(db: DatabaseSync): void {
  if (pragmaNumber(db, "user_version") !== SCHEMA_VERSION)
    throw new Error("canary-pilot-budget-schema-version-invalid");
  const objects = db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Array<{ type: string; name: string }>;
  if (objects.length !== 1 || objects[0]?.type !== "table" || objects[0]?.name !== PILOT_TABLE)
    throw new Error("canary-pilot-budget-schema-objects-invalid");
  const columns = db.prepare(`PRAGMA table_info(${PILOT_TABLE})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
  const expected = [
    ["request_id", "TEXT", 1, 1], ["identity_json", "TEXT", 1, 0], ["phase", "TEXT", 1, 0],
    ["invocation_nonce", "TEXT", 1, 0], ["reserved_micros", "INTEGER", 1, 0],
    ["committed_micros", "INTEGER", 1, 0], ["state", "TEXT", 1, 0], ["settlement_actual_usd", "TEXT", 0, 0],
  ];
  if (columns.length !== expected.length || columns.some((column, index) => {
    const row = expected[index]!;
    return column.name !== row[0] || column.type !== row[1] || column.notnull !== row[2] || column.pk !== row[3];
  })) throw new Error("canary-pilot-budget-schema-columns-invalid");
}

function readValidatedRows(db: DatabaseSync): PilotRow[] {
  const oversized = db.prepare(`SELECT 1 FROM ${PILOT_TABLE}
    WHERE length(request_id)>256 OR length(identity_json)>${MAX_IDENTITY_JSON_BYTES}
      OR length(phase)>16 OR length(invocation_nonce)>64 LIMIT 1`).get();
  if (oversized) throw new Error("canary-pilot-budget-existing-row-field-too-large");
  const rows = db.prepare(`SELECT request_id,identity_json,phase,invocation_nonce,reserved_micros,
    committed_micros,state,settlement_actual_usd FROM ${PILOT_TABLE} ORDER BY request_id LIMIT ${MAX_RESERVATIONS + 1}`).all() as PilotRow[];
  if (rows.length > MAX_RESERVATIONS) throw new Error("canary-pilot-budget-reservation-capacity");
  let lifetime = 0, smoke = 0;
  for (const row of rows) {
    if (typeof row.request_id !== "string" || row.request_id.length < 1 || row.request_id.length > 256
      || !Number.isSafeInteger(row.reserved_micros) || row.reserved_micros <= 0 || row.reserved_micros > LIFETIME_CAP_MICROS
      || !Number.isSafeInteger(row.committed_micros) || row.committed_micros < 0 || row.committed_micros > row.reserved_micros
      || (row.phase !== "smoke" && row.phase !== "post-smoke") || typeof row.invocation_nonce !== "string"
      || !/^[a-f0-9-]{36}$/i.test(row.invocation_nonce) || (row.state !== "held" && row.state !== "settled"))
      throw new Error("canary-pilot-budget-existing-row-invalid");
    let rawIdentity: unknown;
    try { rawIdentity = JSON.parse(row.identity_json); } catch { throw new Error("canary-pilot-budget-existing-identity-invalid"); }
    if (!Array.isArray(rawIdentity) || rawIdentity.length !== 5 || rawIdentity.some(part => typeof part !== "string"))
      throw new Error("canary-pilot-budget-existing-identity-invalid");
    const [requestId, attemptId, provider, deployment, endpoint] = rawIdentity as string[];
    const identity = { requestId, attemptId, provider, deployment, endpoint } as CashRequestIdentity;
    if (!validCashIdentity(identity) || identity.requestId !== row.request_id || identityKey(identity) !== row.identity_json)
      throw new Error("canary-pilot-budget-existing-identity-invalid");
    if (row.state === "held") {
      if (row.committed_micros !== row.reserved_micros || row.settlement_actual_usd !== null)
        throw new Error("canary-pilot-budget-existing-held-row-invalid");
    } else {
      if (row.settlement_actual_usd === null || row.settlement_actual_usd === "")
        throw new Error("canary-pilot-budget-existing-settlement-invalid");
      const actual = Number(row.settlement_actual_usd);
      if (!Number.isFinite(actual) || actual < 0 || actual > row.reserved_micros / 1_000_000
        || usdToMicros(actual, "stored-settlement") !== row.committed_micros)
        throw new Error("canary-pilot-budget-existing-settlement-invalid");
    }
    lifetime += row.committed_micros;
    if (row.phase === "smoke") smoke += row.committed_micros;
    if (!Number.isSafeInteger(lifetime) || !Number.isSafeInteger(smoke))
      throw new Error("canary-pilot-budget-existing-total-invalid");
  }
  if (lifetime > LIFETIME_CAP_MICROS || smoke > SMOKE_CAP_MICROS)
    throw new Error("canary-pilot-budget-existing-total-over-cap");
  return rows;
}
