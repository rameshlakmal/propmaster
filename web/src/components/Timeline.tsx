import { Badge, Box, Card, Flex, Heading, Table, Text } from '@radix-ui/themes';
import { Flag, Pause, Play } from '@phosphor-icons/react';
import { Fragment, useState, type ReactNode } from 'react';
import { Value } from './Value';
import type { Change, Marker, Step } from '../types';

/** How many fields an insert or delete shows before "+N more"; the expanded row has them all. */
const FIELD_LIMIT = 8;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label" title={label}>{label}</span>
      <span className="field-value">{children}</span>
    </div>
  );
}

/** "id=66 sku='A1'" → the key column names, so inserts don't repeat what the Row column shows. */
function keyColumns(change: Change): Set<string> {
  return new Set((change.key ?? '').split(' ').map((p) => p.split('=')[0]!).filter(Boolean));
}

/**
 * What a change did, laid out as labelled fields: new values for an insert, old → new for an update,
 * the removed values for a delete.
 */
function ChangeSummary({ change }: { change: Change }) {
  if (change.op === 'TRUNCATE') return <Text color="gray" size="2">Every row in the table was removed.</Text>;

  if (change.op === 'UPDATE') {
    return (
      <div className="fields fields-wide">
        {change.columns.map((c) => (
          <Field key={c.column} label={c.column}>
            <span className="was"><Value sql={c.before} kind={c.beforeKind} max={32} /></span>
            <span className="arrow" aria-hidden>→</span>
            <span className="sr-only"> changed to </span>
            <span className="now"><Value sql={c.after} kind={c.afterKind} max={32} /></span>
          </Field>
        ))}
      </div>
    );
  }

  const removed = change.op === 'DELETE';
  const keys = keyColumns(change);
  const columns = change.columns.filter((c) => !keys.has(c.column));
  if (columns.length === 0) return <Text color="gray" size="2">{removed ? 'Row removed.' : 'Only the key columns.'}</Text>;
  const shown = columns.slice(0, FIELD_LIMIT);
  return (
    <div className={`fields${removed ? ' fields-removed' : ''}`}>
      {removed && <span className="fields-note">Row removed. It held:</span>}
      {shown.map((c) => (
        <Field key={c.column} label={c.column}>
          {removed ? <Value sql={c.before} kind={c.beforeKind} max={40} /> : <Value sql={c.after} kind={c.afterKind} max={40} />}
        </Field>
      ))}
      {columns.length > shown.length && <span className="fields-note">+{columns.length - shown.length} more · open the row to see every column</span>}
    </div>
  );
}

/** Every column of a change, before and after, exactly as stored, for when a row is expanded. */
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
              {showBefore && <Table.Cell className={`cell-wrap ${c.changed ? 'was' : ''}`}><Value sql={c.before} kind={c.beforeKind} exact /></Table.Cell>}
              {showAfter && <Table.Cell className={`cell-wrap ${c.changed ? 'now' : ''}`}><Value sql={c.after} kind={c.afterKind} exact /></Table.Cell>}
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
    <Table.Root size="1" variant="surface" className="step-table">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeaderCell width="96px">Op</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell width="16%">Table</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell width="14%">Row</Table.ColumnHeaderCell>
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

const MARKER = {
  pause: { icon: <Pause weight="fill" size={14} />, label: 'Paused' },
  resume: { icon: <Play weight="fill" size={14} />, label: 'Resumed' },
  flag: { icon: <Flag weight="fill" size={14} />, label: 'Flagged' },
} as const;

/** Pauses, resumes and flags in a step: flags stand out, pauses are quiet. */
function Markers({ markers }: { markers: Marker[] }) {
  return (
    <Flex direction="column" gap="1" mb="3" asChild>
      <ul className="markers">
        {markers.map((m, i) => (
          <li key={i} className={`marker marker-${m.kind}`}>
            {MARKER[m.kind].icon}
            <Text size="2" weight={m.kind === 'flag' ? 'medium' : 'regular'}>{MARKER[m.kind].label}</Text>
            <Text size="1" color="gray" className="mono">{new Date(m.at).toLocaleTimeString()}</Text>
            {m.note && <Text size="2">{m.note}</Text>}
          </li>
        ))}
      </ul>
    </Flex>
  );
}

/** Steps with their changes. `currentSeq` highlights the step being recorded. */
export function Timeline({ steps, currentSeq }: { steps: Step[]; currentSeq?: number }) {
  const shown = steps.filter((s) => !(s.seq === 0 && s.changes.length === 0 && s.markers.length === 0));
  return (
    <Flex direction="column" gap="5">
      {shown.map((step) => (
        <Card key={step.seq} size="2" className={step.seq === currentSeq ? 'step-current' : undefined}>
          <Flex justify="between" align="center" mb={step.changes.length || step.markers.length ? '3' : '0'} gap="3" wrap="wrap">
            <Flex align="center" gap="3">
              <Badge color={step.seq === currentSeq ? 'cyan' : 'gray'} variant="soft" size="2">Step {step.seq}</Badge>
              <Heading as="h3" size="3" weight="medium">{step.name}</Heading>
              {step.auto && <Badge color="gray" variant="outline" title="Named by Propmaster from its changes">auto</Badge>}
              {step.seq === currentSeq && <Text size="1" color="cyan">now</Text>}
              {step.markers.some((m) => m.kind === 'flag') && <Badge color="amber" variant="soft"><Flag weight="fill" size={12} /> flagged</Badge>}
            </Flex>
            <Text size="2" color="gray">
              {step.changes.length === 1 ? '1 change' : `${step.changes.length} changes`}
            </Text>
          </Flex>
          {step.markers.length > 0 && <Markers markers={step.markers} />}
          {step.changes.length === 0
            ? <Text size="2" color="gray" mt="2" as="p">{step.seq === currentSeq ? 'Waiting for the app to change something…' : 'No database changes.'}</Text>
            : <StepTable step={step} />}
        </Card>
      ))}
    </Flex>
  );
}
