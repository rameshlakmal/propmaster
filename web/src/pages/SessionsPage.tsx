import { AlertDialog, Badge, Box, Button, Card, Checkbox, DropdownMenu, Flex, Heading, IconButton, Select, Switch, Table, Text, TextField } from '@radix-ui/themes';
import { ArrowLeft, CaretLeft, CaretRight, DownloadSimple, ListChecks, MagnifyingGlass, Rows, Trash } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { api, downloadExport } from '../api';
import { EmptyState, ErrorCallout, PageHeader, RetryButton, TimelineSkeleton } from '../components/Feedback';
import { Timeline } from '../components/Timeline';
import { valueText } from '../components/Value';
import { formatWhen, toError, useLoad } from '../hooks';
import type { ApiError, Change, Recording, SessionPage, SessionSummary } from '../types';

const OPS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;

const PAGE_SIZE = 20;

/** "Page 2 of 5": the page numbers to offer, with gaps (null) when there are many. */
function pageNumbers(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const sorted = [...keep].sort((a, b) => a - b);
  return sorted.flatMap((n, i) => (i > 0 && n - sorted[i - 1]! > 1 ? [null, n] : [n]));
}

function SessionList({ activeProfile }: { activeProfile: string | null }) {
  const [page, setPage] = useState(1);
  const list = useLoad(() => api<SessionPage>('GET', `/sessions?page=${page}&pageSize=${PAGE_SIZE}`), [activeProfile, page], 5000);
  // Kept across pages, with each session's details for the confirmation.
  const [selected, setSelected] = useState<Map<string, SessionSummary>>(new Map());
  const [pending, setPending] = useState<SessionSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pages);
  const shown = list.data?.sessions ?? [];
  const deletable = shown.filter((s) => s.stoppedAt); // a session still recording can't be deleted
  const chosen = [...selected.values()];
  const allOnPage = deletable.length > 0 && deletable.every((s) => selected.has(s.id));

  // Deleting the last rows of the last page moves back a page.
  useEffect(() => { if (list.data && page > pages) setPage(pages); }, [list.data, page, pages]);

  const toggle = (s: SessionSummary) => setSelected((prev) => {
    const next = new Map(prev);
    if (next.has(s.id)) next.delete(s.id); else next.set(s.id, s);
    return next;
  });
  const togglePage = () => setSelected((prev) => {
    const next = new Map(prev);
    for (const s of deletable) if (allOnPage) next.delete(s.id); else next.set(s.id, s);
    return next;
  });

  const remove = async (targets: SessionSummary[]) => {
    setBusy(true);
    setError(null);
    const failed: string[] = [];
    for (const s of targets) {
      try { await api('DELETE', `/sessions/${encodeURIComponent(s.id)}`); } catch { failed.push(`#${s.id}`); }
    }
    setSelected((prev) => new Map([...prev].filter(([id]) => failed.includes(`#${id}`))));
    if (failed.length) setError({ message: `Could not delete ${failed.join(', ')}.`, hint: 'A session that is still recording must be stopped first.' });
    setPending(null);
    setBusy(false);
    await list.refresh();
  };

  if (list.error) return <Flex direction="column" gap="3"><ErrorCallout error={list.error} /><Box><RetryButton onClick={() => void list.refresh()} /></Box></Flex>;
  if (!list.data) return <TimelineSkeleton />;
  if (total === 0) {
    return (
      <EmptyState icon={<Rows size={32} />} title="No sessions yet" action={<Button onClick={() => { location.hash = 'record'; }}>Record a test</Button>}>
        Every recording you make appears here, for this database.
      </EmptyState>
    );
  }

  const changeTotal = (targets: SessionSummary[]) => targets.reduce((n, s) => n + s.changeCount, 0);

  return (
    <Flex direction="column" gap="3">
      <Flex justify="between" align="center" gap="3" wrap="wrap" minHeight="32px">
        <Text size="2" color="gray">
          {chosen.length > 0 ? `${chosen.length} selected` : `${total} ${total === 1 ? 'session' : 'sessions'}`}
        </Text>
        {chosen.length > 0 && (
          <Flex gap="2">
            <Button variant="soft" color="gray" onClick={() => setSelected(new Map())}>Clear selection</Button>
            <Button variant="soft" color="red" onClick={() => setPending(chosen)}><Trash /> Delete {chosen.length}</Button>
          </Flex>
        )}
      </Flex>
      {error && <ErrorCallout error={error} />}

      <Table.Root variant="surface">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell width="44px">
              <Checkbox checked={allOnPage} disabled={deletable.length === 0} onCheckedChange={togglePage} aria-label="Select every session on this page" />
            </Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell width="90px">Session</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Test case</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell width="170px">Started</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell width="110px" justify="end">Changes</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell width="130px">Mode</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell width="52px"><span className="sr-only">Delete</span></Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {shown.map((s) => (
            <Table.Row key={s.id} className="change-row" tabIndex={0} data-selected={selected.has(s.id) || undefined}
              onClick={() => { location.hash = `sessions/${s.id}`; }}
              onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) location.hash = `sessions/${s.id}`; }}>
              <Table.Cell onClick={(e) => e.stopPropagation()}>
                <Checkbox checked={selected.has(s.id)} disabled={!s.stoppedAt} onCheckedChange={() => toggle(s)} aria-label={`Select session #${s.id}`} />
              </Table.Cell>
              <Table.RowHeaderCell><Text className="mono" weight="medium">#{s.id}</Text></Table.RowHeaderCell>
              <Table.Cell><Text weight="medium">{s.name}</Text></Table.Cell>
              <Table.Cell><Text color="gray" size="2">{formatWhen(s.startedAt)}</Text></Table.Cell>
              <Table.Cell justify="end"><Text className="mono">{s.changeCount}</Text></Table.Cell>
              <Table.Cell>
                {s.stoppedAt ? <Text size="2" color="gray">{s.mode}</Text> : <Badge color="red" variant="soft"><span className="rec-dot" /> recording</Badge>}
              </Table.Cell>
              <Table.Cell onClick={(e) => e.stopPropagation()}>
                <IconButton size="1" variant="ghost" color="red" disabled={!s.stoppedAt} aria-label={`Delete session #${s.id}`}
                  title={s.stoppedAt ? 'Delete' : 'Stop the recording first'} onClick={() => setPending([s])}>
                  <Trash />
                </IconButton>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>

      {pages > 1 && (
        <Flex justify="between" align="center" gap="3" wrap="wrap">
          <Text size="2" color="gray">
            {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, total)} of {total}
          </Text>
          <Flex gap="1" align="center" asChild>
            <nav aria-label="Pages">
              <IconButton variant="soft" color="gray" disabled={current === 1} onClick={() => setPage(current - 1)} aria-label="Previous page"><CaretLeft /></IconButton>
              {pageNumbers(current, pages).map((n, i) => n === null
                ? <Text key={`gap-${i}`} color="gray" size="2" style={{ padding: "0 4px" }}>…</Text>
                : (
                  <Button key={n} variant={n === current ? 'solid' : 'soft'} color={n === current ? undefined : 'gray'} style={{ minWidth: 34 }}
                    aria-current={n === current ? 'page' : undefined} onClick={() => setPage(n)}>
                    {n}
                  </Button>
                ))}
              <IconButton variant="soft" color="gray" disabled={current === pages} onClick={() => setPage(current + 1)} aria-label="Next page"><CaretRight /></IconButton>
            </nav>
          </Flex>
        </Flex>
      )}

      <AlertDialog.Root open={pending !== null} onOpenChange={(open) => { if (!open && !busy) setPending(null); }}>
        <AlertDialog.Content maxWidth="440px">
          <AlertDialog.Title>
            {pending?.length === 1 ? `Delete session #${pending[0]!.id}?` : `Delete ${pending?.length ?? 0} sessions?`}
          </AlertDialog.Title>
          <AlertDialog.Description size="2">
            {pending?.length === 1
              ? `The recording of "${pending[0]!.name}" and its ${pending[0]!.changeCount} changes are removed.`
              : `These recordings and their ${changeTotal(pending ?? [])} changes are removed.`}
            {' '}Your app's data is not touched.
          </AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end">
            <AlertDialog.Cancel><Button variant="soft" color="gray" disabled={busy}>Cancel</Button></AlertDialog.Cancel>
            <Button color="red" loading={busy} onClick={() => void remove(pending ?? [])}>Delete</Button>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </Flex>
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

      {rec.summary.changes === 0 && rec.steps.every((st) => st.seq === 0 && st.markers.length === 0)
        ? <EmptyState icon={<Rows size={32} />} title="This session recorded no changes">Nothing in the watched tables changed while it was recording.</EmptyState>
        : <Timeline steps={steps.filter((s) => s.changes.length > 0 || (!search && table === 'all' && ops.size === OPS.length))} sessionId={id} onRenamed={() => void session.refresh()} />}
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

