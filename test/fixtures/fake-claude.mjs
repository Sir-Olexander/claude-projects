#!/usr/bin/env node
// A stand-in for the `claude` CLI in stream-json mode, for tests.
// Behaviour depends on the prompt text:
//   "tool"      -> asks permission for a Bash call, then reports the result
//   "question"  -> asks an AskUserQuestion
//   "plan"      -> calls ExitPlanMode
//   "slow"      -> streams slowly so an interrupt can land mid-turn
//   "crash"     -> exits with an error in the middle of a turn
//   anything else -> streams a short text answer
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionId = argValue('--resume') && !args.includes('--fork-session') ? argValue('--resume') : argValue('--session-id') ?? randomUUID();
let permissionMode = argValue('--permission-mode') ?? 'default';
let model = argValue('--model') ?? 'claude-sonnet-5-5';
const MODEL_IDS = { default: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' };
if (MODEL_IDS[model]) model = MODEL_IDS[model];
let effort = argValue('--effort') ?? null;
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, env: { entry: process.env.CLAUDE_CODE_ENTRYPOINT, electron: process.env.ELECTRON_RUN_AS_NODE ?? null, sharedToken: process.env.SHARED_TOKEN ?? null } }) + '\n');

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pendingControl = new Map();
let turn = null; // { interrupted: boolean }

function requestHost(request) {
  const request_id = randomUUID();
  out({ type: 'control_request', request_id, request });
  return new Promise((resolve) => pendingControl.set(request_id, resolve));
}

function state(s) {
  out({ type: 'system', subtype: 'session_state_changed', state: s, session_id: sessionId, uuid: randomUUID() });
}

const started = new Set();
async function streamText(msgId, index, text, parent = null, delay = 5) {
  if (!started.has(msgId)) {
    started.add(msgId);
    out({ type: 'stream_event', event: { type: 'message_start', message: { id: msgId, role: 'assistant', content: [], model } }, parent_tool_use_id: parent, session_id: sessionId });
  }
  out({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, parent_tool_use_id: parent, session_id: sessionId });
  for (const word of text.split(/(?<= )/)) {
    if (turn?.interrupted) return false;
    out({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: word } }, parent_tool_use_id: parent, session_id: sessionId });
    await sleep(delay);
  }
  out({ type: 'assistant', message: { id: msgId, role: 'assistant', model, content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 20 } }, parent_tool_use_id: parent, session_id: sessionId, uuid: randomUUID() });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index }, parent_tool_use_id: parent, session_id: sessionId });
  return true;
}

function result(isError = false, subtype = 'success') {
  out({ type: 'result', subtype, is_error: isError, duration_ms: 1234, result: isError ? '' : 'ok', errors: [], session_id: sessionId, usage: {}, modelUsage: { [model]: { contextWindow: 200000 } }, uuid: randomUUID() });
  state('idle');
}

