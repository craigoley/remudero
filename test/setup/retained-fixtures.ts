import { resolve } from "node:path";

// Shared by explicit fixture scopes and the process-exit backstop. A retained failure must not
// be removed by the older mkdtemp sweep after its narrower teardown correctly kept it.
const retained = new Map<string, string>();

export function retainFixture(dir: string, reason: string): void {
  if (!reason.trim()) throw new Error("retained fixture requires a reason");
  retained.set(resolve(dir), reason);
}

export function fixtureRetentionReason(dir: string | Buffer): string | undefined {
  return retained.get(resolve(String(dir)));
}
