/**
 * Progress reporter threaded through long-running skills. Each call
 * publishes a TaskStatusUpdateEvent with `state: "working"` and
 * `final: false` so streaming clients see pipeline milestones in real
 * time. Non-streaming `message/send` callers are unaffected because
 * the SDK returns the terminal Message, not the status updates.
 *
 * Defined here (and not in dispatcher.ts) so handler modules and
 * collectors can import the type without dragging in the dispatcher
 * itself — which would import them right back and form a cycle.
 */
interface Progress {
  emit(stage: string, data?: Record<string, unknown>): void;
}

/** Extract skill id and input from A2A message parts */
interface SkillRequest {
  skill: string;
  input: Record<string, unknown>;
}

function extractSkillRequest(parts: Array<{ kind?: string; data?: unknown }>): SkillRequest {
  const dataPart = parts.find(p => p.kind === 'data');
  if (!dataPart?.data || typeof dataPart.data !== 'object') {
    throw new Error('Message must contain a data part with skill and input');
  }

  const data = dataPart.data as Record<string, unknown>;
  const skill = data.skill;
  const input = data.input;

  if (typeof skill !== 'string') {
    throw new Error("Missing or invalid 'skill' in message data");
  }

  return {
    skill,
    input: (input as Record<string, unknown>) ?? {},
  };
}

export { extractSkillRequest };
export type { Progress };
