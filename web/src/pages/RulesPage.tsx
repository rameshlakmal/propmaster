import { Badge, Box, Button, Card, Flex, Heading, Select, Switch, Table, Text, TextArea, TextField } from '@radix-ui/themes';
import { CheckCircle, FloppyDisk, FolderOpen, MinusCircle, Play, Warning, XCircle } from '@phosphor-icons/react';
import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorCallout, PageHeader } from '../components/Feedback';
import { formatWhen, toError, useLoad } from '../hooks';
import type { ApiError, RuleResult, RulesFile, SessionSummary } from '../types';

const STATUS = {
  pass: { icon: <CheckCircle size={18} weight="fill" color="var(--grass-9)" />, label: 'pass', color: 'grass' },
  fail: { icon: <XCircle size={18} weight="fill" color="var(--red-9)" />, label: 'fail', color: 'red' },
  skipped: { icon: <MinusCircle size={18} color="var(--gray-9)" />, label: 'nothing to check', color: 'gray' },
  error: { icon: <Warning size={18} weight="fill" color="var(--amber-9)" />, label: 'could not run', color: 'amber' },
} as const;

function show(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function scopeText(scope: Record<string, number>): string {
  const parts = Object.entries(scope).map(([t, n]) => `${n} ${n === 1 ? 'row' : 'rows'} of ${t.replace(/^public\./, '')}`);
  return parts.join(', ') || 'whole query';
}

function Results({ results, allRows }: { results: RuleResult[]; allRows: boolean }) {
  const [open, setOpen] = useState<string | null>(results.find((r) => r.status === 'fail')?.rule.name ?? null);
  const count = (s: RuleResult['status']) => results.filter((r) => r.status === s).length;
  return (
    <Box>
      <Flex gap="2" mb="3" wrap="wrap">
        <Badge color="grass" size="2">{count('pass')} passed</Badge>
        <Badge color="red" size="2">{count('fail')} failed</Badge>
        {count('skipped') > 0 && <Badge color="gray" size="2">{count('skipped')} skipped</Badge>}
        {count('error') > 0 && <Badge color="amber" size="2">{count('error')} could not run</Badge>}
      </Flex>
      <Table.Root variant="surface">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell width="44px"><span className="sr-only">Result</span></Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Rule</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell width="28%">Checked</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell width="150px">Result</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {results.map((r) => {
            const s = STATUS[r.status];
            const expandable = r.status === 'fail' || r.status === 'error';
            const expanded = open === r.rule.name;
            const toggle = () => expandable && setOpen(expanded ? null : r.rule.name);
            const headers = Object.keys(r.violations[0] ?? {});
            return (
              <Fragment key={r.rule.name}>
                <Table.Row className={expandable ? 'change-row' : undefined} tabIndex={expandable ? 0 : undefined}
                  aria-expanded={expandable ? expanded : undefined} onClick={toggle}
                  onKeyDown={(e) => { if (e.key === 'Enter') toggle(); }}>
                  <Table.Cell>{s.icon}</Table.Cell>
                  <Table.RowHeaderCell><Text weight={r.status === 'fail' ? 'bold' : 'regular'}>{r.rule.name}</Text></Table.RowHeaderCell>
                  <Table.Cell><Text size="2" color="gray">{r.status === 'error' ? ''
                    : allRows ? 'whole tables'
                    : r.status === 'skipped' ? `no ${Object.keys(r.scope).map((t) => t.replace(/^public\./, '')).join(' or ')} rows touched`
                    : scopeText(r.scope)}</Text></Table.Cell>
                  <Table.Cell>
                    <Text size="2" color={s.color} weight="medium">
                      {r.status === 'fail' ? `${r.violationCount} ${r.violationCount === 1 ? 'violation' : 'violations'}` : s.label}
                    </Text>
                  </Table.Cell>
                </Table.Row>
                {expanded && (
                  <Table.Row className="change-detail">
                    <Table.Cell colSpan={4}>
                      {r.status === 'error' ? (
                        <Text size="2" color="amber">Line {r.rule.line}: {r.error}</Text>
                      ) : (
                        <Box py="1">
                          <Text as="p" size="2" color="gray" mb="2">Rows that break this rule:</Text>
                          <Table.Root size="1" variant="ghost">
                            <Table.Header>
                              <Table.Row>{headers.map((h) => <Table.ColumnHeaderCell key={h}>{h}</Table.ColumnHeaderCell>)}</Table.Row>
                            </Table.Header>
                            <Table.Body>
                              {r.violations.map((v, i) => (
                                <Table.Row key={i}>{headers.map((h) => <Table.Cell key={h} className="mono">{show(v[h])}</Table.Cell>)}</Table.Row>
                              ))}
                            </Table.Body>
                          </Table.Root>
                          {r.violationCount > r.violations.length && (
                            <Text as="p" size="1" color="gray" mt="2">…and {r.violationCount - r.violations.length} more</Text>
                          )}
                        </Box>
                      )}
                    </Table.Cell>
                  </Table.Row>
                )}
              </Fragment>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}

export function RulesPage({ activeProfile }: { activeProfile: string | null }) {
  const file = useLoad(() => api<RulesFile>('GET', '/rules'), [activeProfile]);
  const sessions = useLoad(() => api<SessionSummary[]>('GET', '/sessions'), [activeProfile]);
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [sessionId, setSessionId] = useState<string>(() => sessionStorage.getItem('propmaster-rules-session') ?? '');
  const [allRows, setAllRows] = useState(false);
  const [busy, setBusy] = useState<'open' | 'save' | 'run' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [results, setResults] = useState<{ results: RuleResult[]; allRows: boolean } | null>(null);

  useEffect(() => {
    if (!file.data) return;
    setPath(file.data.path);
    setContent(file.data.content);
    setDirty(false);
  }, [file.data]);

  useEffect(() => {
    if (!sessionId && sessions.data?.[0]) setSessionId(sessions.data[0].id);
  }, [sessions.data, sessionId]);

  const act = async (kind: 'open' | 'save' | 'run', fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try { await fn(); } catch (err) { setError(toError(err)); } finally { setBusy(null); }
  };
  const open = () => act('open', async () => { await api('PUT', '/rules', { path }); await file.refresh(); });
  const save = () => act('save', async () => { await api('PUT', '/rules', { path, content }); await file.refresh(); });
  const run = () => act('run', async () => {
    if (dirty) await api('PUT', '/rules', { path, content });
    const res = await api<{ results: RuleResult[] }>('POST', '/rules/check', { sessionId, allRows });
    setResults({ results: res.results, allRows });
    sessionStorage.removeItem('propmaster-rules-session');
  });

  return (
    <Box>
      <PageHeader title="Rules" description="Business rules are SQL queries that return the rows breaking them. {{orders}} means the orders rows a session touched." />

      {error && <Box mb="4"><ErrorCallout error={error} /></Box>}

      <Card size="3" mb="5">
        <Heading as="h2" size="3" mb="3">Check a session</Heading>
        <Flex gap="3" align="end" wrap="wrap">
          <Flex direction="column" gap="2" flexGrow="1" minWidth="260px">
            <Text as="label" size="2" weight="medium" htmlFor="rules-session">Session</Text>
            <Select.Root value={sessionId || undefined} onValueChange={setSessionId} disabled={allRows || !sessions.data?.length}>
              <Select.Trigger id="rules-session" placeholder={sessions.data?.length ? 'Choose a session' : 'No sessions yet'} />
              <Select.Content position="popper">
                {sessions.data?.map((s) => (
                  <Select.Item key={s.id} value={s.id}>#{s.id} {s.name} ({formatWhen(s.startedAt)})</Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>
          <Text as="label" size="2">
            <Flex gap="2" align="center" pb="2">
              <Switch checked={allRows} onCheckedChange={setAllRows} /> Whole tables instead
            </Flex>
          </Text>
          <Button size="3" onClick={() => void run()} loading={busy === 'run'} disabled={!file.data?.path || (!allRows && !sessionId)} className="press">
            <Play weight="fill" /> Run rules
          </Button>
        </Flex>
        {results && <Box mt="5"><Results results={results.results} allRows={results.allRows} /></Box>}
      </Card>

      <Card size="3" className="rules-editor">
        <Flex justify="between" align="center" mb="3" gap="3" wrap="wrap">
          <Heading as="h2" size="3">Rules file</Heading>
          {file.data?.rules.length ? <Text size="2" color="gray">{file.data.rules.length} rules</Text> : null}
        </Flex>
        <Flex gap="2" mb="3" wrap="wrap">
          <Box flexGrow="1" minWidth="280px">
            <TextField.Root value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\path\to\rules.sql" aria-label="Rules file path" className="mono" />
          </Box>
          <Button variant="soft" onClick={() => void open()} loading={busy === 'open'} disabled={!path}><FolderOpen /> Open</Button>
          <Button variant="soft" onClick={() => void save()} loading={busy === 'save'} disabled={!path || !dirty}><FloppyDisk /> Save</Button>
        </Flex>
        {file.data?.error && <Box mb="3"><ErrorCallout error={{ message: file.data.error }} /></Box>}
        <TextArea value={content} onChange={(e) => { setContent(e.target.value); setDirty(true); }} rows={18} spellCheck={false}
          aria-label="Rules" placeholder={'-- rule: Payment matches the order total\nSELECT p.order_id, p.amount, o.total\n  FROM {{payments}} p JOIN orders o ON o.id = p.order_id\n WHERE p.amount <> o.total;'} />
        <Text as="p" size="1" color="gray" mt="2">
          Each rule starts with a line "-- rule: name". Rules run read-only, one statement each, with a 30 second limit.
        </Text>
      </Card>
    </Box>
  );
}
