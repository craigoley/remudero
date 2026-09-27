#!/usr/bin/env bash
set -euo pipefail
# Stop all cash-capable daemons before --apply; this script cannot freeze their old local writers.
node --input-type=module - "$@" <<'NODE'
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const mode = args.shift();
if (!["--dry-run", "--apply", "--report"].includes(mode)) {
  throw new Error("usage: migrate-fleet-cash-allowance.sh --dry-run|--apply DEST UTC_DAY CAP CORE SITE CONSOLE; --report DEST UTC_DAY CAP");
}
const dest = args.shift();
const day = args.shift();
const cap = Number(args.shift());
if (!dest || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? "") || !Number.isFinite(cap) || cap <= 0) {
  throw new Error("destination, UTC day, and positive cap are required");
}
if (mode === "--report" && args.length !== 0) throw new Error("--report accepts no source paths");
if (mode !== "--report" && args.length !== 3) throw new Error("migration requires exactly CORE SITE CONSOLE source files");

function checked(path) {
  const fd = openSync(path, "r");
  let raw; let source;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("allowance source is not a bounded regular file: " + path);
    source = { path, mtime: stat.mtime.toISOString(), dev: stat.dev, ino: stat.ino };
    raw = readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
  const value = JSON.parse(raw);
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.utcDay) ||
      !value.reservations || typeof value.reservations !== "object" || Array.isArray(value.reservations)) {
    throw new Error("unreadable allowance state at " + path);
  }
  for (const [id, row] of Object.entries(value.reservations)) {
    if (!id || !row || typeof row !== "object" ||
        !Number.isFinite(row.reservedUsd) || row.reservedUsd < 0 ||
        (row.settledUsd !== null && (!Number.isFinite(row.settledUsd) || row.settledUsd < 0 || row.settledUsd > row.reservedUsd)) ||
        (row.deployment !== undefined && typeof row.deployment !== "string")) {
      throw new Error("unreadable reservation at " + path + " request " + id);
    }
  }
  return { value, source };
}

function receipt(state, sources) {
  const rows = Object.values(state.reservations);
  const byDeployment = {};
  for (const row of rows) {
    const key = row.deployment ?? "unknown";
    const slot = byDeployment[key] ??= { committedUsd: 0, reservedUsd: 0, settledUsd: 0, unsettledCount: 0 };
    slot.committedUsd += row.settledUsd ?? row.reservedUsd;
    slot.reservedUsd += row.reservedUsd;
    if (row.settledUsd === null) slot.unsettledCount++;
    else slot.settledUsd += row.settledUsd;
  }
  const committedUsd = rows.reduce((sum, row) => sum + (row.settledUsd ?? row.reservedUsd), 0);
  if (committedUsd > cap) throw new Error("migrated committed spend exceeds the fleet cap");
  return { utcDay: day, capUsd: cap, committedUsd, reservedUsd: rows.reduce((sum, row) => sum + row.reservedUsd, 0),
    settledUsd: rows.reduce((sum, row) => sum + (row.settledUsd ?? 0), 0), reservations: rows.length,
    byDeployment, sources };
}

if (mode === "--report") {
  const { value: state, source } = checked(dest);
  if (state.utcDay !== day) throw new Error("shared allowance is stale for requested UTC day");
  if (state.fleetCapUsd !== cap) throw new Error("shared allowance fleet cap differs from requested cap");
  process.stdout.write(JSON.stringify({ mode, ...receipt(state, [source]) }, null, 2) + "\n");
} else {
  const merged = { utcDay: day, fleetCapUsd: cap, reservations: {} };
  const sources = [];
  for (const path of args) {
    const { value: state, source } = checked(path);
    sources.push({ ...source, utcDay: state.utcDay, requests: Object.keys(state.reservations).length });
    if (state.utcDay > day) throw new Error("source allowance is from a future UTC day: " + path);
    if (state.utcDay < day) continue;
    for (const [id, row] of Object.entries(state.reservations)) {
      const prior = merged.reservations[id];
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
        throw new Error("conflicting request identity " + id + " in " + path);
      }
      merged.reservations[id] = row;
    }
  }
  const before = receipt(merged, sources);
  if (mode === "--apply") {
    const tmp = join(dirname(dest), ".cash-allowance-" + randomUUID() + ".tmp");
    try {
      writeFileSync(tmp, JSON.stringify(merged) + "\n", { mode: 0o600, flag: "wx" });
      linkSync(tmp, dest); // atomic no-overwrite publication, even if another operator races us
    } finally {
      try { unlinkSync(tmp); } catch { /* a failed temp creation leaves nothing to remove */ }
    }
  }
  process.stdout.write(JSON.stringify({ mode, ...before, destination: dest, published: mode === "--apply" }, null, 2) + "\n");
}
NODE
