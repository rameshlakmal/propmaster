// A clean, from its preview to done: what will change, what blocks it, and the button to do it.
// Used on the Seed & clean page and by "Finish test" on the home page.
import { Badge, Box, Button, Card, Checkbox, Flex, Heading, Table, Text } from '@radix-ui/themes';
import { ArrowCounterClockwise, Broom, Warning, XCircle } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { toError } from '../hooks';
import type { ApiError, CleanAction, CleanResult, Row } from '../types';
import { CopyButton, ErrorCallout } from './Feedback';

const short = (table: string) => table.replace(/^public\./, '');

function show(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

const keyText = (key: Row | null) => (key ? Object.entries(key).map(([k, v]) => `${k}=${show(v)}`).join(' ') : '–');

// ---------- cleaning ----------

const VERB: Record<CleanAction['op'], { label: string; color: 'red' | 'cyan' | 'violet' }> = {
  delete: { label: 'delete', color: 'red' }, update: { label: 'put back', color: 'cyan' }, insert: { label: 're-insert', color: 'violet' },
};

function note(a: CleanAction): string {
  const diffs = (list: { column: string; from: unknown; to: unknown }[]) => list.map((d) => `${d.column} ${show(d.from)} → ${show(d.to)}`).join(', ');
  if (a.why === 'dependent') return `Not created by it: points at a row being deleted (${a.via})`;
  if (a.op === 'delete' && a.why === 'seeded') return a.changed.length ? `Changed since seeding: ${diffs(a.changed)}` : '';
  if (a.op === 'delete') return 'Inserted during the session';
  if (a.op === 'update') return diffs(Object.keys(a.set).map((k) => ({ column: k, from: a.current[k], to: a.set[k] })));
  return 'Deleted during the session';
}

export type CleanTarget = { runIds?: string[]; sessionId?: string; file?: string; label: string };

/** A clean, from its preview to done: what will change, what blocks it, and the button to do it. */
export function CleanPanel({ target, onDone, onClose, onRestore }: { target: CleanTarget; onDone: () => void; onClose: () => void; onRestore: (file: string) => void }) {
  const [result, setResult] = useState<CleanResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [includeDependents, setIncludeDependents] = useState(false);
  const [force, setForce] = useState(false);

  const call = (apply: boolean) => target.file
    ? api<CleanResult>('POST', '/restore', { file: target.file, apply, includeDependents, force })
    : api<CleanResult>('POST', '/clean', { runIds: target.runIds, sessionId: target.sessionId, apply, includeDependents, force });

  useEffect(() => {
    setResult(null); setError(null); setIncludeDependents(false); setForce(false);
    // Clicking another run before this preview arrives must not show this one's plan under the other's button.
    let live = true;
    call(false).then((r) => { if (live) setResult(r); }, (err) => { if (live) setError(toError(err)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try { setResult(await call(true)); onDone(); } catch (err) { setError(toError(err)); } finally { setBusy(false); }
  };

  const plan = result?.plan;
  const dependents = plan?.actions.filter((a) => a.why === 'dependent').length ?? 0;
  const claimedKeys = new Set(plan?.claimed.map((c) => `${c.table}|${keyText(c.key)}`));
  const counts = plan ? (['delete', 'update', 'insert'] as const).map((op) => [op, plan.actions.filter((a) => a.op === op).length] as const).filter(([, n]) => n > 0) : [];
  const blocked = Boolean(plan && (plan.unkeyedDependents.length || (dependents && !includeDependents) || (plan.claimed.length && !force)));

  return (
    <Card size="3" className="clean-panel">
      <Flex justify="between" align="start" gap="3" mb="3" wrap="wrap">
        <Box>
          <Heading as="h3" size="3">{plan?.title ?? target.label}</Heading>
          <Text size="2" color={result?.applied ? 'grass' : 'gray'}>{result?.applied ? 'Done, in one transaction.' : 'Preview: nothing has been changed yet.'}</Text>
        </Box>
        <Button variant="ghost" color="gray" onClick={onClose}>Close</Button>
      </Flex>
      {error && <Box mb="3"><ErrorCallout error={error} /></Box>}
      {!plan && !error && <Text size="2" color="gray">Working out what would change…</Text>}
      {plan && (
        <Flex direction="column" gap="3">
          {plan.actions.length === 0 ? <Text size="2" color="gray">Nothing to change.</Text> : (
            <Table.Root variant="surface" size="1" className="tall-table">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell width="100px">Action</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Table</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Row</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Note</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {plan.actions.map((a, i) => {
                  const claim = plan.claimed.find((c) => c.table === a.table && keyText(c.key) === keyText(a.key));
                  return (
                    <Table.Row key={i} className={a.why === 'dependent' || claimedKeys.has(`${a.table}|${keyText(a.key)}`) ? 'row-warn' : undefined}>
                      <Table.Cell><Badge color={VERB[a.op].color} variant="soft">{VERB[a.op].label}</Badge></Table.Cell>
                      <Table.Cell>{short(a.table)}</Table.Cell>
                      <Table.Cell className="mono">{keyText(a.key)}</Table.Cell>
                      <Table.Cell>
                        <Text size="1" color={a.why === 'dependent' ? 'amber' : 'gray'}>{note(a) || '–'}</Text>
                        {claim && <Text as="div" size="1" color="amber">Claimed by {claim.claim.claimedBy} (#{claim.claim.id})</Text>}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          )}

          {plan.skipped.length > 0 && (
            <Box>
              <Text as="p" size="2" weight="medium" mb="1">Left alone</Text>
              {plan.skipped.map((s, i) => (
                <Text as="p" key={i} size="1" color={s.reason === 'gone' ? 'gray' : 'amber'}>
                  {short(s.table)} {s.key ? keyText(s.key) : ''} · {s.detail}
                </Text>
              ))}
            </Box>
          )}

          {!result.applied && (
            <Flex direction="column" gap="2">
              {plan.unkeyedDependents.map((u) => (
                <Text key={u.via} size="2" color="red"><XCircle /> {u.count} rows of {short(u.table)} point at rows being deleted ({u.via}), but that table has no primary key: delete or re-point them first.</Text>
              ))}
              {dependents > 0 && (
                <Text as="label" size="2">
                  <Flex gap="2" align="start">
                    <Checkbox checked={includeDependents} onCheckedChange={(v) => setIncludeDependents(v === true)} />
                    <span><Warning color="var(--amber-9)" /> Also delete the {dependents} {dependents === 1 ? 'row' : 'rows'} that weren't created by it but point at rows being deleted.</span>
                  </Flex>
                </Text>
              )}
              {plan.claimed.length > 0 && (
                <Text as="label" size="2">
                  <Flex gap="2" align="start">
                    <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
                    <span><Warning color="var(--amber-9)" /> Clean anyway, although {plan.claimed.length === 1 ? 'a row is' : `${plan.claimed.length} rows are`} claimed by someone else.</span>
                  </Flex>
                </Text>
              )}
              {plan.actions.length > 0 && (
                <Flex gap="3" align="center" wrap="wrap">
                  <Button color="red" onClick={() => void apply()} loading={busy} disabled={blocked} className="press">
                    <Broom /> {counts.map(([op, n]) => `${VERB[op].label.replace(/^./, (c) => c.toUpperCase())} ${n}`).join(', ')}
                  </Button>
                  <Text size="1" color="gray">One transaction. A backup is saved first, so it can be undone.</Text>
                </Flex>
              )}
            </Flex>
          )}

          {result.applied && (
            <Flex direction="column" gap="2">
              {result.releasedClaims > 0 && <Text size="2">Released {result.releasedClaims} claims on deleted rows.</Text>}
              {result.backup && (
                <Flex gap="3" align="center" wrap="wrap">
                  <Text size="1" color="gray" className="mono">Backup: {result.backup}</Text>
                  <CopyButton text={result.backup} label="Copy the backup path" />
                  <Button size="1" variant="soft" onClick={() => onRestore(result.backup!)}><ArrowCounterClockwise /> Undo this…</Button>
                </Flex>
              )}
            </Flex>
          )}
        </Flex>
      )}
    </Card>
  );
}

