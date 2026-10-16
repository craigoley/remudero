/**
 * W1-T9541: one host comparison for every PID@HOST identity. macOS derives its kernel hostname from
 * DHCP/mDNS state when `scutil --get HostName` is unset, so `os.hostname()` flips between
 * `Craigs-Mac-mini` and `Craigs-Mac-mini.local` (or a search-domain form) across reboots. Writers
 * keep recording the raw hostname; readers compare through {@link sameHost}.
 */

const CONTAINER_ID = /^(?:[0-9a-f]{12}|[0-9a-f]{64})$/;

/** Trimmed, lower-cased, one trailing `.` dropped, then a trailing mDNS `.local` dropped. */
export function hostIdentity(host: string): string {
  let id = host.trim().toLowerCase();
  if (id.endsWith(".")) id = id.slice(0, -1);
  if (id.endsWith(".local")) id = id.slice(0, -".local".length);
  return id;
}

/**
 * Do `a` and `b` name the same machine? Absent, empty or non-string never matches. Equal identities match; a
 * bare label (no `.`) also matches the other side's first DNS label, but two FQDNs sharing a first
 * label stay different hosts, and a container id matches only itself.
 */
export function sameHost(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = hostIdentity(a);
  const y = hostIdentity(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xBare = !x.includes(".");
  const yBare = !y.includes(".");
  if (xBare === yBare) return false;
  const [bare, qualified] = xBare ? [x, y] : [y, x];
  if (CONTAINER_ID.test(bare)) return false;
  return qualified.slice(0, qualified.indexOf(".")) === bare;
}
