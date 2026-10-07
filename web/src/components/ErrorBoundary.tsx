import { Box, Button, Callout, Code, Flex, Text } from '@radix-ui/themes';
import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react';
import { Component, type ReactNode } from 'react';

/** Shows what went wrong when a page crashes, instead of a blank screen. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Callout.Root color="red" role="alert">
        <Callout.Icon><WarningCircle /></Callout.Icon>
        <Flex direction="column" gap="2">
          <Text weight="bold">This page stopped working.</Text>
          <Text size="2">Other pages still work. Reloading usually helps; if it keeps happening, please report this message:</Text>
          <Box><Code size="2" variant="ghost">{error.message}</Code></Box>
          <Box><Button size="2" variant="soft" color="red" onClick={() => location.reload()}><ArrowClockwise /> Reload</Button></Box>
        </Flex>
      </Callout.Root>
    );
  }
}
