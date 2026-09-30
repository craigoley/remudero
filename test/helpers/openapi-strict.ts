// The strict OpenAPI validator the contract suites share (W1-T4642, P1-12). It checks the subset of
// OpenAPI openapi/daemon.yaml uses, and it is STRICT on one axis JSON Schema is not: a key the body
// carries that the schema never declares is a violation, because "the contract says what the daemon
// sends" is exactly the claim an undeclared key falsifies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type Schema = Record<string, unknown>;
export type Operation = { description?: string; parameters?: Schema[]; responses: Record<string, Schema> };
export type Spec = { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, Schema>; responses: Record<string, Schema> } };

export const SPEC = parseYaml(readFileSync(join(import.meta.dirname, "..", "..", "openapi", "daemon.yaml"), "utf8")) as Spec;

export function resolve(node: Schema): Schema {
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  const m = /^#\/components\/(schemas|responses)\/(.+)$/.exec(ref);
  assert.ok(m, `unsupported $ref ${ref}`);
  const target = SPEC.components[m[1] as "schemas" | "responses"][m[2]!];
  assert.ok(target, `$ref ${ref} names nothing`);
  return resolve(target);
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** Every way `value` fails `schema` -- the OpenAPI subset daemon.yaml uses, strict on undeclared keys. */
export function violations(value: unknown, node: Schema, at = "$"): string[] {
  const schema = resolve(node);
  if (Array.isArray(schema.oneOf)) {
    const matching = (schema.oneOf as Schema[]).filter((branch) => violations(value, branch, at).length === 0).length;
    return matching === 1 ? [] : [`${at}: matches ${matching} oneOf branches, not exactly one`];
  }
  const types = schema.type === undefined ? [] : ([] as string[]).concat(schema.type as string | string[]);
  const actual = jsonType(value);
  if (types.length > 0 && !types.includes(actual) && !(actual === "integer" && types.includes("number"))) {
    return [`${at}: is ${actual}, declared ${types.join("|")}`];
  }
  if ("const" in schema && value !== schema.const) return [`${at}: is ${JSON.stringify(value)}, declared const ${JSON.stringify(schema.const)}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${at}: ${JSON.stringify(value)} is not in enum ${JSON.stringify(schema.enum)}`];
  if (typeof schema.pattern === "string" && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    return [`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`];
  }
  if (actual === "array" && schema.items) return (value as unknown[]).flatMap((item, i) => violations(item, schema.items as Schema, `${at}[${i}]`));
  if (actual !== "object") return [];
  const record = value as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const missing = ((schema.required ?? []) as string[]).filter((key) => !(key in record)).map((key) => `${at}.${key}: required, absent`);
  const perKey = Object.entries(record).flatMap(([key, v]) => {
    if (properties[key]) return violations(v, properties[key]!, `${at}.${key}`);
    if (typeof schema.additionalProperties === "object") return violations(v, schema.additionalProperties as Schema, `${at}.${key}`);
    return schema.additionalProperties === true ? [] : [`${at}.${key}: sent, never declared`];
  });
  return [...missing, ...perKey];
}

export function operation(path: string, method: string): Operation {
  const op = SPEC.paths[path]?.[method.toLowerCase()];
  assert.ok(op, `${method} ${path} is not declared in openapi/daemon.yaml`);
  return op;
}

/** The JSON body schema the spec declares for one route's one status. */
export function declaredBody(path: string, method: string, status: number): Schema {
  const response = operation(path, method).responses[String(status)];
  assert.ok(response, `${method} ${path} declares no ${status}`);
  const schema = (resolve(response).content as Record<string, { schema: Schema }> | undefined)?.["application/json"]?.schema;
  assert.ok(schema, `${method} ${path}'s ${status} declares no JSON body`);
  return schema;
}
