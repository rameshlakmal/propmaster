import { AlertDialog, Badge, Box, Button, Card, DropdownMenu, Flex, Heading, Select, Switch, Table, Text, TextField } from '@radix-ui/themes';
import { ArrowLeft, DownloadSimple, ListChecks, MagnifyingGlass, Rows, Trash } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { api, downloadExport } from '../api';
import { EmptyState, ErrorCallout, PageHeader, RetryButton, TimelineSkeleton } from '../components/Feedback';
import { Timeline } from '../components/Timeline';
import { valueText } from '../components/Value';
import { formatWhen, toError, useLoad } from '../hooks';
import type { ApiError, Change, Recording, SessionSummary } from '../types';

const OPS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;

function SessionList({ activeProfile }: { activeProfile: string | null }) {
  const list = useLoad(() => api<SessionSummary[]>('GET', '/sessions'), [activeProfile], 5000);

  if (list.error) return <Flex direction="column" gap="3"><ErrorCallout error={list.error} /><Box><RetryButton onClick={() => void list.refresh()} /></Box></Flex>;
  if (!list.data) return <TimelineSkeleton />;
  if (list.data.length === 0) {
    return (
      <EmptyState icon={<Rows size={32} />} title="No sessions yet" action={<Button onClick={() => { location.hash = 'record'; }}>Record a test</Button>}>
        Every recording you make appears here, for this database.
      </EmptyState>
    );
  }
  return (
    <Table.Root variant="surface">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeaderCell width="90px">Session</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Test case</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell width="170px">Started</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell width="110px" justify="end">Changes</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell width="130px">Mode</Table.ColumnHeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {list.data.map((s) => (
          <Table.Row key={s.id} className="change-row" tabIndex={0}
            onClick={() => { location.hash = `sessions/${s.id}`; }}
            onKeyDown={(e) => { if (e.key === 'Enter') location.hash = `sessions/${s.id}`; }}>
            <Table.RowHeaderCell><Text className="mono" weight="medium">#{s.id}</Text></Table.RowHeaderCell>
            <Table.Cell><Text weight="medium">{s.name}</Text></Table.Cell>
            <Table.Cell><Text color="gray" size="2">{formatWhen(s.startedAt)}</Text></Table.Cell>
            <Table.Cell justify="end"><Text className="mono">{s.changeCount}</Text></Table.Cell>
            <Table.Cell>
              {s.stoppedAt ? <Text size="2" color="gray">{s.mode}</Text> : <Badge color="red" variant="soft"><span className="rec-dot" /> recording</Badge>}
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}

function matches(change: Change, text: string): boolean {
  if (!text) return true;
  const hay = [change.table, change.key ?? '', ...change.columns.flatMap((c) => [c.column, valueText(c.before), valueText(c.after)])].join(' ').toLowerCase();
  return hay.includes(text.toLowerCase());
}

function SessionDetail({ id }: { id: string }) {
  const session = useLoad(() => api<Recording>('GET', `/sessions/${id}`), [id]);
  const [search, setSearch] = useState('');
  const [ops, setOps] = useState<Set<string>>(new Set(OPS));
  const [table, setTable] = useState('all');
  const [masked, setMasked] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const tables = useMemo(() => [...new Set(session.data?.steps.flatMap((s) => s.changes.map((c) => c.table)) ?? [])].sort(), [session.data]);
  const steps = useMemo(() => session.data?.steps.map((s) => ({
    ...s,
    changes: s.changes.filter((c) => ops.has(c.op) && (table === 'all' || c.table === table) && matches(c, search)),
  })) ?? [], [session.data, ops, table, search]);
  const shownCount = steps.reduce((n, s) => n + s.changes.length, 0);

  const download = async (format: 'html' | 'md' | 'sql') => {
    setError(null);
    try { await downloadExport(id, format, masked); } catch (err) { setError(toError(err)); }
  };
  const remove = async () => {
    try {
      await api('DELETE', `/sessions/${id}`);
      location.hash = 'sessions';
    } catch (err) {
      setError(toError(err));
    }
  };
  const checkRules = () => {
    sessionStorage.setItem('propmaster-rules-session', id);
    location.hash = 'rules';
  };

  if (session.error) return <ErrorCallout error={session.error} />;
  if (!session.data) return <TimelineSkeleton />;
  const rec = session.data;
  const toggleOp = (op: string) => setOps((prev) => {
    const next = new Set(prev);
    if (next.has(op)) next.delete(op); else next.add(op);
    return next;
  });

  return (
    <Box>
      <Button variant="ghost" color="gray" mb="4" onClick={() => { location.hash = 'sessions'; }}>
        <ArrowLeft /> All sessions
      </Button>
      <PageHeader
        title={rec.name}
        description={`Session #${rec.id} on ${rec.database}, ${formatWhen(rec.startedAt)}${rec.mode === 'snapshot' ? ', snapshot mode' : ''}`}
        actions={<>
          <Button variant="soft" onClick={checkRules}><ListChecks /> Check rules</Button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Button variant="soft"><DownloadSimple /> Export <DropdownMenu.TriggerIcon /></Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              <DropdownMenu.Item onSelect={() => void download('html')}>HTML report</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void download('md')}>Markdown (Jira, GitHub)</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => void download('sql')}>SQL checks</DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Label>
                <Flex as="span" align="center" gap="2">
                  <Switch size="1" checked={masked} onCheckedChange={setMasked} aria-label="Hide sensitive values" /> Hide sensitive values
                </Flex>
              </DropdownMenu.Label>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
          <AlertDialog.Root>
            <AlertDialog.Trigger>
              <Button variant="soft" color="red" disabled={!rec.stoppedAt}><Trash /> Delete</Button>
            </AlertDialog.Trigger>
            <AlertDialog.Content maxWidth="420px">
              <AlertDialog.Title>Delete session #{rec.id}?</AlertDialog.Title>
              <AlertDialog.Description size="2">
                The recording of "{rec.name}" and its {rec.summary.changes} changes are removed. Your app's data is not touched.
              </AlertDialog.Description>
              <Flex gap="3" mt="4" justify="end">
                <AlertDialog.Cancel><Button variant="soft" color="gray">Cancel</Button></AlertDialog.Cancel>
                <AlertDialog.Action><Button color="red" onClick={() => void remove()}>Delete</Button></AlertDialog.Action>
              </Flex>
            </AlertDialog.Content>
          </AlertDialog.Root>
        </>}
      />

      {error && <Box mb="4"><ErrorCallout error={error} /></Box>}
      {rec.notes.map((n) => <Text key={n} as="p" size="2" color="amber" mb="2">{n}</Text>)}

      <Card size="2" mb="5">
        <Flex gap="3" align="center" wrap="wrap">
          <Box flexGrow="1" minWidth="220px">
            <TextField.Root value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tables, keys and values" aria-label="Search changes">
              <TextField.Slot><MagnifyingGlass /></TextField.Slot>
            </TextField.Root>
          </Box>
          <Select.Root value={table} onValueChange={setTable}>
            <Select.Trigger aria-label="Table" style={{ minWidth: 170 }} />
            <Select.Content>
              <Select.Item value="all">All tables</Select.Item>
              {tables.map((t) => <Select.Item key={t} value={t}>{t}</Select.Item>)}
            </Select.Content>
          </Select.Root>
          <Flex gap="2" role="group" aria-label="Operations">
            {OPS.filter((op) => rec.summary.byOp[op]).map((op) => (
              <Button key={op} size="1" variant={ops.has(op) ? 'soft' : 'outline'} color={ops.has(op) ? undefined : 'gray'}
                aria-pressed={ops.has(op)} onClick={() => toggleOp(op)}>
                {op.toLowerCase()} {rec.summary.byOp[op]}
              </Button>
            ))}
          </Flex>
        </Flex>
        <Text as="p" size="1" color="gray" mt="2">
          {shownCount === rec.summary.changes
            ? `${rec.summary.changes} changes across ${rec.summary.tables} tables`
            : `Showing ${shownCount} of ${rec.summary.changes} changes`}
        </Text>
      </Card>

      {rec.summary.changes === 0
        ? <EmptyState icon={<Rows size={32} />} title="This session recorded no changes">Nothing in the watched tables changed while it was recording.</EmptyState>
        : <Timeline steps={steps.filter((s) => s.changes.length > 0 || (!search && table === 'all' && ops.size === OPS.length))} />}
    </Box>
  );
}

export function SessionsPage({ selectedId, activeProfile }: { selectedId?: string; activeProfile: string | null }) {
  if (selectedId) return <SessionDetail id={selectedId} />;
  return (
    <Box>
      <PageHeader title="Sessions" description="Everything you have recorded on this database. Open one to see its timeline, export it or check rules." />
      <SessionList activeProfile={activeProfile} />
    </Box>
  );
}

