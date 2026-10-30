/**
 * Approval Prompt Component
 *
 * Shown when the agent wants to run a write tool. The run is paused until
 * the person answers: y/Enter allows the call, n/Esc declines it.
 */
import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest } from '../../core/index.js';
import { safeJson } from '../../core/tracing.js';

export type PendingApproval = Pick<ApprovalRequest, 'tool' | 'description' | 'args'>;

interface ApprovalPromptProps {
  approval: PendingApproval;
  onAnswer: (allow: boolean) => void;
}

const MAX_ARGS_CHARS = 400;

function formatArgs(args: unknown): string {
  const text = safeJson(args, 2);
  return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}…` : text;
}

export function ApprovalPrompt({ approval, onAnswer }: ApprovalPromptProps) {
  useInput((input, key) => {
    if (key.return || input.toLowerCase() === 'y') onAnswer(true);
    else if (key.escape || input.toLowerCase() === 'n') onAnswer(false);
  });

  const firstLine = approval.description.split('\n')[0] ?? '';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Allow {approval.tool}?
      </Text>
      {firstLine && <Text dimColor>{firstLine}</Text>}
      <Text>{formatArgs(approval.args)}</Text>
      <Text>
        <Text color="green">[y]</Text> allow <Text color="red">[n]</Text> decline
      </Text>
    </Box>
  );
}
