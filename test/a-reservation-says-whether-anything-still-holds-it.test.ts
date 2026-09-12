import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  RESERVATION_AUDIT_ISO_RE,
  RUN_BRANCH_TASK_REF_RE,
  classifyReservationAuditRows,
  nextTaskIdCommand,
  reservationAuditHistoryIds,
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
  assert.equal(RESERVATION_AUDIT_ISO_RE.test(OLD), true);
  assert.equal(RESERVATION_AUDIT_ISO_RE.test("not an iso date"), false);
  assert.equal(RUN_BRANCH_TASK_REF_RE.exec("refs/heads/run-W1-T103-1789")?.[1], "W1-T103");
  assert.equal(RUN_BRANCH_TASK_REF_RE.exec("refs/heads/main"), null);

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

test("W1-T3300: reservation audit's default history read maps filed ids into HELD evidence ids", () => {
  const calls: string[][] = [];
  const ids = reservationAuditHistoryIds(join(process.cwd(), "plan", "tasks.yaml"), (args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "abc123\n";
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") throw new Error("no cache in this fixture");
    if (args[0] === "log") return '+- id: W1-T302\n+  title: "historical"\n+- id: W1-T999999\n';
    throw new Error(`unexpected git ${args.join(" ")}`);
  });

  assert.deepEqual(ids, new Set(["W1-T302"]));
  assert.deepEqual(
    calls.find((args) => args[0] === "log"),
    ["log", "HEAD", "-p", "--", "plan"],
    "the audit scans the repo-relative plan directory, matching the mint history source",
  );
});

// ── W1-T3300: the arms diff-coverage named. Every one is a DEGRADED or REFUSED path — the places
// this audit either declines to answer or answers "unknown" rather than guessing. An audit that
// guesses is worse than one that refuses, so these are the arms most worth pinning.

function auditDeps(over: Record<string, unknown> = {}) {
  return {
    runGit: (args: string[]) => {
      if (args[0] === "ls-remote" && args[2] === "refs/rmd-id/*") {
        return { status: 0, stdout: `0000000000000000000000000000000000000301\trefs/rmd-id/W1-T301\n`, stderr: "" };
      }
      if (args[0] === "fetch") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "log") return { status: 0, stdout: `rmd-id reservation 9@host ${OLD}\n`, stderr: "" };
      if (args[0] === "ls-remote" && args[1] === "--heads") return { status: 0, stdout: "", stderr: "" };
      return { status: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    },
    openPrTexts: () => [] as string[],
    auditHistoryIds: () => [] as number[],
    auditNowMs: () => NOW,
    ...over,
  };
}

async function runAudit(args: string[], deps: Record<string, unknown>, planPath: string) {
  const cap = captureConsole();
  try {
    const code = await nextTaskIdCommand(["--audit", "--plan", planPath, ...args], {}, deps as never);
    return { code, out: cap.out.join("\n"), err: cap.err.join("\n") };
  } finally {
    cap.restore();
  }
}

test("W1-T3300: an open PR's Remudero-Task trailer counts as holding evidence", async () => {
  const planPath = planFixture();
  const r = await runAudit([], auditDeps({ openPrTexts: () => ["chore: x\n\nRemudero-Task: W1-T301\n"] }), planPath);
  assert.equal(r.code, 0);
  assert.match(r.out, /W1-T301 HELD/, "a trailer in an open PR is exactly the evidence this audit exists to find");
});

test("W1-T3300: a THROWING reservation-ref read reports unknown, never an empty reservation set", async () => {
  const planPath = planFixture();
  const deps = auditDeps({
    runGit: (args: string[]) => {
      if (args[0] === "ls-remote" && args[2] === "refs/rmd-id/*") throw new Error("network down");
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  const r = await runAudit([], deps, planPath);
  assert.equal(r.code, 2, "an unreadable reservation namespace must refuse, not report zero reservations");
  assert.match(r.err, /cannot read origin refs\/rmd-id/);
});

test("W1-T3300: a THROWING run-branch read leaves every row UNKNOWN rather than CANDIDATE", async () => {
  const planPath = planFixture();
  const deps = auditDeps({
    runGit: (args: string[]) => {
      if (args[0] === "ls-remote" && args[1] === "--heads") throw new Error("network down");
      if (args[0] === "ls-remote" && args[2] === "refs/rmd-id/*") {
        return { status: 0, stdout: `0000000000000000000000000000000000000301\trefs/rmd-id/W1-T301\n`, stderr: "" };
      }
      if (args[0] === "fetch") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "log") return { status: 0, stdout: `rmd-id reservation 9@host ${OLD}\n`, stderr: "" };
      return { status: 1, stdout: "", stderr: "unexpected" };
    },
  });
  const r = await runAudit([], deps, planPath);
  assert.equal(r.code, 0);
  assert.match(r.out, /W1-T301 UNKNOWN/, "a failed branch read must never be read as 'no branch holds it'");
  assert.match(r.out, /open run branch read failed/);
});

test("W1-T3300: --offline SAYS the open-PR read was skipped, so an unread source is never silence", async () => {
  const planPath = planFixture();
  const r = await runAudit(["--offline"], auditDeps(), planPath);
  assert.equal(r.code, 0);
  assert.match(r.out, /--offline: open PRs were not read/, "a degraded input has to be named in the report itself");
});

test("W1-T3300: --audit-age-days REFUSES a non-numeric or negative threshold rather than defaulting", async () => {
  const planPath = planFixture();
  for (const bad of ["not-a-number", "-3"]) {
    const cap = captureConsole();
    let code: number;
    try {
      code = await nextTaskIdCommand(["--audit", "--plan", planPath, "--audit-age-days", bad], {}, auditDeps() as never);
    } finally {
      cap.restore();
    }
    assert.equal(code, 2, `${bad} must refuse`);
    assert.match(cap.err.join("\n"), /must be a non-negative number/);
  }
});

test("W1-T3300: --audit and --reserve are refused together — the audit is read-only and reserve writes", async () => {
  const planPath = planFixture();
  const cap = captureConsole();
  let code: number;
  try {
    code = await nextTaskIdCommand(["--audit", "--reserve", "--plan", planPath], {}, auditDeps() as never);
  } finally {
    cap.restore();
  }
  assert.equal(code, 2);
  assert.match(cap.err.join("\n"), /contradictory/, "a read-only report must never silently become a write");
});

test("W1-T3300: --reserve and --offline stay contradictory, the pre-existing refusal this verb already had", async () => {
  const cap = captureConsole();
  let code: number;
  try {
    code = await nextTaskIdCommand(["--reserve", "--offline"], {}, auditDeps() as never);
  } finally {
    cap.restore();
  }
  assert.equal(code, 2, "the audit flags must not have weakened the reserve/offline refusal beside them");
});
