/**
 * test/overlap-advisory-outage.test.ts — W1-T2606.
 *
 * THE OVERLAP ADVISORY CANNOT SAY IT DID NOT LOOK. `overlapWarningLinesFor`'s failure arm used to
 * be `catch { return []; }` — a rate-limited open-PR read rendered as "no overlap", which is byte
 * -identical to a genuine clean read. This suite proves the successor contract:
 *
 *  (1) a FAILED scope read yields exactly one named outage line; a SUCCEEDED read that finds no
 *      overlap still yields zero lines — the two are distinguishable in the OUTPUT.
 *  (2) the advisory stays advisory: the printed id, the reservation notice and the exit code are
 *      byte-identical across the succeeded/no-overlap/could-not-read arms, and no arm throws.
 *  (4) `--offline` announces that the open-PR files surface was not consulted — deliberate
 *      suppression never reads as a clean check either.
 *
 * Criterion 3 (the outage reuses {@link MintDegradation}'s own shape rather than a second parallel
 * one) is proven by grep, not here — `ScopeReadOutage` is exported from src/run-task.ts. Criterion
 * 5 (W1-T917's shipped suite updated to the successor contract) lives in
 * test/next-task-id-overlap-warning.test.ts, declared alongside this file.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  nextTaskIdCommand,
  overlapAdvisoryLines,
  overlapWarningLinesFor,
  scopeReadOutageLine,
  type ScopeReadOutage,
} from "../src/run-task.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { OpenPrFileScope } from "../src/lib/dispatch-overlap.js";

function task(id: string, files: string[]): Task {
  return { id, files } as unknown as Task;
}

/** Same 100-shard fixture as W1-T917's own suite: src/lib/plan.ts is rare (2/100), src/run-task.ts
 *  is a hub (37/100) — so a warning fires only where rarity, not mere sharing, says it should. */
function planFixture(): Plan {
  const tasks: Task[] = [];
  for (let i = 0; i < 37; i++) tasks.push(task(`W1-H${i}`, ["src/run-task.ts"]));
  tasks.push(task("W1-R1", ["src/lib/plan.ts", "test/plan-sharding.test.ts"]));
  tasks.push(task("W1-R2", ["src/lib/plan.ts"]));
  for (let i = 0; i < 61; i++) tasks.push(task(`W1-F${i}`, [`src/lib/filler-${i}.ts`]));
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

const PLAN_PATH = "plan/tasks.yaml";

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  return { out, err, restore: () => { console.log = ol; console.error = oe; } };
}

// ══ criterion 1 — distinguishable in the OUTPUT, not merely internally ═══════════════════════════

test("W1-T2606: a FAILED scope read yields one named outage line, never a bare []", () => {
  const failed = overlapWarningLinesFor(["src/lib/plan.ts"], "o", "r", PLAN_PATH, {
    plan: () => planFixture(),
    scopes: () => {
      throw new Error("unreachable: getaddrinfo ENOTFOUND api.github.com");
    },
  });
  assert.equal(failed.length, 1, `expected exactly one outage line, got ${JSON.stringify(failed)}`);
  assert.match(failed[0]!, /could not be read/, "must say plainly that the read did not complete");
  assert.match(failed[0]!, /ENOTFOUND/, "must carry the underlying reason verbatim, not a generic message");
  assert.match(failed[0]!, /NOT checked/i, "must say the candidate was not confirmed clean");

  // A failed PLAN read (the other seam inside the same try) must degrade the same way.
  const planFailed = overlapWarningLinesFor(["src/lib/plan.ts"], "o", "r", PLAN_PATH, {
    plan: () => {
      throw new Error("EACCES: permission denied, open 'plan/tasks.yaml'");
    },
    scopes: () => [{ id: "#1", files: ["src/lib/plan.ts"] }],
  });
  assert.equal(planFailed.length, 1);
  assert.match(planFailed[0]!, /EACCES/);
});

test("W1-T2606: a SUCCEEDED read that finds no overlap still yields zero lines — clean stays silent", () => {
  const clean = overlapWarningLinesFor(["src/lib/plan.ts"], "o", "r", PLAN_PATH, {
    plan: () => planFixture(),
    scopes: () => [{ id: "#42", files: ["some/wholly/unrelated/file.ts"] }],
  });
  assert.deepEqual(clean, [], "a genuine clean read must remain silent — this task does not touch that arm");
});

test("W1-T2606: the outage line and a clean silent read never render the same output", () => {
  const outage = overlapWarningLinesFor(["src/lib/plan.ts"], "o", "r", PLAN_PATH, {
    plan: () => planFixture(),
    scopes: () => {
      throw new Error("boom");
    },
  });
  const clean = overlapWarningLinesFor(["src/lib/plan.ts"], "o", "r", PLAN_PATH, {
    plan: () => planFixture(),
    scopes: () => [],
  });
  assert.notDeepEqual(outage, clean, "\"could not check\" and \"checked, clean\" must never collapse onto the same []");
  assert.deepEqual(clean, [], "sanity: the clean arm really is empty");
  assert.equal(outage.length, 1, "sanity: the outage arm really does say something");
});

// ── the exported vocabulary itself, directly ──────────────────────────────────────────────────

test("W1-T2606: scopeReadOutageLine renders a ScopeReadOutage's reason, and only that shape", () => {
  const outage: ScopeReadOutage = { source: "open-prs", reason: "rate limited: X-Ratelimit-Remaining: 0" };
  const line = scopeReadOutageLine(outage);
  assert.match(line, /rate limited: X-Ratelimit-Remaining: 0/);
  assert.match(line, /could not be read/);
});

