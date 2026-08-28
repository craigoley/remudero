// test/account-identity-is-readable.test.ts — W1-T2434.
//
// THE DEFECT. `readAccountUsageFile` (src/lib/account-usage.ts) defaults to
// `join(homedir(), ".claude.json")`. Under `remudero-serve`'s own `HOME=/home/node` that path has
// never existed — nothing in `deploy/serve-container.sh` ever mounted it or supplied
// `RMD_ACCOUNT_FILE_PATH` (the override W1-T997 built for exactly this, per
// `producer-completeness.ts`'s own runtime-adoption audit, which named the seam as wired but never
// supplied). So the read fails soft to `{ unreadable: true }`, and `deriveAccountUsage`'s own
// documented promise — "identity is returned in every case… so the panel can always answer 'which
// account'" — breaks for exactly this one reason, because it is the one case where the file itself
// never parsed and both identity and usage are lost together.
//
// THE FIX, in two parts:
//   (a) deploy/serve-container.sh now mounts the host's `~/.claude.json` read-only into the
//       container and sets `RMD_ACCOUNT_FILE_PATH` to that mount destination — wiring the
//       already-built `resolveAccountFilePath`/`ACCOUNT_FILE_PATH_ENV` seam (serve.ts, W1-T997)
//       that nothing had ever supplied. Absent host file ⇒ not refused, same as GH_APP_* today.
//   (b) src/lib/serve.ts's client strip (`usageWindowLabel`/`renderAccountUsage`) now carries
//       `usageUnknownReason` on the five-hour, seven-day AND account fields, not only on the
//       as-of field — a render change only, since the reason was already computed and already on
//       the payload (account-usage.ts's `usageUnknownReason`).
//
// NEITHER account-usage.ts's `readAccountUsageFile` NOR its `deriveAccountUsage` needed a logic
// change: once the path resolves to a file that actually parses, the "unreadable" branch is simply
// never entered, and every other branch (no-cache/account-mismatch/too-old) already returns
// identity alongside the reason — locked in below alongside the two real changes, so a future edit
// cannot quietly reintroduce the discard this task closes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  USAGE_CACHE_MAX_AGE_MS,
  buildAccountUsageRoute,
  deriveAccountUsage,
  readAccountUsageFile,
  type AccountUsageInput,
} from "../src/lib/account-usage.js";
import { ACCOUNT_FILE_PATH_ENV, renderShellHtml, resolveAccountFilePath } from "../src/lib/serve.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/account-usage/claude-json.json", import.meta.url));
const CAPTURED_AT = 1785516413209;
const SERVE_CONTAINER_SH = fileURLToPath(new URL("../deploy/serve-container.sh", import.meta.url));
const ACCOUNT_USAGE_TS = fileURLToPath(new URL("../src/lib/account-usage.ts", import.meta.url));

// ── (1) THE PATH THE SERVE PROCESS ACTUALLY RESOLVES NOW EXISTS WHERE IT RUNS ───────────────────

test("W1-T2434: deploy/serve-container.sh wires RMD_ACCOUNT_FILE_PATH to a mount it creates, closing the gap producer-completeness.ts named", () => {
  const sh = readFileSync(SERVE_CONTAINER_SH, "utf8");
  // The mount destination is declared once and reused for both the bind mount and the env var, so
  // the two can never drift apart into "mounted here, told to read there".
  assert.match(sh, /CLAUDE_JSON_MOUNT_DEST="\/home\/node\/\.claude\.json"/);
  assert.match(
    sh,
    /-v "\$\{CLAUDE_JSON_PATH\}:\$\{CLAUDE_JSON_MOUNT_DEST\}:ro"/,
    "the account file is bind-mounted read-only into the container",
  );
  assert.match(
    sh,
    /-e "RMD_ACCOUNT_FILE_PATH=\$\{CLAUDE_JSON_MOUNT_DEST\}"/,
    "RMD_ACCOUNT_FILE_PATH is supplied pointing at exactly the mount destination above",
  );
  // The host-side source is HOME-derived, overridable, and distinct from the credential
  // DIRECTORY mount (`.claude`) recycle-container.sh already owns for the daemon — this is the
  // FILE beside it, never folded into that directory's mount.
  assert.match(sh, /CLAUDE_JSON_PATH="\$\{RMD_CLAUDE_JSON_PATH:-\$\{HOME:-\/root\}\/\.claude\.json\}"/);
});

