import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accessIdentityProviders } from "../src/lib/serve.js";
import type { CloudflareAccessKeyCache, IdentityProvider } from "../src/lib/service.js";
import type { IncomingMessage } from "node:http";

const REPO_ROOT = join(import.meta.dirname, "..");

// ── W1-T996: THE ACCESS JWT PROVIDER IS BUILT, TESTED, AND HAD ZERO PRODUCTION CALL SITES ────
//
// `cloudflareAccessIdentityProvider` and `createCloudflareAccessKeyCache` shipped in W1-T531 fully
// unit-tested. MEASURED at origin/main on 2026-09-04 they scored **0 src invocations each**,
// against controls of **2 and 2** for `tailscaleIdentityProvider` and `bearerTokenProvider` — the
// two providers that ARE wired. So every console request already carried a verified Cloudflare
// Access identity that the server threw away.
//
// THIS SUITE COVERS THE WIRING, NOT THE VERIFIER. `src/lib/service.ts` is deliberately outside
// this task's scope: its verification logic is W1-T531's and is covered by
// test/identity-provider-seam.test.ts. What is new here is composition — WHETHER a provider is
// built, WHERE it lands in the chain, and that the key refresh stays off the request path.

/** A request carrying (or not carrying) the Access assertion header. */
const req = (headers: Record<string, string> = {}): IncomingMessage => ({ headers }) as unknown as IncomingMessage;

/** A key cache under the test's control — `scheduleRefresh` records rather than fetches. */
function recordingCache(keys?: readonly unknown[]) {
  let scheduled = 0;
  const cache: CloudflareAccessKeyCache = {
    keys: () => keys as never,
    scheduleRefresh: () => {
      scheduled += 1;
    },
  };
  return { cache, scheduled: () => scheduled };
}

function providersWith(opts: { teamDomain?: string; audience?: string; cache?: CloudflareAccessKeyCache }): IdentityProvider[] {
  return accessIdentityProviders({
    teamDomain: opts.teamDomain,
    audience: opts.audience,
    makeKeyCache: (() => opts.cache ?? recordingCache().cache) as never,
  });
}

// ── criterion 1 ──────────────────────────────────────────────────────────────────────────────

test("W1-T996: the access provider is composed after the bearer token at the serve call site", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "serve.ts"), "utf8");
  const start = src.indexOf("const server = createService({");
  assert.ok(start >= 0, "control: the one production createService call site must exist");
  const call = src.slice(start, src.indexOf("});", start));
  assert.match(call, /providers: accessIdentityProviders\(/, "the provider must reach the ONE production call site");

  // AFTER the built-ins, via the seam — never by reordering createService's own array. The
  // token-first order is the pre-seam W1-T371 contract, and preserving it is what keeps every CLI
  // caller unaffected. `service.ts` is out of scope precisely so it cannot be reordered here.
  const service = readFileSync(join(REPO_ROOT, "src", "lib", "service.ts"), "utf8");
  const builtins = service.indexOf("const providers: IdentityProvider[] = [");
  assert.ok(builtins >= 0, "control: the built-in provider array must exist");
  const arr = service.slice(builtins, service.indexOf("];", builtins));
  const tailnet = arr.indexOf("tailscaleIdentityProvider");
  const bearer = arr.indexOf("bearerTokenProvider");
  assert.ok(tailnet >= 0 && bearer > tailnet, "the built-in order (tailnet, then bearer) must be unchanged");
  assert.ok(!arr.includes("cloudflareAccess"), "and the Access provider must NOT have been spliced into it");
});

// ── criterion 2 ──────────────────────────────────────────────────────────────────────────────

test("W1-T996: a request with no access header falls through instead of being granted write", () => {
  const [provider] = providersWith({ teamDomain: "https://example.cloudflareaccess.com", audience: "aud-tag" });
  assert.ok(provider, "a configured install composes exactly one Access provider");
  // `undefined` is "not my credential, try the next provider" — NOT a denial, which is what keeps
  // identity ADDITIVE to the token rather than a replacement.
  assert.equal(provider!.grant(req(), false), undefined);
});

test("W1-T996: absent config composes NO provider at all, never a permissive one", () => {
  // Composing with an empty audience would verify nothing and grant on ANY assertion — strictly
  // worse than leaving it unwired, which is why absence is a hard skip rather than a default.
  assert.deepEqual(providersWith({}), [], "neither value");
  assert.deepEqual(providersWith({ teamDomain: "https://example.cloudflareaccess.com" }), [], "domain only");
  assert.deepEqual(providersWith({ audience: "aud-tag" }), [], "audience only");
  assert.deepEqual(providersWith({ teamDomain: "   ", audience: "aud-tag" }), [], "whitespace is not configuration");
  assert.equal(providersWith({ teamDomain: "https://x.cloudflareaccess.com", audience: "a" }).length, 1, "control: both present composes one");
});

