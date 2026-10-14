# Staged worker MCP isolation

This policy is default off: no production caller supplies `mcpIsolation` today. It changes neither
active workers nor operator/chat connectors. Activation is a separate, qualified operation; do not
enable it with a restart, recycle, ambient environment toggle, or broad organization policy.

An opted-in spawn must name `repo-knowledge-only`, explicitly pin Claude, declare a subset of
Read/Write/Edit/Grep/Glob/Bash, and start a fresh session. The existing read-only knowledge rule
tool is retained when `ruleLookup` is supplied. Resume, subagent tools, custom aliases, and other
MCP servers are refused until separately qualified. Existing disallowed tools, sandbox, egress,
settings hooks, and permission denials are preserved; an approved tool receives no permission
override. Repository tools are not themselves a network/filesystem or credential boundary.

At the final SDK seam the policy uses `strictMcpConfig`, disables connector fetching in the
worker's own settings/environment, and adds a PreToolUse denial outside the declared toolkit.
Strict configuration excludes ambient project/user/plugin MCP configurations. Disabling fetched
connectors alone does not cover desktop/cloud host-delivered connectors. These controls must not
be substituted for a fresh native capability qualification.

`mcp_isolation` records configuration separately from bounded SDK init inventory: observed-only,
unknown, or violated. Unknown/violated inventory cannot earn successful worker credit. Complete
approved names do not prove effective authorization, executed calls, absence of later dynamic
updates, or the correctness of the SDK's enforcement. No raw settings, credentials, tool input,
connector URL, or session content is added to this evidence.

Before enabling even a pilot, pin the deployed SDK/CLI and source identity. Use one separately
authorized fresh disposable session to positively retain repository and knowledge operations,
deny a test external connector under bypassPermissions, verify subagent/reuse refusal and dynamic
tool updates, and confirm permission-denial receipts. Compare advertised and executed capabilities
with complete/missing inventory controls. Do not reuse closed runtime/eval grants. Adopt only at
the approved next natural safe startup after qualification and merge, leaving active work,
reviews, and serving untouched. No new infrastructure is required.

Primary references: [Claude MCP isolation and connector delivery](https://code.claude.com/docs/en/mcp)
and the repository-locked Claude Agent SDK `Options.strictMcpConfig`, `Options.hooks`, and
`Settings.disableClaudeAiConnectors` declarations. The declarations are configuration contracts,
not a live test result.
