import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAUDE_CODE_TOOL_WRAPPERS,
  IsolationError,
  assessIsolation,
  isolationProbePrompt,
  isolationProbeSpawnArgs,
  parseIsolationReport,
  probeIsolation,
  type ProbeExecResult,
} from "../src/lib/isolation.js";

// ── The PURE verdict (the falsifier lives here, LLM-free) ───────────────────

test("assessIsolation: 0 aliases + 0 functions ⇒ isolated", () => {
  const v = assessIsolation({ aliasCount: 0, functionCount: 0 });
  assert.equal(v.isolated, true);
});

test("assessIsolation: NONZERO alias count ⇒ FAILS CLOSED, reason carries the observed count", () => {
  const v = assessIsolation({ aliasCount: 3, functionCount: 0 });
  assert.equal(v.isolated, false);
  assert.match(v.reason, /3 alias/);
});

test("assessIsolation: NONZERO function count ⇒ FAILS CLOSED, reason carries the observed count", () => {
  const v = assessIsolation({ aliasCount: 0, functionCount: 5 });
  assert.equal(v.isolated, false);
  assert.match(v.reason, /5 function/);
});

test("assessIsolation: an UNPARSEABLE count (NaN) ⇒ FAILS CLOSED (unproven is not a pass)", () => {
  const v = assessIsolation({ aliasCount: NaN, functionCount: 0 });
  assert.equal(v.isolated, false);
  assert.match(v.reason, /UNPROVEN/i);
});

// ── parseIsolationReport ─────────────────────────────────────────────────────

test("parseIsolationReport: extracts both counts from the probe's REPORT block", () => {
  const r = parseIsolationReport("some preamble\nREPORT\naliases: 4\nfunctions: 2\n");
  assert.deepEqual(r, { aliasCount: 4, functionCount: 2 });
});

test("parseIsolationReport: no REPORT block ⇒ null (unparseable)", () => {
  assert.equal(parseIsolationReport("the worker said nothing useful"), null);
});

// ── isolationProbeSpawnArgs: READ-ONLY BY CONSTRUCTION ───────────────────────

test("isolationProbeSpawnArgs: restricts the tool set to Bash ONLY — no Write/Edit/NotebookEdit/MultiEdit ever in context", () => {
  const args = isolationProbeSpawnArgs({ cwd: "/tmp/x", settingsFile: "/tmp/settings.json", budgetUsd: 5 });
  assert.deepEqual(args.tools, ["Bash"]);
  assert.equal(args.tools?.includes("Write"), false);
  assert.equal(args.tools?.includes("Edit"), false);
  assert.equal(args.permissionMode, "bypassPermissions");
  assert.equal(args.settingsFile, "/tmp/settings.json");
  assert.equal(args.maxBudgetUsd, 5);
});

test("isolationProbePrompt: instructs Bash-only commands and explicitly forbids writing", () => {
  const p = isolationProbePrompt();
  assert.match(p, /alias \| wc -l/);
  assert.match(p, /declare -F \| awk/); // functions counted via awk (not the CC-wrapped grep)
  assert.match(p, /READ-ONLY/i);
  assert.match(p, /no write tool available/i);
});

test("isolationProbePrompt: EXCLUDES Claude Code's own find/grep/rg tool wrappers from the function count (not operator state)", () => {
  const p = isolationProbePrompt();
  // The awk filter names every Claude Code wrapper, so the count is operator-only.
  for (const w of CLAUDE_CODE_TOOL_WRAPPERS) {
    assert.ok(p.includes(w), `the prompt's exclusion filter must name the Claude Code wrapper '${w}'`);
  }
  assert.match(p, /\$NF !~/); // awk excludes functions whose name matches a wrapper
  // The wrappers are exactly find/grep/rg — a tight, explicit list (fail-closed on any other name).
  assert.deepEqual([...CLAUDE_CODE_TOOL_WRAPPERS], ["find", "grep", "rg"]);
});

// ── probeIsolation: the fail-closed gate, via an injected executor ──────────

const cleanExec = (): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0", aliasCount: 0, functionCount: 0, costUsd: 0 });

test("probeIsolation: a CLEAN worker (0 aliases, 0 functions) PROCEEDS", async () => {
  const res = await probeIsolation({ settingsFile: "unused", exec: cleanExec });
  assert.equal(res.isolated, true);
  assert.equal(res.evidence.aliasCount, 0);
  assert.equal(res.evidence.functionCount, 0);
});

test("probeIsolation: a CONTAMINATED worker (nonzero alias count) FAILS CLOSED and names the count", async () => {
  await assert.rejects(
    () =>
      probeIsolation({
        settingsFile: "unused",
        exec: async () => ({ transcript: "REPORT\naliases: 7\nfunctions: 0", aliasCount: 7, functionCount: 0 }),
      }),
    (e: unknown) =>
      e instanceof IsolationError &&
      /isolation_preflight_failed/.test((e as Error).message) &&
      /7 alias/.test((e as Error).message),
  );
});