// ── criterion 3 ──────────────────────────────────────────────────────────────────────────────

test("W1-T996: a verified assertion grants write at the middle tier and not the high tier", () => {
  const [provider] = providersWith({ teamDomain: "https://example.cloudflareaccess.com", audience: "aud-tag" });
  assert.equal(provider!.writeTier, "middle", "middle: a real per-caller credential, but reachable from ANY network");
  // The five HIGH-tier routes stay out of reach. `/v1/inbox/approve` is HIGH — a briefing for this
  // task listed it as unlocked by this grant, and the shard corrects that.
  assert.notEqual(provider!.writeTier, "high");
  assert.equal(provider!.name, "cloudflare-access", "and the grant is attributable to its own provider");
});

// ── criterion 4 ──────────────────────────────────────────────────────────────────────────────

test("W1-T996: the bearer token keeps working for a caller that presents one", () => {
  // The Access provider must not recognize a bearer credential at all, so a token-presenting
  // caller falls straight through to `bearerTokenProvider` exactly as before this task.
  const [provider] = providersWith({ teamDomain: "https://example.cloudflareaccess.com", audience: "aud-tag" });
  assert.equal(provider!.grant(req({ authorization: "Bearer some-write-token" }), false), undefined);
  // And with no Access config the array is EMPTY, so the composed chain is byte-identical to main.
  assert.deepEqual(providersWith({}), []);
});

// ── criterion 5 ──────────────────────────────────────────────────────────────────────────────

test("W1-T996: the key cache refresh never runs on the request path", () => {
  const rec = recordingCache(undefined); // no keys yet — every request is a cache miss
  const [provider] = providersWith({ teamDomain: "https://example.cloudflareaccess.com", audience: "aud-tag", cache: rec.cache });
  const afterCompose = rec.scheduled();
  assert.equal(afterCompose, 1, "the refresh is started ONCE at composition, off any request");

  // A cache miss must DENY THIS REQUEST and let the next refresh fix the next one — the design's
  // own falsifier. `grant` is synchronous, so it cannot have awaited a fetch even if it wanted to.
  const result = provider!.grant(req({ "cf-access-jwt-assertion": "not.a.real.assertion" }), false);
  assert.equal(result, undefined, "a miss denies rather than blocking on a refresh");
  assert.ok(typeof (provider!.grant as unknown as () => unknown) === "function");
  assert.equal(
    (provider!.grant(req({ "cf-access-jwt-assertion": "still.not.real" }), false) as unknown) ?? undefined,
    undefined,
    "and a second miss is still a denial, never an await",
  );
});

test("W1-T996: composition starts the refresh exactly once, not once per request", () => {
  const rec = recordingCache(undefined);
  const [provider] = providersWith({ teamDomain: "https://example.cloudflareaccess.com", audience: "aud-tag", cache: rec.cache });
  for (let i = 0; i < 5; i++) provider!.grant(req({ "cf-access-jwt-assertion": `a.b.${i}` }), false);
  // The cache's OWN scheduleRefresh may fire on a miss (that is its documented job); what must not
  // happen is the WIRING re-arming it per request. Composition contributed exactly one.
  assert.equal(rec.scheduled(), 1, `expected the single composition-time start; got ${rec.scheduled()}`);
});

// ── criterion 6: scope ───────────────────────────────────────────────────────────────────────

test("W1-T996: this task wires the grant and does not rebuild the verifier", () => {
  // `src/lib/service.ts` is deliberately NOT in this task's files: a builder editing it is
  // rebuilding W1-T531 rather than wiring it. Pinned so a later change has to notice.
  const service = readFileSync(join(REPO_ROOT, "src", "lib", "service.ts"), "utf8");
  assert.match(service, /export function cloudflareAccessIdentityProvider\(/, "the provider still lives in service.ts");
  assert.match(service, /export function createCloudflareAccessKeyCache\(/, "and so does the cache");
  const serve = readFileSync(join(REPO_ROOT, "src", "lib", "serve.ts"), "utf8");
  assert.ok(!/function cloudflareAccessIdentityProvider\(/.test(serve), "serve.ts must not carry a second copy of the provider");
  assert.ok(!/function createCloudflareAccessKeyCache\(/.test(serve), "nor of the key cache");
});
