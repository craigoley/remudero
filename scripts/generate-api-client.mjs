#!/usr/bin/env node
// scripts/generate-api-client.mjs
//
// packages/api-client GENERATOR (W3-T1b, MASTER-PLAN §7A).
//
// §7A: "packages/api-client is GENERATED from that surface" (openapi/daemon.yaml) "and is the ONLY
// way any client talks to the daemon. Generator choice: OpenAPI -> typed client (over hand-written
// TS types)... TS-types-only would re-encode the surface by hand, the exact drift this section
// exists to kill." This script IS that generator: it reads openapi/daemon.yaml and renders the
// committed packages/api-client/src/schema.d.ts. `--check` (same convention as
// scripts/generate-plan-index.mjs / generate-learnings-index.mjs) re-renders and fails loudly if
// the committed file does not match -- a STALE client is exactly the drift §7A exists to catch.
//
// A third-party OpenAPI->TS generator (openapi-typescript) was evaluated and rejected: its
// `typescript@^5.x` peer dependency conflicts with this repo's `typescript@^7.0.2` and breaks
// `npm ci` repo-wide (the same TS7-ecosystem-lag class .dependency-cruiser.cjs already works
// around by using the swc parser instead of dependency-cruiser's own tsc-based extractor). Rather
// than loosen peer-dep enforcement repo-wide for one generator, this is a small self-contained
// renderer over a deliberately small OpenAPI subset (object/string/number/integer/boolean/array
// schemas, $ref, enum, nullable via a `["T","null"]` type array, http-bearer security schemes,
// and per-path/per-method response types) -- the same "plain Node script" convention every other
// scripts/generate-*.mjs in this repo already uses.
//
// Usage:
//   node scripts/generate-api-client.mjs [--source openapi/daemon.yaml] [--out packages/api-client/src/schema.d.ts]
//   node scripts/generate-api-client.mjs --check   # exit 1 if the committed client is stale

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const GENERATED_BANNER = (sourceLabel) =>
  `// GENERATED FILE -- DO NOT EDIT BY HAND.\n` +
  `// Source: ${sourceLabel}\n` +
  `// Regenerate: \`npm run api-client:generate\`. Verify (CI): \`npm run api-client:check\`.\n` +
  `// See scripts/generate-api-client.mjs and MASTER-PLAN §7A.\n`;

/** Collapse a (possibly YAML-folded, multi-line) description into one JSDoc-safe line. */
function docText(description) {
  return description.trim().replace(/\s+/g, " ");
}

/**
 * Resolve a local "#/components/schemas/Name" $ref to its schema name, verifying it is actually
 * declared in `knownSchemaNames` -- an unresolvable $ref must fail generation loudly rather than
 * emit TypeScript that references an undefined type (a broken "generated" client is worse than no
 * client: it fails at every CONSUMER's typecheck with no pointer back to the real cause).
 */
function refSchemaName(ref, knownSchemaNames) {
  const match = /^#\/components\/schemas\/([A-Za-z0-9_]+)$/.exec(ref);
  if (!match) throw new Error(`generate-api-client: unsupported $ref '${ref}' (only local components/schemas refs are supported)`);
  const name = match[1];
  if (!knownSchemaNames.has(name)) {
    throw new Error(`generate-api-client: $ref '${ref}' points at undeclared schema '${name}' -- no components.schemas.${name} exists`);
  }
  return name;
}

/** Render one JSON-Schema-subset node (as used by openapi/daemon.yaml) as a TS type expression. */
function renderType(schema, indent, knownSchemaNames) {
  if (schema.$ref) return refSchemaName(schema.$ref, knownSchemaNames);

  const rawType = schema.type;
  const types = Array.isArray(rawType) ? rawType : [rawType];
  const nullable = types.includes("null");
  const coreTypes = types.filter((t) => t !== "null");
  if (coreTypes.length !== 1) {
    throw new Error(`generate-api-client: expected exactly one non-null type, got ${JSON.stringify(rawType)}`);
  }
  const type = coreTypes[0];

  let rendered;
  if (schema.enum) {
    rendered = schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  } else if (type === "object") {
    rendered = renderObject(schema, indent, knownSchemaNames);
  } else if (type === "array") {
    const itemType = renderType(schema.items ?? {}, indent, knownSchemaNames);
    rendered = `(${itemType})[]`;
  } else if (type === "string") {
    rendered = "string";
  } else if (type === "number" || type === "integer") {
    rendered = "number";
  } else if (type === "boolean") {
    rendered = "boolean";
  } else {
    throw new Error(`generate-api-client: unsupported schema type '${type}'`);
  }
  return nullable ? `${rendered} | null` : rendered;
}

function renderObject(schema, indent, knownSchemaNames) {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const propIndent = indent + "  ";
  const names = Object.keys(properties);
  if (names.length === 0) return "Record<string, never>";
  const lines = names.map((name) => {
    const prop = properties[name];
    const optional = required.has(name) ? "" : "?";
    const doc = prop.description ? `${propIndent}/** ${docText(prop.description)} */\n` : "";
    return `${doc}${propIndent}${name}${optional}: ${renderType(prop, propIndent, knownSchemaNames)};`;
  });
  return `{\n${lines.join("\n")}\n${indent}}`;
}