test("probeIsolation: a CONTAMINATED worker (nonzero function count) FAILS CLOSED and names the count", async () => {
  await assert.rejects(
    () =>
      probeIsolation({
        settingsFile: "unused",
        exec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 2", aliasCount: 0, functionCount: 2 }),
      }),
    (e: unknown) => e instanceof IsolationError && /2 function/.test((e as Error).message),
  );
});

test("probeIsolation: logs isolation_preflight_failed with the OBSERVED count on the failing path", async () => {
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  await assert.rejects(() =>
    probeIsolation({
      settingsFile: "unused",
      log: (step, extra) => events.push({ step, extra }),
      exec: async () => ({ transcript: "REPORT\naliases: 9\nfunctions: 0", aliasCount: 9, functionCount: 0 }),
    }),
  );
  const failed = events.find((e) => e.step === "isolation_preflight_failed");
  assert.ok(failed, "must ledger a dedicated isolation_preflight_failed event");
  assert.equal(failed?.extra?.alias_count, 9);
  assert.equal(failed?.extra?.function_count, 0);
});

test("probeIsolation: a CLEAN run never logs isolation_preflight_failed", async () => {
  const events: string[] = [];
  await probeIsolation({ settingsFile: "unused", log: (step) => events.push(step), exec: cleanExec });
  assert.equal(events.includes("isolation_preflight_failed"), false);
});

// ── OBSERVABILITY: NAME the inherited state, not just count it ────────────────
// (the live incident: three W3-T1a blocked_isolation runs at "1 function", CC
// auto-update in the window, five operator diagnostics where one name sufficed)

test("isolationProbePrompt: also requests the alias_names / function_names lines (same wrapper exclusion for functions)", () => {
  const p = isolationProbePrompt();
  assert.match(p, /alias_names:/);
  assert.match(p, /function_names:/);
  // Command 4 lists function NAMES under the SAME find/grep/rg exclusion as the count.
  assert.match(p, /printf "%s ", \$NF/);
  for (const w of CLAUDE_CODE_TOOL_WRAPPERS) assert.ok(p.includes(w));
});

test("parseIsolationReport: extracts the NAMES when the report carries them", () => {
  const r = parseIsolationReport("REPORT\naliases: 2\nfunctions: 1\nalias_names: cc gg\nfunction_names: claude");
  assert.deepEqual(r, { aliasCount: 2, functionCount: 1, aliasNames: "cc gg", functionNames: "claude" });
});

test("parseIsolationReport: names RESPECT the CLAUDE_CODE_TOOL_WRAPPERS exclusion (find/grep/rg stripped from function names)", () => {
  const r = parseIsolationReport(
    "REPORT\naliases: 0\nfunctions: 1\nalias_names: -\nfunction_names: claude grep find rg",
  );
  // Only the real operator function survives; the injected wrappers are stripped, matching the count's exclusion.
  assert.equal(r?.functionNames, "claude");
  assert.equal(r?.aliasNames, undefined); // "-" ⇒ no names
});

test("parseIsolationReport: an OLD-prompt report (no name lines) parses to the exact same shape as before (byte-identical)", () => {
  const r = parseIsolationReport("preamble\nREPORT\naliases: 4\nfunctions: 2\n");
  assert.deepEqual(r, { aliasCount: 4, functionCount: 2 }); // no aliasNames/functionNames keys
});

test("assessIsolation: a nonzero verdict with NAMES surfaces them in the reason (one name replaces a diagnostics session)", () => {
  const v = assessIsolation({ aliasCount: 0, functionCount: 1, functionNames: "claude" });
  assert.equal(v.isolated, false);
  assert.match(v.reason, /1 function\(s\) \[claude\]/);
});

test("assessIsolation: a nonzero verdict WITHOUT names is byte-identical to the count-only reason (regression lock)", () => {
  const named = assessIsolation({ aliasCount: 3, functionCount: 0 });
  assert.equal(
    named.reason,
    "worker inherited 3 alias(es) and 0 function(s) from operator shell state — isolation is NOT holding on this host/run",
  );
});

test("probeIsolation: the IsolationError NAMES the inherited functions when the probe reported them", async () => {
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  await assert.rejects(
    () =>
      probeIsolation({
        settingsFile: "unused",
        log: (step, extra) => events.push({ step, extra }),
        exec: async (): Promise<ProbeExecResult> => ({
          transcript: "REPORT\naliases: 0\nfunctions: 1\nalias_names: -\nfunction_names: claude",
          aliasCount: 0,
          functionCount: 1,
          functionNames: "claude",
        }),
      }),
    (e: unknown) => e instanceof IsolationError && /1 function\(s\) \[claude\]/.test((e as Error).message),
  );
  // The named state is also on the dedicated ledger event.
  const failed = events.find((e) => e.step === "isolation_preflight_failed");
  assert.equal(failed?.extra?.function_names, "claude");
});