test("W1-T2434: an absent host account file is not refused — the mount and env var are only added when the file exists", () => {
  const sh = readFileSync(SERVE_CONTAINER_SH, "utf8");
  assert.match(
    sh,
    /if \[ -f "\$\{CLAUDE_JSON_PATH\}" \]; then/,
    "the wiring is conditional on the file actually being a regular file, never assumed present",
  );
  assert.doesNotMatch(
    sh,
    /REFUSING.*account file|REFUSING.*claude\.json/i,
    "a missing account file must degrade the ACCOUNT strip, never block the console from starting",
  );
});

test("W1-T2434: once RMD_ACCOUNT_FILE_PATH resolves to a mounted, readable file, the route reads real identity end-to-end", async () => {
  // Simulates exactly what the container now does: the file lands at some container path, and
  // RMD_ACCOUNT_FILE_PATH (set by deploy/serve-container.sh) names that path — never the
  // unreachable `homedir()` default remudero-serve had before this task.
  const mountDest = join(mkdtempSync(join(tmpdir(), "account-identity-mount-")), "claude.json");
  writeFileSync(mountDest, readFileSync(FIXTURE, "utf8"));

  const resolved = resolveAccountFilePath(undefined, { [ACCOUNT_FILE_PATH_ENV]: mountDest });
  assert.equal(resolved, mountDest, "the env var deploy/serve-container.sh sets is exactly what resolveAccountFilePath honours");

  const routeDir = mkdtempSync(join(tmpdir(), "account-identity-route-"));
  const route = buildAccountUsageRoute({
    ledgerPath: join(routeDir, "ledger.ndjson"),
    accountFilePath: resolved,
    now: () => CAPTURED_AT,
  });
  let status = 0;
  let body = "";
  await route.handler({} as never, { writeHead: (c: number) => (status = c), end: (b: string) => (body = b) } as never, { params: {} });
  const parsed = JSON.parse(body);
  assert.equal(status, 200);
  assert.equal(parsed.accountEmail, "operator@example.com", "identity resolves through the mounted path, not the unreachable default");
  assert.equal(parsed.accountUuid, "00000000-1111-2222-3333-444444444444");
  assert.equal(parsed.usageUnknownReason, undefined, "the cache is fresh at its own captured instant, so nothing is unknown at all");
});

// ── (2)/(3)/(5)/(6) IDENTITY SURVIVES EVERY REASON THE CACHE GOES UNKNOWN, EXCEPT THE ONE THAT ──
// ── GENUINELY LOSES THE WHOLE FILE — locking in deriveAccountUsage's documented promise ─────────

