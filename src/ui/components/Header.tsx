/**
 * Header Component
 *
 * Application header displaying the title and version number. Uses a
 * rounded border with cyan styling for visual distinction.
 */
import { Box, Text } from 'ink';
import { version as packageVersion } from '../../../package.json';

interface HeaderProps {
  title?: string;
  version?: string;
}

export function Header({ title = 'Solenoid', version = packageVersion }: HeaderProps) {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={2} justifyContent="space-between">
      <Text bold color="cyan">
        {title}
      </Text>
      <Text dimColor>v{version}</Text>
    </Box>
  );
}
