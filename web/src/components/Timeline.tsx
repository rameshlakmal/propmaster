import { Badge, Box, Button, Card, Flex, Heading, IconButton, Table, Text, TextField } from '@radix-ui/themes';
import { Flag, Pause, PencilSimple, Play } from '@phosphor-icons/react';
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { toError } from '../hooks';
import type { ApiError } from '../types';
import { Value } from './Value';
import type { Change, Marker, Step } from '../types';

/** How many fields an insert or delete shows before "+N more"; the expanded row has them all. */
const FIELD_LIMIT = 8;

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`field${wide ? ' field-wide' : ''}`}>
      <span className="field-label" title={label}>{label}</span>
      <span className="field-value">{children}</span>
    </div>
  );
}

/** One side of a changed JSON path: a number or string inline, an object or array as an indented block. */
function JsonPart({ text, className }: { text: string | null; className: string }) {
  if (text === null) return <span className="v-null">missing</span>;
  if (text.includes('\n')) return <pre className="v-json-block json-part" tabIndex={0}>{text}</pre>;
  return <span className={className}>{text}</span>;
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
        {change.columns.map((c) => c.beforeKind === 'json' || c.afterKind === 'json' ? (
          // What changed inside the JSON, path by path; the whole value before and after on request.
          <Field key={c.column} label={c.column} wide>
            {c.jsonChanges && c.jsonChanges.length > 0 && (
              <span className="json-changes">
                {c.jsonChanges.map((j) => (
                  <span key={j.path} className="json-change">
                    <span className="json-path">{j.path}</span>
                    <JsonPart text={j.before} className="was" />
                    <span className="arrow" aria-hidden>→</span>
                    <span className="sr-only"> changed to </span>
                    <JsonPart text={j.after} className="now" />
                  </span>
                ))}
              </span>
            )}
            <details className="json-full" onClick={(e) => e.stopPropagation()}>
              <summary>Full JSON before and after</summary>
              <span className="json-pair">
                <span className="json-pair-label">before</span>
                <Value sql={c.before} kind={c.beforeKind} />
                <span className="json-pair-label">after</span>
                <Value sql={c.after} kind={c.afterKind} />
              </span>
            </details>
          </Field>
        ) : (
          <Field key={c.column} label={c.column}>
            <span className="was"><Value sql={c.before} kind={c.beforeKind} max={32} other={c.after} /></span>
            <span className="arrow" aria-hidden>→</span>
            <span className="sr-only"> changed to </span>
            <span className="now"><Value sql={c.after} kind={c.afterKind} max={32} other={c.before} /></span>
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
        <Field key={c.column} label={c.column} wide={(removed ? c.beforeKind : c.afterKind) === 'json'}>
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
              {showBefore && <Table.Cell className={`cell-wrap ${c.changed && c.beforeKind !== 'json' ? 'was' : ''}`}><Value sql={c.before} kind={c.beforeKind} exact /></Table.Cell>}
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

/** A step's name, with a pencil to rename it. Enter saves, Escape cancels. */
function StepName({ step, sessionId, onRenamed }: { step: Step; sessionId?: string; onRenamed?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(step.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) input.current?.select(); }, [editing]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || name.trim() === step.name) { setEditing(false); return; }
    setBusy(true); setError(null);
    try {
      await api('PUT', `/sessions/${encodeURIComponent(sessionId!)}/steps/${step.seq}`, { name });
      setEditing(false);
      onRenamed?.();
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <Flex align="center" gap="1" minWidth="0">
        <Heading as="h3" size="3" weight="medium">{step.name}</Heading>
        {sessionId && (
          <IconButton size="1" variant="ghost" color="gray" className="rename-button" aria-label={`Rename step ${step.seq}`}
            onClick={() => { setName(step.name); setEditing(true); }}>
            <PencilSimple />
          </IconButton>
        )}
      </Flex>
    );
  }
  return (
    <form onSubmit={save} style={{ flex: 1, minWidth: 240 }}>
      <Flex gap="2" align="center">
        <Box flexGrow="1">
          <TextField.Root ref={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} aria-label={`New name for step ${step.seq}`}
            onKeyDown={(e) => { if (e.key === 'Escape') { setEditing(false); setError(null); } }} />
        </Box>
        <Button type="submit" size="2" loading={busy} disabled={!name.trim()}>Save</Button>
        <Button type="button" size="2" variant="soft" color="gray" onClick={() => { setEditing(false); setError(null); }}>Cancel</Button>
      </Flex>
      {error && <Text as="p" size="1" color="red" mt="1">{error.message}</Text>}
    </form>
  );
}

/**
 * Steps with their changes. `currentSeq` highlights the step being recorded. With `sessionId`, each
 * step name can be renamed; `onRenamed` is called after a rename so the caller can reload.
 */
export function Timeline({ steps, currentSeq, sessionId, onRenamed }: { steps: Step[]; currentSeq?: number; sessionId?: string; onRenamed?: () => void }) {
  const shown = steps.filter((s) => !(s.seq === 0 && s.changes.length === 0 && s.markers.length === 0));
  return (
    <Flex direction="column" gap="5">
      {shown.map((step) => (
        <Card key={step.seq} size="2" className={step.seq === currentSeq ? 'step-current' : undefined}>
          <Flex justify="between" align="center" mb={step.changes.length || step.markers.length ? '3' : '0'} gap="3" wrap="wrap">
            <Flex align="center" gap="3">
              <Badge color={step.seq === currentSeq ? 'cyan' : 'gray'} variant="soft" size="2">Step {step.seq}</Badge>
              <StepName key={step.seq} step={step} sessionId={sessionId} onRenamed={onRenamed} />
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
