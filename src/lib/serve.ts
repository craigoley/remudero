/**
 * lib/serve.ts — `rmd serve`'s assembler: the FRONT DOOR (W1-T139, MASTER-PLAN §7/§7B).
 *
 * board.ts's own header named exactly this gap: "Real `rmd serve` CLI wiring (registering
 * these routes on a live createService(...) instance, with a real ghGateway) is a later
 * task's concern" — panel-actions.ts and panel-graph.ts's headers say the same. That later
 * task is this one. This module wires ZERO new business logic — it is a thin layer over the
 * FOUR already-proven modules (service.ts's mechanism, board.ts's read side, panel-actions.ts's
 * write side, panel-graph.ts's graph) plus one new thing this task actually owns: a minimal
 * HTML shell at `GET /` and the tiny bit of CLI glue (port resolution, token persistence) a
 * launchable command needs. Every route below is REUSED verbatim from its own module's
 * exported builder — never reimplemented (task design note).
 *
 * TWO ROOTS, ONE `PanelActionDeps` SHAPE (verified from source, not assumed): panel-actions.ts's
 * six routes all take a `PanelActionDeps` with a single `root` field, but that field backs TWO
 * genuinely different filesystem locations elsewhere in this codebase:
 *   - `requestPause`/`requestStop`/`resumeFleet`/`setQuietHours` (fleet-control.ts) read/write
 *     `<root>/state/{STOP,PAUSE,QUIET_HOURS}` — and MUST agree with what `rmd daemon`/`rmd
 *     drain` check (`stopDetail(config.root)` etc., run-task.ts's daemonCommand) or a panel
 *     STOP would write a flag file the real daemon never looks at.
 *   - `appendQuestionAnswer` (worker.ts, only `buildAnswerQuestionRoute` calls it) writes
 *     `<root>/plan/questions.ndjson` — and MUST agree with where `appendQuestion` (the QUESTION
 *     side of the SAME contract, run-task.ts) writes, which is `repoRoot` (the git tree), not
 *     `config.root` — else "THE ANSWER FLOWS TO THE ARCHITECT" (panel-actions.ts's own header)
 *     would silently land in a file nothing reads.
 * `config.root` and `repoRoot` are NOT the same directory by default (config.root defaults to
 * `~/Remudero`, a workspace; repoRoot is the git checkout serve runs from) — one shared `root`
 * cannot satisfy both correctly. Since every `build*Route` function takes its own independent
 * `PanelActionDeps`, {@link buildServeRoutes} passes TWO differently-rooted instances: a
 * `fleetControlRoot`-rooted one for pause/resume/stop/quiet-hours/approve-manual, and a
 * `questionsRoot`-rooted one for answer-question alone — both share the SAME `ledgerPath`
 * (every module's `panel.*`/`daemon.*` ledger lines always live under config.root, unambiguous
 * everywhere else in this codebase).
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { Server } from "node:http";
import { createService, type Route, type ServiceOptions, type ServiceTokens } from "./service.js";
import { buildStatusRoute, buildStatusStream, DEFAULT_POLL_MS, type BoardDeps } from "./board.js";
import {
  buildAnswerQuestionRoute,
  buildApproveManualRoute,
  buildPauseRoute,
  buildQuietHoursRoute,
  buildResumeRoute,
  buildStopRoute,
  type IssueCloser,
  type PanelActionDeps,
} from "./panel-actions.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "./panel-graph.js";

/** Default `rmd serve` port — matches apps/dashboard/src/main.ts's own `?daemon=` default (`http://localhost:4317`), so the shipped dashboard points at a served daemon out of the box. */
export const DEFAULT_SERVE_PORT = 4317;

