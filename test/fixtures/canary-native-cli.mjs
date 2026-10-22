// Credential-free protocol peer for the real installed SDK, never a model or field-trial sample.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const mode = process.env.RMD_CANARY_FIXTURE_MODE;
const resource = mode.startsWith('usage-') ? JSON.parse(readFileSync(process.env.RMD_CANARY_RESOURCE_CONTRACTS, 'utf8')).scenarios.find(s => s.mode === mode) : undefined;
if (mode.startsWith('usage-') && !resource) throw new Error('synthetic-resource-fixture-unknown');
const log = row => appendFileSync(process.env.RMD_CANARY_FIXTURE_LOG, JSON.stringify(row) + '\n', { mode: 0o600 });
const out = row => process.stdout.write(JSON.stringify(row) + '\n');
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  log({ phase: 'version', node: process.version });
  console.log(mode === 'old-version' ? '2.1.302 (Claude Code)' : mode === 'future-version' ? '2.1.304 (Claude Code)' : mode === 'wrong-version' ? '2.1.1 (Claude Code)' : '2.1.303 (Claude Code)');
  process.exit(0);
}
if (argv[0] === 'auth') {
  log({ phase: 'auth', node: process.version });
  if (mode === 'auth-error') process.exit(2);
  if (mode === 'auth-json') { console.log('unreadable'); process.exit(0); }
  out({ loggedIn: mode !== 'logged-out', authMethod: mode === 'api-auth' ? 'api_key' : 'claude.ai',
    apiProvider: 'firstParty', subscriptionType: 'max', email: 'PRIVATE-DO-NOT-RETAIN' });
  process.exit(0);
}
const flag = name => argv[argv.indexOf(name) + 1];
const resumed = argv.find(arg => arg.startsWith('--resume='))?.slice('--resume='.length);
const sessionId = resumed ?? argv.find(arg => arg.startsWith('--session-id='))?.slice('--session-id='.length);
const stateFile = process.env.RMD_CANARY_FIXTURE_STATE;
const prior = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { sessionId, prompts: [] };
log({ phase: 'spawn', pid: process.pid, node: process.version, sessionId, resumed, tools: flag('--tools'),
  sources: argv.find(arg => arg.startsWith('--setting-sources=')), strict: argv.includes('--strict-mcp-config'),
  permissionMode: flag('--permission-mode'), partial: argv.includes('--include-partial-messages') });
