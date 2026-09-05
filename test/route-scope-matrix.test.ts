import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import {
  assertRoutesScopeComplete,
  buildServeRoutes,
  buildServeServer,
  resolveServiceTokens,
  routesMissingScopeClassification,
  type ServeDeps,
} from "../src/lib/serve.js";
import { buildStatusStream } from "../src/lib/board.js";
import { createService, type Method, type Route, type Scope } from "../src/lib/service.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── W1-T493: prove every console route's scope is enforced server-side BEFORE the console is
// exposed. The rationale's good news first: `createService` already resolves `requiredScope`
// off the matched Route/SseRoute and refuses BEFORE any handler runs (401 no credential, 403
// wrong scope) — this suite is an AUDIT AND A RATCHET, not a repair. design (i): every probe
// below drives the REAL assembled table (`buildServeRoutes`, plus the one mounted SSE stream via
// `buildStatusStream`) — never a hand-copied list, which is the artifact that rots — through the
// REAL `createService` request path (`buildServeServer`, `rmd serve`'s own wiring), so route 37
// added tomorrow is swept in automatically and must actually be refused, not merely declared. ──

const READ_TOKEN = "route-scope-matrix-read-token";
const WRITE_TOKEN = "route-scope-matrix-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-route-scope-matrix-"));
}

function fakeGitHub(): GitHub {
  return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
}
function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}
function fakeIssueCloser(): IssueCloser {
  return { close: () => {} };
}
function fakeRatifyGateway(): RatifyCliGateway {
  return { approve: () => {}, reframe: () => {} };
}
function planOf(): Plan {
  return { tasks: [], byId: new Map() };
}

function ledgerPathFor(root: string): string {
  const p = join(root, "state", "ledger.ndjson");
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(p, "");
  return p;
}

function writePlan(root: string): string {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n", { flag: "wx" });
  return planPath;
}

function depsFor(root: string): ServeDeps {
  const ledgerPath = ledgerPathFor(root);
  const planPath = writePlan(root);
  return {
    board: { plan: planOf(), ledgerPath, github: fakeGitHub() },
    panelGraph: { root, planPath, ledgerPath, github: fakeTraceGithub(), statusGithub: fakeGitHub(), ratify: fakeRatifyGateway() },
    ledgerPath,
    issues: fakeIssueCloser(),
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
    log: () => {},
  };
}

