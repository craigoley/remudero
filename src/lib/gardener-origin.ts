/** A passive correlation carrier, never an authorization, outcome, or cost receipt. Its
 * parent is the exact garden.lifecycle/garden.pass row with the same name and passId. */
export const GARDENER_ORIGIN_ENV = "REMUDERO_GARDENER_ORIGIN";
/** PRIMARY CONTROL: a carrier holds only the version, garden name, and UUID. */
export const GARDENER_ORIGIN_MAX_BYTES = 256;
export type GardenerOrigin =
  | { state: "linked"; version: 1; name: string; passId: string }
  | { state: "invalid"; reason: "malformed" };

/** Invalid/future carriers are explicitly unknown, with no raw environment text retained. */
export function readGardenerOrigin(env: NodeJS.ProcessEnv = process.env): GardenerOrigin | undefined {
  const text = env[GARDENER_ORIGIN_ENV];
  if (text === undefined) return undefined;
  if (Buffer.byteLength(text, "utf8") > GARDENER_ORIGIN_MAX_BYTES) return { state: "invalid", reason: "malformed" };
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { state: "invalid", reason: "malformed" };
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || value.version !== 1 ||
        typeof value.name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.name) ||
        typeof value.passId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.passId)) {
      return { state: "invalid", reason: "malformed" };
    }
    return { state: "linked", version: 1, name: value.name, passId: value.passId };
  } catch {
    return { state: "invalid", reason: "malformed" };
  }
}

/** A new pass replaces an inherited carrier. A direct/legacy spawn clears it instead of
 * borrowing another pass's identity; the daemon process's environment is never mutated. */
export function gardenerOriginEnv(name: string, passId: string | undefined): string | undefined {
  if (passId === undefined) return undefined;
  return JSON.stringify({ version: 1, name, passId });
}
