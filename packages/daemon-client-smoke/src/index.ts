// packages/daemon-client-smoke/src/index.ts
//
// W3-T1c (MASTER-PLAN §7A): a MINIMAL internal consumer of the GENERATED @remudero/api-client.
// It exists for exactly one reason -- to be a real package whose typecheck (the `ci` job's
// `npx tsc -p tsconfig.json --noEmit` step in .github/workflows/ci.yml, unconditional on every
// PR; tsconfig.json's `include` already covers `packages/*/src/**/*.ts`, so this file needs no
// new CI wiring) goes RED the moment a daemon surface field it depends on is removed or renamed --
// proving §7A's "a breaking contract change must fail CI in EVERY consumer in the SAME PR" BEFORE
// any real client (apps/dashboard, W3-T2+) exists.
//
// See test/consumer-breaking-change.test.ts for the falsifier proof: a mutated
// packages/api-client/src/schema.d.ts (a renamed field, then a renamed enum member) turns THIS
// file's compile RED; the real committed schema.d.ts compiles it GREEN.
//
// It depends on components.schemas.Error (openapi/daemon.yaml) two independent ways, so either
// class of breaking edit is caught:
//   - a property rename/removal (`error`, `required_scope`) -- a direct property access breaks.
//   - an enum member rename/removal on `error` -- the exhaustive switch's `never` check breaks.
import type { components } from "@remudero/api-client";

type DaemonError = components["schemas"]["Error"];

/** Renders the daemon's shared JSON error envelope as an operator-facing message. */
export function describeDaemonError(err: DaemonError): string {
  const base = describeErrorCode(err.error);
  return err.required_scope ? `${base} (requires ${err.required_scope} scope)` : base;
}

function describeErrorCode(code: DaemonError["error"]): string {
  switch (code) {
    case "unauthorized":
      return "no or unrecognized bearer token";
    case "forbidden":
      return "token missing the required scope";
    case "not_found":
      return "no route registered for this method + path";
    case "internal_error":
      return "the route handler threw";
    default: {
      // Exhaustiveness check: if `error`'s enum gains/renames a member upstream and this switch
      // isn't updated to match, `code` is no longer assignable to `never` here and tsc fails --
      // the "renamed surface enum member breaks a consumer's typecheck" proof this file exists
      // for (see test/consumer-breaking-change.test.ts).
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}
