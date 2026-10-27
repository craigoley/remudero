import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readAffectedListings, readAffectedListingsAsync } from "#src/lib/affected-suites.js";

const ABSENT = join(tmpdir(), "rmd-w1-t10140-absent-root");

test("W1-T10140: check:ci-log:coverage-shard:flake-retry-first-attempt-failed-no-test-name-parsed-from-ou is prevented, not retried", async () => {
  // A listing over an unreadable tree fails loudly and synchronously-named, in both lanes,
  // instead of yielding an empty listing that a later shard would trip over unnamed.
  assert.throws(() => readAffectedListings(ABSENT, ["src/a.ts"]), /ENOENT/);
  await assert.rejects(readAffectedListingsAsync(ABSENT, ["src/a.ts"]), /ENOENT/);
});
