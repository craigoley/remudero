import { resolve } from "node:path";

// ONE process-local custody registry, shared by production captures and fixture exit cleanup.
const retained = new Map();

export function retainFixture(dir, reason) {
  if (!reason.trim()) throw new Error("retained fixture requires a reason");
  retained.set(resolve(dir), reason);
}

export function fixtureRetentionReason(dir) {
  return retained.get(resolve(String(dir)));
}
