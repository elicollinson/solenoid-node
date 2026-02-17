/**
 * Response Formatting Agent (ADK)
 *
 * Composes the final response by embedding original rich artifacts
 * (charts, tables, text) instead of letting the planning agent
 * reconstruct them as ASCII. Uses list_artifacts to discover available
 * content and embed_artifact to place each piece inline.
 *
 * Dependencies:
 * - @google/adk: LlmAgent for ADK-compatible agent
 * - artifacts: list_artifacts and embed_artifact tools
 */
import { LlmAgent } from '@google/adk';
import { embedArtifactTool, listArtifactsTool } from '../artifacts/index.js';
import { getAgentConfig } from '../config/index.js';
import { TRANSFER_BACK_INSTRUCTION } from './types.js';

const DEFAULT_INSTRUCTION = `You are the Response Formatting Agent. You compose the final response for the user by embedding rich artifacts created during the task.

### WORKFLOW
1. Call list_artifacts to discover all charts, tables, and text artifacts created by specialist agents.
2. For EACH artifact found, call embed_artifact with its artifact ID. The UI renders these as rich inline elements automatically.
3. Write ONLY brief connective prose between artifacts (1-2 sentences max). The artifacts already contain the data.
4. Transfer the final composed response to your parent agent.

### CRITICAL: WHAT NOT TO DO
- NEVER draw, describe, or reconstruct chart data as text (no ASCII bars, no text-based charts)
- NEVER reproduce table data as text or markdown tables — the embed_artifact call renders it
- NEVER repeat numbers, values, or data points that are already shown in an artifact
- NEVER write a "detailed comparison table" or "chart" in prose — embed_artifact does this

### WHAT TO WRITE
- A brief 1-2 sentence intro before the first artifact
- Short transitions between artifacts ("The table below shows the detailed breakdown.")
- A brief summary of key insights AFTER the artifacts (focus on interpretation, not data repetition)

### EXAMPLE OUTPUT STRUCTURE
"Here is the performance comparison."
[embed_artifact: chart]
"The detailed values are shown below."
[embed_artifact: table]
"Key takeaway: X outperforms Y in category Z by N%."

### RULES
- ALWAYS call list_artifacts first.
- ALWAYS call embed_artifact for every artifact found — never skip one.
- If there are no artifacts, compose a text-only summary and return.
- Your total prose should be under 100 words. Let artifacts carry the content.
${TRANSFER_BACK_INSTRUCTION}`;

const { modelName, customPrompt } = getAgentConfig('response_formatting_agent');

/**
 * Response Formatting LlmAgent - composes final output with embedded artifacts
 */
export const responseFormattingAgent = new LlmAgent({
  name: 'response_formatting_agent',
  model: modelName,
  description:
    'Composes the final response by embedding rich artifacts (charts, tables, text) produced by specialist agents.',
  instruction: customPrompt ?? DEFAULT_INSTRUCTION,
  tools: [listArtifactsTool, embedArtifactTool],
});
