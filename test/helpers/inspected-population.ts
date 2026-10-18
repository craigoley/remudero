import assert from "node:assert/strict";

/** Compare the actual inspected population with a separate enumeration of the same members. */
export function assertInspected(label: string, inspected: number, independent: number): void {
  assert.ok(Number.isSafeInteger(inspected) && Number.isSafeInteger(independent)
    && inspected > 0 && inspected === independent,
  `${label}: inspected=${inspected}, independent=${independent}; expected equal, non-empty populations`);
}