async function withListening<T>(server: ReturnType<typeof buildServeServer>, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

/** One row of the REAL assembled table — a REST `Route` or the mounted SSE stream, reduced to
 *  the three fields this audit needs. Built FROM `buildServeRoutes`/`buildStatusStream`, never
 *  hand-typed, so a route this suite has never seen is still probed the moment it exists. */
interface MatrixEntry {
  method?: Method;
  path: string;
  scope: Scope;
  selfAuthenticated?: boolean;
}

function realMatrix(deps: ServeDeps): MatrixEntry[] {
  const rest: MatrixEntry[] = buildServeRoutes(deps).map((r) => ({
    method: r.method,
    path: r.path,
    scope: r.scope,
    selfAuthenticated: r.selfAuthenticated,
  }));
  const sse = buildStatusStream(deps.board);
  return [...rest, { path: sse.path, scope: sse.scope }];
}

/** W1-T2568: routes that carry their OWN credential and so cannot be probed with a bearer token.
 *  HAND-ENUMERATED WITH A REASON, never derived from the flag alone — otherwise setting
 *  `selfAuthenticated: true` would be a silent way OUT of this audit, which is the one thing a
 *  scope ratchet must not offer. Each entry states what refuses the request instead, and that
 *  refusal is asserted by the route's own suite (named below), not taken on trust here. */
const SELF_AUTHENTICATED: ReadonlyArray<{ path: string; refusedBy: string; provenBy: string }> = [
  {
    path: "/v1/hooks/github",
    refusedBy: "an HMAC signature over the raw body (x-hub-signature-256) plus a repository match",
    provenBy: "test/github-event-sweep-wake.test.ts — invalid signature -> 401, wrong repository -> 403",
  },
  {
    path: "/v1/escalation/confirm",
    refusedBy:
      "the same HMAC over the link's claims as the answer route below, checked before anything is " +
      "rendered — this route is GET and deliberately has no side effect, so an iMessage link " +
      "preview cannot consume a link",
    provenBy:
      "test/escalation-answer-links.test.ts — forged -> 403, expired -> 410, and a verified link " +
      "renders 200 while leaving the single-use marker unwritten",
  },
  {
    path: "/v1/escalation/answer",
    refusedBy:
      "an HMAC signature over the link's own claims (escalation id, class, route, expiry), plus " +
      "an expiry check and a single-use marker — the operator's phone carries no bearer token",
    provenBy:
      "test/escalation-answer-links.test.ts — forged -> 403, expired/already-used -> 410, and a " +
      "route or class swapped inside a valid link reads as forged",
  },
];

// ── design (i): "assert, for every route it finds: a declared scope" — every entry in the REAL
// table (REST + SSE) carries one of the two real Scope values. `Route.scope`/`SseRoute.scope` are
// REQUIRED on their types (service.ts), so this can only ever fail if a route is assembled
// through something that bypasses the type system — see the compile-time proof further down for
// the stronger claim that an unclassified route cannot even be written. ──

test("every route in the REAL assembled table (REST + the mounted SSE stream) declares a scope", () => {
  const matrix = realMatrix(depsFor(tmpRoot()));
  // Positive control: the derivation actually found the console's routes — 30+ at filing time
  // (route-registration.test.ts's own bar) — so an empty `matrix` could never read as "complete".
  assert.ok(matrix.length >= 30, `expected the real assembled table to have >= 30 entries, got ${matrix.length}`);
  assert.deepEqual(routesMissingScopeClassification(matrix), []);
  assert.doesNotThrow(() => assertRoutesScopeComplete(matrix));
});

// ── the primitive's own falsifier, mirroring test/write-tier-completeness.test.ts's treatment of
// `writeRoutesMissingTier`/`assertWriteTiersComplete`: prove the filter NAMES an unclassified
// entry rather than defaulting it open, on synthetic data that bypasses the type system exactly
// the way a real defect would have to. ──

test("routesMissingScopeClassification: an entry with no valid scope is named, not defaulted", () => {
  const entries: MatrixEntry[] = [
    { method: "GET", path: "/v1/read-only", scope: "read" },
    { method: "POST", path: "/v1/write-only", scope: "write" },
    { path: "/v1/status/stream", scope: "read" },
    // The falsifier: a value the `Scope` union does not admit, reachable only by defeating the
    // compiler — the exact shape a widened/cast `Route[]` could slip past `buildServeRoutes`.
    { method: "GET", path: "/v1/unclassified", scope: "anon" as unknown as Scope },
    { path: "/v1/unclassified-sse", scope: undefined as unknown as Scope },
  ];
  assert.deepEqual(routesMissingScopeClassification(entries), [
    "GET /v1/unclassified",
    "GET /v1/unclassified-sse (sse)",
  ]);
});

test("assertRoutesScopeComplete: throws naming the unclassified route(s), never defaults quietly", () => {
  const entries: MatrixEntry[] = [
    { method: "GET", path: "/v1/labeled", scope: "read" },
    { method: "POST", path: "/v1/unlabeled", scope: "" as unknown as Scope },
  ];
  assert.throws(() => assertRoutesScopeComplete(entries), /POST \/v1\/unlabeled/);
});

// ── design (i)'s strongest form of "a route added without a classification fails the audit
// instead of defaulting open": `scope` is REQUIRED on the `Route` type, so the failure isn't
// merely a runtime check someone could forget to run -- an unclassified route literal refuses to
// COMPILE. `npm run typecheck` (CI, ci.yml) is what actually exercises the `@ts-expect-error`
// below: if `scope` ever became optional, this directive would stop matching a real error and
// `tsc` would fail the build on THIS line for the opposite reason (an unused directive). ──

test("Route.scope is required on the type — an unclassified route literal does not compile", () => {
  // @ts-expect-error design (i)/(ii): omitting `scope` must not compile. This is WHY
  // `buildServeRoutes`'s real routes can never trip `routesMissingScopeClassification` above at
  // runtime -- TypeScript refuses this exact object one line below, before `npm test` even runs.
  const unscoped: Route = { method: "GET", path: "/v1/unscoped", handler: () => {} };
  assert.ok(unscoped, "compile-time-only assertion — see the @ts-expect-error comment above");
});

// ── design (i)'s other half: "a request without that scope is refused by the REAL createService
// request path rather than by a stub" — stand up the REAL `buildServeServer` (rmd serve's own
// wiring, SSE included) and probe EVERY entry the real table reports, anonymously and (for write
// routes) with an insufficient READ token. This is also criterion 3, generalized: "a sensitive
// read is refused without a credential, not merely hidden by the console" holds for EVERY read
// route, sensitive-labelled or not, because scope is checked before any handler and before any
// rendering decision the console's UI could hide behind. ──

test("every route in the REAL table is refused without its scope, over the REAL createService path", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  const matrix = realMatrix(deps);

  await withListening(buildServeServer(deps), async (base) => {
    // The instrument itself, calibrated: an absent path must 404, or "not 401" below proves
    // nothing about whether a route is mounted vs. merely unauthenticated.
    const control = await fetch(`${base}/v1/no-such-route-route-scope-matrix`);
    await control.arrayBuffer();
    assert.equal(control.status, 404, "an absent path must 404 for the 401-vs-404 split to mean anything");

    // The self-authenticated set must be exactly what this suite has reviewed. A NEW route setting
    // the flag fails HERE, before it can quietly disappear from the sweep below.
    assert.deepEqual(
      matrix.filter((e) => e.selfAuthenticated).map((e) => e.path).sort(),
      SELF_AUTHENTICATED.map((e) => e.path).sort(),
      "a route set `selfAuthenticated` without a reviewed entry in SELF_AUTHENTICATED — it would " +
        "otherwise leave this audit silently. Add it with what refuses the request instead, and the " +
        "suite that proves that refusal.",
    );

    const failures: string[] = [];
    for (const entry of matrix) {
      const method = entry.method ?? "GET";
      // A self-authenticated route carries no bearer semantics at all (Route.selfAuthenticated's
      // own doc), so a 401/403 probe measures nothing about it. Its refusal is proven by the suite
      // named in SELF_AUTHENTICATED above.
      if (entry.selfAuthenticated) continue;

      // No credential at all: every scope (read AND write) must refuse this — 401, never 200,
      // never a bare 404 (404 would mean the route this audit found isn't actually mounted).
      const anon = await fetch(`${base}${entry.path}`, { method });
      await anon.arrayBuffer();
      if (anon.status !== 401) failures.push(`${method} ${entry.path}: anonymous got ${anon.status}, want 401`);

      // A credential that grants READ but not WRITE must still refuse a write-scoped route —
      // the SPECIFIC required-scope check, not merely "any auth failure".
      if (entry.scope === "write") {
        const readOnly = await fetch(`${base}${entry.path}`, { method, headers: { authorization: `Bearer ${READ_TOKEN}` } });
        await readOnly.arrayBuffer();
        if (readOnly.status !== 403) failures.push(`${method} ${entry.path}: read-token got ${readOnly.status}, want 403`);
      }
    }
    assert.deepEqual(failures, []);
  });

  // The whole sweep touched no handler: every probe was rejected at the scope check, before any
  // effect. A write route that ever answered an under-scoped request would show up here too.
  assert.equal(readFileSync(deps.ledgerPath, "utf8").trim(), "", "an under-scoped probe must never reach a handler");
});

