/**
 * Agent Runner (ADK)
 *
 * Session manager that orchestrates agent execution using ADK's InMemoryRunner.
 * Maintains conversation history per session, transforms user input into agent
 * requests, and streams responses back. Acts as the interface between the
 * server API and the ADK-based agent system.
 *
 * Features:
 * - ADK InMemoryRunner for session management
 * - Async generator interface for response streaming (backwards compatible)
 * - Session-based conversation tracking with unique session IDs
 *
 * Dependencies:
 * - @google/adk: InMemoryRunner for session-based agent execution
 * - @google/genai: Content type for message formatting
 */
import { InMemoryRunner, isFinalResponse } from '@google/adk';
import type { LlmAgent } from '@google/adk';
import type { Content } from '@google/genai';
import { agentLogger } from '../utils/logger.js';
import { createPlanningAgent } from './planning.js';
import type { AgentStreamChunk } from './types.js';

const APP_NAME = 'Solenoid';

/**
 * Debug: Log the agent hierarchy
 */
export function logAgentHierarchy(agent: LlmAgent, indent = 0) {
  const prefix = '  '.repeat(indent);
  agentLogger.debug(`${prefix}[Agent] ${agent.name} (model: ${agent.model})`);
  if (agent.subAgents && agent.subAgents.length > 0) {
    for (const subAgent of agent.subAgents) {
      logAgentHierarchy(subAgent as LlmAgent, indent + 1);
    }
  }
}

/**
 * Creates a runner with fully initialized MCP tools
 * Use this when you need MCP tools to be fully initialized
 */
export async function createRunner(): Promise<InMemoryRunner> {
  const initializedRootAgent = await createPlanningAgent();
  return new InMemoryRunner({
    agent: initializedRootAgent,
    appName: APP_NAME,
  });
}

/**
 * Creates a Content object from text for use with the runner
 */
export function createUserContent(text: string): Content {
  return {
    role: 'user',
    parts: [{ text }],
  };
}

/**
 * Runs the agent with the given input and yields stream chunks
 * Compatible with the existing server API
 *
 * @param input User message
 * @param runner The InMemoryRunner to use
 * @param sessionId Optional session ID (creates new if not provided)
 */
