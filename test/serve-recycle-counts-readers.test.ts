import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  consoleRecyclePatienceMs,
  readAttention,
  READ_ATTENTION_HALF_LIFE_MS,
  RECYCLE_PATIENCE_BASE_MS,
  RECYCLE_PATIENCE_FREE_MS,
  stampReadWith,
} from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";

// ── A POLLING CONSOLE IS A WATCHER ───────────────────────────────────────────────────────────
//
// The recycle gate asked "is anyone SUBSCRIBED", counting SSE clients on /v1/status/stream. That
// was right when the only console was the shell this daemon serves itself. The product console is
// a separate Next.js application that POLLS /v1/status every 3s and never opens a stream, so an
// operator reading it counted as nobody, patience read as zero, and the daemon recycled out from
// under him.
//
// OPERATOR REPORT 2026-09-15: "the data is all showing unavailable right now". Measured the same
// day: the boot window after a recycle is 86.5s, and cloudflared logs "connection refused" then
// "connection reset by peer" against remudero-serve:4317 across it.
//
// A HALF-LIFE RATHER THAN A WINDOW, because a window is a cliff and this is a question of degree.

test("a read decays by half every minute, so attention is a slope and never a cliff", () => {
  assert.equal(readAttention(0), 1, "a read this instant is full attention");
  assert.equal(readAttention(READ_ATTENTION_HALF_LIFE_MS), 0.5);
  assert.equal(readAttention(READ_ATTENTION_HALF_LIFE_MS * 2), 0.25);

  // Strictly decreasing across the whole range — the property that makes this a slope. A cliff
  // anywhere would reintroduce a threshold, which is what this shape exists to avoid.
  let previous = Number.POSITIVE_INFINITY;
  for (let minutes = 0; minutes <= 30; minutes += 1) {
    const value = readAttention(minutes * 60_000);
    assert.ok(value < previous, `attention must fall at ${minutes} minutes`);
    previous = value;
  }

  assert.equal(readAttention(undefined), 0, "no read ever observed is exactly zero, not a small number");
  assert.equal(readAttention(-1), 0, "a clock that went backwards is no evidence of attention");
});

test("a console that only polls keeps the daemon from recycling under it, though it opens no stream", () => {
  const justPolled = consoleRecyclePatienceMs(0, 10, 1_000);
  assert.ok(justPolled > 0, "a read one second ago is a watcher — this is the whole defect, and it reddens here");

  // The old behaviour, for contrast: subscribers alone would have reported nobody watching.
  assert.equal(consoleRecyclePatienceMs(0, 10, undefined), RECYCLE_PATIENCE_FREE_MS);
});

test("attention that has aged out returns the daemon to recycling freely", () => {
  const stale = consoleRecyclePatienceMs(0, 10, READ_ATTENTION_HALF_LIFE_MS * 20);
  const fresh = consoleRecyclePatienceMs(0, 10, 0);
  assert.ok(stale < fresh);
  assert.ok(stale < 1_000, "twenty half-lives is effectively unwatched, so patience is negligible rather than pinned");
});

test("a subscriber still counts, so the SSE console is not regressed by teaching the gate about reads", () => {
  assert.equal(consoleRecyclePatienceMs(1, 10, undefined), RECYCLE_PATIENCE_BASE_MS / 10);
  assert.ok(
    consoleRecyclePatienceMs(1, 10, 0) > consoleRecyclePatienceMs(1, 10, undefined),
    "a subscriber who is ALSO reading is more attention than a subscriber alone",
  );
});

test("a read-scoped route stamps attention and a write-scoped one does not", () => {
  const stamps: number[] = [];
  const base: Route = {
    method: "GET",
    path: "/v1/status",
    scope: "read",
    handler: () => {},
  };
  const wrapped = stampReadWith(base, () => stamps.push(Date.now()));
  wrapped.handler({} as IncomingMessage, {} as ServerResponse, { params: {} } as never);
  assert.equal(stamps.length, 1);

  // A webhook delivery is not an operator watching: /v1/hooks/github carried 1341 of the 1423
  // requests reaching the tunnel on 2026-09-15, so counting it would report constant attention
  // and the gate would never recycle at all.
  const hook: Route = { method: "POST", path: "/v1/hooks/github", scope: "write", handler: () => {} };
  const unwrapped = stampReadWith(hook, () => stamps.push(Date.now()));
  assert.equal(unwrapped, hook, "a non-read route is returned untouched, not wrapped");
  unwrapped.handler({} as IncomingMessage, {} as ServerResponse, { params: {} } as never);
  assert.equal(stamps.length, 1, "and serving it stamps nothing");
});
