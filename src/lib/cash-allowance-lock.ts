import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);

/** SQLite's BEGIN IMMEDIATE is the process boundary for one shared allowance JSON file.
 * A crashed holder releases its OS lock. A failed acquisition refuses the paid request. */
export function withFleetCashAllowanceLock<T>(allowancePath: string, action: () => T): T {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  let db: DatabaseSync | undefined;
  let begun = false;
  try {
    db = new DatabaseSync(`${allowancePath}.lock.sqlite`, { timeout: 5_000 });
    db.exec("BEGIN IMMEDIATE");
    begun = true;
    const result = action();
    db.exec("COMMIT");
    begun = false;
    return result;
  } catch (error) {
    if (begun) {
      try { db?.exec("ROLLBACK"); } catch { /* preserve the original refusal */ }
    }
    throw error;
  } finally {
    db?.close();
  }
}
