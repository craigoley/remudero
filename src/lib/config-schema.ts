export const CONFIG_SCHEMA_VERSION = 1;

export interface Config {
  claudeBin: string;
  root: string;
  installRoot?: string;
  zdotdir?: string;
  workerShell?: string;
  workerHomeRoot?: string;
  softBudgetThresholdUsd?: number;
  workerModel?: string;
  architectModel?: string;
  accessTeamDomain?: string;
  accessAudience?: string;
  notifyRecipient?: string;
  overflow?: "none" | "api_key";
  dailyCapUsd?: number | null;
  fixStrikeCap?: number;
  consoleUrl?: string;
  serve?: { host?: string; port?: number; identityCapability?: string; trustedProxy?: string };
  relay?: { url?: string; token?: string };
  headroom?: { enabled?: boolean };
  workerProviders?: {
    enabled?: Array<"claude" | "codex">;
    reservePercent?: number;
    capacityCacheMs?: number;
    codexBin?: string;
    codexHome?: string;
    codexModel?: string;
    codexModels?: {
      economy?: string[];
      balanced?: string[];
      frontier?: string[];
    };
  };
  learningsHomes?: { userOverall?: string; global?: string };
}

type ScalarKind = "string" | "number" | "boolean";

type ValueSchema =
  | { kind: ScalarKind }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "nullable"; value: ValueSchema }
  | { kind: "array"; element: ValueSchema }
  | { kind: "object"; fields: readonly ConfigFieldSchema[] };

export interface ConfigFieldSchema {
  name: string;
  type: string;
  optional: boolean;
  default: unknown;
  source: string;
  description: string;
  shape: ValueSchema;
}

export interface ConfigShapeIssue {
  path: string;
  message: string;
}

