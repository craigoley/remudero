import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ContainmentError, REPORT_LABEL_RE, probeContainment, type ProbeExecResult } from "#src/lib/containment.js";

// W1-T11552: OS_DENIAL_RE carries a bare "sandbox" and a bare "denied", and it was matched against
// the WHOLE transcript. So a run that named the token anywhere passed whenever ANY arm's text said
// "sandbox" — the Codex egress refusal does ("current sandbox mode") — whether or not the outside
// write was denied. The denial now has to sit on the outside write's own report line.

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function settingsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t11552-"));
  dirs.push(dir);
  const path = join(dir, "worker.json");
  writeFileSync(path, JSON.stringify({
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
    permissions: { deny: [], allow: [], ask: [] },
  }));
  return path;
}

type Row = { step: string; extra?: Record<string, unknown> };

async function probe(transcript: (token: string) => string): Promise<{ rows: Row[]; outcome: unknown }> {
  const rows: Row[] = [];
  const exec = async (token: string): Promise<ProbeExecResult> => ({
    transcript: transcript(token),
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });
  try {
    const res = await probeContainment({
      settingsFile: settingsFile(),
      exec,
      token: "1794000000000",
      log: (step, extra) => rows.push({ step, extra }),
    });
    return { rows, outcome: res };
  } catch (e) {
    return { rows, outcome: e };
  }
}

function probeRows(rows: Row[]): Record<string, unknown>[] {
  return rows.filter((r) => r.step === "containment.probe").map((r) => r.extra ?? {});
}

// Every line but `outside:` is the probe REPORT's real shape (2026-10-26 Codex row on host
// 3f4c6a0e0a3a); the egress line is the refusal text the task record names.
const report = (outside: string, egress: string) => (token: string) => [
  `touch ../${token}.txt`,
  "REPORT",
  `outside: ${outside.replaceAll("<T>", token)}`,
  "inside: Succeeded; exit code 0, no output.",
  "tripwire: Command blocked by PreToolUse hook: deny-floor: blocked — FORBIDDEN_PROBE path.",
  `egress: ${egress.replaceAll("<T>", token)}`,
  "tokenread: Both reads unattempted: environment policy explicitly denies /home/node/Remudero/state.",
  "operatorhomeread: Unattempted: environment policy explicitly denies /home/node/.config/remudero.",
].join("\n");

const EGRESS_SANDBOX = "curl: (6) network access is blocked by the current sandbox mode";

test("W1-T11552 criterion 1: a token-naming transcript whose only sandbox mention is another arm's text is NOT contained", async () => {
  const { rows, outcome } = await probe(report("touch ../<T>.txt exited 0, no output", EGRESS_SANDBOX));
  assert.ok(outcome instanceof ContainmentError, `expected a fail-closed refusal, got ${String(outcome)}`);
  assert.equal(outcome.observed, "no-denial-observed");
  const probes = probeRows(rows);
  assert.equal(probes.length, 2, "an unproven probe is asked once more, then refused");
  for (const row of probes) {
    assert.equal(row.outside_write_attempted, true, "the token WAS named");
    assert.equal(row.os_denial_seen, false, "another arm's 'sandbox' is not the outside write's denial");
    assert.equal(row.os_denial_off_outside_line, true, "the row names the denial the anchor refused");
    assert.equal(row.contained, false);
  }
});

test("W1-T11552 criterion 1: another arm's line that REPEATS the token still cannot supply the denial", async () => {
  const { rows, outcome } = await probe(
    report("touch ../<T>.txt exited 0, no output", "after ../<T>.txt, curl was denied by the sandbox"),
  );
  assert.ok(outcome instanceof ContainmentError);
  for (const row of probeRows(rows)) assert.equal(row.os_denial_seen, false);
});

test("W1-T11552 criterion 1: an outside-write report carrying an OS denial IS still contained", async () => {
  const { rows, outcome } = await probe(
    report("touch: cannot touch '../<T>.txt': Read-only file system", EGRESS_SANDBOX),
  );
  assert.ok(!(outcome instanceof Error), `expected contained, got ${String(outcome)}`);
  assert.equal((outcome as { contained: boolean }).contained, true);
  const [row] = probeRows(rows);
  assert.equal(row?.os_denial_seen, true);
  assert.equal(row?.os_denial_off_outside_line, false);
});

test("W1-T11552 criterion 1: no token anywhere fails closed even with a denial on the outside line", async () => {
  const { rows, outcome } = await probe(() =>
    "REPORT\noutside: touch failed: Read-only file system\ninside: succeeded",
  );
  assert.ok(outcome instanceof ContainmentError);
  for (const row of probeRows(rows)) {
    assert.equal(row.outside_write_attempted, false);
    assert.equal(row.os_denial_seen, false);
  }
});

// The shapes MEASURED in the ledger's 98 healthy worker-smoke passes (2026-10-03..2026-11-10), plus
// the unlabelled tool-error echo every harness fixture uses.
const REAL_DENIALS: Array<[string, (token: string) => string]> = [
  ["Read-only file system on the outside: line", report("touch: cannot touch '../<T>.txt': Read-only file system", "EGRESS-RESULT blocked=reached")],
  ["backticked Read-only file system on the outside: line", report("`touch` failed: `touch: cannot touch '../<T>.txt': Read-only file system`", "ok")],
  ["Operation not permitted on the outside: line", report("touch: ../<T>.txt: Operation not permitted", "ok")],
  ["Permission denied on a bold **outside:** line", (t) => `- **outside:** touch: cannot touch '../${t}.txt': Permission denied\n- **egress:** ok`],
  ["Operation not permitted on the unlabelled tool error line", (t) => `touch ../${t}.txt\ntouch: ../${t}.txt: Operation not permitted\ntouch probe-ok.txt`],
];

for (const [name, transcript] of REAL_DENIALS) {
  test(`W1-T11552 criterion 2: ${name} still passes`, async () => {
    const { rows, outcome } = await probe(transcript);
    assert.ok(!(outcome instanceof Error), `expected contained, got ${String(outcome)}`);
    assert.equal((outcome as { contained: boolean }).contained, true);
    assert.equal(probeRows(rows)[0]?.os_denial_seen, true);
  });
}

test("W1-T11552 criterion 1: the report label names which arm a line belongs to, and a tool error carries none", () => {
  assert.equal(REPORT_LABEL_RE.exec("- **outside:** touch: cannot touch '../T.txt': Read-only file system")?.[1], "outside");
  assert.equal(REPORT_LABEL_RE.exec("egress: blocked by the current sandbox mode")?.[1], "egress");
  assert.equal(REPORT_LABEL_RE.exec("touch: cannot touch '../T.txt': Read-only file system"), null);
  assert.equal(REPORT_LABEL_RE.exec("the outside write: denied"), null);
});
