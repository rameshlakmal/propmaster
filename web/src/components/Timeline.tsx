import { Badge, Box, Card, Flex, Heading, Table, Text } from '@radix-ui/themes';
import { Fragment, useState } from 'react';
import type { Change, Step } from '../types';

const SUMMARY_LIMIT = 48;

/** Long values are shortened in the row; the expanded row shows them in full. */
function short(value: string | null): string {
  if (value === null) return 'NULL';
  return value.length > SUMMARY_LIMIT ? `${value.slice(0, SUMMARY_LIMIT - 1)}…` : value;
}

function ChangeSummary({ change }: { change: Change }) {
  if (change.op === 'TRUNCATE') return <Text color="gray" size="2">every row removed</Text>;
  if (change.op === 'DELETE') {
    return change.key
      ? <Text color="gray" size="2">row removed</Text>
      : <Text className="mono value-before cell-wrap">{change.columns.map((c) => `${c.column}=${short(c.before)}`).join('  ')}</Text>;
  }
  if (change.op === 'UPDATE') {
    return (
      <Flex direction="column" gap="1">
        {change.columns.map((c) => (
          <Text key={c.column} className="mono">
            {c.column} <span className="value-before">{short(c.before)}</span> <span aria-hidden>→</span>
            <span className="sr-only"> changed to </span> <span className="value-after">{short(c.after)}</span>
          </Text>
        ))}
      </Flex>
    );
  }
  const keyCols = new Set((change.key ?? '').split(' ').map((p) => p.split('=')[0]));
  return (
    <Text className="mono cell-wrap" color="gray">
      {change.columns.filter((c) => !keyCols.has(c.column)).map((c) => `${c.column}=${short(c.after)}`).join('  ')}
    </Text>
  );
}

/** Every column of a change, before and after, for when a row is expanded. */
function ChangeDetail({ change }: { change: Change }) {
  const showBefore = change.op !== 'INSERT';
  const showAfter = change.op !== 'DELETE';
  return (
    <Box py="2">
      <Table.Root size="1" variant="ghost">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Column</Table.ColumnHeaderCell>
            {showBefore && <Table.ColumnHeaderCell>Before</Table.ColumnHeaderCell>}
            {showAfter && <Table.ColumnHeaderCell>After</Table.ColumnHeaderCell>}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {change.columns.map((c) => (
            <Table.Row key={c.column}>
              <Table.RowHeaderCell><Text weight="medium" size="2">{c.column}</Text></Table.RowHeaderCell>
              {showBefore && <Table.Cell className="mono cell-wrap value-before">{c.before}</Table.Cell>}
              {showAfter && <Table.Cell className={`mono cell-wrap ${c.changed ? 'value-after' : ''}`}>{c.after}</Table.Cell>}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      <Text as="p" size="1" color="gray" mt="2">
        {[change.dbUser && `DB user ${change.dbUser}`, change.appName && `app ${change.appName}`, new Date(change.changedAt).toLocaleTimeString()]
          .filter(Boolean).join(', ')}
      </Text>
    </Box>
  );
}

function StepTable({ step }: { step: Step }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Table.Root size="1" variant="surface">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeaderCell width="96px">Op</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell width="18%">Table</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell width="20%">Row</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Changes</Table.ColumnHeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {step.changes.map((change) => {
          const expanded = open === change.id;
          const toggle = () => setOpen(expanded ? null : change.id);
          return (
            <Fragment key={change.id}>
              <Table.Row
                className="change-row"
                tabIndex={0}
                aria-expanded={expanded}
                onClick={toggle}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
              >
                <Table.Cell><span className={`op op-${change.op}`}>{change.op.toLowerCase()}</span></Table.Cell>
                <Table.Cell><Text weight="medium" size="2">{change.table}</Text></Table.Cell>
                <Table.Cell className="mono cell-wrap">{change.key ?? <Text color="gray">no key</Text>}</Table.Cell>
                <Table.Cell><ChangeSummary change={change} /></Table.Cell>
              </Table.Row>
              {expanded && (
                <Table.Row className="change-detail">
                  <Table.Cell colSpan={4}><ChangeDetail change={change} /></Table.Cell>
                </Table.Row>
              )}
            </Fragment>
          );
        })}
      </Table.Body>
    </Table.Root>
  );
}

/** Steps with their changes. `currentSeq` highlights the step being recorded. */
export function Timeline({ steps, currentSeq }: { steps: Step[]; currentSeq?: number }) {
  const shown = steps.filter((s) => !(s.seq === 0 && s.changes.length === 0));
  return (
    <Flex direction="column" gap="5">
      {shown.map((step) => (
        <Card key={step.seq} size="2" className={step.seq === currentSeq ? 'step-current' : undefined}>
          <Flex justify="between" align="center" mb={step.changes.length ? '3' : '0'} gap="3" wrap="wrap">
            <Flex align="center" gap="3">
              <Badge color={step.seq === currentSeq ? 'cyan' : 'gray'} variant="soft" size="2">Step {step.seq}</Badge>
              <Heading as="h3" size="3" weight="medium">{step.name}</Heading>
              {step.seq === currentSeq && <Text size="1" color="cyan">now</Text>}
            </Flex>
            <Text size="2" color="gray">
              {step.changes.length === 1 ? '1 change' : `${step.changes.length} changes`}
            </Text>
          </Flex>
          {step.changes.length === 0
            ? <Text size="2" color="gray" mt="2" as="p">{step.seq === currentSeq ? 'Waiting for the app to change something…' : 'No database changes.'}</Text>
            : <StepTable step={step} />}
        </Card>
      ))}
    </Flex>
  );
}
