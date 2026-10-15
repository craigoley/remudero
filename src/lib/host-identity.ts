/** Comparison identity only; persisted hostnames retain the machine's raw spelling. */
export function hostIdentity(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/\.local$/, "");
}

/** Match bare names to DNS suffixes without equating two distinct qualified names. */
export function sameHost(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const left = hostIdentity(a), right = hostIdentity(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (/^(?:[0-9a-f]{12}|[0-9a-f]{64})$/.test(left) || /^(?:[0-9a-f]{12}|[0-9a-f]{64})$/.test(right)) return false;
  const leftBare = !left.includes("."), rightBare = !right.includes(".");
  return leftBare !== rightBare && left.split(".")[0] === right.split(".")[0];
}
