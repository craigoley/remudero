export const CONFIG_SCHEMA_VERSION = 1;

/** The shared provider identity; config re-exports it for existing consumers.
 *
 * W1-T3607: THE CATEGORY IS HOW A DEPLOYMENT IS PAID FOR, NOT WHAT LICENCE IT SHIPS UNDER. "openweight"
 * mis-sorted a candidate like gpt-5-nano (proprietary, cash-billed) — a reader trusting the key name had
 * to conclude either that it is open-weight (false) or that it does not belong on this ladder (a decision
 * NOT to save money). "cash" is the CANONICAL id from here on: this is the non-subscription, pay-per-token
 * lane, billed per request against `dailyCapUsd`, outside the Claude/Codex subscriptions — see the
 * `capabilities.cash` block of the mounts file that {@link loadMounts} (src/lib/mounts.ts) reads for
 * the written admission rule. The path itself is deliberately NOT re-spelled here: mounts.ts resolves
 * it, and a second src file naming the house layout inline is exactly what test/repo-layout.ts's
 * W1-T2922 ratchet counts.
 * "openweight" is kept as a DEPRECATED ALIAS ONLY: an already-deployed host's `~/.config/remudero/config.json`
 * (never committed to git) may still carry the old spelling, and a rename that refuses it takes the fleet
 * down at the next boot. {@link canonicalWorkerProviderId} is the ONE read-boundary function that maps it
 * to "cash" — REMOVE "openweight" from this list once no live host config carries it any longer. */
export const WORKER_PROVIDER_IDS = ["claude", "codex", "cash", "openweight"] as const;
export type WorkerProviderId = (typeof WORKER_PROVIDER_IDS)[number];

/** Deprecated provider-id spellings mapped to their canonical replacement (W1-T3607). Read ONLY by
 *  {@link canonicalWorkerProviderId} — never compared against directly, so the alias set has exactly one
 *  place to grow or shrink. */
export const WORKER_PROVIDER_ID_ALIASES: Readonly<Record<string, WorkerProviderId>> = {
  openweight: "cash",
};

/**
 * The ONE function that maps a raw provider-id spelling (however it was written in a config file, a
 * mounts.yaml `provider:` row, or a caller's `mountProvider` argument) to the canonical id everything
 * downstream must compare against. Never sprinkle `|| "openweight"` at a call site — normalise here,
 * once, at the read boundary (W1-T3607 design). An id absent from {@link WORKER_PROVIDER_ID_ALIASES}
 * passes through unchanged (it is already canonical, or it is invalid and some other check will refuse it).
 */
export function canonicalWorkerProviderId(id: string): string {
  return WORKER_PROVIDER_ID_ALIASES[id] ?? id;
}