export class ConfigShapeError extends Error {
  constructor(
    public readonly source: string,
    public readonly issues: readonly ConfigShapeIssue[],
  ) {
    super(`invalid config shape in ${source}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    this.name = "ConfigShapeError";
  }
}

const stringShape: ValueSchema = { kind: "string" };
const numberShape: ValueSchema = { kind: "number" };
const booleanShape: ValueSchema = { kind: "boolean" };

const stringArrayShape: ValueSchema = { kind: "array", element: stringShape };

const codexModelsShape: ValueSchema = {
  kind: "object",
  fields: [
    configField("economy", "string[]", true, undefined, "config.json", "Codex model preferences for economy-tier work.", stringArrayShape),
    configField("balanced", "string[]", true, undefined, "config.json", "Codex model preferences for balanced-tier work.", stringArrayShape),
    configField("frontier", "string[]", true, undefined, "config.json", "Codex model preferences for frontier-tier work.", stringArrayShape),
  ],
};

const workerProvidersShape: ValueSchema = {
  kind: "object",
  fields: [
    configField(
      "enabled",
      '"claude" | "codex"[]',
      true,
      ["claude"],
      "config.json",
      "Worker backends the dispatcher may use.",
      stringArrayShape,
    ),
    configField("reservePercent", "number", true, 5, "config.json", "Provider capacity held in reserve.", numberShape),
    configField("capacityCacheMs", "number", true, 60_000, "config.json", "Provider capacity cache lifetime.", numberShape),
    configField("codexBin", "string", true, undefined, "config.json", "Absolute Codex CLI path.", stringShape),
    configField("codexHome", "string", true, undefined, "config.json", "Codex state/auth home.", stringShape),
    configField("codexModel", "string", true, undefined, "config.json", "Hard Codex model override.", stringShape),
    configField("codexModels", "object", true, undefined, "config.json", "Codex model preferences per mount tier.", codexModelsShape),
  ],
};

export const CONFIG_SCHEMA: readonly ConfigFieldSchema[] = [
  configField("claudeBin", "string", false, undefined, "config.json", "Absolute path to the real Claude CLI binary.", stringShape),
  configField("root", "string", false, undefined, "config.json", "Workspace root.", stringShape),
  configField("installRoot", "string", true, "<root>/daemon-install", "config.json", "Daemon git checkout root.", stringShape),
  configField("zdotdir", "string", true, "<root>/../.config/remudero/zdotdir", "config.json", "Worker shell ZDOTDIR.", stringShape),
  configField("workerShell", "string", true, "/bin/bash", "config.json", "Worker Bash-tool shell.", stringShape),
  configField("workerHomeRoot", "string", true, "<root>/worker-home", "config.json", "Scratch HOME root for workers.", stringShape),
  configField("softBudgetThresholdUsd", "number", true, 25, "config.json", "Soft notional budget warning threshold.", numberShape),
  configField("workerModel", "string", true, "sonnet", "config.json", "Worker model selector.", stringShape),
  configField("architectModel", "string", true, "opus", "config.json", "Architect model fallback.", stringShape),
  configField("accessTeamDomain", "string", true, undefined, "config.json", "Cloudflare Access team domain.", stringShape),
  configField("accessAudience", "string", true, undefined, "config.json", "Cloudflare Access audience tag.", stringShape),
  configField("notifyRecipient", "string", true, "craigoley@gmail.com", "config.json", "Escalation notification recipient.", stringShape),
  configField("overflow", '"none" | "api_key"', true, "none", "config.json", "Metered overflow billing mode.", {
    kind: "enum",
    values: ["none", "api_key"],
  }),
  configField("dailyCapUsd", "number | null", true, undefined, "config.json", "Hard daily cap for API-mode billing.", {
    kind: "nullable",
    value: numberShape,
  }),
  configField("fixStrikeCap", "number", true, 2, "config.json", "Blocked-review fix rung strike cap.", numberShape),
  configField("consoleUrl", "string", true, "http://localhost:4317", "config.json", "Operator console base URL.", stringShape),
  configField("serve", "object", true, undefined, "config.json", "Operator console bind and identity settings.", {
    kind: "object",
    fields: [
      configField("host", "string", true, undefined, "config.json", "Console bind host list.", stringShape),
      configField("port", "number", true, undefined, "config.json", "Console bind port.", numberShape),
      configField("identityCapability", "string", true, undefined, "config.json", "Tailnet identity capability.", stringShape),
      configField("trustedProxy", "string", true, undefined, "config.json", "Trusted identity proxy kind.", stringShape),
    ],
  }),
  configField("relay", "object", true, undefined, "config.json", "Outbound relay connection settings.", {
    kind: "object",
    fields: [
      configField("url", "string", true, undefined, "config.json", "Relay server URL.", stringShape),
      configField("token", "string", true, undefined, "config.json", "Relay enrollment token.", stringShape),
    ],
  }),
  configField("headroom", "object", true, { enabled: true }, "config.json", "Headroom governor settings.", {
    kind: "object",
    fields: [configField("enabled", "boolean", true, true, "config.json", "Whether headroom dispatch gating is enabled.", booleanShape)],
  }),
  configField("workerProviders", "object", true, { enabled: ["claude"] }, "config.json", "Worker provider routing settings.", workerProvidersShape),
  configField("learningsHomes", "object", true, undefined, "config.json", "Shared-knowledge home overrides.", {
    kind: "object",
    fields: [
      configField("userOverall", "string", true, undefined, "config.json", "User-overall learnings home.", stringShape),
      configField("global", "string", true, undefined, "config.json", "Global learnings artifact home.", stringShape),
    ],
  }),
];

export interface EnvRegistryEntry {
  name: string;
  purpose: string;
  readBy: readonly string[];
}

export const ENV_REGISTRY: readonly EnvRegistryEntry[] = [
  envEntry("REMUDERO_CLAUDE_BIN", "Overrides the Claude binary path for worker spawn tests and diagnostics.", ["src/lib/worker.ts"]),
  envEntry("REMUDERO_DAEMON_PROCESS", "Marks this process as the daemon actor for ledger attribution.", ["src/lib/ledger.ts"]),
  envEntry("REMUDERO_DAILY_COST_CEILING_SHARE_USD", "Sets this instance's share of the daily cost ceiling.", ["src/lib/policy.ts", "src/run-task.ts"]),
  envEntry("REMUDERO_INSTANCE_LABEL", "Labels the instance associated with a configured daily cost ceiling share.", ["src/lib/policy.ts"]),
  envEntry("REMUDERO_REVIEWER_LOGIN", "Names the reviewer identity trusted for review ownership checks.", ["src/lib/review.ts"]),
  envEntry("REMUDERO_REVIEWER_TOKEN", "Supplies the reviewer token used for review-side GitHub calls.", ["src/lib/review.ts"]),
  envEntry("REMUDERO_RUN_ID", "Carries run attribution into worker process trees.", ["src/lib/worker-containment.ts", "src/lib/ledger.ts"]),
  envEntry("REMUDERO_TASK_ID", "Carries task attribution into worker process trees.", ["src/lib/worker-containment.ts"]),
  envEntry("REMUDERO_WORKER_SCOPE", "Carries worker scope attribution into process trees.", ["src/lib/worker-containment.ts", "src/lib/ledger.ts"]),
  envEntry("RMD_ACCOUNT_FILE_PATH", "Points serve account-usage reads at the operator's account file copy.", ["src/lib/serve.ts"]),
  envEntry("RMD_ALLOW_LIVE_SPAWN", "Opt-in guard for live worker spawn boundaries.", ["src/lib/spawn-guard.ts"]),
  envEntry("RMD_ALLOW_LIVE_WRITES", "Opt-in guard for live write boundaries under tests.", ["src/lib/live-write-guard.ts", "src/run-task.ts"]),
  envEntry("RMD_AUTOMATED_RETRO_DECISION", "Carries an automated retro decision into retro subprocess handling.", ["src/lib/retro-subprocess.ts", "src/run-task.ts"]),
  envEntry("RMD_FRESHNESS_RESTART_MAX", "Deploy entrypoint knob documented by the containment restart discipline.", ["src/lib/containment.ts"]),
  envEntry("RMD_GITHUB_WEBHOOK_SECRET_FILE", "Names the file holding the GitHub webhook secret.", ["src/lib/github-event-wake.ts", "src/lib/serve.ts"]),
  envEntry("RMD_HEADROOM_ENABLED", "Overrides the headroom governor on or off for this process.", ["src/lib/config.ts"]),
  envEntry("RMD_MAIL_COMMAND", "Overrides the mail command used for notification delivery.", ["src/lib/notify.ts"]),
  envEntry("RMD_RESTART_THROTTLE_S", "Documents restart throttling excluded from proof environments.", ["src/lib/review.ts"]),
  envEntry("RMD_SELF_SYNC_DONE", "Guards CLI self-sync re-exec loops.", ["src/lib/self-sync.ts", "src/lib/commit-message.ts", "src/run-task.ts"]),
  envEntry("RMD_SERVE_HOST", "Overrides operator console bind hosts.", ["src/lib/serve.ts", "src/lib/launchd.ts", "src/run-task.ts"]),
  envEntry("RMD_SERVE_NETWORK", "Declares container-network context for serve wildcard binds.", ["src/lib/serve.ts"]),
];

function configField(
  name: string,
  type: string,
  optional: boolean,
  defaultValue: unknown,
  source: string,
  description: string,
  shape: ValueSchema,
): ConfigFieldSchema {
  return { name, type, optional, default: defaultValue, source, description, shape };
}

function envEntry(name: string, purpose: string, readBy: readonly string[]): EnvRegistryEntry {
  return { name, purpose, readBy };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeExpected(schema: ValueSchema): string {
  switch (schema.kind) {
    case "string":
    case "number":
    case "boolean":
      return schema.kind;
    case "enum":
      return `one of ${schema.values.map((v) => JSON.stringify(v)).join(", ")}`;
    case "nullable":
      return `${describeExpected(schema.value)} or null`;
    case "array":
      return `${describeExpected(schema.element)}[]`;
    case "object":
      return "object";
  }
}

function validateValue(value: unknown, schema: ValueSchema, path: string, issues: ConfigShapeIssue[]): void {
  switch (schema.kind) {
    case "string":
      if (typeof value !== "string") issues.push({ path, message: `expected ${describeExpected(schema)}` });
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) issues.push({ path, message: `expected ${describeExpected(schema)}` });
      return;
    case "boolean":
      if (typeof value !== "boolean") issues.push({ path, message: `expected ${describeExpected(schema)}` });
      return;
    case "enum":
      if (typeof value !== "string" || !schema.values.includes(value)) {
        issues.push({ path, message: `expected ${describeExpected(schema)}` });
      }
      return;
    case "nullable":
      if (value !== null) {
        const firstNewIssue = issues.length;
        validateValue(value, schema.value, path, issues);
        for (let i = firstNewIssue; i < issues.length; i++) {
          issues[i] = { path: issues[i]!.path, message: `expected ${describeExpected(schema)}` };
        }
      }
      return;
    case "array":
      if (!Array.isArray(value)) {
        issues.push({ path, message: `expected ${describeExpected(schema)}` });
        return;
      }
      value.forEach((item, i) => validateValue(item, schema.element, `${path}[${i}]`, issues));
      return;
    case "object":
      if (!isPlainRecord(value)) {
        issues.push({ path, message: `expected ${describeExpected(schema)}` });
        return;
      }
      validateObject(value, schema.fields, path, issues);
      return;
  }
}

function validateObject(
  value: unknown,
  fields: readonly ConfigFieldSchema[],
  path: string,
  issues: ConfigShapeIssue[],
): void {
  if (!isPlainRecord(value)) {
    issues.push({ path, message: "expected object" });
    return;
  }

  const allowed = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push({ path: path === "<root>" ? key : `${path}.${key}`, message: "unexpected field" });
  }

  for (const field of fields) {
    const fieldPath = path === "<root>" ? field.name : `${path}.${field.name}`;
    if (!(field.name in value) || value[field.name] === undefined) {
      if (!field.optional) issues.push({ path: fieldPath, message: "required field is missing" });
      continue;
    }
    validateValue(value[field.name], field.shape, fieldPath, issues);
  }
}

export function validateConfigShape(raw: unknown, source: string): Config {
  const issues: ConfigShapeIssue[] = [];
  validateObject(raw, CONFIG_SCHEMA, "<root>", issues);
  if (issues.length > 0) throw new ConfigShapeError(source, issues);
  return raw as Config;
}
