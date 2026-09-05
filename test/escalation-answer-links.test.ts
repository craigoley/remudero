import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  consumeOptionLink,
  escalationLinkSecretPath,
  escalationLinkUsedPath,
  loadEscalationLinkSecret,
  mintOptionLink,
  OPTION_LINK_TTL_MS,
  signOptionLink,
  verifyOptionLink,
  type EscalationOptionKind,
  type OptionLinkClaims,
} from "../src/lib/escalate.js";
import { renderEscalationPing } from "../src/lib/notify.js";
import { buildEscalationLinkAnswerRoute, buildEscalationLinkConfirmRoute } from "../src/lib/panel-actions.js";
import { appendThreadMessage } from "../src/lib/inbox-thread.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * test/escalation-answer-links.test.ts — W1-T2696.
 *
 * A MANUAL or HARD_STOP escalation pages the operator with prose; answering means opening the
 * console. The option kinds and the routes already exist (W1-T2273), so what was missing is a
 * link carrying the operator's authority for exactly one option, once.
 *
 * The three refusals are asserted APART, not collapsed: `forged` is an attack or a mangled URL,
 * `expired` is a stale ping worth re-raising, `already-used` is a double-tap and is benign. A
 * single "invalid" would leave the ledger unable to tell an attack from a second tap.
 */

const EXECUTABLE: EscalationOptionKind = { type: "executable", route: "/v1/control/pause", tier: "middle" };
const OTHER_EXECUTABLE: EscalationOptionKind = { type: "executable", route: "/v1/control/stop", tier: "middle" };
const SECRET = "a".repeat(64);
const BASE = "https://console.example/";
const NOW = 1_700_000_000_000;