/** `components.schemas.*` -> one exported TS interface per schema, in declared order. */
function renderSchemas(spec, knownSchemaNames) {
  const schemas = spec.components?.schemas ?? {};
  const names = Object.keys(schemas);
  if (names.length === 0) return "  schemas: Record<string, never>;\n";
  const entries = names.map((name) => {
    const schema = schemas[name];
    const doc = schema.description ? `    /** ${docText(schema.description)} */\n` : "";
    return `${doc}    ${name}: ${renderType(schema, "    ", knownSchemaNames)};`;
  });
  return `  schemas: {\n${entries.join("\n")}\n  };\n`;
}

/** `components.securitySchemes.*` -> one exported TS type per scheme. Only http-bearer is supported today. */
function renderSecuritySchemes(spec) {
  const schemes = spec.components?.securitySchemes ?? {};
  const names = Object.keys(schemes);
  if (names.length === 0) return "  securitySchemes: Record<string, never>;\n";
  const entries = names.map((name) => {
    const scheme = schemes[name];
    if (scheme.type !== "http") {
      throw new Error(`generate-api-client: securityScheme '${name}': unsupported type '${scheme.type}' (only 'http' is supported)`);
    }
    const doc = scheme.description ? `    /** ${docText(scheme.description)} */\n` : "";
    return `${doc}    ${name}: { type: "http"; scheme: ${JSON.stringify(scheme.scheme)} };`;
  });
  return `  securitySchemes: {\n${entries.join("\n")}\n  };\n`;
}

/** Resolve a response object, following a local "#/components/responses/Name" $ref if present. */
function resolveResponse(response, spec) {
  if (!response.$ref) return response;
  const match = /^#\/components\/responses\/([A-Za-z0-9_]+)$/.exec(response.$ref);
  if (!match) throw new Error(`generate-api-client: unsupported response $ref '${response.$ref}' (only local components/responses refs are supported)`);
  const resolved = spec.components?.responses?.[match[1]];
  if (!resolved) throw new Error(`generate-api-client: response $ref '${response.$ref}' points at undeclared components.responses.${match[1]}`);
  return resolved;
}

/** One `paths` entry per path -> per HTTP method -> a response-status-keyed operation type. */
function renderPaths(spec, knownSchemaNames) {
  const paths = spec.paths ?? {};
  const pathNames = Object.keys(paths);
  if (pathNames.length === 0) return "export interface paths {}\n";

  const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
  const pathEntries = pathNames.map((path) => {
    const pathItem = paths[path];
    const methodNames = METHODS.filter((m) => pathItem[m]);
    const methodEntries = methodNames.map((method) => {
      const op = pathItem[method];
      const responses = op.responses ?? {};
      const statusEntries = Object.keys(responses).map((status) => {
        const response = resolveResponse(responses[status], spec);
        const content = response.content?.["application/json"]?.schema;
        const bodyType = content ? renderType(content, "      ", knownSchemaNames) : "undefined";
        return `      ${JSON.stringify(status)}: ${bodyType};`;
      });
      const responsesBlock = statusEntries.length > 0 ? `{\n${statusEntries.join("\n")}\n    }` : "Record<string, never>";
      return `    ${method}: {\n      responses: ${responsesBlock.replace(/\n/g, "\n    ")};\n    };`;
    });
    return `  ${JSON.stringify(path)}: {\n${methodEntries.join("\n")}\n  };`;
  });
  return `export interface paths {\n${pathEntries.join("\n")}\n}\n`;
}

/**
 * Render the full generated client from a parsed OpenAPI document. Pure (no I/O) so it's directly
 * unit-testable -- `main` below is the only part of this file that touches the filesystem.
 */
export function renderApiClient(spec, sourceLabel) {
  const knownSchemaNames = new Set(Object.keys(spec.components?.schemas ?? {}));
  const parts = [
    GENERATED_BANNER(sourceLabel),
    "\n",
    "export interface components {\n",
    renderSchemas(spec, knownSchemaNames),
    renderSecuritySchemes(spec),
    "}\n",
    "\n",
    renderPaths(spec, knownSchemaNames),
    "\n",
    "export interface operations {}\n",
  ];
  return parts.join("");
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string", default: "openapi/daemon.yaml" },
      out: { type: "string" },
      check: { type: "boolean", default: false },
    },
  });
  const outPath = values.out ?? "packages/api-client/src/schema.d.ts";

  let fresh;
  let schemaCount = 0;
  try {
    const text = readFileSync(values.source, "utf8");
    const spec = parseYaml(text);
    schemaCount = Object.keys(spec.components?.schemas ?? {}).length;
    fresh = renderApiClient(spec, values.source);
  } catch (err) {
    console.error(`generate-api-client: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (values.check) {
    let committed;
    try {
      committed = readFileSync(outPath, "utf8");
    } catch {
      console.error(`generate-api-client: ${outPath} does not exist -- run 'npm run api-client:generate' to generate it.`);
      process.exitCode = 1;
      return;
    }
    if (committed !== fresh) {
      console.error(
        `generate-api-client: ${outPath} is STALE -- it does not match a fresh regeneration from ${values.source}.\n` +
          `Run 'npm run api-client:generate' and commit the result.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`generate-api-client: OK -- ${outPath} matches the current ${values.source}.`);
    process.exitCode = 0;
    return;
  }

  writeFileSync(outPath, fresh);
  console.log(`generate-api-client: wrote ${outPath} (${schemaCount} schema(s) from ${values.source}).`);
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/generate-api-client.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
