/**
 * Status Bar Component
 *
 * Bottom bar showing current status and exit hint.
 */
import { Spinner } from '@inkjs/ui';
import { Box, Text } from 'ink';

interface StatusBarProps {
  isLoading?: boolean;
  status?: string;
  interruptHint?: string;
}

export function StatusBar({ isLoading = false, status = 'Ready', interruptHint }: StatusBarProps) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box gap={1}>{isLoading ? <Spinner label={status} /> : <Text dimColor>{status}</Text>}</Box>
      <Box gap={2}>
        {isLoading && interruptHint && <Text dimColor>{interruptHint}</Text>}
        <Text dimColor>Ctrl+C to quit</Text>
      </Box>
    </Box>
  );
}