// ══ criterion 2 — the advisory stays advisory across all three arms ══════════════════════════════

test("W1-T2606: the printed id, reservation notice and exit code are identical whether the advisory warns, stays silent, or reports an outage", async () => {
  const root = mkdtempSync(join(tmpdir(), "t2606-mint-"));
  try {
    writeFileSync(join(root, "tasks.yaml"), "- id: W1-T4\n  title: seed\n  files: [src/lib/plan.ts]\n");
    const planPath = join(root, "tasks.yaml");
    const NO_OPEN_PRS = (): string[] => [];

    async function run(scopes: () => OpenPrFileScope[]) {
      const cap = capture();
      let code: number;
      try {
        code = await nextTaskIdCommand(
          ["--plan", planPath, "--files", "src/lib/plan.ts"],
          { plan: () => planFixture(), scopes },
          { openPrTexts: NO_OPEN_PRS },
        );
      } finally {
        cap.restore();
      }
      return { code, out: cap.out.join("\n"), err: cap.err.join("\n") };
    }

    // (a) warns — an open PR shares the rare path.
    const warns = await run(() => [{ id: "#1873", files: ["src/lib/plan.ts"] }]);
    // (b) succeeds, no overlap — an open PR touches something unrelated.
    const silent = await run(() => [{ id: "#9999", files: ["some/unrelated/file.ts"] }]);
    // (c) could not read — the scope read throws.
    const outage = await run(() => {
      throw new Error("API rate limit already exceeded");
    });

    const idOf = (text: string) => /^(W1-T\d+) \(max/m.exec(text)?.[1];
    const id = idOf(warns.out);
    assert.ok(id, "control: the mint printed an id at all");
    assert.equal(idOf(silent.out), id, "the minted id must not change because the advisory found nothing");
    assert.equal(idOf(outage.out), id, "the minted id must not change because the advisory COULD NOT READ");

    assert.equal(warns.code, silent.code, "exit code must be identical: warn vs silent");
    assert.equal(outage.code, silent.code, "exit code must be identical: outage vs silent — an advisory outage is not a mint failure");
    assert.equal(warns.err, "", "no arm may print to stderr — none of these refuse anything");
    assert.equal(silent.err, "");
    assert.equal(outage.err, "", "the advisory's own outage must not read as a command-level error");

    // The reservation-notice line ("... is RESERVED by a live minter ...") is best-effort and
    // config-gated; whatever it does in one arm it must do in every arm — never appear only when
    // the overlap advisory happens to have succeeded.
    const notice = /is RESERVED by a live minter/;
    assert.equal(notice.test(warns.out), notice.test(silent.out));
    assert.equal(notice.test(outage.out), notice.test(silent.out));

    // And the advisory's OWN lines are the only difference between the three transcripts — proving
    // none of it leaked into the id/reservation/exit-code triple asserted above.
    assert.match(warns.out, /#1873/, "sanity: the warn arm really did warn");
    assert.equal(silent.out.includes("#9999"), false, "a clean read never NAMES the unrelated PR");
    assert.match(outage.out, /could not be read/, "sanity: the outage arm really did report the outage");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ══ criterion 4 — --offline announces the suppression, never reads as a clean check ══════════════

test("W1-T2606: --offline announces that the open-PR files surface was not consulted", () => {
  const scopes: OpenPrFileScope[] = [{ id: "#1873", files: ["src/lib/plan.ts"] }];
  let swept = 0;
  const deps = { plan: () => planFixture(), scopes: () => { swept++; return scopes; } };

  const offlineLines = overlapAdvisoryLines(["--files", "src/lib/plan.ts"], true, "o", "r", PLAN_PATH, deps);
  assert.equal(offlineLines.length, 1, "a requested-but-suppressed check must say so, not go silent");
  assert.match(offlineLines[0]!, /--offline/);
  assert.match(offlineLines[0]!, /NOT read/);
  assert.equal(swept, 0, "the suppression must still spend nothing — only what is SAID changes, never what is SPENT");

  // Falsifier: the identical call online really does read (and here, warn) — the offline line
  // above is genuinely a suppression notice, not something printed unconditionally.
  const onlineLines = overlapAdvisoryLines(["--files", "src/lib/plan.ts"], false, "o", "r", PLAN_PATH, deps);
  assert.equal(swept, 1);
  assert.notDeepEqual(offlineLines, onlineLines, "the offline notice and the real warning must never read alike");

  // And offline suppression is distinct from "nothing was ever going to be checked": with no
  // --files at all, offline still prints nothing, because there was nothing to announce
  // not-having-read (matches the online arm's own empty-candidate silence).
  assert.deepEqual(overlapAdvisoryLines([], true, "o", "r", PLAN_PATH, deps), []);
});

test("W1-T2606: the --offline suppression notice is distinguishable from a genuine outage line", () => {
  const scopes: OpenPrFileScope[] = [];
  const offlineLine = overlapAdvisoryLines(["--files", "src/lib/plan.ts"], true, "o", "r", PLAN_PATH, {
    plan: () => planFixture(),
    scopes: () => scopes,
  })[0]!;
  const outageLine = overlapWarningLinesFor(["src/lib/plan.ts"], "o", "r", PLAN_PATH, {
    plan: () => planFixture(),
    scopes: () => {
      throw new Error("boom");
    },
  })[0]!;
  assert.notEqual(offlineLine, outageLine, "deliberate suppression and inability to read must read differently");
});