export interface ServeDeps {
  board: BoardDeps;
  /** `plan/feedback/` + `plan/tasks.yaml` root and GitHub trace gateway (panel-graph.ts). */
  panelGraph: PanelGraphDeps;
  /** `<root>/state/ledger.ndjson` — SAME path board.ts tails and every panel route ledgers into. */
  ledgerPath: string;
  /** `gh issue close` gateway shared by every panel-actions write route that needs it. */
  issues: IssueCloser;
  /** Fleet-control flag-file root — MUST equal the `config.root` `rmd daemon`/`rmd drain` check (see module header). */
  fleetControlRoot: string;
  /** `plan/questions.ndjson` root — MUST equal the `repoRoot` `appendQuestion` writes into (see module header). */
  questionsRoot: string;
  tokens: ServiceTokens;
  /** Board SSE poll pace; defaults to board.ts's own `DEFAULT_POLL_MS` (250ms, the W3-T2 2s acceptance bar). */
  pollMs?: number;
  /** Forwarded to `createService` — one ledger line per auth decision/SSE lifecycle/handler error. */
  log?: ServiceOptions["log"];
}

/**
 * The minimal operator-console HTML shell (task title: "a minimal HTML shell"). NOT
 * apps/dashboard's full SPA — that page's own header already documents why it stays a
 * separate, later-wired artifact ("Wiring the daemon to actually SERVE this directory as
 * static files... is explicit follow-on work"): its `main.js` is a `tsc`-compiled ES module
 * with no bundler, and serving it verbatim would need its own static-asset route(s) plus a
 * decision on caching/versioning that is out of THIS task's one concern (front-door wiring).
 * This shell instead proves the wiring end-to-end on its own: it mounts the live board
 * (`GET /v1/status`, polled — see the inline comment below for why not SSE here) and links
 * the panel actions + plan→task→PR graph, using bearer auth exactly like every other route on
 * this surface (there is no unauthenticated route in service.ts's model — `GET /` is
 * `scope: "read"` like everything else; the reader must already carry a token, same
 * `?token=` query-param convention apps/dashboard's own `main.ts` uses).
 */
export function renderShellHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Remudero — rmd serve</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 60rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; border-bottom: 1px solid #ccc; padding: 0.25rem 0.5rem; }
  nav a { margin-right: 1rem; }
  section { margin: 1.5rem 0; }
  #status { color: #666; }
</style>
</head>
<body>
<h1>Remudero — the operator console front door</h1>
<nav>
  <!-- IN-SHELL PANELS, not page hops: a browser NAVIGATION to a header-only /v1 route cannot send
       the Authorization header, so a bare anchor click 401s and shows raw JSON (the #339
       bootstrap-paradox recurring at the LINK layer). These are buttons whose handlers fetch WITH the
       header the page already carries and render the result INSIDE the page — no navigation, no raw
       JSON, no token in a navigable URL. This is also W1-T153's IA shape (panels, not hops). -->
  <button id="feedback-btn" type="button">Feedback inbox</button>
  <button id="graph-btn" type="button">Plan→task→PR graph</button>
</nav>
<p id="status">loading…</p>

<section id="panel" aria-label="Panel" hidden>
  <h2 id="panel-title"></h2>
  <div id="panel-controls"></div>
  <pre id="panel-body"></pre>
</section>

<section id="board" aria-label="Live task board">
  <h2>Board</h2>
  <table id="board-table">
    <thead><tr><th>task</th><th>status</th><th>PR</th></tr></thead>
    <tbody id="board-rows"></tbody>
  </table>
</section>

<section id="controls" aria-label="Fleet control">
  <h2>Fleet control</h2>
  <label>reason (optional) <input id="reason" type="text" /></label>
  <button id="pause-btn" type="button">Pause</button>
  <button id="resume-btn" type="button">Resume</button>
  <button id="stop-btn" type="button">STOP</button>
  <label><input id="quiet-hours" type="checkbox" /> Quiet hours</label>
</section>

