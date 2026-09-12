import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyReservationAuditRows,
  nextTaskIdCommand,
  type ReservationAuditRef,
} from "../src/run-task.js";

const NOW = Date.parse("2026-09-12T00:00:00.000Z");
const OLD = "2026-08-20T00:00:00.000Z";
const RECENT = "2026-09-10T00:00:00.000Z";

function planFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-reservation-audit-"));
  const p = join(dir, "tasks.yaml");
  writeFileSync(
    p,
    [
      "- id: W1-T101",
      '  title: "declared"',
      "  repo: remudero",
      "  type: implement",
      "  depends_on: []",
      "  status: queued",
      "",
    ].join("\n"),
  );
  return p;
}

function reservation(id: number, iso = OLD): ReservationAuditRef {
  return {
    id,
    taskId: `W1-T${id}`,
    ref: `refs/rmd-id/W1-T${id}`,
    sha: `${id}`.padStart(40, "0"),
    anchor: `rmd-id reservation 9@host ${iso}`,
  };
}

function captureConsole(): { out: string[]; err: string[]; restore(): void } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void err.push(args.join(" "));
  return {
    out,
    err,
    restore() {
      console.log = log;
      console.error = error;
    },
  };
}

test("reservation audit classifies every readable reservation, and HELD rows name the holding evidence", () => {
  const rows = classifyReservationAuditRows({
    reservations: [reservation(101), reservation(102), reservation(103), reservation(104), reservation(105), reservation(106, RECENT)],
    declaredIds: new Set(["W1-T101"]),
    historicalIds: new Set(["W1-T102"]),
    openRunBranchesById: new Map([["W1-T103", ["run-W1-T103-1789"]]]),
    openPrTrailerIds: new Set(["W1-T104"]),
    thresholdDays: 14,
    nowMs: NOW,
  });

  assert.deepEqual(
    rows.map((r) => [r.taskId, r.status, r.reasons.join("|")]),
    [
      ["W1-T101", "HELD", "declared shard"],
      ["W1-T102", "HELD", "historical shard"],
      ["W1-T103", "HELD", "open run branch run-W1-T103-1789"],
      ["W1-T104", "HELD", "open PR trailer"],
      ["W1-T105", "CANDIDATE", "no holding evidence older than threshold"],
      ["W1-T106", "HELD", "younger than threshold"],
    ],
  );
});

test("reservation audit reports UNKNOWN, never CANDIDATE, when the open-PR read is degraded", () => {
  const [row] = classifyReservationAuditRows({
    reservations: [reservation(201)],
    declaredIds: new Set(),
    historicalIds: new Set(),
    openRunBranchesById: new Map(),
    openPrTrailerIds: "unknown",
    thresholdDays: 14,
    nowMs: NOW,
  });

  assert.equal(row.status, "UNKNOWN");
  assert.deepEqual(row.reasons, ["open PR read failed"]);
});

test("reservation audit states and applies the age threshold, so changing it moves candidates", async () => {
  const planPath = planFixture();
  const calls: string[][] = [];
  let fetched = "";
  const runGit = (args: string[]) => {
    calls.push(args);
    if (args[0] === "ls-remote" && args[2] === "refs/rmd-id/*") {
      return {
        status: 0,
        stdout: [
          "0000000000000000000000000000000000000301\trefs/rmd-id/W1-T301",
          "0000000000000000000000000000000000000302\trefs/rmd-id/W1-T302",
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    if (args[0] === "fetch") {
      fetched = args[2] ?? "";
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "log") {
      const iso = fetched.endsWith("W1-T301") ? "2026-09-02T00:00:00.000Z" : OLD;
      return { status: 0, stdout: `rmd-id reservation 9@host ${iso}\n`, stderr: "" };
    }
    if (args[0] === "ls-remote" && args[1] === "--heads") return { status: 0, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };

  const cap14 = captureConsole();
  try {
    assert.equal(
      await nextTaskIdCommand(["--audit", "--audit-age-days", "14", "--plan", planPath], {}, {
        runGit,
        openPrTexts: () => [],
        auditHistoryIds: () => [],
        auditNowMs: () => NOW,
      }),
      0,
    );
  } finally {
    cap14.restore();
  }
  assert.match(cap14.out.join("\n"), /age threshold: 14 day\(s\)/);
  assert.match(cap14.out.join("\n"), /W1-T301 HELD younger than threshold/);

  const cap7 = captureConsole();
  try {
    assert.equal(
      await nextTaskIdCommand(["--audit", "--audit-age-days", "7", "--plan", planPath], {}, {
        runGit,
        openPrTexts: () => [],
        auditHistoryIds: () => [],
        auditNowMs: () => NOW,
      }),
      0,
    );
  } finally {
    cap7.restore();
  }
  assert.match(cap7.out.join("\n"), /age threshold: 7 day\(s\)/);
  assert.match(cap7.out.join("\n"), /W1-T301 CANDIDATE no holding evidence older than threshold/);

  const destructive = calls.filter((args) => ["push", "update-ref", "delete"].includes(args[0] ?? ""));
  assert.deepEqual(destructive, [], "audit issues no destructive git command");
});

test("reservation audit degrades the shipped CLI report to UNKNOWN when open PR enumeration throws", async () => {
  const planPath = planFixture();
  const cap = captureConsole();
  try {
    const code = await nextTaskIdCommand(["--audit", "--plan", planPath], {}, {
      runGit: (args) => {
        if (args[0] === "ls-remote" && args[2] === "refs/rmd-id/*") {
          return { status: 0, stdout: "0000000000000000000000000000000000000401\trefs/rmd-id/W1-T401\n", stderr: "" };
        }
        if (args[0] === "fetch") return { status: 0, stdout: "", stderr: "" };
        if (args[0] === "log") return { status: 0, stdout: `rmd-id reservation 9@host ${OLD}\n`, stderr: "" };
        if (args[0] === "ls-remote" && args[1] === "--heads") return { status: 0, stdout: "", stderr: "" };
        return { status: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
      },
      openPrTexts: () => {
        throw new Error("REST budget exhausted");
      },
      auditHistoryIds: () => [],
      auditNowMs: () => NOW,
    });
    assert.equal(code, 0);
  } finally {
    cap.restore();
  }

  const text = cap.out.join("\n");
  assert.match(text, /DEGRADED: open PR read failed: Error: REST budget exhausted/);
  assert.match(text, /W1-T401 UNKNOWN open PR read failed/);
});
