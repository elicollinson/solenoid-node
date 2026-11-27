import { type ApprovalRequest, safeJson } from '@elicollinson/solenoid-engine';
import { capabilityFor } from '@elicollinson/solenoid-security';
/**
 * Approval Prompt Component
 *
 * Shown when the agent wants to run a write tool. The run is paused until
 * the person answers: y/Enter allows the call, a allows its canonical
 * capability from now on (a standing rule, saved to settings), n/Esc declines it.
 */
import { Box, Text, useInput } from 'ink';

export type PendingApproval = Pick<ApprovalRequest, 'tool' | 'description' | 'args'>;

/** Allow this call, allow the tool from now on, or decline. */
export type ApprovalAnswer = 'allow' | 'always' | 'decline';

interface ApprovalPromptProps {
  approval: PendingApproval;
  onAnswer: (answer: ApprovalAnswer) => void;
}

const MAX_ARGS_CHARS = 400;

function formatArgs(args: unknown): string {
  const text = safeJson(args, 2);
  return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}…` : text;
}

export function ApprovalPrompt({ approval, onAnswer }: ApprovalPromptProps) {
  useInput((input, key) => {
    const letter = input.toLowerCase();
    if (key.return || letter === 'y') onAnswer('allow');
    else if (letter === 'a') onAnswer('always');
    else if (key.escape || letter === 'n') onAnswer('decline');
  });

  const firstLine = approval.description.split('\n')[0] ?? '';
  const capability = capabilityFor(approval.tool);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Allow {approval.tool}?
      </Text>
      {firstLine && <Text dimColor>{firstLine}</Text>}
      <Text>{formatArgs(approval.args)}</Text>
      <Text>
        <Text color="green">[y]</Text> allow <Text color="green">[a]</Text> always allow (
        {capability}) <Text color="red">[n]</Text> decline
      </Text>
    </Box>
  );
}