/** One operator approval for a human-gated model id. Lives only in the host's config.json. */
export interface ModelApproval {
  model: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt?: string;
}

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
  /** Operator approvals for human-gated model families (Astra, Fable). See src/lib/model-gate.ts. */
  modelApprovals?: ModelApproval[];
  accessTeamDomain?: string;
  accessAudience?: string;
  notifyRecipient?: string;
  overflow?: "none" | "api_key";
  /** the cash (Azure) spend ceiling for one UTC day. A PLAIN NUMBER is the whole cap, as
   *  before. A PAIR raises it only on a day the subscriptions are tapped out:
   *
   *      dailyCapUsd: { normal: 10, squeezed: 25 }
   *
   *  `normal` governs routine mount-affinity cash work; `squeezed` governs a request that only
   *  reached cash because the capacity auction found NO subscription with readable headroom (the
   *  W1-T3692 fallback). It is a CEILING on the day's committed total either way -- never a budget
   *  the fleet is encouraged to spend. */
  dailyCapUsd?: number | { normal: number; squeezed: number } | null;
  fixStrikeCap?: number;
  consoleUrl?: string;
  /** `rmd board`'s default repository set (W1-T3685) — `owner/repo` strings, read when no
   *  `--repo` flag is given. A fourth repository needs an edit HERE, never a `pr-board.ts` code
   *  change: this is the one field that makes "configuration, never a hardcoded list" true for
   *  the survey's default. Absent ⇒ the CLI's own three-repository fallback (run-task.ts). */
  fleetRepos?: string[];
  serve?: {
    host?: string;
    port?: number;
    identityCapability?: string;
    trustedProxy?: string;
    /** W1-T4244: the console operator's Clerk session identity. Absent: the provider is off. */
    operatorIdentity?: {
      issuer: string;
      jwksUrl?: string;
      allowedOrigins: string[];
      operatorUserIds: string[];
      stepUpWindowMinutes?: number;
    };
  };
  relay?: { url?: string; token?: string };
  headroom?: { enabled?: boolean };
  workerProviders?: {
    enabled?: WorkerProviderId[];
    /** Operator consent for OUTBOUND WEB ACCESS on behalf of cash workers (W1-T3558). Default false,
     * and deliberately separate from enabling the cash provider: enabling a provider authorises
     * spending on inference, this authorises fetching arbitrary public pages on a worker's
     * instruction. The search credential is environment-only, never a config field. */
    cashWebSearch?: boolean;
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
    /** Azure OpenAI-compatible endpoint for the bounded cash (non-subscription) adapter. The API key is
     * intentionally environment-only and is never a config field.
     * W1-T3607: canonical field — read before the deprecated {@link openweightEndpoint} alias. */
    cashEndpoint?: string;
    /** DEPRECATED (W1-T3607): the pre-rename spelling of {@link cashEndpoint}, read as a fallback so an
     *  already-deployed host's config.json need not be hand-edited the moment this ships. Remove once no
     *  live host config carries it. */
    openweightEndpoint?: string;
    /** W1-T3692: when the capacity auction finds NO subscription with usable headroom, dispatch
     *  normally blocks. With this true, an eligible lane falls back to the cash provider instead of
     *  stalling. DEFAULT FALSE and deliberately so: it spends real money, so it must be an
     *  operator decision and must never arrive by upgrade. Bounded by `dailyCapUsd`, which the
     *  cash adapter already refuses to run without. */
    cashFallbackWhenBlocked?: boolean;
    /** Hand the implement lane's git effects to the HARNESS on EVERY provider, not only where the
     * worker has no shell (W1-T3696). Default false. Turning it on is what makes a Claude implement
     * run DIVERTIBLE: its prompt then already says the harness commits, so a blocked auction may
     * retry it on the shell-less cash surface without the prompt and the tools disagreeing. It is
     * also the security direction W1-T3572 asked for — forge authority leaves every worker, not
     * only the cheap ones. */
    harnessCommitsImplement?: boolean;
    /** W1-T3727: the same opt-in for the CI-log fix rung. Its caller already pushes through
     *  `deps.push`; only the commit was the worker's, so handing that to the harness makes the
     *  rung divertible to cash — which is what a squeeze needs most, since a red pull request is
     *  exactly what cannot be repaired while every subscription is exhausted. */
    harnessCommitsFix?: boolean;
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
      '"claude" | "codex" | "cash" | "openweight"[]',
      true,
      ["claude"],
      "config.json",
      'Worker backends the dispatcher may use. "openweight" is a deprecated alias for "cash" (W1-T3607).',
      stringArrayShape,
    ),
    configField("reservePercent", "number", true, 5, "config.json", "Provider capacity held in reserve.", numberShape),
    configField("cashWebSearch", "boolean", true, false, "config.json", "Consent for daemon-brokered web search on behalf of cash workers.", booleanShape),
    configField("capacityCacheMs", "number", true, 60_000, "config.json", "Provider capacity cache lifetime.", numberShape),
    configField("codexBin", "string", true, undefined, "config.json", "Absolute Codex CLI path.", stringShape),
    configField("codexHome", "string", true, undefined, "config.json", "Codex state/auth home.", stringShape),
    configField("codexModel", "string", true, undefined, "config.json", "Hard Codex model override.", stringShape),
    configField("codexModels", "object", true, undefined, "config.json", "Codex model preferences per mount tier.", codexModelsShape),
    configField("cashEndpoint", "string", true, undefined, "config.json", "Azure OpenAI-compatible endpoint for the cash (non-subscription) worker adapter.", stringShape),
    configField(
      "harnessCommitsImplement",
      "boolean",
      true,
      false,
      "config.json",
      "Harness owns implement's git effects on every provider, which is what makes the lane divertible to cash (W1-T3696).",
      booleanShape,
    ),
    configField(
      "harnessCommitsFix",
      "boolean",
      true,
      false,
      "config.json",
      "Harness owns the CI-log fix rung's commit, which is what makes that lane divertible to cash (W1-T3727).",
      booleanShape,
    ),
    configField(
      "cashFallbackWhenBlocked",
      "boolean",
      true,
      false,
      "config.json",
      "Fall back to the cash provider when no subscription has readable headroom, instead of blocking dispatch (W1-T3692).",
      booleanShape,
    ),
    configField(
      "openweightEndpoint",
      "string",
      true,
      undefined,
      "config.json",
      "DEPRECATED (W1-T3607): alias for cashEndpoint, read as a fallback for an already-deployed host config.",
      stringShape,
    ),
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
  configField("modelApprovals", "ModelApproval[]", true, undefined, "config.json", "Operator approvals for human-gated models (Astra, Fable).", {
    kind: "array",
    element: {
      kind: "object",
      fields: [
        configField("model", "string", false, undefined, "config.json", "Exact approved model id.", stringShape),
        configField("approvedBy", "string", false, undefined, "config.json", "Who approved it.", stringShape),
        configField("approvedAt", "string", false, undefined, "config.json", "When it was approved (ISO time).", stringShape),
        configField("expiresAt", "string", true, undefined, "config.json", "When the approval lapses (ISO time).", stringShape),
      ],
    },
  }),
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
  configField(
    "fleetRepos",
    "string[]",
    true,
    ["craigoley/remudero", "craigoley/remudero-site", "craigoley/remudero-console"],
    "config.json",
    "rmd board's default repository set, as owner/repo strings.",
    stringArrayShape,
  ),
  configField("serve", "object", true, undefined, "config.json", "Operator console bind and identity settings.", {
    kind: "object",
    fields: [
      configField("host", "string", true, undefined, "config.json", "Console bind host list.", stringShape),
      configField("port", "number", true, undefined, "config.json", "Console bind port.", numberShape),
      configField("identityCapability", "string", true, undefined, "config.json", "Tailnet identity capability.", stringShape),
      configField("trustedProxy", "string", true, undefined, "config.json", "Trusted identity proxy kind.", stringShape),
      configField("operatorIdentity", "object", true, undefined, "config.json", "Console operator Clerk session identity (W1-T4244).", {
        kind: "object",
        fields: [
          configField("issuer", "string", false, undefined, "config.json", "Clerk issuer, matched exactly against iss.", stringShape),
          configField("jwksUrl", "string", true, "<issuer>/.well-known/jwks.json", "config.json", "Clerk public key set URL.", stringShape),
          configField("allowedOrigins", "string[]", false, undefined, "config.json", "Console origins accepted in azp.", stringArrayShape),
          configField("operatorUserIds", "string[]", false, undefined, "config.json", "Clerk user ids allowed to act.", stringArrayShape),
          configField("stepUpWindowMinutes", "number", true, 10, "config.json", "Minutes a verified factor keeps high tier.", numberShape),
        ],
      }),
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
  envEntry("RMD_CASH_WEB_SEARCH_API_KEY", "Supplies the daemon's own credential for brokered cash-worker web search; never copied into a worker environment.", ["src/lib/cash-web-bridge.ts"]),
  envEntry("RMD_FRESHNESS_RESTART_MAX", "Deploy entrypoint knob documented by the containment restart discipline.", ["src/lib/containment.ts"]),
  envEntry("RMD_GH_READ_BURST", "Overrides the GitHub read burst this process grants inside the shared cadence floor.", ["src/lib/github-transport.ts"]),
  envEntry("RMD_GH_SHARED_READ_GAP_MS", "Overrides the short cross-process gap between shared GitHub reads; not a second cadence budget window.", ["src/lib/github-transport.ts"]),
  envEntry("RMD_GITHUB_WEBHOOK_SECRET_FILE", "Names the file holding the GitHub webhook secret.", ["src/lib/github-event-wake.ts", "src/lib/serve.ts"]),
  envEntry("RMD_HEADROOM_ENABLED", "Overrides the headroom governor on or off for this process.", ["src/lib/config.ts"]),
  envEntry("RMD_MAIL_COMMAND", "Overrides the mail command used for notification delivery.", ["src/lib/notify.ts"]),
  envEntry("RMD_OPENWEIGHT_API_KEY", "Supplies the Azure API key to the daemon-local open-weight adapter; it is never copied into a worker environment.", ["src/lib/worker-provider.ts"]),
  envEntry("RMD_OPERATOR_IDENTITY_PATH", "Names the read-only mounted file holding serve's operator identity when config.json has none.", ["src/lib/operator-identity-file.ts"]),
  envEntry("RMD_RESTART_THROTTLE_S", "Documents restart throttling excluded from proof environments.", ["src/lib/review.ts"]),
  envEntry("RMD_SELF_SYNC_DONE", "Guards CLI self-sync re-exec loops.", ["src/lib/self-sync.ts", "src/lib/commit-message.ts", "src/run-task.ts"]),
  envEntry("RMD_SERVE_HOST", "Overrides operator console bind hosts.", ["src/lib/serve.ts", "src/lib/launchd.ts", "src/run-task.ts"]),
  envEntry("RMD_SERVE_INGEST_TOKEN", "Supplies serve's optional bearer token that is accepted only on the incident ingest route.", ["src/lib/serve.ts"]),
  envEntry("RMD_SERVE_INGEST_TOKEN_FILE", "Names the read-only mounted file holding serve's incident ingest token when RMD_SERVE_INGEST_TOKEN is unset.", ["src/lib/serve.ts"]),
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
