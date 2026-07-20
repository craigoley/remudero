#!/usr/bin/env node
// apps/shell-macos/scripts/verify-daemon.mjs
//
// A REAL, standalone local daemon for manually/interactively verifying this shell's acceptance
// claim ("a signed local build launches, lives in the menu bar, and reads the same tailnet
// API") end-to-end -- committed and reproducible, unlike a one-off script that only existed for
// a single verification run. Built entirely from this repo's own EXISTING, already-tested
// pieces -- no daemon-specific code lives in apps/shell-macos itself (this shell reads the same
// tailnet API surface every other client does):
//
//   - src/lib/service.ts's createService() -- the generic bearer-scoped REST+SSE mechanism
//     (W3-T1a), the exact same wiring test/service.test.ts drives.
//   - src/lib/board.ts's buildStatusRoute()/buildStatusStream() -- the read-only board's
//     GET /v1/status + /v1/status/stream routes (W3-T2), the exact same wiring
//     test/board.test.ts drives.
//
// Usage (from apps/shell-macos/):
//   node ../../dist -- (run `npm run build` at the repo root first, see below)
//   node scripts/verify-daemon.mjs
//   REMUDERO_DAEMON_URL=http://127.0.0.1:4317 REMUDERO_DAEMON_TOKEN=<printed token> \
//     REMUDERO_VERIFY_DUMP=1 open -W src-tauri/target/release/bundle/macos/Remudero.app --stdout ...
//
// (README.md's "Verified" section spells out the exact commands + what the resulting
// [verify-dump] transcript looks like.)
//
// This script logs every request (method, path, auth outcome, status, latency) to stdout via
// `log`, listens on 127.0.0.1:4317 (apps/dashboard/src/main.ts's own documented default
// baseUrl -- see its readConfig() header comment), prints the read token it picked, and after
// ~4s appends ONE ledger line that flips task "W3-T3"'s projection from "running" to
// "merged ✓ #296" -- driving a real ledger-write -> SSE-event -> (verified) DOM update, the
// same live-state-flip contract test/board.test.ts's 2s-latency test proves.
//
// Run `npm run build` at the repo root first -- this script imports compiled output the same
// way sync-web-build.mjs does (no bundler, no ts-node; this repo's plain `tsc` build only).

import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", ".."); // apps/shell-macos/scripts -> repo root

const { createService } = await import(join(repoRoot, "dist", "src", "lib", "service.js"));
const { buildStatusRoute, buildStatusStream } = await import(join(repoRoot, "dist", "src", "lib", "board.js"));

const READ_TOKEN = process.env.REMUDERO_VERIFY_READ_TOKEN ?? randomBytes(9).toString("base64url");
const WRITE_TOKEN = process.env.REMUDERO_VERIFY_WRITE_TOKEN ?? randomBytes(9).toString("base64url");
const PORT = Number(process.env.REMUDERO_VERIFY_PORT ?? 4317);
const FLIP_DELAY_MS = Number(process.env.REMUDERO_VERIFY_FLIP_DELAY_MS ?? 4000);

const ledgerDir = mkdtempSync(join(tmpdir(), "remudero-verify-"));
const ledgerPath = join(ledgerDir, "ledger.ndjson");
writeFileSync(ledgerPath, "");

// A small, realistic 5-task plan mirroring this repo's own real MASTER-PLAN board shape.
const tasks = [
  { id: "W3-T1", title: "daemon service surface + api-client", repo: "remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 },
  { id: "W3-T2", title: "dashboard v0 (shell 0)", repo: "remudero", depends_on: ["W3-T1"], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 },
  { id: "W3-T3", title: "Tauri macOS shell (shell 1)", repo: "remudero", depends_on: ["W3-T2"], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 },
  { id: "W3-T4", title: "iOS shell spike", repo: "remudero", depends_on: ["W3-T3"], type: "implement", risk: "high", verify: "auto", status: "queued", attempts: 0 },
  { id: "W3-T5", title: "connection UX + actions tier", repo: "remudero", depends_on: ["W3-T3"], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 },
];
const plan = { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };

// A tiny fake GitHub gateway: W3-T1/W3-T2 already MERGED, W3-T3 already OPEN (about to flip to
// MERGED below -- the live state change this whole verification run exists to demonstrate).
const prByRefTable = {
  "https://github.com/craigoley/remudero/pull/288": { number: 288, url: "https://github.com/craigoley/remudero/pull/288", state: "MERGED" },
  "https://github.com/craigoley/remudero/pull/294": { number: 294, url: "https://github.com/craigoley/remudero/pull/294", state: "MERGED" },
  "https://github.com/craigoley/remudero/pull/296": { number: 296, url: "https://github.com/craigoley/remudero/pull/296", state: "OPEN" },
};
const github = {
  prByRef: (ref) => prByRefTable[String(ref)] ?? null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

writeFileSync(
  ledgerPath,
  [
    { ts: new Date().toISOString(), run_id: "verify", task_id: "W3-T1", step: "pr.opened", pr_url: prByRefTable["https://github.com/craigoley/remudero/pull/288"].url },
    { ts: new Date().toISOString(), run_id: "verify", task_id: "W3-T2", step: "pr.opened", pr_url: prByRefTable["https://github.com/craigoley/remudero/pull/294"].url },
    { ts: new Date().toISOString(), run_id: "verify", task_id: "W3-T3", step: "pr.opened", pr_url: prByRefTable["https://github.com/craigoley/remudero/pull/296"].url },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n",
);

const deps = { plan, ledgerPath, github };

function log(step, extra) {
  console.log(`[daemon] ${new Date().toISOString()} ${step}${extra ? " " + JSON.stringify(extra) : ""}`);
}

const server = createService({
  tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
  routes: [buildStatusRoute(deps)],
  sse: [buildStatusStream(deps, 250)],
  log,
});

// Extra request/response-level logging for verification only (src/lib/service.ts itself only
// logs auth failures + SSE lifecycle -- see its own `log(...)` call sites -- this is a SECOND,
// additive `request` listener on the plain node:http Server createService() returns; it never
// touches, wraps, or replaces the real routing listener createService() already registered).
// Surfaces the real client's User-Agent -- the detail that proves a real WebKit webview (not
// Node's `fetch`, which every existing automated test uses) is the one making these requests.
server.on("request", (req, res) => {
  const start = Date.now();
  const ua = req.headers["user-agent"] ?? "(none)";
  log("http", { method: req.method, path: req.url, ua });
  res.on("finish", () => {
    log("http.done", { method: req.method, path: req.url, status: res.statusCode, ms: Date.now() - start });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log("listening", { url: `http://127.0.0.1:${PORT}`, readToken: READ_TOKEN, writeToken: WRITE_TOKEN });
  console.log(`\nREMUDERO_DAEMON_URL=http://127.0.0.1:${PORT}`);
  console.log(`REMUDERO_DAEMON_TOKEN=${READ_TOKEN}\n`);

  setTimeout(() => {
    const line = { ts: new Date().toISOString(), run_id: "verify", task_id: "W3-T3", step: "pr.merged", pr_url: "https://github.com/craigoley/remudero/pull/296" };
    prByRefTable[line.pr_url].state = "MERGED";
    appendFileSync(ledgerPath, JSON.stringify(line) + "\n");
    log("ledger write: W3-T3 pr#296 OPEN -> MERGED", line);
  }, FLIP_DELAY_MS);
});

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