// ── criterion 3, named explicitly: the three reads rationale (5) calls out as MORE sensitive
// than an ordinary write (`/v1/account-usage` is spend, `/v1/trace` renders provenance chains,
// `/v1/status` carries absolute host file paths) are refused without a credential — proving the
// scope gate, not the console's button-hiding, is what stands between an anonymous caller and
// these three, by name. ──

test("the three named sensitive reads (spend, provenance, host paths) are refused without a credential", async () => {
  const deps = depsFor(tmpRoot());
  const sensitiveGets = ["/v1/account-usage", "/v1/trace", "/v1/status"];
  const matrix = realMatrix(deps);
  for (const path of sensitiveGets) {
    const found = matrix.find((e) => e.path === path && (e.method ?? "GET") === "GET");
    assert.ok(found, `expected ${path} in the real assembled table`);
    assert.equal(found?.scope, "read", `expected ${path} to be read-scoped`);
  }

  await withListening(buildServeServer(deps), async (base) => {
    for (const path of sensitiveGets) {
      const res = await fetch(`${base}${path}`);
      await res.arrayBuffer();
      assert.equal(res.status, 401, `${path} must refuse an anonymous caller, not merely hide its button`);
    }
  });
});

// ── criterion 4: "an unreadable or malformed token store refuses rather than granting" — design
// (iii)'s two named fail-fatal paths. Both REFUSE rather than GRANT (the safe direction), but
// both take the console down rather than answering cleanly, and the audit must say so rather
// than silently pass either. ──

test("resolveServiceTokens: a corrupt token store file throws at startup rather than granting anything", () => {
  const root = tmpRoot();
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "service-tokens.json"), "{ not valid json");
  assert.throws(() => resolveServiceTokens(root), /Unexpected|JSON/);
});

test("resolveServiceTokens: a well-formed file missing its keys parses fine (the OTHER fail-fatal path)", () => {
  const root = tmpRoot();
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "service-tokens.json"), "{}\n");
  // JSON.parse succeeds on `{}` -- the corrupt-file throw above does NOT fire here -- so a caller
  // gets tokens back rather than an exception at this layer. design (iii): the danger moves one
  // layer down, into every per-request comparison against these `undefined` fields (see the
  // subprocess-isolated proof below for why THAT is where this must be observed).
  const tokens = resolveServiceTokens(root);
  assert.equal(tokens.read, undefined);
  assert.equal(tokens.write, undefined);
});

