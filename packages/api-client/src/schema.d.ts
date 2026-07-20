// GENERATED FILE -- DO NOT EDIT BY HAND.
// Source: openapi/daemon.yaml
// Regenerate: `npm run api-client:generate`. Verify (CI): `npm run api-client:check`.
// See scripts/generate-api-client.mjs and MASTER-PLAN §7A.

export interface components {
  schemas: {
    /** The JSON error envelope every non-2xx response on the surface returns (src/lib/service.ts's `sendJson` error paths). */
    Error: {
      /** `unauthorized` (401, no/unrecognized bearer token), `forbidden` (403, recognized token missing the required scope), `not_found` (404, no route registered for this method + path), or `internal_error` (500, the route handler threw). */
      error: "unauthorized" | "forbidden" | "not_found" | "internal_error";
      /** Present only on a 403 -- the scope the caller's token was missing. */
      required_scope?: "read" | "write";
    };
  };
  securitySchemes: {
    /** Read-scoped bearer token. Grants GET access to read-scoped routes and SSE streams. A write-scoped token also satisfies this scope (write is a superset of read). */
    bearerRead: { type: "http"; scheme: "bearer" };
    /** Write-scoped bearer token. Required for any route whose `scope` is `write` (src/lib/service.ts's `Scope`). */
    bearerWrite: { type: "http"; scheme: "bearer" };
  };
}

export interface paths {}

export interface operations {}
