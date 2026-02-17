/**
 * Generic Executor Agent (ADK)
 *
 * General-purpose text worker for knowledge-based tasks that don't require
 * specialized tools. Handles content creation, summarization, analysis,
 * and general knowledge questions. Has no external tool access.
 *
 * Capabilities:
 * - Answer general knowledge questions
 * - Write creative content (emails, documents, stories)
 * - Summarize and analyze provided text
 * - Generate structured content (lists, outlines, comparisons)
 *
 * Dependencies:
 * - @google/adk: LlmAgent for ADK-compatible agent
 */
import { LlmAgent } from '@google/adk';
import { saveArtifactTool } from '../artifacts/index.js';
import { getAgentConfig } from '../config/index.js';
import { saveMemoriesOnFinalResponse } from '../memory/callbacks.js';
import { TRANSFER_BACK_INSTRUCTION } from './types.js';

const DEFAULT_INSTRUCTION = `You are the Generic Executor Agent, handling knowledge tasks.

### ROLE
You handle general-purpose tasks. You are the "knowledge worker" for text-based work.

### CAPABILITIES

**You CAN do:**
- Answer general knowledge questions
- Write creative content (poems, stories, emails, etc.)
- Summarize or analyze provided text
- Generate structured content (lists, outlines, comparisons)
- Draft documents, messages, or responses

**You CANNOT do:**
- Execute Python code (use code_executor_agent)
- Generate charts or visualizations (use chart_generator_agent)
- Search the web for current information (use research_agent)
- Access files or external systems (use mcp_agent)

### SAVING STRUCTURED OUTPUT
When you produce tabular data or structured content, use the save_artifact tool to preserve it for rich rendering:
- For tables: save_artifact with type "table", headers, and rows
- For formatted text: save_artifact with type "text" and content

### CONSTRAINTS
- ALWAYS provide helpful, accurate responses
- If asked to do something outside your capabilities, clearly state what agent should be used instead
${TRANSFER_BACK_INSTRUCTION}`;

const { modelName, customPrompt } = getAgentConfig('generic_executor_agent');

/**
 * Generic Executor LlmAgent - handles knowledge-based text tasks
 */
export const genericAgent = new LlmAgent({
  name: 'generic_executor_agent',
  model: modelName,
  description:
    'General-purpose knowledge worker for text-based tasks like writing, summarization, and analysis.',
  instruction: customPrompt ?? DEFAULT_INSTRUCTION,
  tools: [saveArtifactTool],
  afterModelCallback: saveMemoriesOnFinalResponse,
});

// Factory function for backwards compatibility
export function createGenericAgent(): LlmAgent {
  return genericAgent;
}
