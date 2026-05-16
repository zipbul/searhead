import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Message, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import { v4 as uuid } from "uuid";
import { extractSkillRequest } from "./types";
import { handleFind } from "./handlers/find";
import { handleFeedback } from "./handlers/feedback";
import { handleClaimFeedback } from "./handlers/claim-feedback";
import { handleNeighbors } from "./handlers/neighbors";
import { handleProvenance } from "./handlers/provenance";
import { handleContradictions } from "./handlers/contradictions";
import { handleIngest } from "./handlers/ingest";
import { logger } from "../observability/logger";

const SUPPORTED_SKILLS = [
  "find",
  "feedback",
  "claim_feedback",
  "neighbors",
  "provenance",
  "contradictions",
  "ingest",
] as const;
type SupportedSkill = (typeof SUPPORTED_SKILLS)[number];

/**
 * Progress reporter threaded through long-running skills. Each call
 * publishes a TaskStatusUpdateEvent with `state: "working"` and
 * `final: false` so streaming clients see pipeline milestones in real
 * time. Non-streaming `message/send` callers are unaffected because
 * the SDK returns the terminal Message, not the status updates.
 */
export interface Progress {
  emit(stage: string, data?: Record<string, unknown>): void;
}

function makeMessage(data: Record<string, unknown>): Message {
  return {
    kind: "message",
    messageId: uuid(),
    role: "agent",
    parts: [{ kind: "data", data }],
  };
}

function makeStatusUpdate(
  taskId: string,
  contextId: string,
  stage: string,
  data: Record<string, unknown> | undefined,
): TaskStatusUpdateEvent {
  return {
    kind: "status-update",
    taskId,
    contextId,
    final: false,
    status: {
      state: "working",
      timestamp: new Date().toISOString(),
      message: {
        kind: "message",
        messageId: uuid(),
        role: "agent",
        parts: [{ kind: "data", data: { stage, ...(data ?? {}) } }],
      },
    },
  };
}

function runSkill(
  skill: SupportedSkill,
  input: Record<string, unknown>,
  progress: Progress,
): Promise<unknown> {
  switch (skill) {
    case "find":
      return handleFind(input, progress);
    case "feedback":
      // handleFeedback already returns Promise<FeedbackResult>, which
      // is assignable to Promise<unknown>. No cast needed.
      return handleFeedback(input);
    case "claim_feedback":
      return handleClaimFeedback(input);
    case "neighbors":
      return handleNeighbors(input);
    case "provenance":
      return handleProvenance(input);
    case "contradictions":
      return handleContradictions(input);
    case "ingest":
      return handleIngest(input);
  }
}

export class KnoldrExecutor implements AgentExecutor {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { userMessage, taskId } = requestContext;
    const contextId = userMessage.contextId ?? uuid();

    const progress: Progress = {
      emit(stage, data) {
        eventBus.publish(makeStatusUpdate(taskId, contextId, stage, data));
      },
    };

    try {
      const { skill, input } = extractSkillRequest(userMessage.parts);

      if (!SUPPORTED_SKILLS.includes(skill as SupportedSkill)) {
        eventBus.publish(
          makeMessage({ error: `Unknown skill: ${skill}. Supported: ${SUPPORTED_SKILLS.join(", ")}.` }),
        );
        eventBus.finished();
        return;
      }

      logger.info({ skill, taskId }, "executing A2A skill");
      progress.emit("started", { skill });

      // AWAIT the skill before returning from execute(). The prior
      // fire-and-forget shape relied on the SDK holding the eventBus
      // open after execute() resolved; any SDK change that tears the
      // bus down at resolution boundary would drop the final message.
      try {
        const result = await runSkill(skill as SupportedSkill, input, progress);
        eventBus.publish(makeMessage(result as Record<string, unknown>));
      } catch (err) {
        logger.error(
          { taskId, skill, error: (err as Error).message },
          "skill execution failed",
        );
        // Don't echo the raw error message to the caller — it can carry
        // SQL text, stack fragments, or dependency internals. The log
        // above preserves the detail for operators.
        eventBus.publish(
          makeMessage({ error: { code: -32603, message: "Internal error" } }),
        );
      }
      eventBus.finished();
    } catch (err) {
      const error = err as Error;
      logger.error({ taskId, error: error.message }, "A2A skill execution failed");
      eventBus.publish(
        makeMessage({ error: { code: -32603, message: "Internal error" } }),
      );
      eventBus.finished();
    }
  }

  async cancelTask(_taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.finished();
  }
}
