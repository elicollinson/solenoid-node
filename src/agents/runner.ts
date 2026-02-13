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
import type { Span as OtelSpan } from '@opentelemetry/api';
import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { agentLogger } from '../utils/logger.js';
import { createPlanningAgent } from './planning.js';
import type { AgentStreamChunk } from './types.js';

const APP_NAME = 'Solenoid';
const tracer = trace.getTracer('solenoid');

/**
 * Serialize any error value into a readable string.
 * ADK sometimes throws non-standard error objects (e.g. `{}`) that lose
 * information with naive stringification.
 */
function serializeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.constructor.name;
  if (typeof error === 'string') return error;
  try {
    const str = String(error);
    if (str !== '[object Object]') return str;
  } catch {
    // fall through
  }
  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}') return json;
  } catch {
    // fall through
  }
  return 'Unknown error (non-serializable)';
}

/**
 * Debug: Log the agent hierarchy with model and rootAgent info
 */
export function logAgentHierarchy(agent: LlmAgent, indent = 0): void {
  const prefix = '  '.repeat(indent);
  // biome-ignore lint/suspicious/noExplicitAny: rootAgent is not exposed in ADK's public types
  const rootName = (agent as any).rootAgent?.name ?? 'unknown';
  agentLogger.debug(`${prefix}[Agent] ${agent.name} (model: ${agent.model}, root: ${rootName})`);
  for (const subAgent of agent.subAgents) {
    logAgentHierarchy(subAgent as LlmAgent, indent + 1);
  }
}

/**
 * Creates a runner with fully initialized MCP tools
 * Use this when you need MCP tools to be fully initialized
 */
