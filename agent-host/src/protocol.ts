/** Sidecar protocol between the Rust core and the agent host: JSON Lines over stdin/stdout. */
export const PROTOCOL_VERSION = 1;

/** Full name of Foreman's in-process step-list tool as Claude sees it. */
export const STEPS_TOOL = 'mcp__foreman__set_steps';

export type StepState = 'pending' | 'in_progress' | 'completed';

export interface Step {
  text: string;
  state: StepState;
}

export interface LogEntry {
  kind: 'text' | 'tool' | 'result' | 'error' | 'info';
  /** Tool name for `tool` entries. */
  tool?: string;
  /** Tool-use id linking a `result` to its `tool` entry. */
  id?: string;
  text: string;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export type FromCore =
  | { type: 'start'; cwd: string; prompt: string; model?: string; resume?: string; allowAllTools: boolean; allowedTools: string[] }
  | { type: 'approve'; requestId: string }
  | { type: 'deny'; requestId: string; message?: string }
  | { type: 'reply'; requestId: string; answers: Record<string, string> }
  | { type: 'stop' };

export type ToCore =
  | { type: 'session_id'; sessionId: string }
  | { type: 'steps'; items: Step[] }
  | { type: 'log'; entry: LogEntry }
  | { type: 'needs_input'; requestId: string; kind: 'permission' | 'question'; title: string; text: string; detail: string; questions: Question[] }
  | { type: 'ended'; outcome: 'success' | 'error' | 'cancelled'; costUsd: number | null; durationMs: number | null; error: string | null };
