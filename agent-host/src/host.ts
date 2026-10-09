/**
 * Foreman agent host: one process per session. Drives Claude Code through the
 * Claude Agent SDK and talks to the Rust core over stdin/stdout as JSON Lines.
 */
import { createInterface } from 'node:readline';
import { createSdkMcpServer, query, tool, type CanUseTool, type PermissionResult, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { parseMessage, StepTracker, summariseTool } from './parse.js';
import { PROTOCOL_VERSION, STEPS_TOOL, type FromCore, type Question, type ToCore } from './protocol.js';
import { runStub } from './stub.js';

type StartMsg = Extract<FromCore, { type: 'start' }>;
type Answer = Extract<FromCore, { type: 'approve' | 'deny' | 'reply' }>;

export function send(msg: ToCore): void {
  process.stdout.write(JSON.stringify({ v: PROTOCOL_VERSION, ...msg }) + '\n');
}

const waiting = new Map<string, (answer: Answer) => void>();
let nextRequest = 1;
const abort = new AbortController();
let stopped = false;
let started = false;

/** Parks the session in Needs input until the core relays the user's decision (FR3.3, FR3.4). */
export function askCore(req: Omit<Extract<ToCore, { type: 'needs_input' }>, 'type' | 'requestId'>): Promise<Answer> {
  const requestId = String(nextRequest++);
  send({ type: 'needs_input', requestId, ...req });
  return new Promise((resolve) => waiting.set(requestId, resolve));
}

/**
 * Foreman's own step-list tool. Current Claude Code builds don't expose TodoWrite to SDK
 * sessions, so the step list the UI shows comes from this tool instead (FR3.1).
 */
const foremanTools = createSdkMcpServer({
  name: 'foreman',
  version: '1.0.0',
  tools: [
    tool(
      'set_steps',
      'Publish your step list to the person watching this session. Call it with the FULL list every time a step starts or finishes: exactly one step in_progress while you work, completed ones kept in the list.',
      {
        steps: z
          .array(z.object({ text: z.string().describe('Short imperative step, e.g. "Run the test suite"'), status: z.enum(['pending', 'in_progress', 'completed']) }))
          .describe('Every step in order, each with its current status'),
      },
      async ({ steps }) => {
        send({ type: 'steps', items: steps.map((s) => ({ text: s.text, state: s.status })) });
        return { content: [{ type: 'text' as const, text: 'Step list updated.' }] };
      },
    ),
  ],
});

function makeCanUseTool(start: StartMsg): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    if (toolName === 'AskUserQuestion') {
      const questions = (Array.isArray(input['questions']) ? input['questions'] : []) as Question[];
      const answer = await askCore({
        kind: 'question',
        title: 'Claude has a question',
        text: questions.map((q) => q.question).join('\n'),
        detail: '',
        questions,
      });
      if (answer.type === 'reply') return { behavior: 'allow', updatedInput: { ...input, answers: answer.answers } };
      return { behavior: 'deny', message: 'The user declined to answer.' };
    }
    if (toolName === STEPS_TOOL || start.allowAllTools || start.allowedTools.includes(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }
    const answer = await askCore({
      kind: 'permission',
      title: `Claude wants to use ${toolName}`,
      text: '',
      detail: summariseTool(toolName, input),
      questions: [],
    });
    if (answer.type === 'approve') return { behavior: 'allow', updatedInput: input };
    const note = answer.type === 'deny' ? answer.message : '';
    return { behavior: 'deny', message: note || 'The user denied this action.' };
  };
}

async function run(start: StartMsg): Promise<void> {
  let finished: () => void = () => undefined;
  const done = new Promise<void>((resolve) => (finished = resolve));

  // canUseTool needs streaming input, and the stream must stay open until the result arrives.
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: 'user', message: { role: 'user', content: start.prompt }, parent_tool_use_id: null };
    await done;
  }

  const tracker = new StepTracker();
  let ended = false;
  try {
    const stream = query({
      prompt: input(),
      options: {
        cwd: start.cwd,
        abortController: abort,
        canUseTool: makeCanUseTool(start),
        permissionMode: 'default',
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        mcpServers: { foreman: foremanTools },
        // The packaged host has no bundled Claude Code, so the core points it at the installed one.
        ...(process.env['FOREMAN_CLAUDE_PATH'] ? { pathToClaudeCodeExecutable: process.env['FOREMAN_CLAUDE_PATH'] } : {}),
        ...(start.model ? { model: start.model } : {}),
        ...(start.resume ? { resume: start.resume } : {}),
      },
    });
    for await (const message of stream) {
      const parsed = parseMessage(message as unknown as Record<string, unknown>, tracker);
      if (parsed.sessionId) send({ type: 'session_id', sessionId: parsed.sessionId });
      // Step-list bookkeeping has its own section in the UI; keep it out of the activity log.
      const quiet = new Set(parsed.log.filter((e) => e.kind === 'tool' && e.tool === STEPS_TOOL).map((e) => e.id));
      for (const entry of parsed.log) if (!quiet.has(entry.id) || !entry.id) send({ type: 'log', entry });
      if (parsed.steps) send({ type: 'steps', items: parsed.steps });
      if (parsed.result) {
        ended = true;
        send({ type: 'ended', ...parsed.result, outcome: stopped ? 'cancelled' : parsed.result.outcome });
        break;
      }
    }
  } catch (err) {
    if (!ended) {
      ended = true;
      const error = err instanceof Error ? err.message : String(err);
      send({ type: 'ended', outcome: stopped ? 'cancelled' : 'error', costUsd: null, durationMs: null, error: stopped ? null : error });
    }
  } finally {
    finished();
  }
  if (!ended) {
    send({ type: 'ended', outcome: stopped ? 'cancelled' : 'error', costUsd: null, durationMs: null, error: stopped ? null : 'The session ended without a result' });
  }
}

function onMessage(msg: FromCore & { v?: number }): void {
  if (msg.v !== PROTOCOL_VERSION) {
    send({ type: 'ended', outcome: 'error', costUsd: null, durationMs: null, error: `Protocol version mismatch: core sent ${msg.v}, host speaks ${PROTOCOL_VERSION}` });
    process.exit(1);
  }
  switch (msg.type) {
    case 'start': {
      if (started) return;
      started = true;
      const runner = process.argv.includes('--stub') ? runStub(msg, () => stopped) : run(msg);
      void runner.finally(() => process.stdout.write('', () => process.exit(0)));
      break;
    }
    case 'approve':
    case 'deny':
    case 'reply': {
      const resolve = waiting.get(msg.requestId);
      waiting.delete(msg.requestId);
      resolve?.(msg);
      break;
    }
    case 'stop':
      stopped = true;
      for (const [id, resolve] of waiting) resolve({ type: 'deny', requestId: id, message: 'The session was stopped.' });
      waiting.clear();
      abort.abort();
      break;
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  try {
    onMessage(JSON.parse(line) as FromCore & { v?: number });
  } catch (err) {
    send({ type: 'log', entry: { kind: 'error', text: `Agent host couldn't read a message: ${String(err)}` } });
  }
});