export async function createRunner(): Promise<InMemoryRunner> {
  const initializedRootAgent = await createPlanningAgent();
  logAgentHierarchy(initializedRootAgent);
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
 * Retrieve an existing session or create a new one.
 */
async function getOrCreateSession(
  runner: InMemoryRunner,
  sessionId: string
): Promise<unknown> {
  const params = { appName: APP_NAME, userId: 'default_user', sessionId };
  const existing = await runner.sessionService.getSession(params);
  if (existing) return existing;
  return runner.sessionService.createSession(params);
}

/**
 * Build a human-readable summary of an event's part types for debug logging.
 */
function describePartTypes(parts: Array<Record<string, unknown>> | undefined): string {
  if (!parts) return 'no parts';
  return (
    parts
      .map((p) => {
        if ('text' in p && p.text) return 'text';
        if ('functionCall' in p && p.functionCall)
          return `functionCall:${(p.functionCall as { name?: string }).name}`;
        if ('functionResponse' in p && p.functionResponse)
          return `functionResponse:${(p.functionResponse as { name?: string }).name}`;
        return `unknown(${Object.keys(p).join(',')})`;
      })
      .join(', ') || 'no parts'
  );
}

/**
 * Choose the appropriate message for a retry attempt.
 * On first attempt, sends the original user message.
 * After an exception (no ADK error code), provides error context.
 * After an empty response or ADK error, nudges the model to continue.
 */
function buildRetryMessage(
  attempt: number,
  userMessage: Content,
  lastErrorMessage: string | undefined,
  lastErrorCode: string | undefined
): Content {
  if (attempt === 0) return userMessage;

  if (lastErrorMessage && !lastErrorCode) {
    return createUserContent(
      `The previous attempt encountered an error: ${lastErrorMessage}. Please try an alternative approach or a different agent.`
    );
  }
  return createUserContent('Please continue with your response.');
}

/**
 * Record an OTel span for a tool call, nested under the current agent span.
 */
function recordToolSpan(
  name: string,
  args: unknown,
  parentCtx: ReturnType<typeof context.active>
): void {
  const span = tracer.startSpan(
    `tool: ${name}`,
    {
      attributes: {
        'gen_ai.tool.name': name,
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.call.args': JSON.stringify(args),
      },
    },
    parentCtx
  );
  span.end();
}

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

/**
 * Runs the agent with the given input and yields stream chunks.
 * Compatible with the existing server API.
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
  const rootSpan = tracer.startSpan('solenoid.agent_run');
  rootSpan.setAttribute('solenoid.session_id', sid);
  rootSpan.setAttribute('solenoid.user_input', input.substring(0, 500));
  rootSpan.setAttribute('wandb.thread_id', sid);
  rootSpan.setAttribute('wandb.is_turn', true);
  const rootCtx = trace.setSpan(context.active(), rootSpan);

  let currentAgentSpan: OtelSpan | null = null;
  let currentAgentCtx = rootCtx;

  try {
    await getOrCreateSession(runner, sid);

    const userMessage = createUserContent(input);
    let attempt = 0;
    let gotFinalContent = false;
    let lastErrorCode: string | undefined;
    let lastErrorMessage: string | undefined;

    function retryReason(): string {
      return lastErrorMessage ?? lastErrorCode ?? 'empty response';
    }

    while (attempt <= MAX_RETRIES && !gotFinalContent) {
      if (attempt > 0) {
        const delayMs = BASE_DELAY_MS * 2 ** (attempt - 1);
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

      const message = buildRetryMessage(attempt, userMessage, lastErrorMessage, lastErrorCode);

      try {
        let eventIndex = 0;
        for await (const event of context.with(rootCtx, () =>
          runner.runAsync({
            userId: 'default_user',
            sessionId: sid,
            newMessage: message,
          })
        )) {
          eventIndex++;
          // biome-ignore lint/suspicious/noExplicitAny: errorCode/errorMessage not in ADK's public Event types
          const eventAny = event as any;
          agentLogger.debug(
            `[Runner] ===== EVENT #${eventIndex} (attempt ${attempt + 1}) ===== ` +
              `id=${event.id} from=${event.author} ` +
              `parts=${event.content?.parts?.length ?? 0} role=${event.content?.role} ` +
              `isFinal=${isFinalResponse(event)} transfer=${event.actions?.transferToAgent ?? 'none'} ` +
              `errorCode=${eventAny.errorCode ?? 'none'} errorMessage=${eventAny.errorMessage ?? 'none'}`
          );

          if (event.actions?.transferToAgent) {
            if (currentAgentSpan) currentAgentSpan.end();
            currentAgentSpan = tracer.startSpan(
              `agent: ${event.actions.transferToAgent}`,
              {
                attributes: {
                  'gen_ai.agent.name': event.actions.transferToAgent,
                  'gen_ai.operation.name': 'invoke_agent',
                },
              },
              rootCtx
            );
            currentAgentCtx = trace.setSpan(rootCtx, currentAgentSpan);

            agentLogger.info(
              `[Runner] *** TRANSFER: ${event.author} -> ${event.actions.transferToAgent} ***`
            );
            yield { type: 'transfer', transferTo: event.actions.transferToAgent };
          }

          agentLogger.debug(
            `[Runner] Event parts: ${describePartTypes(event.content?.parts as Array<Record<string, unknown>> | undefined)}`
          );

          if (event.content?.parts) {
            for (const part of event.content.parts) {
              if (part.text) {
                yield { type: 'text', content: part.text };
              }
              if ('functionCall' in part && part.functionCall?.name) {
                recordToolSpan(part.functionCall.name, part.functionCall.args, currentAgentCtx);
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
          if (isFinalResponse(event)) {
            const hasContent =
              (event.content?.parts?.length ?? 0) > 0 || event.actions?.transferToAgent;

            if (hasContent) {
              agentLogger.debug(`[Runner] Final response received from ${event.author}`);
              gotFinalContent = true;
              yield { type: 'done' };
              return;
            }

            lastErrorCode = eventAny.errorCode?.toString();
            lastErrorMessage = eventAny.errorMessage;
            agentLogger.warn(
              `[Runner] Empty final event from ${event.author} ` +
                `(attempt ${attempt + 1}/${MAX_RETRIES + 1}). ` +
                `errorCode: ${lastErrorCode ?? 'none'}, errorMessage: ${lastErrorMessage ?? 'none'}`
            );
            break;
          }
        }
      } catch (error) {
        const serialized = serializeError(error);
        lastErrorMessage = serialized;
        lastErrorCode = undefined;
        rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: serialized });
        agentLogger.error(
          { errorType: error?.constructor?.name, attempt: attempt + 1, message: serialized },
          '[Runner] Exception during runAsync — will retry'
        );
      }

      if (!gotFinalContent) {
        attempt++;
      }
    }

    if (!gotFinalContent) {
      const reason = retryReason();
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: reason });
      agentLogger.error(`[Runner] All ${MAX_RETRIES + 1} attempts exhausted — ${reason}`);
      yield {
        type: 'text',
        content: `The model failed after ${MAX_RETRIES + 1} attempts: ${reason}`,
      };
      yield { type: 'done' };
    }
  } finally {
    if (currentAgentSpan) currentAgentSpan.end();
    rootSpan.end();
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
