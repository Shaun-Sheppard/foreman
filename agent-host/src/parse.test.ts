import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMessage, StepTracker, summariseTool } from './parse.js';

test('init carries the SDK session id', () => {
  const p = parseMessage({ type: 'system', subtype: 'init', session_id: 'abc' }, new StepTracker());
  assert.equal(p.sessionId, 'abc');
});

test('TodoWrite replaces the step list', () => {
  const t = new StepTracker();
  const msg = (todos: unknown[]) => ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos } }] },
  });
  parseMessage(msg([{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }]), t);
  const p = parseMessage(msg([{ content: 'A', status: 'completed' }]), t);
  assert.deepEqual(p.steps, [{ text: 'A', state: 'completed' }]);
});

test('TaskCreate and TaskUpdate build the list incrementally', () => {
  const t = new StepTracker();
  t.apply('TaskCreate', { subject: 'Read code', description: '' });
  t.apply('TaskCreate', { subject: 'Write tests', description: '' });
  assert.deepEqual(t.apply('TaskUpdate', { taskId: '1', status: 'completed' }), [
    { text: 'Read code', state: 'completed' },
    { text: 'Write tests', state: 'pending' },
  ]);
  assert.deepEqual(t.apply('TaskUpdate', { taskId: '2', status: 'deleted' }), [{ text: 'Read code', state: 'completed' }]);
  assert.equal(t.apply('TaskUpdate', { taskId: '9', status: 'completed' }), null);
  assert.equal(t.apply('Bash', { command: 'ls' }), null);
});

test('assistant text and tool calls become log entries', () => {
  const p = parseMessage(
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: ' Looking. ' }, { type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'dotnet  build' } }] },
    },
    new StepTracker(),
  );
  assert.deepEqual(p.log, [
    { kind: 'text', text: 'Looking.' },
    { kind: 'tool', tool: 'Bash', id: 'x', text: 'dotnet build' },
  ]);
});

test('tool results are truncated and errors flagged', () => {
  const p = parseMessage(
    {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(5000) },
          { type: 'tool_result', tool_use_id: 'z', is_error: true, content: [{ type: 'text', text: 'boom' }] },
        ],
      },
    },
    new StepTracker(),
  );
  assert.equal(p.log[0]?.text.length, 2001);
  assert.deepEqual(p.log[1], { kind: 'error', id: 'z', text: 'boom' });
});

test('subagent messages are skipped', () => {
  const p = parseMessage({ type: 'assistant', parent_tool_use_id: 'task1', message: { content: [{ type: 'text', text: 'hi' }] } }, new StepTracker());
  assert.equal(p.log.length, 0);
});

test('result reports outcome and cost', () => {
  const ok = parseMessage({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.42, duration_ms: 1200 }, new StepTracker());
  assert.deepEqual(ok.result, { outcome: 'success', costUsd: 0.42, durationMs: 1200, error: null });
  const bad = parseMessage({ type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 1 }, new StepTracker());
  assert.equal(bad.result?.outcome, 'error');
  assert.equal(bad.result?.error, 'error_max_turns');
});

test('summariseTool picks the most telling input', () => {
  assert.equal(summariseTool('Read', { file_path: '/a/b.cs' }), '/a/b.cs');
  assert.equal(summariseTool('Custom', {}), '');
  assert.equal(summariseTool('Custom', { n: 1 }), '{"n":1}');
});
