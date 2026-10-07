import { Box, Button, Callout, Flex, Heading, Skeleton, Text } from '@radix-ui/themes';
import { WarningCircle } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { ApiError } from '../types';

/** An error with the server's next-step hint underneath. */
export function ErrorCallout({ error }: { error: ApiError }) {
  return (
    <Callout.Root color="red" role="alert">
      <Callout.Icon>
        <WarningCircle size={18} weight="bold" />
      </Callout.Icon>
      <Callout.Text>
        {error.message}
        {error.hint && (
          <Text as="span" size="2" color="gray" style={{ display: 'block', marginTop: 4 }}>
            {error.hint}
          </Text>
        )}
      </Callout.Text>
    </Callout.Root>
  );
}

/** A centred message for "nothing here yet", saying how to get started. */
export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <Flex direction="column" align="center" gap="3" py="9" px="4" style={{ textAlign: 'center' }}>
      <Box style={{ color: 'var(--gray-9)' }}>{icon}</Box>
      <Heading size="4" weight="medium">{title}</Heading>
      {children && <Text size="2" color="gray" style={{ maxWidth: '46ch' }}>{children}</Text>}
      {action}
    </Flex>
  );
}

/** Placeholder rows in the shape of a timeline while it loads. */
export function TimelineSkeleton() {
  return (
    <Flex direction="column" gap="3">
      {[0, 1].map((i) => (
        <Box key={i}>
          <Skeleton height="20px" width="40%" mb="3" />
          <Skeleton height="36px" mb="1" />
          <Skeleton height="36px" mb="1" />
          <Skeleton height="36px" />
        </Box>
      ))}
    </Flex>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <Flex justify="between" align="start" gap="4" mb="5" wrap="wrap">
      <Box>
        <Heading size="6" weight="bold">{title}</Heading>
        {description && <Text as="p" size="2" color="gray" mt="1">{description}</Text>}
      </Box>
      {actions && <Flex gap="2" wrap="wrap">{actions}</Flex>}
    </Flex>
  );
}

export function RetryButton({ onClick }: { onClick: () => void }) {
  return <Button variant="soft" onClick={onClick}>Try again</Button>;
}