// design (iii): comparing a presented credential against an `undefined` stored token
// (`bearerTokenProvider`'s `safeEqual`, service.ts) throws inside `Buffer.from` rather than
// returning a clean false. THE PROPERTY THIS TEST OWNS — the request is REFUSED, never GRANTED —
// is unchanged and asserted below in both directions.
//
// WHAT CHANGED (R-2, recon-2026-09-05): the MECHANISM of that refusal. `createService`'s listener
// used to be `void (async () => {...})()` with NO `.catch()`, so the throw became an UNHANDLED
// REJECTION and Node terminated the process — which this test pinned, while its own words called
// it out as "the safe direction — but fatal, not a clean 500". It is now the clean 500: the
// dispatch's `.catch` hands the failure to `respondToRequestFailure`, which logs `service.error`
// and answers 500. That is strictly stronger, because the fatal version was reachable from any
// caller who could open a socket — one malformed request line (`GET http://[`) took the whole
// console and webhook receiver down, per-packet, under launchd's 60 s restart throttle.
//
// The ISOLATED CHILD `node --test` (the technique test/reapable-prefix.test.ts uses for its own
// end-to-end fixture) is KEPT rather than folded back in-process, and deliberately: it is what
// makes the "never fatal" half falsifiable. node:test's harness attributes ANY unhandled rejection
// during a test to THAT test regardless of listeners the test itself registers (verified
// empirically when this suite was written), so a regression to the crash would corrupt this file's
// own pass/fail instead of being reported. In a child, the exit code IS the assertion.
test("createService: a malformed token store refuses an authenticated request with a 500, never a grant and never a crash", () => {
  const scratch = mkdtempSync(join(tmpdir(), "rmd-route-scope-matrix-crash-"));
  try {
    const fixture = join(scratch, "malformed-store-crash.test.ts");
    const servicePath = join(REPO_ROOT, "src", "lib", "service.ts");
    writeFileSync(
      fixture,
      [
        `import { createService } from ${JSON.stringify(servicePath)};`,
        'import { test } from "node:test";',
        "",
        'test("malformed token store never grants a 200", async () => {',
        "  const server = createService({",
        "    // The exact shape resolveServiceTokens returns for a well-formed file with no keys.",
        "    tokens: { read: undefined, write: undefined },",
        "    routes: [",
        "      {",
        '        method: "GET",',
        '        path: "/v1/probe",',
        '        scope: "read",',
        "        handler: (_req, res) => {",
        "          res.writeHead(200);",
        '          res.end("GRANTED");',
        "        },",
        "      },",
        "    ],",
        "    log: () => {},",
        "  });",
        '  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));',
        "  const port = server.address().port;",
        "  try {",
        "    const res = await fetch(`http://127.0.0.1:${port}/v1/probe`, {",
        '      headers: { authorization: "Bearer whatever-credential-at-all" },',
        "      signal: AbortSignal.timeout(2000),",
        "    });",
        '    console.log("FETCH_STATUS:" + res.status);',
        "  } catch (e) {",
        '    console.log("FETCH_FAILED:" + (e && e.message));',
        "  } finally {",
        "    server.close();",
        "  }",
        "});",
        "",
      ].join("\n"),
    );

    // Same isolation reapable-prefix.test.ts's fixture uses: strip NODE_TEST_CONTEXT/NODE_OPTIONS
    // so the NESTED `node --test` actually runs the fixture's test body, this outer run notwithstanding.
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_OPTIONS;

    let threw = false;
    let output = "";
    try {
      output = execFileSync("node", ["--test", "--import", "tsx", fixture], { encoding: "utf8", cwd: REPO_ROOT, env: childEnv });
    } catch (e) {
      threw = true;
      const err = e as { stdout?: string; stderr?: string };
      output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    }

    // HALF ONE — never grants. The unchanged property, and the reason this test exists: an
    // `undefined` stored token must not be comparable-equal to anything a caller presents.
    assert.ok(!/FETCH_STATUS:200/.test(output), `must never have answered the probe with a 200:\n${output}`);
    assert.match(output, /FETCH_STATUS:500/, `expected a clean 500 refusal from the dispatch guard:\n${output}`);

    // HALF TWO — never fatal. A child that exits nonzero here means the throw escaped the
    // dispatch's `.catch` again and Node terminated the process, which is the R-2 regression.
    assert.ok(
      !threw,
      `a malformed token store must be refused, not fatal — the child exited nonzero, so the ` +
        `throw escaped createService's dispatch guard and became an unhandled rejection again:\n${output}`,
    );
    assert.ok(
      !/unhandledRejection|ERR_UNHANDLED_REJECTION/.test(output),
      `no rejection may escape the dispatch, however the child exited:\n${output}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
