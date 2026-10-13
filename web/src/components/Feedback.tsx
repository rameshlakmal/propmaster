import { Box, Button, Callout, Flex, Heading, IconButton, Skeleton, Text, Tooltip } from '@radix-ui/themes';
import { Check, Copy, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';
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

export type Tone = 'red' | 'blue' | 'green' | 'violet' | 'amber' | 'indigo' | 'gray';

/** A page's title: a coloured tile for the tool, the title, what the page is for, and its actions. */
export function PageHeader({ title, description, actions, icon, tone = 'indigo' }: { title: string; description?: ReactNode; actions?: ReactNode; icon?: ReactNode; tone?: Tone }) {
  return (
    <header className="page-head">
      <Flex gap="4" align="start" minWidth="0">
        {icon && <span className={`tile tile-lg tile-${tone}`} aria-hidden>{icon}</span>}
        <Box minWidth="0">
          <Heading as="h1" size="7" weight="bold" className="display">{title}</Heading>
          {description && <Text as="p" size="2" color="gray" mt="1" className="page-lede">{description}</Text>}
        </Box>
      </Flex>
      {actions && <Flex gap="2" wrap="wrap">{actions}</Flex>}
    </header>
  );
}

export function RetryButton({ onClick }: { onClick: () => void }) {
  return <Button variant="soft" onClick={onClick}>Try again</Button>;
}

/** Copies a command, path or id, and says so for a moment. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* clipboard blocked: the text is still on screen to select */ }
  };
  return (
    <Tooltip content={copied ? 'Copied' : label}>
      <IconButton type="button" size="1" variant="ghost" color={copied ? 'grass' : 'gray'} aria-label={copied ? 'Copied' : label} onClick={() => void copy()}>
        {copied ? <Check /> : <Copy />}
      </IconButton>
    </Tooltip>
  );
}
