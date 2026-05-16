import type { Message, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';

import { logger } from '../observability/logger';
import { handleClaimFeedback } from './handlers/claim-feedback';
import { handleContradictions } from './handlers/contradictions';
import { handleFeedback } from './handlers/feedback';
import { handleFind } from './handlers/find';
import { handleIngest } from './handlers/ingest';
import { handleNeighbors } from './handlers/neighbors';
import { handleProvenance } from './handlers/provenance';
import { extractSkillRequest, type Progress } from './types';

const SUPPORTED_SKILLS = ['find', 'feedback', 'claim_feedback', 'neighbors', 'provenance', 'contradictions', 'ingest'] as const;
type SupportedSkill = (typeof SUPPORTED_SKILLS)[number];

function makeMessage(data: Record<string, unknown>): Message {
  return {
    kind: 'message',
    messageId: crypto.randomUUID(),
    role: 'agent',
    parts: [{ kind: 'data', data }],
  };
}

function makeStatusUpdate(
  taskId: string,
  contextId: string,
  stage: string,
  data: Record<string, unknown> | undefined,
): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final: false,
    status: {
      state: 'working',
      timestamp: new Date().toISOString(),
      message: {
        kind: 'message',
        messageId: crypto.randomUUID(),
        role: 'agent',
        parts: [{ kind: 'data', data: { stage, ...data } }],
      },
    },
  };
}

function runSkill(skill: SupportedSkill, input: Record<string, unknown>, progress: Progress): Promise<unknown> {
  switch (skill) {
    case 'find':
      return handleFind(input, progress);
    case 'feedback':
      // handleFeedback already returns Promise<FeedbackResult>, which
      // is assignable to Promise<unknown>. No cast needed.
      return handleFeedback(input);
    case 'claim_feedback':
      return handleClaimFeedback(input);
    case 'neighbors':
      return handleNeighbors(input);
    case 'provenance':
      return handleProvenance(input);
    case 'contradictions':
      return handleContradictions(input);
    case 'ingest':
      return handleIngest(input);
    default: {
      // SupportedSkill is a string-literal union, so this branch is
      // statically unreachable. The exhaustiveness assertion makes
      // adding a new skill without a case a compile error.
      const _exhaustive: never = skill;
      throw new Error(`unreachable: unsupported skill ${String(_exhaustive)}`);
    }
  }
}

export class KnoldrExecutor implements AgentExecutor {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { userMessage, taskId } = requestContext;
    const contextId = userMessage.contextId ?? crypto.randomUUID();

    const progress: Progress = {
      emit(stage, data) {
        eventBus.publish(makeStatusUpdate(taskId, contextId, stage, data));
      },
    };

    try {
      const { skill, input } = extractSkillRequest(userMessage.parts);

      if (!SUPPORTED_SKILLS.includes(skill as SupportedSkill)) {
        eventBus.publish(makeMessage({ error: `Unknown skill: ${skill}. Supported: ${SUPPORTED_SKILLS.join(', ')}.` }));
        eventBus.finished();
        return;
      }

      logger.info({ skill, taskId }, 'executing A2A skill');
      progress.emit('started', { skill });

      // AWAIT the skill before returning from execute(). The prior
      // fire-and-forget shape relied on the SDK holding the eventBus
      // open after execute() resolved; any SDK change that tears the
      // bus down at resolution boundary would drop the final message.
      try {
        const result = await runSkill(skill as SupportedSkill, input, progress);
        eventBus.publish(makeMessage(result as Record<string, unknown>));
      } catch (err) {
        logger.error({ taskId, skill, error: (err as Error).message }, 'skill execution failed');
        // Don't echo the raw error message to the caller — it can carry
        // SQL text, stack fragments, or dependency internals. The log
        // above preserves the detail for operators.
        eventBus.publish(makeMessage({ error: { code: -32603, message: 'Internal error' } }));
      }
      eventBus.finished();
    } catch (err) {
      const error = err as Error;
      logger.error({ taskId, error: error.message }, 'A2A skill execution failed');
      eventBus.publish(makeMessage({ error: { code: -32603, message: 'Internal error' } }));
      eventBus.finished();
    }
  }

  async cancelTask(_taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.finished();
  }
}
