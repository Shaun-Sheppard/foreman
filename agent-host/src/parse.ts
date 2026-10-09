import type { LogEntry, Step, StepState } from './protocol.js';

const MAX_RESULT_CHARS = 2000;
const MAX_ARG_CHARS = 300;

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** One-line summary of a tool call's input for the activity log. */
export function summariseTool(name: string, input: Record<string, unknown>): string {
  const pick =
    str(input['command']) || str(input['file_path']) || str(input['path']) || str(input['pattern']) ||
    str(input['url']) || str(input['query']) || str(input['description']) || str(input['subject']) ||
    str(input['prompt']);
  if (pick) return clip(pick.replace(/\s+/g, ' '), MAX_ARG_CHARS);
  if (name === 'TodoWrite') return 'updated the step list';
  const json = JSON.stringify(input);
  return json === '{}' ? '' : clip(json, MAX_ARG_CHARS);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && 'text' in b ? str((b as { text: unknown }).text) : ''))
    .filter(Boolean)
    .join('\n');
}

function stepState(v: unknown): StepState {
  return v === 'in_progress' || v === 'completed' ? v : 'pending';
}

/**
 * Tracks Claude's task list across the message stream. Claude Code keeps it either
 * with TodoWrite (whole list each time) or TaskCreate/TaskUpdate (incremental).
 */
export class StepTracker {
  private steps: (Step & { id: string })[] = [];
  private nextId = 1;

  /** Returns the new step list if this tool call changed it, otherwise null. */
  apply(name: string, input: Record<string, unknown>): Step[] | null {
    if (name === 'TodoWrite' && Array.isArray(input['todos'])) {
      this.steps = (input['todos'] as Record<string, unknown>[]).map((t, i) => ({
        id: String(i + 1),
        text: str(t['content']),
        state: stepState(t['status']),
      }));
    } else if (name === 'TaskCreate') {
      this.steps.push({ id: String(this.nextId++), text: str(input['subject']), state: 'pending' });
    } else if (name === 'TaskUpdate') {
      const id = str(input['taskId']);
      if (input['status'] === 'deleted') {
        this.steps = this.steps.filter((s) => s.id !== id);
      } else {
        const step = this.steps.find((s) => s.id === id);
        if (!step) return null;
        if (input['status'] !== undefined) step.state = stepState(input['status']);
        if (str(input['subject'])) step.text = str(input['subject']);
      }
    } else {
      return null;
    }
    return this.steps.map(({ text, state }) => ({ text, state }));
  }
}

export interface Parsed {
  log: LogEntry[];
  steps: Step[] | null;
  sessionId: string | null;
  result: { outcome: 'success' | 'error'; costUsd: number | null; durationMs: number | null; error: string | null } | null;
}

type Block = Record<string, unknown>;

/** Turns one SDK stream message into log entries, step updates and lifecycle facts (FR3.1, FR3.2). */
export function parseMessage(msg: Record<string, unknown>, tracker: StepTracker): Parsed {
  const out: Parsed = { log: [], steps: null, sessionId: null, result: null };
  const content = (msg['message'] as { content?: unknown } | undefined)?.content;
  const blocks: Block[] = Array.isArray(content) ? (content as Block[]) : [];

  if (msg['type'] === 'system' && msg['subtype'] === 'init') {
    out.sessionId = str(msg['session_id']) || null;
  } else if (msg['type'] === 'assistant') {
    // Subagent chatter stays out of the main log; its tool calls are summarised by the parent Task call.
    if (msg['parent_tool_use_id']) return out;
    for (const b of blocks) {
      if (b['type'] === 'text' && str(b['text']).trim()) {
        out.log.push({ kind: 'text', text: str(b['text']).trim() });
      } else if (b['type'] === 'tool_use') {
        const name = str(b['name']);
        const input = (b['input'] ?? {}) as Record<string, unknown>;
        out.log.push({ kind: 'tool', tool: name, id: str(b['id']), text: summariseTool(name, input) });
        const steps = tracker.apply(name, input);
        if (steps) out.steps = steps;
      }
    }
  } else if (msg['type'] === 'user') {
    if (msg['parent_tool_use_id']) return out;
    for (const b of blocks) {
      if (b['type'] !== 'tool_result') continue;
      const text = clip(resultText(b['content']).trim(), MAX_RESULT_CHARS);
      out.log.push({ kind: b['is_error'] ? 'error' : 'result', id: str(b['tool_use_id']), text });
    }
  } else if (msg['type'] === 'result') {
    const ok = msg['subtype'] === 'success' && !msg['is_error'];
    out.result = {
      outcome: ok ? 'success' : 'error',
      costUsd: typeof msg['total_cost_usd'] === 'number' ? msg['total_cost_usd'] : null,
      durationMs: typeof msg['duration_ms'] === 'number' ? msg['duration_ms'] : null,
      error: ok ? null : str(msg['result']) || str(msg['subtype']) || 'The session ended with an error',
    };
  }
  return out;
}
