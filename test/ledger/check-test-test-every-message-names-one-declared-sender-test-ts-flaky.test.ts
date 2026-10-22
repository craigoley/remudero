import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PRODUCER_IDENTITIES, UndeclaredProducerError, resolveProducerIdentity } from "#src/lib/producer-identity.js";
import { appendProducerLedger } from "#src/lib/ledger.js";

// The census in test/every-message-names-one-declared-sender.test.ts reddens when a PR writes a
// task_id no registry entry declares. That is a deterministic refusal, not a flake: the write
// path itself refuses an undeclared sender, so the author finds it the first time it is used.

test("W1-T10202: check:test:test/every-message-names-one-declared-sender.test.ts:flaky is prevented, not retried", () => {
  const path = join(mkdtempSync(join(tmpdir(), "rmd-t10202-")), "ledger.ndjson");
  // Resolution is deterministic: every declared spelling resolves to the same object each time.
  for (const raw of Object.keys(PRODUCER_IDENTITIES)) {
    assert.equal(resolveProducerIdentity(raw), resolveProducerIdentity(raw));
  }
  // An undeclared sender is refused before anything is written, naming the sender.
  assert.throws(
    () => appendProducerLedger(path, "NINETEENTH", { run_id: "R", step: "x" }),
    (err: unknown) => err instanceof UndeclaredProducerError && String((err as Error).message).includes("NINETEENTH"),
  );
  assert.equal(existsSync(path), false);
});
