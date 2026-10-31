/**
 * Help Screen Component
 *
 * Overlay screen displaying available commands, keyboard shortcuts, and
 * the agent's capabilities. Closes on Enter or Escape key press.
 */
import { Box, Text, useInput } from 'ink';

interface HelpScreenProps {
  onClose: () => void;
}

export function HelpScreen({ onClose }: HelpScreenProps) {
  useInput((_, key) => {
    if (key.escape || key.return) {
      onClose();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="yellow">
        Solenoid Help
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">
          Slash Commands
        </Text>
        <Box paddingLeft={2} flexDirection="column">
          <Text>/help - Show this help screen</Text>
          <Text>/settings - View current settings</Text>
          <Text>/clear - Clear the conversation</Text>
          <Text>/tools - Show model routes, screening and tools</Text>
          <Text>/quit - Exit the application</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">
          Keyboard Shortcuts
        </Text>
        <Box paddingLeft={2} flexDirection="column">
          <Text>Ctrl+C - Quit application</Text>
          <Text>Enter - Send message</Text>
          <Text>Esc - Interrupt agent response (configurable: keyboard.interrupt)</Text>
          <Text>y / n - Allow or decline a tool that changes something</Text>
          <Text>Esc - Close overlay screens</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color="cyan">
          The Agent
        </Text>
        <Box paddingLeft={2} flexDirection="column">
          <Text dimColor>One agent with web search, page reading and charts,</Text>
          <Text dimColor>plus any MCP servers in settings. Routes fall back in order;</Text>
          <Text dimColor>your messages, web pages and MCP results are screened for injection.</Text>
        </Box>
      </Box>

      <Box marginTop={2}>
        <Text dimColor>Press Enter or Esc to close</Text>
      </Box>
    </Box>
  );
}