async function runTurn(text, uuid) {
  turn = { interrupted: false };
  out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model, permissionMode, slash_commands: ['compact', 'review'], tools: ['Bash', 'Read'], uuid: randomUUID() });
  state('running');
  const msgId = 'msg_' + randomUUID().slice(0, 8);
  started.add(msgId);
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: msgId, role: 'assistant', content: [], model } }, parent_tool_use_id: null, session_id: sessionId, user_message_uuids: uuid ? [uuid] : undefined });

  if (text.includes('crash')) {
    process.stderr.write('Error: simulated crash\n');
    process.exit(3);
  }

  if (text.includes('background-agent')) {
    // An Agent tool call that goes to the background, finishing after FAKE_AGENT_MS.
    const toolId = 'toolu_' + randomUUID().slice(0, 8);
    const input = { subagent_type: 'Explore', description: 'Scan the repo', prompt: 'look around', run_in_background: true };
    out({ type: 'assistant', message: { id: msgId, role: 'assistant', model, content: [{ type: 'tool_use', id: toolId, name: 'Agent', input }] }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
    const taskId = 'task_' + randomUUID().slice(0, 6);
    out({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolId, description: 'Scan the repo', subagent_type: 'Explore', is_backgrounded: true, task_type: 'local_agent', session_id: sessionId, uuid: randomUUID() });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'Agent launched in the background.' }] }, parent_tool_use_id: null, session_id: sessionId });
    await streamText('msg_' + randomUUID().slice(0, 8), 0, 'Started an agent in the background.');
    result();
    setTimeout(() => out({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolId, status: 'completed', summary: 'Scanned', session_id: sessionId, uuid: randomUUID() }), Number(process.env.FAKE_AGENT_MS ?? 800));
    return;
  }

  if (text.includes('hit-limit')) {
    // What Claude Code sends when a usage limit stops a turn.
    const resetsAt = Math.floor(Date.now() / 1000) + Number(process.env.FAKE_LIMIT_RESET_SECONDS ?? 3600);
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' }, session_id: sessionId, uuid: randomUUID() });
    const message = "You've hit your session limit · resets 7:30am (Europe/Lisbon)";
    out({ type: 'assistant', message: { id: msgId, role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: message }] }, parent_tool_use_id: null, error: 'rate_limit', session_id: sessionId, uuid: randomUUID() });
    out({ type: 'result', subtype: 'success', is_error: true, duration_ms: 50, result: message, errors: [], session_id: sessionId, usage: {}, modelUsage: {}, uuid: randomUUID() });
    state('idle');
    return;
  }

  if (text.includes('tool')) {
    const toolId = 'toolu_' + randomUUID().slice(0, 8);
    const input = { command: 'echo hi', description: 'Say hi' };
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'assistant', message: { id: msgId, role: 'assistant', model, content: [{ type: 'tool_use', id: toolId, name: 'Bash', input }] }, parent_tool_use_id: null, session_id: sessionId });
    state('requires_action');
    const decision = await requestHost({ subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input, description: 'Say hi', tool_use_id: toolId, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo hi:*' }], behavior: 'allow', destination: 'localSettings' }] });
    state('running');
    if (decision.behavior === 'allow') {
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'hi', is_error: false }] }, parent_tool_use_id: null, session_id: sessionId, tool_use_result: { stdout: 'hi', stderr: '', interrupted: false } });
      await streamText('msg_' + randomUUID().slice(0, 8), 0, 'The command printed hi.');
      result();
    } else {
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: decision.message, is_error: true }] }, parent_tool_use_id: null, session_id: sessionId, tool_use_result: 'User rejected tool use' });
      if (decision.interrupt) {
        out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, parent_tool_use_id: null, session_id: sessionId });
        result(true, 'error_during_execution');
      } else {
        await streamText('msg_' + randomUUID().slice(0, 8), 0, 'OK, I will not run it.');
        result();
      }
    }
    return;
  }

  if (text.includes('elicit')) {
    const url = text.includes('elicit-url');
    const answer = await requestHost(
      url
        ? { subtype: 'elicitation', mcp_server_name: 'github', message: 'Sign in to GitHub to continue.', mode: 'url', url: 'https://github.com/login/device', elicitation_id: 'e1' }
        : {
            subtype: 'elicitation',
            mcp_server_name: 'deploy',
            title: 'Deploy service',
            message: 'Where should I deploy?',
            mode: 'form',
            requested_schema: {
              type: 'object',
              properties: {
                env: { type: 'string', title: 'Environment', enum: ['staging', 'production'], enumNames: ['Staging', 'Production'] },
                replicas: { type: 'integer', title: 'Replicas', minimum: 1, maximum: 5 },
                notify: { type: 'boolean', title: 'Notify the team' },
                email: { type: 'string', format: 'email', description: 'Who to notify' },
              },
              required: ['env', 'replicas'],
            },
          },
    );
    await streamText('msg_' + randomUUID().slice(0, 8), 0, `Elicitation result: ${JSON.stringify(answer)}`);
    result();
    return;
  }

  if (text.includes('question')) {
    const toolId = 'toolu_' + randomUUID().slice(0, 8);
    const input = { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] };
    out({ type: 'assistant', message: { id: msgId, role: 'assistant', model, content: [{ type: 'tool_use', id: toolId, name: 'AskUserQuestion', input }] }, parent_tool_use_id: null, session_id: sessionId });
    state('requires_action');
    const decision = await requestHost({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: toolId, requires_user_interaction: true });
    state('running');
    const answer = decision.updatedInput?.answers?.['Which color?'] ?? 'none';
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: `Answered: ${answer}` }] }, parent_tool_use_id: null, session_id: sessionId, tool_use_result: { answers: decision.updatedInput?.answers } });
    await streamText('msg_' + randomUUID().slice(0, 8), 0, `You chose ${answer}.`);
    result();
    return;
  }

  if (text.includes('plan')) {
    const toolId = 'toolu_' + randomUUID().slice(0, 8);
    const input = { plan: '# Plan\n\n1. Do the thing', planFilePath: '/tmp/plan.md' };
    out({ type: 'assistant', message: { id: msgId, role: 'assistant', model, content: [{ type: 'tool_use', id: toolId, name: 'ExitPlanMode', input }] }, parent_tool_use_id: null, session_id: sessionId });
    state('requires_action');
    const decision = await requestHost({ subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input, tool_use_id: toolId, requires_user_interaction: true });
    state('running');
    const mode = decision.updatedPermissions?.find((u) => u.type === 'setMode')?.mode;
    if (mode) permissionMode = mode;
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: decision.behavior === 'allow' ? 'Plan approved' : decision.message, is_error: decision.behavior !== 'allow' }] }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: 'system', subtype: 'status', status: null, permissionMode, session_id: sessionId });
    result();
    return;
  }

  const ok = await streamText(msgId, 0, text.includes('slow') ? 'This is a long and slow answer that takes a while to finish streaming out.' : `Echo: ${text}`, null, text.includes('slow') ? 120 : 5);
  if (!ok) return; // interrupted
  result();
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === 'control_response') {
    const r = pendingControl.get(m.response.request_id);
    if (r) {
      pendingControl.delete(m.response.request_id);
      r(m.response.response);
    }
    return;
  }
  if (m.type === 'control_request') {
    const { request_id, request } = m;
    const ok = (response = {}) => out({ type: 'control_response', response: { subtype: 'success', request_id, response } });
    switch (request.subtype) {
      case 'initialize':
        ok({
          commands: [{ name: 'compact', description: 'Compact the conversation' }, { name: 'review', description: 'Review code' }],
          models: [
            { value: 'default', resolvedModel: 'claude-sonnet-5-5', displayName: 'Default (recommended)', description: 'Sonnet 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
            { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
            { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5' },
          ],
          account: { email: 'test@example.com', subscriptionType: 'Claude Max' },
          current_permission_mode: permissionMode,
          pid: process.pid,
        });
        return;
      case 'get_usage':
        ok({ subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 42, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 7, resets_at: '2030-01-05T00:00:00Z' }, model_scoped: [{ display_name: 'Fable', utilization: 1, resets_at: '2030-01-05T00:00:00Z' }] } });
        return;
      case 'rename_session':
        if (process.env.FAKE_RENAME_LOG) appendFileSync(process.env.FAKE_RENAME_LOG, JSON.stringify({ title: m.request.title, source: m.request.source, session_id: m.request.session_id }) + '\n');
        ok({});
        break;
      case 'remote_control':
        if (process.env.FAKE_REMOTE_FAIL) {
          out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Remote Control is not available for this account' } });
          break;
        }
        ok(m.request.enabled ? { session_url: `https://claude.ai/code/session_${sessionId.slice(0, 8)}`, connect_url: 'https://claude.ai/connect', bridge_session_id: 'b1' } : {});
        break;
      case 'interrupt':
        ok({ still_queued: [] });
        if (turn && !turn.interrupted) {
          turn.interrupted = true;
          for (const [id, r] of pendingControl) {
            out({ type: 'control_cancel_request', request_id: id });
            pendingControl.delete(id);
            r({ behavior: 'deny', message: 'interrupted', interrupt: true });
          }
          setTimeout(() => result(true, 'error_during_execution'), 20);
        }
        return;
      case 'set_permission_mode':
        permissionMode = request.mode;
        ok();
        return;
      case 'set_model':
        model = MODEL_IDS[request.model] ?? request.model ?? 'claude-sonnet-5-5';
        ok();
        return;
      case 'get_settings':
        ok({ effective: {}, sources: [], applied: { model, effort: model.includes('haiku') ? null : (effort ?? 'high') } });
        return;
      case 'apply_flag_settings':
        if ('effortLevel' in (request.settings ?? {})) effort = request.settings.effortLevel;
        ok();
        return;
      default:
        out({ type: 'control_response', response: { subtype: 'error', request_id, error: `unknown ${request.subtype}` } });
        return;
    }
  }
  if (m.type === 'user') {
    const content = m.message.content;
    const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    await runTurn(text, m.uuid);
  }
});
rl.on('close', () => setTimeout(() => process.exit(0), 10));
