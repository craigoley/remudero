import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { retireRecoveredHeadroomEscalations } from "#src/lib/headroom-recovery.js";

const issueUrl = "https://github.com/example/repo/issues/42";
const escalation = {
  step: "daemon.headroom_reserve.escalated",
  issue_url: issueUrl,
  window: "weekly",
  ts: "2026-11-12T10:00:00.000Z",
  resets_at: "2026-11-19T10:00:00.000Z",
};
const recovery = {
  step: "daemon.headroom",
  window: "weekly",
  ts: "2026-11-12T11:00:00.000Z",
  over_ceiling: false,
  percent_used: 12,
  limit_pct: 95,
};

function writeLedger(t: TestContext, rows: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-headroom-list-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.ndjson");
  writeFileSync(path, rows.map((row) => JSON.stringify(row) + "\n").join(""));
  return path;
}

test("W1-T12440: sweep.headroom_recovery.list_failed no longer recurs", async (t) => {
  const cases = [
    ["empty ledger", []],
    ["no recovery", [escalation]],
    ["already retired", [escalation, recovery, {
      step: "daemon.headroom_reserve.retired", issue_url: issueUrl,
    }]],
  ] as const;
  for (const [name, rows] of cases) {
    await t.test(name, async (t) => {
      const path = writeLedger(t, [...rows]);
      let listings = 0;
      const result = await retireRecoveredHeadroomEscalations(path, "sweep", {
        issues: {
          create: () => assert.fail("recovery must not create issues"),
          listOpen: async () => {
            listings++;
            throw new Error("issues API unavailable");
          },
        },
      });
      assert.equal(result.retired, 0);
      assert.equal(listings, 0, "no GitHub listing is needed without a pending recovery");
    });
  }
});

test("a pending recovery logs a failed issue listing and closes the open issue on the next sweep", async (t) => {
  const path = writeLedger(t, [escalation, recovery]);
  const labels: string[] = [];
  const closed: string[] = [];
  const failures: unknown[] = [];
  const ctx = {
    issues: {
      create: () => assert.fail("recovery must not create issues"),
      listOpen: async (label: string) => {
        labels.push(label);
        if (label !== "fleet-notice") return [];
        if (labels.length === 2) throw new Error("issues API unavailable");
        return [{ number: 42, url: issueUrl }];
      },
      closeWithComment: async (url: string, comment: string) => {
        assert.match(comment, /12% used/);
        closed.push(url);
      },
    },
    log: (step: string, extra?: Record<string, unknown>) => {
      if (step === "sweep.headroom_recovery.list_failed") failures.push(extra?.error);
    },
  };
  assert.deepEqual(await retireRecoveredHeadroomEscalations(path, "first", ctx), { retired: 0 });
  assert.deepEqual(failures, ["issues API unavailable"]);
  assert.deepEqual(closed, []);

  assert.deepEqual(await retireRecoveredHeadroomEscalations(path, "second", ctx), { retired: 1 });
  assert.deepEqual(closed, [issueUrl]);
  assert.deepEqual(await retireRecoveredHeadroomEscalations(path, "third", ctx), { retired: 0 });
  assert.deepEqual(labels, ["needs-human", "fleet-notice", "needs-human", "fleet-notice"]);
});
