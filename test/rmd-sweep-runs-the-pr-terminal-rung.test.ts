import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../src/lib/tmp.js";
import { readLedgerLines } from "../src/lib/status.js";
import { sweepCommand } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

test("test/rmd-sweep-runs-the-pr-terminal-rung.test.ts: closed PR is previewed, appended once, and reported", async (t) => {
  const home = makeTempDir("sweep-terminal");
  const root = join(home, "Remudero");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const prUrl = "https://github.com/craigoley/remudero-sandbox/pull/42";
  const shim = ghShim([
    { when: "state=closed", stdout: JSON.stringify([{
      number: 42, html_url: prUrl, state: "closed", merged_at: null,
      closed_at: "2026-10-04T01:02:03Z", updated_at: "2026-10-04T01:02:03Z",
      title: "closed taskless PR", body: "",
      head: { ref: "closed-taskless", sha: "head42" }, base: { ref: "main" },
    }]) },
    { when: "", stdout: "[]" },
  ], { kind: "sweep-terminal-gh" });
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"),
    JSON.stringify({ root, claudeBin: "/bin/true" }));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify({ step: "pr.opened", pr_url: prUrl }) + "\n");
  process.env.HOME = home;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  const output: string[] = [];
  t.mock.method(console, "log", (message: string) => output.push(message));
  const terminalRows = () => readLedgerLines(ledgerPath).filter((row) => row.step === "pr.terminal");

  assert.equal(await sweepCommand(["--repo", "remudero-sandbox", "--dry-run"]), 0);
  assert.deepEqual(terminalRows(), []);
  const previewOutput = output.join("\n");

  output.length = 0;
  assert.equal(await sweepCommand(["--repo", "remudero-sandbox"]), 0);
  const rows = terminalRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pr_url, prUrl);
  assert.equal(rows[0].pr_number, 42);
  assert.equal(rows[0].state, "closed");
  assert.equal(rows[0].source, "sweep.pr_terminal");
  assert.match(previewOutput, /pr terminal: 1 named PR\(s\).*0 appended/);
  assert.ok(shim.calls().some((call) => call.includes("state=closed")), "the gateway reads the fake closed PR corpus");
  assert.match(output.join("\n"), /pr terminal: 1 named PR\(s\).*1 appended/);

  output.length = 0;
  assert.equal(await sweepCommand(["--repo", "remudero-sandbox"]), 0);
  assert.equal(terminalRows().length, 1);
  assert.match(output.join("\n"), /pr terminal: 1 named PR\(s\).*0 appended/);
});