test("W1-T2434: identity is returned for every usage-unknown reason EXCEPT unreadable, because only unreadable loses the whole file", () => {
  const input = readAccountUsageFile(FIXTURE);

  // TOO-OLD (5): the panel still names the account; the numbers are withheld, never shown stale.
  const tooOld = deriveAccountUsage(input, [], CAPTURED_AT + USAGE_CACHE_MAX_AGE_MS + 1);
  assert.equal(tooOld.usageUnknownReason, "too-old");
  assert.equal(tooOld.accountEmail, "operator@example.com", "identity survives a too-old cache");
  assert.equal(tooOld.accountUuid, "00000000-1111-2222-3333-444444444444");
  assert.equal(tooOld.fiveHour, undefined, "but the numbers are never shown once stale");

  // NO-CACHE: identity survives an un-ageable reading too.
  const noCache = deriveAccountUsage({ ...input, cacheFetchedAtMs: undefined }, [], CAPTURED_AT);
  assert.equal(noCache.usageUnknownReason, "no-cache");
  assert.equal(noCache.accountEmail, "operator@example.com");

  // (6) ACCOUNT-MISMATCH — THE SWITCH GUARD CAN FIRE, because `input.uuid` (the field reason 1
  // discards) is present to compare against the cache's own accountUuid.
  const switched: AccountUsageInput = { ...input, uuid: "99999999-8888-7777-6666-555555555555" };
  const mismatch = deriveAccountUsage(switched, [], CAPTURED_AT);
  assert.equal(mismatch.usageUnknownReason, "account-mismatch", "the guard fired");
  assert.equal(mismatch.accountUuid, "99999999-8888-7777-6666-555555555555", "identity is the CURRENT account, not the cache's");

  // (2)/(3) UNREADABLE is the one reason that loses BOTH halves — inherent to a file that never
  // parsed, not a bug this task changes. What THIS task changes is that remudero-serve no longer
  // HITS this branch once the path is wired to a file that exists (see the tests above).
  const missing = readAccountUsageFile(join(tmpdir(), "w1-t2434-definitely-does-not-exist.json"));
  assert.deepEqual(missing, { unreadable: true });
  const unreadable = deriveAccountUsage(missing, [], CAPTURED_AT);
  assert.equal(unreadable.usageUnknownReason, "unreadable");
  assert.equal(unreadable.accountEmail, undefined, "identity is genuinely unrecoverable when the file itself never parsed");

  // And the guard CANNOT fire while unreadable, because the uuid it compares is exactly the field
  // this reason discards — the safety hazard (11) names for piece three.
  assert.equal(
    typeof (missing as AccountUsageInput).uuid,
    "undefined",
    "the account-mismatch guard's own input is absent on the unreadable branch — this is why fixing the path matters beyond display",
  );
});

// ── (4) EVERY FIELD THAT GOES UNKNOWN NOW CARRIES ITS REASON, NOT A BARE WORD ────────────────────
// Pulled out of the REAL rendered shell, never a reimplementation — the same `new Function`
// verbatim-extraction discipline test/account-usage.test.ts and test/console-shell-unknowns.test.ts
// already use for this exact template.

function extractClientSlice(startMarker: string, endMarker: string): string {
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(renderShellHtml())![1]!;
  const start = script.indexOf(startMarker);
  const end = script.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `expected to find ${startMarker}…${endMarker} in the rendered shell`);
  return script.slice(start, end);
}

test("W1-T2434: the five-hour and seven-day fields render the unknown REASON, not a bare 'unknown'", () => {
  const slice = extractClientSlice("function usageWindowLabel", "/** Renders GET /v1/account-usage");
  const label = new Function(`${slice} return usageWindowLabel;`)() as (w: unknown, reason?: string) => string;

  assert.equal(label(undefined, "too-old"), "unknown (too-old)", "the reason travels onto the five-hour/seven-day fields now");
  assert.equal(label(undefined, "unreadable"), "unknown (unreadable)");
  assert.equal(label(undefined, "account-mismatch"), "unknown (account-mismatch)");
  assert.equal(label(undefined, "no-cache"), "unknown (no-cache)");
  // No reason supplied (the reading is simply absent from a caller that never had one) still
  // degrades to the bare word — never fabricates a reason that was not on the payload.
  assert.equal(label(undefined, undefined), "unknown");
  // A GENUINE reading is unaffected by the reason argument — the reason only ever explains an
  // absence, it never overrides a real number.
  assert.equal(label({ percentUsed: 0, resetsAt: "2026-08-02T04:59:59.209129+00:00" }, "too-old").startsWith("0%"), true);
});

