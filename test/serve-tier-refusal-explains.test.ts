import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import type { IssueCloser } from "../src/lib/panel-actions.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import type { TraceGithub } from "../src/lib/trace.js";
import type { RatifyCliGateway } from "../src/lib/panel-graph.js";

// ── A REFUSED ACTION MUST EXPLAIN ITSELF ─────────────────────────────────────────────────────
//
// W1-T500 turned `enforceWriteTiers` on. The bearer token that every `rmd console-url --write`
// link carries is pinned at LOW, so from that link ELEVEN write routes now answer 403 — and the
// client read that 403 as "your token is gone", printing the sessionStorage message and telling
// the operator to run `rmd console-url --write` again. That instruction hands them another LOW
// token which fails identically: the console's own recovery advice was a loop.
//
// `/v1/control/stop` is why this is urgent rather than cosmetic. It is MIDDLE, not HIGH — the
// hard kill, the button an operator reaches for when something is wrong and reading carefully is
// the last thing they are doing. Sending them round the token loop at that moment is the worst
// possible time to be wrong about the cause.
//
// The wire already carried the answer: service.ts's tier gate replies `required_tier`. Only the
// client threw it away. So these tests pin BOTH halves — that the refusal really carries the
// fact (over the REAL assembled server, both tiers), and that the client really renders it into
// a message naming the consequence and the remedy.

const READ_TOKEN = "tier-explain-read-token";
const WRITE_TOKEN = "tier-explain-write-token";
const CAPABILITY = "example.com/cap/console-write";

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


const tierRefusal = (tier: string) => JSON.stringify({ error: "forbidden", required_scope: "write", required_tier: tier });




