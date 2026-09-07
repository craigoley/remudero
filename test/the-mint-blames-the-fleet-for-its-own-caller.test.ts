import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  classifyReservationAnchor,
  describeContestedId,
  nextTaskIdCommand,
  readReservationHolder,
} from "../src/run-task.js";
import { type RemoteRefReserver, type RemoteReserveOutcome } from "../src/lib/task-id-reservation.js";

const NO_OPEN_PRS = (): string[] => [];

function planFixture(maxId: number): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-mint-self-holder-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, `- id: W1-T${maxId}\n  title: fixture\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n`);
  return planPath;
}

function captureConsole(t: TestContext): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(console, "log", (...a: unknown[]) => void out.push(a.map(String).join(" ")));
  t.mock.method(console, "error", (...a: unknown[]) => void err.push(a.map(String).join(" ")));
  return { out, err };
}

function holderRun(message: string): (args: string[]) => { status: number | null; stdout: string; stderr: string } {
  return (args) =>
    args[0] === "fetch"
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 0, stdout: message, stderr: "" };
}

test("W1-T2685: this caller's reservation anchor is reported as this caller", () => {
  const message = "rmd-id reservation 4242@mint-host 2026-09-02T12:00:00.000Z";
  assert.equal(classifyReservationAnchor(message, { pid: 4242, host: "mint-host" }), "self");
  assert.equal(readReservationHolder("W1-T2685", holderRun(message), { pid: 4242, host: "mint-host" }), "self");

  const line = describeContestedId("W1-T2685", "self");
  assert.match(line, /HELD BY THIS CALLER/);
  assert.doesNotMatch(line, /the fleet/);
  assert.doesNotMatch(line, /HELD BY ANOTHER CALLER/);
});

test("W1-T2685: the default caller identity recognizes this process's own anchor", () => {
  const message = `rmd-id reservation ${process.pid}@${hostname()} 2026-09-02T12:00:00.000Z`;
  assert.equal(readReservationHolder("W1-T2685", holderRun(message)), "self");
});

test("W1-T2685: another caller's reservation anchor is still reported as the fleet", () => {
  const message = "rmd-id reservation 4242@other-host 2026-09-02T12:00:00.000Z";
  assert.equal(classifyReservationAnchor(message, { pid: 4242, host: "mint-host" }), "fleet");
  assert.equal(readReservationHolder("W1-T2686", holderRun(message), { pid: 4242, host: "mint-host" }), "fleet");

  const line = describeContestedId("W1-T2686", "fleet");
  assert.match(line, /HELD BY ANOTHER CALLER/);
  assert.match(line, /the fleet/);
  assert.match(line, /rmd-id reservation/);
});

test("W1-T2685: an unreadable holder is reported as unreadable rather than guessed", () => {
  const message = "reservation without a caller identity";
  assert.equal(classifyReservationAnchor(message, { pid: 4242, host: "mint-host" }), "unknown");
  assert.equal(readReservationHolder("W1-T2687", holderRun(message), { pid: 4242, host: "mint-host" }), "unknown");

  const line = describeContestedId("W1-T2687", "unknown");
  assert.match(line, /holder shape unreadable from here/);
  assert.doesNotMatch(line, /the fleet/);
});

test("W1-T2685: --reserve recomputes the advisory line to the id it actually holds", async (t) => {
  const attempted: string[] = [];
  const reserver: RemoteRefReserver = {
    mintAnchor: () => "anchor",
    attempt(taskId: string): RemoteReserveOutcome {
      attempted.push(taskId);
      return taskId === "W1-T4" ? "created" : "taken";
    },
  };
  const cap = captureConsole(t);

  const code = await nextTaskIdCommand(["--reserve", "--plan", planFixture(1)], {}, {
    reserver,
    holderOf: () => "self",
    openPrTexts: NO_OPEN_PRS,
  });

  assert.equal(code, 0);
  assert.deepEqual(attempted, ["W1-T2", "W1-T3", "W1-T4"], "the reservation walk is unchanged");
  assert.match(cap.out[0], /^W1-T4 \(max 3 across /, "the top advisory names the id the winning attempt took");
  assert.match(cap.out.join("\n"), /^RESERVED W1-T4 on origin \(refs\/rmd-id\/W1-T4\) after 3 attempt\(s\)$/m);
  assert.doesNotMatch(cap.out.join("\n"), /advisory mint printed W1-T2/, "no corrective note is needed for a stale advisory");
});

test("W1-T2685: a non-reserve advisory namespace failure leaves the mint printable", async (t) => {
  const cap = captureConsole(t);
  const code = await nextTaskIdCommand(["--plan", planFixture(1)], {}, {
    openPrTexts: NO_OPEN_PRS,
    runGit: () => {
      throw new Error("namespace unavailable");
    },
  });

  assert.equal(code, 0);
  assert.match(cap.out[0], /^W1-T2 \(max 1 across /);
  assert.equal(cap.err.length, 0);
});
