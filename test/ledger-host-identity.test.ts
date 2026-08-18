/**
 * W1-T972 — every ledger row is written by SOME process on SOME machine, and until this task
 * nothing on the row said which: nine correct crash-loop escalations were followed by a reader
 * on the OTHER host, who found a healthy unit and concluded noise. `appendLedger` (ledger.ts)
 * now stamps `host` beside the `ts` it already stamps, via an identity reader that defaults to
 * the real `os.hostname()` and is injectable ONLY because `hostname()` is constant within one
 * process — a test cannot otherwise produce two distinct real identities in a single run.
 *
 * A new, concern-scoped file rather than an addition to an existing ledger suite — ledger.ts has
 * no single `test/ledger.test.ts`; it is covered by eight concern-scoped files (ledger-atomic,
 * ledger-corpus-both-forms, ledger-grep, ledger-render-retention, ledger-repo-scope,
 * ledger-rotation-convergence, ledger-rotation, ledger-account-dimension), so a new concern takes
 * a new concern-scoped file following that established pattern.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedger } from "../src/lib/ledger.js";

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Read an ndjson ledger file back into parsed rows, in file order. */
function readLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("W1-T972: a ledger row carries the identity of the machine that wrote it", () => {
  const dir = tmpDir("rmd-ledger-host-identity-");
  try {
    const path = join(dir, "ledger.ndjson");
    appendLedger(
      path,
      { run_id: "RUN-1", task_id: "W1-T1", step: "run.start" },
      { identity: () => "Craigs-Mac-mini" },
    );
    const [line] = readLines(path);
    assert.equal(line.host, "Craigs-Mac-mini", "the row must carry the identity it was written with");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T972: two identities in one run stamp their own rows not a constant", () => {
  const dir = tmpDir("rmd-ledger-host-identity-two-");
  try {
    // Two DISTINCT ledger roots (the two cells' own local files), each driven through its own
    // injected identity in the SAME process — the only way to falsify a hardcoded/constant
    // reader, since `os.hostname()` cannot itself vary within one run.
    const pathA = join(dir, "cell-a.ndjson");
    const pathB = join(dir, "cell-b.ndjson");
    appendLedger(pathA, { run_id: "RUN-A", task_id: "W1-T1", step: "run.start" }, { identity: () => "Craigs-Mac-mini" });
    appendLedger(pathB, { run_id: "RUN-B", task_id: "W1-T1", step: "run.start" }, { identity: () => "Remudero" });

    const [lineA] = readLines(pathA);
    const [lineB] = readLines(pathB);
    assert.equal(lineA.host, "Craigs-Mac-mini");
    assert.equal(lineB.host, "Remudero");
    assert.notEqual(
      lineA.host,
      lineB.host,
      "a fixed constant would stamp the same value on both rows and fail this direction",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T972: the default identity reader runs and yields a non-empty value", () => {
  const dir = tmpDir("rmd-ledger-host-identity-default-");
  try {
    const path = join(dir, "ledger.ndjson");
    // Nothing injected — exercises the DEFAULT arm (real `os.hostname()`). Asserts
    // non-emptiness rather than a literal machine name: a test pinning one machine's name
    // would pass on that unit and fail on every other, re-creating inside the suite the exact
    // unattributability this task exists to remove.
    appendLedger(path, { run_id: "RUN-1", task_id: "W1-T1", step: "run.start" });
    const [line] = readLines(path);
    assert.equal(typeof line.host, "string", "the default arm must still stamp a host field");
    assert.ok((line.host as string).length > 0, "the default arm must yield a non-empty value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