test("W1-T2434: the account line itself carries the reason when identity is the thing that went unknown", () => {
  const slice = extractClientSlice("function renderAccountUsage", "/** W1-T364");
  const factory = new Function(
    "elements",
    [
      "var document = { getElementById: function (id) { return elements[id] === undefined ? null : elements[id]; } };",
      "function setGlanceValue(id, text) { var e = document.getElementById(id); if (e) e.textContent = text; }",
      "function usageWindowLabel(w, reason) { if (!w || w.percentUsed == null) return reason ? `unknown (${reason})` : 'unknown'; return String(w.percentUsed) + '%'; }",
      "function formatRelative() { return ''; }",
      "function formatTimestamp() { return ''; }",
      "function costLabel(v) { return v == null ? 'unknown' : ('$' + v); }",
      slice,
      "return { renderAccountUsage: renderAccountUsage };",
    ].join("\n"),
  ) as (els: unknown) => { renderAccountUsage: (a: unknown) => void };

  function el() {
    return { textContent: "" };
  }
  const elements: Record<string, { textContent: string }> = {
    "au-account": el(),
    "au-five-hour": el(),
    "au-seven-day": el(),
    "au-governor": el(),
    "au-cost-governor": el(),
    "au-queue-governor": el(),
    "au-cost-ceiling": el(),
    "au-cost-ceiling-audit": el(),
    "au-as-of": el(),
    "au-measures": el(),
  };
  const built = factory(elements);

  // Identity present (every reason except "unreadable") — the real account renders, no reason text.
  built.renderAccountUsage({ accountEmail: "operator@example.com", usageUnknownReason: "too-old", governor: "unknown", costGovernor: "unknown", queueGovernor: "unknown" });
  assert.equal(elements["au-account"]!.textContent, "operator@example.com", "a known identity is never annotated with a usage reason");

  // Identity absent — the ONLY case is "unreadable" — the account line now carries the reason,
  // rather than the bare "unknown" the measured strip showed before this task.
  built.renderAccountUsage({ usageUnknownReason: "unreadable", governor: "unknown", costGovernor: "unknown", queueGovernor: "unknown" });
  assert.equal(elements["au-account"]!.textContent, "unknown (unreadable)");
  assert.notEqual(elements["au-account"]!.textContent, "unknown", "a bare word is no longer acceptable here");
});

// ── (7) NO CREDENTIAL FIELD IS COPIED OUT, AND THE PARSED OBJECT NEVER ESCAPES ───────────────────

test("W1-T2434: the reader still projects only identity and usage — no credential field, and the parsed object never escapes", () => {
  const input = readAccountUsageFile(FIXTURE);
  assert.deepEqual(
    Object.keys(input).sort(),
    ["cacheFetchedAtMs", "cacheUuid", "email", "fiveHour", "org", "sevenDay", "uuid"],
    "exactly the seven projected fields, unchanged by this task",
  );
  const serialized = JSON.stringify(deriveAccountUsage(input, [], CAPTURED_AT));
  for (const forbidden of ["oauthAccount", "accessToken", "refreshToken", "apiKey", "primaryApiKey", "sk-ant"]) {
    assert.equal(serialized.includes(forbidden), false, `the served payload must never contain ${forbidden}`);
  }
  // Source-level lock: the parsed object is never returned or assigned outside readAccountUsageFile.
  const src = readFileSync(ACCOUNT_USAGE_TS, "utf8");
  assert.match(src, /THE PARSED OBJECT NEVER ESCAPES THIS FUNCTION/, "the containment rule this task inherits is still documented, not quietly dropped");
});

// ── (8) THE CACHE AGE BOUND IS UNCHANGED, AND NOTHING WRITES OR BACK-DATES IT ────────────────────

test("W1-T2434: USAGE_CACHE_MAX_AGE_MS stays 30 minutes, and account-usage.ts never writes the cache it reads", () => {
  assert.equal(USAGE_CACHE_MAX_AGE_MS, 30 * 60 * 1000);
  const src = readFileSync(ACCOUNT_USAGE_TS, "utf8");
  assert.doesNotMatch(src, /writeFileSync|appendFileSync/, "this module only ever reads ~/.claude.json, never writes or back-dates it");
});

// ── (9) NO WRITE-SCOPED ROUTE AND NO SWITCH AFFORDANCE IS ADDED BY THIS PIECE ────────────────────

test("W1-T2434: the account-usage route stays read-scoped, and this piece adds no switch affordance", () => {
  const route = buildAccountUsageRoute({ ledgerPath: join(mkdtempSync(join(tmpdir(), "account-identity-scope-")), "ledger.ndjson") });
  assert.equal(route.method, "GET");
  assert.equal(route.scope, "read", "read-only, exactly as before this task");

  const sh = readFileSync(SERVE_CONTAINER_SH, "utf8");
  assert.doesNotMatch(sh, /-p\s|--publish/, "no new port is published by this task's mount/env change");
  const src = readFileSync(ACCOUNT_USAGE_TS, "utf8");
  assert.doesNotMatch(src, /scope:\s*"write"/, "this module declares no write-scoped route");
});