<script type="module">
  // Bootstrap: the SAME \`?token=\` query-param convention apps/dashboard/src/main.ts uses —
  // this page itself already required a bearer header to load (service.ts gates every route,
  // GET / included), so whatever fetched this page already has a token; this just lets that
  // same token drive the page's own follow-up API calls.
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";
  const authHeaders = { authorization: \`Bearer \${token}\` };

  async function refreshBoard() {
    try {
      const res = await fetch("/v1/status", { headers: authHeaders });
      if (!res.ok) throw new Error(\`GET /v1/status -> \${res.status}\`);
      const snapshot = await res.json();
      const rows = document.getElementById("board-rows");
      rows.innerHTML = "";
      for (const t of snapshot.tasks) {
        const tr = document.createElement("tr");
        const pr = t.prUrl ? \`<a href="\${t.prUrl}" target="_blank" rel="noreferrer">#\${t.prNumber ?? t.prUrl}</a>\` : "";
        tr.innerHTML = \`<td>\${t.taskId}</td><td>\${t.status}\${t.merged ? " ✓" : ""}</td><td>\${pr}</td>\`;
        rows.appendChild(tr);
      }
      document.getElementById("status").textContent = \`updated \${snapshot.generated_at}\`;
    } catch (e) {
      document.getElementById("status").textContent = \`board fetch failed: \${e}\`;
    }
  }

  // v0: polls rather than opening /v1/status/stream. Real-time consumption over fetch-based
  // SSE (native EventSource cannot carry an Authorization header — service.ts has no
  // unauthenticated fallback) is exactly what @remudero/api-client's subscribeStatus already
  // implements; this inline shell deliberately does not re-implement that a second time. The
  // stream route itself is proven directly (test/board.test.ts, test/serve.test.ts), not
  // through this page.
  refreshBoard();
  setInterval(refreshBoard, 3000);

  function postJson(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  document.getElementById("pause-btn").addEventListener("click", () => {
    postJson("/v1/control/pause", { reason: document.getElementById("reason").value || undefined }).then(refreshBoard);
  });
  document.getElementById("resume-btn").addEventListener("click", () => {
    postJson("/v1/control/resume").then(refreshBoard);
  });
  document.getElementById("stop-btn").addEventListener("click", () => {
    postJson("/v1/control/stop", { reason: document.getElementById("reason").value || undefined }).then(refreshBoard);
  });
  document.getElementById("quiet-hours").addEventListener("change", (e) => {
    postJson("/v1/quiet-hours", { enabled: e.target.checked });
  });

  // IN-SHELL PANELS — authorized fetch (the header the page already carries), rendered inline.
  // NEVER a navigation to a header-only route (that is exactly what 401'd via the old <a href>).
  async function getJson(path) {
    const res = await fetch(path, { headers: authHeaders });
    if (!res.ok) throw new Error(\`GET \${path} -> \${res.status}\`);
    return res.json();
  }
  function openPanel(title) {
    document.getElementById("panel-title").textContent = title;
    document.getElementById("panel-controls").innerHTML = "";
    document.getElementById("panel").hidden = false;
    document.getElementById("panel-body").textContent = "loading…";
  }
  document.getElementById("feedback-btn").addEventListener("click", async () => {
    openPanel("Feedback inbox");
    const body = document.getElementById("panel-body");
    try {
      const data = await getJson("/v1/feedback");
      const entries = data.entries ?? [];
      body.textContent = entries.length
        ? entries.map((e) => \`\${e.id ?? "?"} — \${e.status ?? ""}: \${e.summary ?? e.title ?? ""}\`).join("\\n")
        : "(inbox empty)";
    } catch (e) {
      body.textContent = \`panel fetch failed: \${e}\`;
    }
  });
  document.getElementById("graph-btn").addEventListener("click", () => {
    openPanel("Plan→task→PR graph");
    const controls = document.getElementById("panel-controls");
    controls.innerHTML =
      '<label>task or feedback id <input id="trace-id" type="text" /></label> <button id="trace-btn" type="button">Trace</button>';
    const body = document.getElementById("panel-body");
    body.textContent = "enter an id and click Trace";
    document.getElementById("trace-btn").addEventListener("click", async () => {
      const id = document.getElementById("trace-id").value.trim();
      if (!id) { body.textContent = "an id is required"; return; }
      body.textContent = "loading…";
      try {
        const data = await getJson(\`/v1/trace?id=\${encodeURIComponent(id)}\`);
        body.textContent = JSON.stringify(data.chain ?? data, null, 2);
      } catch (e) {
        body.textContent = \`panel fetch failed: \${e}\`;
      }
    });
  });
</script>
</body>
</html>
`;
}

/**
 * `GET /` — the shell above, read-scoped like every other route on this surface, but ALSO
 * accepting the token via `?token=` (allowQueryToken). A browser NAVIGATION to `/?token=<read>`
 * cannot set an `Authorization` header, so without this the shell would 401 and never load — the
 * page's OWN follow-up `/v1/*` fetches then carry the header (those routes stay header-only). This
 * closes the W1-T139 bootstrap paradox: the auth spec was satisfied against header-sending fetch
 * clients and unreachable by the one client that matters, the browser opening the URL.
 */
