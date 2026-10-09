/** Stubbed agent runtime for integration-test mode (NFR4): no Claude usage, no file changes. */
import { askCore, send } from './host.js';
import type { FromCore, Step } from './protocol.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runStub(start: Extract<FromCore, { type: 'start' }>, isStopped: () => boolean): Promise<void> {
  const pace = Number(process.env['FOREMAN_STUB_PACE_MS'] ?? 1500);
  const texts = ['Read work item and acceptance criteria', 'Find the affected code', 'Implement the change', 'Run the test suite', 'Commit, push and open a PR'];
  const steps: Step[] = texts.map((text) => ({ text, state: 'pending' }));
  const ended = (outcome: 'success' | 'cancelled') =>
    send({ type: 'ended', outcome, costUsd: outcome === 'success' ? 0.37 : null, durationMs: null, error: null });

  send({ type: 'session_id', sessionId: start.resume ?? `stub-${Date.now()}` });
  send({ type: 'log', entry: { kind: 'text', text: start.resume ? 'Picking up where I left off.' : "I'll start by reading the work item." } });
  for (const [i, step] of steps.entries()) {
    step.state = 'in_progress';
    send({ type: 'log', entry: { kind: 'tool', tool: 'TodoWrite', id: `todo-${i}`, text: 'updated the step list' } });
    send({ type: 'steps', items: steps });
    send({ type: 'log', entry: { kind: 'tool', tool: i === 3 ? 'Bash' : 'Read', id: `t-${i}`, text: i === 3 ? 'dotnet test' : `src/Intake/File${i}.cs` } });
    await sleep(pace);
    if (isStopped()) return ended('cancelled');
    send({ type: 'log', entry: { kind: 'result', id: `t-${i}`, text: i === 3 ? 'Passed!  - Failed: 0, Passed: 412, Skipped: 0' : '(42 lines)' } });
    if (i === 2 && !start.resume) {
      const answer = await askCore({
        kind: 'question',
        title: 'Claude has a question',
        text: 'Should invalid numbers block saving, or only warn?',
        detail: '',
        questions: [{
          question: 'Should invalid numbers block saving, or only warn?',
          header: 'Validation',
          options: [{ label: 'Block saving', description: 'The form cannot be submitted.' }, { label: 'Warn only', description: 'Show a warning but allow saving.' }],
        }],
      });
      if (isStopped()) return ended('cancelled');
      send({ type: 'log', entry: { kind: 'text', text: answer.type === 'reply' ? `Understood: ${Object.values(answer.answers).join(', ')}.` : 'No answer; I will use the safer option.' } });
    }
    step.state = 'completed';
    send({ type: 'steps', items: steps });
  }
  ended('success');
}