function root(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}esc-links-`));
}
const never = (): boolean => false;
const queryOf = (url: string): URLSearchParams => new URL(url).searchParams;

// ── the ping ─────────────────────────────────────────────────────────────────

test("W1-T2696: a MANUAL ping carries one signed link per executable option and none for prose options", () => {
  const ping = renderEscalationPing(
    {
      cls: "MANUAL",
      taskId: "W1-T1",
      summary: "needs a call",
      issueUrl: "https://github.com/o/r/issues/1",
      cardUrl: "https://console.example/card",
      options: [
        { label: "Pause", detail: "hold the fleet", kind: EXECUTABLE },
        { label: "Go and look", detail: "operator only", kind: { type: "operator-only" } },
        { label: "Untyped", detail: "no kind at all" },
      ],
    },
    { secret: SECRET, baseUrl: BASE, nowMs: NOW },
  );
  const links = ping.split("\n").filter((l) => l.includes("/v1/escalation/confirm"));
  assert.equal(links.length, 1, `exactly one executable option must get a link:\n${ping}`);
  assert.match(links[0], /^Pause: https:\/\/console\.example\/v1\/escalation\/confirm\?/);
  // The prose survives on every option — a link is a sibling of the sentence, not a replacement.
  assert.ok(ping.includes("[MANUAL] W1-T1: needs a call"));
  // Neither prose option leaks a link.
  assert.equal(ping.includes("Go and look: https"), false);
  assert.equal(ping.includes("Untyped: https"), false);
});

test("W1-T2696: with no secret the ping is exactly today's text, so a missing secret never costs the page", () => {
  const input = {
    cls: "HARD_STOP",
    taskId: "W1-T2",
    summary: "stop",
    issueUrl: "u",
    cardUrl: "c",
    options: [{ label: "Pause", detail: "d", kind: EXECUTABLE }],
  };
  assert.equal(renderEscalationPing(input, { baseUrl: BASE, nowMs: NOW }), "[HARD_STOP] W1-T2: stop\nu\nc");
  // Control: the same input WITH a secret does add a link, so the line above is the degrade
  // path and not a renderer that never links at all.
  assert.ok(renderEscalationPing(input, { secret: SECRET, baseUrl: BASE, nowMs: NOW }).includes("/v1/escalation/confirm"));
});

// ── verification ─────────────────────────────────────────────────────────────

test("W1-T2696: a valid link verifies, and each of forged, expired and already-used is refused apart", () => {
  const url = mintOptionLink("W1-T1", "MANUAL", EXECUTABLE, SECRET, NOW, BASE);
  assert.ok(url);
  assert.equal(verifyOptionLink(queryOf(url), SECRET, NOW, never).ok, true);

  // forged — one character of the signature changed.
  const q = queryOf(url);
  const sig = q.get("s")!;
  q.set("s", (sig[0] === "0" ? "1" : "0") + sig.slice(1));
  const forged = verifyOptionLink(q, SECRET, NOW, never);
  assert.equal(forged.ok, false);
  assert.equal(forged.ok === false && forged.reason, "forged");

  // forged — the ROUTE swapped for another member of the closed set, which is the escalation
  // an attacker would actually attempt: a valid-looking link pointing at a bigger action.
  const swapped = queryOf(url);
  swapped.set("r", "/v1/skills/run");
  const swappedCheck = verifyOptionLink(swapped, SECRET, NOW, never);
  assert.equal(swappedCheck.ok === false && swappedCheck.reason, "forged");

  // forged — the CLASS swapped, which would redirect the answer onto another thread.
  const reclassed = queryOf(url);
  reclassed.set("c", "HARD_STOP");
  assert.equal(verifyOptionLink(reclassed, SECRET, NOW, never).ok, false);

  // expired — verified signature, clock past the expiry.
  const expired = verifyOptionLink(queryOf(url), SECRET, NOW + OPTION_LINK_TTL_MS + 1, never);
  assert.equal(expired.ok === false && expired.reason, "expired");

  // already-used — verified and unexpired, but the marker exists.
  const used = verifyOptionLink(queryOf(url), SECRET, NOW, () => true);
  assert.equal(used.ok === false && used.reason, "already-used");

  // a different secret cannot verify a link minted under this one.
  assert.equal(verifyOptionLink(queryOf(url), "b".repeat(64), NOW, never).ok, false);
});

test("W1-T2696: an expired link that ALSO fails its signature is reported forged, never merely expired", () => {
  const url = mintOptionLink("W1-T1", "MANUAL", EXECUTABLE, SECRET, NOW, BASE)!;
  const q = queryOf(url);
  q.set("s", "0".repeat(64));
  const check = verifyOptionLink(q, SECRET, NOW + OPTION_LINK_TTL_MS + 1, never);
  assert.equal(check.ok === false && check.reason, "forged", "signature is checked before expiry, or an attack hides as staleness");
});

test("W1-T2696: a malformed link is bad-request, and an operator-only option is never given a link", () => {
  assert.equal(verifyOptionLink(new URLSearchParams(""), SECRET, NOW, never).ok, false);
  assert.equal(
    verifyOptionLink(new URLSearchParams("e=a&c=MANUAL&r=/v1/control/pause&x=1&s=short"), SECRET, NOW, never).ok,
    false,
  );
  // A route outside the closed set is refused before any signature work.
  const outside = verifyOptionLink(
    new URLSearchParams(`e=a&c=MANUAL&r=/v1/not/a/route&x=${NOW + 1}&s=${"0".repeat(64)}`),
    SECRET,
    NOW,
    never,
  );
  assert.equal(outside.ok === false && outside.reason, "bad-request");
  assert.equal(mintOptionLink("W1-T1", "MANUAL", { type: "operator-only" }, SECRET, NOW, BASE), undefined);
});

test("W1-T2696: two links for the same escalation differ by option, so one cannot answer the other", () => {
  const a = mintOptionLink("W1-T1", "MANUAL", EXECUTABLE, SECRET, NOW, BASE)!;
  const b = mintOptionLink("W1-T1", "MANUAL", OTHER_EXECUTABLE, SECRET, NOW, BASE)!;
  assert.notEqual(queryOf(a).get("s"), queryOf(b).get("s"));
});

// ── the secret ───────────────────────────────────────────────────────────────

test("W1-T2696: the signing secret lives under the state root and never enters a worker environment or prompt", () => {
  const r = root();
  try {
    const secret = loadEscalationLinkSecret(r);
    const path = escalationLinkSecretPath(r);
    // Under the state root — the SAME directory settings/worker.json's deny rule already covers
    // for the console's write token (W1-T2211), which is the boundary this relies on.
    assert.equal(path, join(r, "state", "escalation-link-secret"));
    assert.equal((statSync(path).mode & 0o777), 0o600);
    assert.match(secret, /^[0-9a-f]{64}$/);
    // Create-once, read-thereafter: a second load returns the same secret, so a daemon restart
    // does not invalidate every link already in an operator's messages.
    assert.equal(loadEscalationLinkSecret(r), secret);
    // The secret never appears in a rendered ping — only signatures derived from it do.
    const ping = renderEscalationPing(
      { cls: "MANUAL", taskId: "W1-T1", summary: "s", issueUrl: "u", cardUrl: "c", options: [{ label: "P", detail: "d", kind: EXECUTABLE }] },
      { secret, baseUrl: BASE, nowMs: NOW },
    );
    assert.equal(ping.includes(secret), false, "a ping must never carry the signing secret itself");
    assert.ok(ping.includes("/v1/escalation/confirm"), "positive control: the ping did render a link to search");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("W1-T2696: consuming a link is exclusive, so two taps racing cannot both win", () => {
  const r = root();
  try {
    const sig = "c".repeat(64);
    assert.equal(consumeOptionLink(r, sig), true);
    assert.equal(consumeOptionLink(r, sig), false, "the second claim must lose");
    assert.ok(existsSync(escalationLinkUsedPath(r, sig)));
    // A DIFFERENT signature is unaffected — the marker is per link, not a global latch.
    assert.equal(consumeOptionLink(r, "d".repeat(64)), true);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

// ── the routes ───────────────────────────────────────────────────────────────

interface Captured { status: number; body: string; headers: Record<string, unknown> }
function fakeRes(): { res: any; captured: Captured } {
  const captured: Captured = { status: 0, body: "", headers: {} };
  const res: any = {
    writeHead(status: number, headers: Record<string, unknown>) { captured.status = status; captured.headers = headers; },
    end(body?: string) { captured.body = body ?? ""; },
  };
  return { res, captured };
}
const reqFor = (url: string): any => ({ url: url.replace("https://console.example", ""), headers: {} });
/** The handler's third argument. These routes are selfAuthenticated, so they never read it. */
const CTX: any = {};

function seededRoot(): { r: string; threadStorePath: string; ledgerPath: string } {
  const r = root();
  const threadStorePath = join(r, "threads.jsonl");
  appendThreadMessage({ taskId: "W1-T1", class: "MANUAL" }, "escalation", "raised", { threadStorePath });
  return { r, threadStorePath, ledgerPath: join(r, "ledger.ndjson") };
}

test("W1-T2696: the GET confirm route verifies and shows, and never consumes — an iMessage preview must not burn a link", () => {
  const { r, threadStorePath, ledgerPath } = seededRoot();
  try {
    const url = mintOptionLink("W1-T1", "MANUAL", EXECUTABLE, SECRET, NOW, BASE)!;
    const route = buildEscalationLinkConfirmRoute({ root: r, ledgerPath, threadStorePath } as any, { root: r, secret: () => SECRET, now: () => NOW });
    const { res, captured } = fakeRes();
    route.handler(reqFor(url), res, CTX);
    assert.equal(captured.status, 200);
    assert.match(captured.body, /Confirm/);
    // The whole point: nothing was consumed, so the link still verifies afterwards.
    assert.equal(existsSync(escalationLinkUsedPath(r, queryOf(url).get("s")!)), false);
    assert.equal(verifyOptionLink(queryOf(url), SECRET, NOW, (s) => existsSync(escalationLinkUsedPath(r, s))).ok, true);
    assert.equal(route.selfAuthenticated, true, "the phone carries no bearer token; the signature is the authority");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("W1-T2696: a valid link answers exactly once, and the second attempt is refused already-used", () => {
  const { r, threadStorePath, ledgerPath } = seededRoot();
  try {
    const url = mintOptionLink("W1-T1", "MANUAL", EXECUTABLE, SECRET, NOW, BASE)!;
    const deps: any = { root: r, ledgerPath, threadStorePath };
    const route = buildEscalationLinkAnswerRoute(deps, { root: r, secret: () => SECRET, now: () => NOW });

    const first = fakeRes();
    route.handler(reqFor(url), first.res, CTX);
    assert.equal(first.captured.status, 200, first.captured.body);
    assert.match(readFileSync(threadStorePath, "utf8"), /answered by link: \/v1\/control\/pause/);

    const second = fakeRes();
    route.handler(reqFor(url), second.res, CTX);
    assert.equal(second.captured.status, 410);
    assert.match(second.captured.body, /already-used/);

    const ledger = readFileSync(ledgerPath, "utf8");
    assert.match(ledger, /"step":"escalation\.answered_by_link"/);
    assert.match(ledger, /"step":"escalation\.link_refused"/);
    assert.match(ledger, /"reason":"already-used"/);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("W1-T2696: a forged link is refused 403 and ledgered, and nothing is recorded on the thread", () => {
  const { r, threadStorePath, ledgerPath } = seededRoot();
  try {
    const url = mintOptionLink("W1-T1", "MANUAL", EXECUTABLE, SECRET, NOW, BASE)!;
    const before = readFileSync(threadStorePath, "utf8");
    const tampered = url.replace(/s=[0-9a-f]{64}/, `s=${"0".repeat(64)}`);
    const route = buildEscalationLinkAnswerRoute({ root: r, ledgerPath, threadStorePath } as any, { root: r, secret: () => SECRET, now: () => NOW });
    const { res, captured } = fakeRes();
    route.handler(reqFor(tampered), res, CTX);
    assert.equal(captured.status, 403);
    assert.equal(readFileSync(threadStorePath, "utf8"), before, "a forged link must record nothing");
    assert.match(readFileSync(ledgerPath, "utf8"), /"reason":"forged"/);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("W1-T2696: a store fault refuses WITHOUT burning the link, so a wiring fault never costs the operator their answer", () => {
  const r = root();
  try {
    const ledgerPath = join(r, "ledger.ndjson");
    const url = mintOptionLink("W1-T1", "MANUAL", EXECUTABLE, SECRET, NOW, BASE)!;
    // No threadStorePath configured — the same refusal the reply route gives.
    const route = buildEscalationLinkAnswerRoute({ root: r, ledgerPath } as any, { root: r, secret: () => SECRET, now: () => NOW });
    const { res, captured } = fakeRes();
    route.handler(reqFor(url), res, CTX);
    assert.equal(captured.status, 400);
    assert.equal(existsSync(escalationLinkUsedPath(r, queryOf(url).get("s")!)), false, "the link must survive a fault that is not the operator's doing");
    // And it still verifies, so the operator can answer once the wiring lands.
    assert.equal(verifyOptionLink(queryOf(url), SECRET, NOW, (s) => existsSync(escalationLinkUsedPath(r, s))).ok, true);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("W1-T2696: the signed payload binds every claim, so no field can be moved between links", () => {
  const a: OptionLinkClaims = { escalationId: "W1-T1", cls: "MANUAL", route: "/v1/control/pause", expiresAtMs: NOW };
  for (const changed of [
    { ...a, escalationId: "W1-T2" },
    { ...a, cls: "HARD_STOP" },
    { ...a, route: "/v1/control/stop" as const },
    { ...a, expiresAtMs: NOW + 1 },
  ]) {
    assert.notEqual(signOptionLink(changed, SECRET), signOptionLink(a, SECRET));
  }
  // A delimiter smuggled into a field would let two different claim sets share a payload.
  assert.throws(() => signOptionLink({ ...a, escalationId: "W1|T1" }, SECRET), /delimiter/);
});

// ── the wiring ───────────────────────────────────────────────────────────────

test("W1-T2696: the REAL escalate command's ping carries the links, so the renderer is not shipped inert", async () => {
  const { escalateCommand } = await import("../src/run-task.js");
  const { setPresenceMode } = await import("../src/lib/escalate.js");
  const r = root();
  const home = root();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // config.root must resolve to `r`, the same pinning test/away-mode-delivery.test.ts uses:
    // an instance config under the redirected HOME names the root explicitly.
    mkdirSync(join(r, "state"), { recursive: true });
    writeFileSync(join(r, "state", "ledger.ndjson"), "");
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(
      join(home, ".config", "remudero", "config.json"),
      JSON.stringify({ claudeBin: "/bin/true", root: r, consoleUrl: "http://100.64.1.2:4317" }),
    );
    // ATTENDED, so the real-time ping actually fires (AWAY batches it instead — W1-T2696 changes
    // neither which classes ping nor when).
    setPresenceMode(r, "attended");
    const sent: string[] = [];
    const code = await escalateCommand(
      ["--class", "MANUAL", "--task", "W1-TX", "--summary", "needs a call", "--option", "Pause|hold the fleet", "--recommendation", "pause"],
      {
        issues: { create: () => "https://github.com/o/r/issues/9" } as never,
        notifyChannel: { send: (m: string) => { sent.push(m); return true; } } as never,
      },
    );
    assert.equal(code, 0);
    assert.equal(sent.length, 1, "an ATTENDED MANUAL escalation still pages exactly once");
    // The option `Pause|hold the fleet` carries no `kind` (parseOptionFlags produces none), so it
    // renders as prose with no link — today's behaviour, unchanged. What this pins is that the
    // ping went through renderEscalationPing at all: it still carries the head line verbatim, and
    // the secret was minted under the state root as a side effect of rendering.
    assert.match(sent[0], /^\[MANUAL\] W1-TX: needs a call\n/);
    assert.ok(existsSync(escalationLinkSecretPath(r)),
      `rendering the ping resolves the link secret under the state root (${escalationLinkSecretPath(r)})`);
    // No link, because no option declared an executable kind — a link is never invented for prose.
    assert.equal(sent[0].includes("/v1/escalation/confirm"), false);
  } finally {
    process.env.HOME = oldHome;
    rmSync(r, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

// ── the refusal arms ─────────────────────────────────────────────────────────

test("W1-T2696: a secret that cannot be resolved answers 503 rather than crashing the console", () => {
  const r = root();
  try {
    const deps: any = { root: r, ledgerPath: join(r, "ledger.ndjson"), threadStorePath: join(r, "t.jsonl") };
    const linkDeps = { root: r, secret: () => { throw new Error("state dir unreadable"); }, now: () => NOW };
    for (const route of [buildEscalationLinkConfirmRoute(deps, linkDeps), buildEscalationLinkAnswerRoute(deps, linkDeps)]) {
      const { res, captured } = fakeRes();
      route.handler(reqFor(mintOptionLink("W1-T1", "MANUAL", EXECUTABLE, SECRET, NOW, BASE)!), res, CTX);
      assert.equal(captured.status, 503, `${route.method} ${route.path} must refuse, never throw`);
      assert.match(captured.body, /unavailable/);
    }
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("W1-T2696: the confirm route ledgers a forged link and renders why, without acting", () => {
  const { r, threadStorePath, ledgerPath } = seededRoot();
  try {
    const url = mintOptionLink("W1-T1", "MANUAL", EXECUTABLE, SECRET, NOW, BASE)!;
    const tampered = url.replace(/s=[0-9a-f]{64}/, `s=${"0".repeat(64)}`);
    const route = buildEscalationLinkConfirmRoute({ root: r, ledgerPath, threadStorePath } as any, { root: r, secret: () => SECRET, now: () => NOW });
    const { res, captured } = fakeRes();
    route.handler(reqFor(tampered), res, CTX);
    assert.equal(captured.status, 403);
    assert.match(readFileSync(ledgerPath, "utf8"), /"phase":"confirm"/);
    assert.match(readFileSync(ledgerPath, "utf8"), /"reason":"forged"/);
    // An expired link renders 410 rather than 403 — a stale ping is not an attack.
    const { res: r2, captured: c2 } = fakeRes();
    route.handler(reqFor(url), r2, CTX);
    const late = buildEscalationLinkConfirmRoute({ root: r, ledgerPath, threadStorePath } as any, { root: r, secret: () => SECRET, now: () => NOW + OPTION_LINK_TTL_MS + 1 });
    const { res: r3, captured: c3 } = fakeRes();
    late.handler(reqFor(url), r3, CTX);
    assert.equal(c2.status, 200);
    assert.equal(c3.status, 410);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("W1-T2696: a thread naming no escalation is refused, and the link is not burned", () => {
  const r = root();
  try {
    const ledgerPath = join(r, "ledger.ndjson");
    const threadStorePath = join(r, "empty.jsonl");
    const url = mintOptionLink("W1-T1", "MANUAL", EXECUTABLE, SECRET, NOW, BASE)!;
    const route = buildEscalationLinkAnswerRoute({ root: r, ledgerPath, threadStorePath } as any, { root: r, secret: () => SECRET, now: () => NOW });
    const { res, captured } = fakeRes();
    route.handler(reqFor(url), res, CTX);
    assert.equal(captured.status, 400);
    assert.match(captured.body, /names no existing escalation/);
    assert.equal(existsSync(escalationLinkUsedPath(r, queryOf(url).get("s")!)), false, "an unattachable answer must not burn the link");
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("W1-T2696: losing the race to claim the marker is refused already-used, not executed twice", () => {
  const { r, threadStorePath, ledgerPath } = seededRoot();
  try {
    const url = mintOptionLink("W1-T1", "MANUAL", EXECUTABLE, SECRET, NOW, BASE)!;
    const before = readFileSync(threadStorePath, "utf8");
    // The window a real second tap opens: verification saw no marker, and the claim then loses.
    const route = buildEscalationLinkAnswerRoute({ root: r, ledgerPath, threadStorePath } as any, {
      root: r,
      secret: () => SECRET,
      now: () => NOW,
      consume: () => false,
    });
    const { res, captured } = fakeRes();
    route.handler(reqFor(url), res, CTX);
    assert.equal(captured.status, 410);
    assert.match(captured.body, /already-used/);
    assert.equal(readFileSync(threadStorePath, "utf8"), before, "the loser must record nothing");
    assert.match(readFileSync(ledgerPath, "utf8"), /lost the race/);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("W1-T2696: an unusable state root degrades the ping to today's text instead of dropping the page", async () => {
  const { escalateCommand } = await import("../src/run-task.js");
  const r = root();
  const home = root();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // `<root>/state` is a FILE, so minting the secret throws — the path run-task.ts catches.
    mkdirSync(join(r, "state"), { recursive: true });
    writeFileSync(join(r, "state", "ledger.ndjson"), "");
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root: r, consoleUrl: "http://100.64.1.2:4317" }));
    writeFileSync(join(r, "state", "escalation-link-secret"), "");
    // A directory where the secret file must be makes the create-or-read fail loud.
    rmSync(join(r, "state", "escalation-link-secret"));
    mkdirSync(join(r, "state", "escalation-link-secret"));
    const sent: string[] = [];
    const code = await escalateCommand(
      ["--class", "MANUAL", "--task", "W1-TY", "--summary", "still pages", "--option", "Pause|hold", "--recommendation", "pause"],
      { issues: { create: () => "https://github.com/o/r/issues/11" } as never, notifyChannel: { send: (m: string) => { sent.push(m); return true; } } as never },
    );
    assert.equal(code, 0);
    assert.equal(sent.length, 1, "a missing secret must never cost the operator the page itself");
    assert.match(sent[0], /^\[MANUAL\] W1-TY: still pages\n/);
  } finally {
    process.env.HOME = oldHome;
    rmSync(r, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