function buildShellRoute(): Route {
  return {
    method: "GET",
    path: "/",
    scope: "read",
    allowQueryToken: true,
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderShellHtml());
    },
  };
}

/** Every REST route `rmd serve` registers — board, panel actions (two-root split, see module header), panel graph, and the shell. Reused verbatim from each module's own exported builder. */
export function buildServeRoutes(deps: ServeDeps): Route[] {
  const fleetControlDeps: PanelActionDeps = { root: deps.fleetControlRoot, ledgerPath: deps.ledgerPath, issues: deps.issues };
  const questionDeps: PanelActionDeps = { root: deps.questionsRoot, ledgerPath: deps.ledgerPath, issues: deps.issues };

  return [
    buildStatusRoute(deps.board),
    buildPauseRoute(fleetControlDeps),
    buildResumeRoute(fleetControlDeps),
    buildStopRoute(fleetControlDeps),
    buildQuietHoursRoute(fleetControlDeps),
    buildAnswerQuestionRoute(questionDeps),
    buildApproveManualRoute(fleetControlDeps),
    ...buildPanelGraphRoutes(deps.panelGraph),
    buildShellRoute(),
  ];
}

/** Build (but do not `.listen()`) the full `rmd serve` HTTP server — one call, every route wired. */
export function buildServeServer(deps: ServeDeps): Server {
  return createService({
    tokens: deps.tokens,
    routes: buildServeRoutes(deps),
    sse: [buildStatusStream(deps.board, deps.pollMs ?? DEFAULT_POLL_MS)],
    log: deps.log,
  });
}

// ── CLI glue: port + token resolution (kept here, not run-task.ts, so both are unit-testable
// as pure/near-pure functions rather than only exercisable through the live CLI) ────────────

/**
 * `--port <n>` if present (validated: an integer 1-65535), else {@link DEFAULT_SERVE_PORT}.
 * Throws (never returns an invalid port) so the CLI can fail loud before any bind attempt.
 */
export function resolveServePort(rest: string[]): number {
  const idx = rest.indexOf("--port");
  if (idx < 0) return DEFAULT_SERVE_PORT;
  const raw = rest[idx + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`--port must be an integer 1-65535, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Where `rmd serve`'s generated bearer tokens persist across restarts (config.root, like every other `<root>/state/*` control file). */
export function serviceTokensPath(configRoot: string): string {
  return join(configRoot, "state", "service-tokens.json");
}

/**
 * Load `rmd serve`'s bearer tokens, generating + persisting them on first run. A bearer token
 * must stay STABLE across daemon restarts (a client — apps/dashboard's `?token=` param, a
 * saved curl command — would otherwise silently break every relaunch), so this is create-once,
 * read-thereafter, using the SAME exclusive-create discipline config.ts's `loadConfig` already
 * established for its own first-run file (`openSync(p, "wx")` folds the existence check and
 * the create into one atomic syscall — no TOCTOU window for a second `rmd serve` racing this
 * one's first launch to clobber the other's tokens).
 */
export function resolveServiceTokens(configRoot: string): ServiceTokens {
  const p = serviceTokensPath(configRoot);
  mkdirSync(dirname(p), { recursive: true });
  let fd: number | undefined;
  try {
    fd = openSync(p, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  if (fd !== undefined) {
    try {
      const created: ServiceTokens = { read: randomBytes(32).toString("hex"), write: randomBytes(32).toString("hex") };
      writeSync(fd, JSON.stringify(created, null, 2) + "\n");
      return created;
    } finally {
      closeSync(fd);
    }
  }
  const readFd = openSync(p, "r");
  try {
    return JSON.parse(readFileSync(readFd, "utf8")) as ServiceTokens;
  } finally {
    closeSync(readFd);
  }
}

/** `existsSync` re-export point kept trivial — used only by test fixtures wanting to assert the tokens file's persistence without importing node:fs directly for that one check. */
export function serviceTokensFileExists(configRoot: string): boolean {
  return existsSync(serviceTokensPath(configRoot));
}
