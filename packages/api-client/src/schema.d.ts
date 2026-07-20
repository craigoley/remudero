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
    /** One task's projected merge-state, derived from GitHub (src/lib/status.ts's `StatusProjection` -- never written back to plan/tasks.yaml). This is the per-task "live state" the read-only board (W3-T2) renders. */
    StatusProjection: {
      /** The plan task id (plan/tasks.yaml's `id`). */
      taskId: string;
      /** Derived status label in the plan's vocabulary (src/lib/plan.ts's TaskStatus). */
      status: "queued" | "recon" | "prompted" | "running" | "review" | "fixing" | "diagnosing" | "blocked" | "merged" | "done";
      /** The single fact dependency-gating cares about -- has this task landed? */
      merged: boolean;
      /** Which precedence source resolved this projection (or `none`). */
      source: "ledger" | "pr-field" | "trailer" | "correction" | "none";
      prNumber?: number;
      prUrl?: string;
      prState?: string;
      /** Trailer search hits rejected by the ownership/anchor asserts, each with a machine-readable reason. Present only when a candidate was actually rejected. */
      rejected_candidates?: ({
        pr: string;
        reason: string;
      })[];
    };
    /** GET /v1/status's body -- one StatusProjection per plan task, as of `generated_at`. */
    StatusSnapshot: {
      generated_at: string;
      tasks: (StatusProjection)[];
    };
  };
  securitySchemes: {
    /** Read-scoped bearer token. Grants GET access to read-scoped routes and SSE streams. A write-scoped token also satisfies this scope (write is a superset of read). */
    bearerRead: { type: "http"; scheme: "bearer" };
    /** Write-scoped bearer token. Required for any route whose `scope` is `write` (src/lib/service.ts's `Scope`). */
    bearerWrite: { type: "http"; scheme: "bearer" };
  };
}

export interface paths {
  "/v1/status": {
    get: {
      responses: {
          "200": StatusSnapshot;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
  "/v1/status/stream": {
    get: {
      responses: {
          "200": undefined;
          "401": Error;
          "403": Error;
          "404": Error;
        };
    };
  };
}

export interface operations {}