const input = createInterface({ input: process.stdin });
const frame = event => out({ type: 'stream_event', session_id: sessionId, uuid: 'synthetic-event', parent_tool_use_id: resource?.parentToolUseId ?? null, event });
const pending = new Map();
let sequence = 0, hookId;
const control = request => new Promise((resolve, reject) => {
  const request_id = `synthetic-control-${++sequence}`;
  pending.set(request_id, { resolve, reject });
  out({ type: 'control_request', request_id, request });
});
async function syntheticTools() {
  const hook = (tool_name, tool_input, hook_event_name = 'PreToolUse') => control({ subtype: 'hook_callback', callback_id: hookId,
    input: { hook_event_name, session_id: sessionId, transcript_path: stateFile, cwd: process.cwd(), tool_name, tool_input },
    tool_use_id: `synthetic-tool-${sequence}` });
  const rpc = async (method, params) => {
    const reply = await control({ subtype: 'mcp_message', server_name: 'canary',
      message: { jsonrpc: '2.0', id: ++sequence, method, params } });
    return reply.mcp_response;
  };
  const listed = await rpc('tools/list', {});
  log({ phase: 'native-list', tools: listed.result.tools });
  if (mode === 'tool-permission') {
    const reply = await control({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'never-run' }, tool_use_id: 'synthetic-permission' });
    log({ phase: 'native-permission', behavior: reply.behavior });
    return;
  }
  const name = listed.result.tools[0].name;
  const cases = mode === 'tool-denied' ? [{ tool: 'Bash', args: {} }, { tool: `mcp__canary__${name}`, args: { item: 'A', extra: true } }]
    : mode === 'tool-unexpected-hook' ? [{ tool: `mcp__canary__${name}`, args: { item: 'A' }, event: 'PostToolUse' }]
    : mode === 'tool-grade' ? [{ tool: `mcp__canary__${name}`, args: { item: 'A' } }]
    : name === 'inventory' ? [{ tool: `mcp__canary__${name}`, args: { item: 'A' } }, { tool: `mcp__canary__${name}`, args: { item: 'B' } }]
    : [{ tool: `mcp__canary__${name}`, args: {} }, { tool: `mcp__canary__${name}`, args: {} }];
  if (mode === 'tool-schema') {
    const reply = await rpc('tools/call', { name, arguments: { item: 'A', extra: true } });
    log({ phase: 'native-tool-result', result: reply.result }); return;
  }
  for (const call of cases) {
    const allowed = await hook(call.tool, call.args, call.event);
    const decision = allowed.hookSpecificOutput?.permissionDecision;
    log({ phase: 'native-hook', decision: decision ?? 'continue', tool: call.tool });
    if (decision === 'deny') continue;
    const reply = await rpc('tools/call', { name, arguments: call.args });
    log({ phase: 'native-tool-result', result: reply.result });
  }
}
input.on('line', async line => {
  const message = JSON.parse(line);
  if (message.type === 'control_response') {
    const reply = message.response, owner = pending.get(reply.request_id);
    if (!owner) throw new Error('synthetic-control-response-unowned');
    pending.delete(reply.request_id);
    if (reply.subtype === 'success') owner.resolve(reply.response);
    else owner.reject(new Error('synthetic-control-response-error'));
    return;
  }
  if (message.type === 'control_request') {
    log({ phase: 'control', subtype: message.request.subtype, systemPrompt: message.request.systemPrompt });
    if (mode === 'hang-init') return;
    if (message.request.subtype === 'initialize') {
      hookId = message.request.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0];
      if (mode.startsWith('tool-')) log({ phase: 'native-contract', hookRegistered: typeof hookId === 'string', servers: message.request.sdkMcpServers,
        skills: message.request.skills, manifests: Object.keys(message.request.sdkMcpServerManifests ?? {}) });
    }
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
      response: { account: { apiProvider: mode === 'foundry' ? 'foundry' : 'firstParty',
        apiKeySource: mode === 'account-api' ? 'ANTHROPIC_API_KEY' : mode === 'account-unknown' ? undefined : 'none',
        subscriptionType: mode === 'subscription-drift' ? 'pro' : 'max', email: 'PRIVATE-DO-NOT-RETAIN' } } } });
    return;
  }
  if (message.type !== 'user') return;
  log({ phase: 'prompt', content: message.message.content, sessionId: message.session_id, resumed, priorTurns: prior.prompts.length });
  if (mode === 'hang-stream') return;
  if (resumed && (prior.sessionId !== resumed || prior.prompts.length === 0)) process.exit(3);
  prior.prompts.push(message.message.content);
  writeFileSync(stateFile, JSON.stringify(prior), { mode: 0o600 });
  if (mode.startsWith('tool-')) await syntheticTools();
  if (mode === 'tool-hang') return;
  const actualSession = mode === 'foreign-session' ? '11111111-1111-4111-8111-111111111111' : sessionId;
  out({ type: 'system', subtype: 'init', session_id: actualSession, uuid: 'synthetic-init',
    apiKeySource: mode === 'init-api' ? 'apiKeyHelper' : 'none', claude_code_version: '2.1.303', permissionMode: 'dontAsk' });
  const text = process.env.RMD_CANARY_FIXTURE_CODING_OUTPUT ?? (mode === 'tool-grade' ? '{"quantity":4}' : mode === 'oversize' ? 'x'.repeat(200) : `native-turn-${prior.prompts.length}`);
  if (resource?.reset) out({ type: 'system', subtype: 'compact_boundary', session_id: sessionId, uuid: 'synthetic-reset' });
  const startUsage = resource ? resource.startUsage ?? undefined : { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
  frame({ type: 'message_start', message: { id: `fixture-${prior.prompts.length}`, model: 'synthetic-model',
    usage: startUsage } });
  frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
  frame({ type: 'content_block_stop', index: 0 });
  frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
  if (!resource?.omitMessageStop) frame({ type: 'message_stop' });
  if (resource?.secondaryModel) {
    frame({ type: 'message_start', message: { id: `fixture-secondary-${prior.prompts.length}`, model: resource.secondaryModel, usage: startUsage } });
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } });
    frame({ type: 'message_stop' });
  }
  if (mode === 'missing-result') { input.close(); process.stdin.destroy(); return; }
  out({ type: 'result', subtype: mode === 'result-error' ? 'error_max_turns' : 'success', is_error: mode === 'result-error',
    session_id: sessionId, uuid: 'synthetic-result', result: text, permission_denials: mode === 'permission' ? [{}] : [],
    num_turns: 1, usage: resource ? resource.finalUsage ?? undefined : { input_tokens: 2, output_tokens: 3 }, modelUsage: { cumulative: { inputTokens: 999999 } },
    total_cost_usd: 999, duration_ms: 3, duration_api_ms: 2 });
});
input.on('close', () => process.exit(0));