export async function* runAgent(
  input: string,
  runner: InMemoryRunner,
  sessionId?: string
): AsyncGenerator<AgentStreamChunk, void, unknown> {
  const sid = sessionId ?? crypto.randomUUID();

  let session = await runner.sessionService.getSession({
    appName: APP_NAME,
    userId: 'default_user',
    sessionId: sid,
  });

  if (!session) {
    session = await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: 'default_user',
      sessionId: sid,
    });
  }

  const userMessage = createUserContent(input);

  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 1000;
  let attempt = 0;
  let gotFinalContent = false;
  let lastErrorCode: string | undefined;
  let lastErrorMessage: string | undefined;

  function retryReason(): string {
    return lastErrorMessage ?? lastErrorCode ?? 'empty response';
  }

  try {
    while (attempt <= MAX_RETRIES && !gotFinalContent) {
      if (attempt > 0) {
        const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1); // 1s, 2s, 4s, 8s, 16s
        const reason = retryReason();
        agentLogger.info(
          `[Runner] Retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${reason}`
        );
        yield {
          type: 'status',
          content: `Retrying (${attempt}/${MAX_RETRIES}): ${reason}`,
        };
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const message =
        attempt === 0 ? userMessage : createUserContent('Please continue with your response.');

      let eventIndex = 0;
      for await (const event of runner.runAsync({
        userId: 'default_user',
        sessionId: sid,
        newMessage: message,
      })) {
        eventIndex++;
        agentLogger.debug(`[Runner] ===== EVENT #${eventIndex} (attempt ${attempt + 1}) =====`);
        agentLogger.debug(
          `[Runner] Event ID: ${event.id}, from ${event.author}, parts: ${event.content?.parts?.length ?? 0}, role: ${event.content?.role}, isFinal: ${isFinalResponse(event)}, transferToAgent: ${event.actions?.transferToAgent ?? 'none'}, errorCode: ${(event as any).errorCode ?? 'none'}, errorMessage: ${(event as any).errorMessage ?? 'none'}`
        );

        if (event.actions?.transferToAgent) {
          agentLogger.debug(
            `[Runner] *** TRANSFER DETECTED: ${event.author} -> ${event.actions.transferToAgent} ***`
          );
        }

        const partTypes =
          event.content?.parts
            ?.map((p) => {
              if ('text' in p && p.text) return 'text';
              if ('functionCall' in p && p.functionCall)
                return `functionCall:${p.functionCall.name}`;
              if ('functionResponse' in p && p.functionResponse)
                return `functionResponse:${(p.functionResponse as { name?: string }).name}`;
              return `unknown(${Object.keys(p).join(',')})`;
            })
            .join(', ') ?? 'no parts';
        agentLogger.debug(`[Runner] Event parts: ${partTypes}`);

        if (event.content?.parts?.some((p) => 'functionResponse' in p)) {
          agentLogger.debug('[Runner] Function response event detected!');
        }

        if (event.content?.parts) {
          for (const part of event.content.parts) {
            if (part.text) {
              yield { type: 'text', content: part.text };
            }
            if ('functionCall' in part && part.functionCall?.name) {
              agentLogger.debug(
                `[Runner] Tool call: ${part.functionCall.name}, args: ${JSON.stringify(part.functionCall.args)}`
              );
              yield {
                type: 'tool_call',
                toolCall: {
                  function: {
                    name: part.functionCall.name,
                    arguments: part.functionCall.args as Record<string, unknown>,
                  },
                },
              };
            }
          }
        }

        // ADK may yield empty "auth" events that appear final but aren't meaningful.
        // Skip these and retry.
        if (isFinalResponse(event)) {
          const hasContent =
            (event.content?.parts?.length ?? 0) > 0 || event.actions?.transferToAgent;

          if (hasContent) {
            agentLogger.debug(`[Runner] Final response received from ${event.author}`);
            gotFinalContent = true;
            yield { type: 'done' };
            return;
          }

          lastErrorCode = (event as any).errorCode?.toString();
          lastErrorMessage = (event as any).errorMessage;
          agentLogger.warn(
            `[Runner] Empty final event from ${event.author} ` +
              `(attempt ${attempt + 1}/${MAX_RETRIES + 1}). ` +
              `errorCode: ${lastErrorCode ?? 'none'}, errorMessage: ${lastErrorMessage ?? 'none'}`
          );
          break;
        }
      }

      if (!gotFinalContent) {
        attempt++;
      }
    }

    if (!gotFinalContent) {
      const reason = retryReason();
      agentLogger.error(`[Runner] All ${MAX_RETRIES + 1} attempts exhausted — ${reason}`);
      yield {
        type: 'text',
        content: `The model failed after ${MAX_RETRIES + 1} attempts: ${reason}`,
      };
      yield { type: 'done' };
    }
  } catch (error) {
    agentLogger.error({ error }, '[Runner] Error during agent execution');
    yield {
      type: 'text',
      content: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
    yield { type: 'done' };
  }
}

/**
 * Legacy AgentRunner class for backwards compatibility
 * Wraps the ADK InMemoryRunner with the existing interface
 */
export class AgentRunner {
  private adkRunner: InMemoryRunner;

  constructor(agent: LlmAgent) {
    this.adkRunner = new InMemoryRunner({
      agent,
      appName: APP_NAME,
    });
  }

  async *run(input: string, sessionId?: string): AsyncGenerator<AgentStreamChunk, void, unknown> {
    yield* runAgent(input, this.adkRunner, sessionId);
  }

  /**
   * Gets the underlying ADK runner
   */
  getAdkRunner(): InMemoryRunner {
    return this.adkRunner;
  }
}
