#!/usr/bin/env node
// worker-mcp-exposure-census — fail on any Claude worker ledger row spawned under the strict MCP boundary whose SDK init
// inventory still offered a claude.ai account connector (W1-T9489).
//
// WHY. Until W1-T9489 every fix, implement, review and recon worker inherited the fleet account's claude.ai connectors:
// 120 rows on 2026-10-13/14 listed all eight mcp__claude_ai_Claude_Docs__* tools under bypassPermissions. Every spawn is
// now strictMcpConfig with an explicit server map, and its row carries `mcp_boundary: "strict"`, so this census needs no
// date cutoff: a strict row that lists a connector is a boundary that failed, and a row without the field predates it.
//
// WHAT IT COUNTS AS EXPOSED. Any `mcp__claude_ai_*` name in `sdk_init_summary.mcpToolNames`, or any rejected server entry
// in `sdk_init_summary.serverNames`: "claude.ai Claude Docs" has spaces, so the summary never renders it and only the
// rejected count shows it. A pre-fix row is counted and reported, never failed on.
//
// USAGE.
//   node --import tsx scripts/worker-mcp-exposure-census.mjs <ledger.ndjson>...   read the named files
//   node --import tsx scripts/worker-mcp-exposure-census.mjs --state-dir <dir>     read the ledger union under <dir>
// The union read is RAW LINES filtered by pattern (readLedgerUnionRawLinesSync), never a full-record union read, which
// costs gigabytes inside the core container. Exit 0 clean, 1 on any exposed strict row, 2 on a usage error.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CONNECTOR_PREFIX = "mcp__claude_ai_";
/** Only rows that carry an init inventory are candidates; the pattern keeps the union read narrow. */
const ROW_PATTERN = /"sdk_init_summary"/;

/** Classify parsed ledger rows. Pure, so the test drives it without a ledger. */
export function censusWorkerMcpExposure(rows) {
  const exposed = [];
  let strictRows = 0;
  let preFixRows = 0;
  let preFixExposed = 0;
  for (const row of rows) {
    const summary = row?.sdk_init_summary;
    if (!summary || typeof summary !== "object") continue;
    const tools = (summary.mcpToolNames?.names ?? []).filter((name) => typeof name === "string" && name.startsWith(CONNECTOR_PREFIX));
    const rejected = Number(summary.serverNames?.rejectedEntries ?? 0) || 0;
    const isExposed = tools.length > 0 || rejected > 0;
    if (row.mcp_boundary === "strict") {
      strictRows += 1;
      if (isExposed) exposed.push({ run_id: row.run_id, step: row.step, ts: row.ts, tools, rejected_server_entries: rejected });
    } else {
      preFixRows += 1;
      if (isExposed) preFixExposed += 1;
    }
  }
  return { strictRows, preFixRows, preFixExposed, exposed };
}

function parseLines(lines) {
  const rows = [];
  for (const line of lines) {
    if (!ROW_PATTERN.test(line)) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // deliberate: a torn line is not a row; the census judges rows, and the ledger's own readers skip these the same way.
    }
  }
  return rows;
}

async function readLines(argv) {
  if (argv[0] === "--state-dir") {
    if (!argv[1]) throw new Error("--state-dir needs a directory");
    const { readLedgerUnionRawLinesSync } = await import("../src/lib/ledger-union.ts");
    return readLedgerUnionRawLinesSync(argv[1], { pattern: ROW_PATTERN }).rawLines;
  }
  if (argv.length === 0) throw new Error("name ledger files, or --state-dir <dir>");
  return argv.flatMap((path) => readFileSync(path, "utf8").split("\n"));
}

export async function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  let lines;
  try {
    lines = await readLines(argv);
  } catch (error) {
    err.write(`worker-mcp-exposure-census: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const result = censusWorkerMcpExposure(parseLines(lines));
  out.write(`worker-mcp-exposure-census: ${result.strictRows} strict-boundary row(s), ${result.preFixRows} pre-fix row(s) ` +
    `(${result.preFixExposed} of them exposed, reported only)\n`);
  for (const row of result.exposed) {
    out.write(`EXPOSED ${row.run_id} ${row.step} ${row.ts}: tools=[${row.tools.join(", ")}] ` +
      `rejected_server_entries=${row.rejected_server_entries}\n`);
  }
  return result.exposed.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
