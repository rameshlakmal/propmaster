import { Badge, Box, Button, Card, Checkbox, Flex, Heading, Select, Switch, Table, Text, TextField } from '@radix-ui/themes';
import { ArrowCounterClockwise, Broom, CheckCircle, FolderOpen, MagnifyingGlass, Plant, Stethoscope, Warning, XCircle } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { CopyButton, EmptyState, ErrorCallout, PageHeader } from '../components/Feedback';
import { formatWhen, toError, useLoad } from '../hooks';
import type { ApiError, BackupInfo, CleanAction, CleanResult, Row, Run, Scenario, ScenarioCheck, ScenariosSource, SeedResult, SessionPage } from '../types';

const short = (table: string) => table.replace(/^public\./, '');

function show(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

const keyText = (key: Row | null) => (key ? Object.entries(key).map(([k, v]) => `${k}=${show(v)}`).join(' ') : '–');
const pairs = (row: Row, skip: Row) => Object.entries(row).filter(([k]) => !(k in skip)).map(([k, v]) => `${k}=${show(v)}`).join('  ');

const INPUT_TYPE: Partial<Record<Scenario['params'][number]['type'], 'number' | 'date'>> = { int: 'number', bigint: 'number', numeric: 'number', date: 'date' };

function matches(s: Scenario, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [s.name, s.id, s.description, ...s.tags].join(' ').toLowerCase();
  return words.every((w) => haystack.includes(w));
}

function ScenarioList({ scenarios, selected, onSelect }: { scenarios: Scenario[]; selected: string | null; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const shown = scenarios.filter((s) => matches(s, query));
  return (
    <Flex direction="column" gap="3">
      <TextField.Root value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search scenarios and #tags" aria-label="Search scenarios">
        <TextField.Slot><MagnifyingGlass /></TextField.Slot>
      </TextField.Root>
      <div className="recipe-list" role="listbox" aria-label="Scenarios">
        {shown.map((s) => (
          <button key={s.id} type="button" role="option" aria-selected={s.id === selected} className="recipe-item" onClick={() => onSelect(s.id)}>
            <Text as="div" size="2" weight="medium">{s.name}</Text>
            {s.description && <Text as="div" size="1" color="gray" className="recipe-description">{s.description}</Text>}
            <Flex gap="1" wrap="wrap" mt="1">
              {s.tags.map((t) => <Badge key={t} size="1" variant="soft" color="gray">#{t}</Badge>)}
              <Badge size="1" variant="soft" color="violet">{s.tables.map(short).join(', ')}</Badge>
            </Flex>
          </button>
        ))}
        {shown.length === 0 && <Text size="2" color="gray">No scenario matches "{query}".</Text>}
      </div>
    </Flex>
  );
}

function SeededRows({ result }: { result: SeedResult }) {
  return (
    <Table.Root variant="surface" size="1" className="tall-table">
      <Table.Header>
        <Table.Row>
          <Table.ColumnHeaderCell width="40px">#</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Table</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Key</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>Values</Table.ColumnHeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {result.rows.map((r) => (
          <Table.Row key={r.seq}>
            <Table.Cell><Text size="1" color="gray">{r.seq}</Text></Table.Cell>
            <Table.Cell>
              <Text size="2">{short(r.table)}</Text>
              {r.alias && <Badge size="1" ml="2" variant="soft" color="violet">{r.alias}</Badge>}
              {r.auto && <Text as="div" size="1" color="gray">made for a required link</Text>}
            </Table.Cell>
            <Table.Cell className="mono">{keyText(r.key)}</Table.Cell>
            <Table.Cell className="mono"><Text size="1" color="gray">{pairs(r.values, r.key)}</Text></Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}

function ScenarioPanel({ scenario, onSeeded, onClean }: { scenario: Scenario; onSeeded: () => void; onClean: (runId: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'seed' | 'dry' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<SeedResult | null>(null);

  useEffect(() => { setValues({}); setResult(null); setError(null); }, [scenario.id]);

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'dry' : 'seed');
    setError(null);
    try {
      setResult(await api<SeedResult>('POST', '/seed', { scenario: scenario.id, params: values, dryRun, note }));
      if (!dryRun) onSeeded();
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(null);
    }
  };
  const required = scenario.params.filter((p) => p.default === undefined && !values[p.name]?.trim());
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of result?.rows ?? []) m.set(r.table, (m.get(r.table) ?? 0) + 1);
    return [...m].map(([t, n]) => `${short(t)}: ${n}`).join(', ');
  }, [result]);

  return (
    <Flex direction="column" gap="4">
      <Box>
        <Heading as="h2" size="4">{scenario.name}</Heading>
        {scenario.description && <Text as="p" size="2" color="gray" mt="1">{scenario.description}</Text>}
        <Text as="p" size="1" color="gray" mt="1" className="mono">{scenario.file}</Text>
      </Box>

      {scenario.params.length > 0 && (
        <div className="param-grid">
          {scenario.params.map((p) => (
            <Flex key={p.name} direction="column" gap="1">
              <Text as="label" size="2" weight="medium" htmlFor={`sparam-${p.name}`}>
                {p.name} <Text size="1" color="gray" weight="regular">{p.type}{p.default === undefined ? ' · required' : ''}</Text>
              </Text>
              {p.type === 'boolean' ? (
                <Select.Root value={values[p.name] ?? p.default ?? ''} onValueChange={(v) => setValues({ ...values, [p.name]: v })}>
                  <Select.Trigger id={`sparam-${p.name}`} placeholder="Choose" />
                  <Select.Content position="popper"><Select.Item value="true">true</Select.Item><Select.Item value="false">false</Select.Item></Select.Content>
                </Select.Root>
              ) : (
                <TextField.Root id={`sparam-${p.name}`} type={INPUT_TYPE[p.type] ?? 'text'} step={p.type === 'numeric' ? 'any' : undefined}
                  value={values[p.name] ?? ''} placeholder={p.default ?? ''} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} />
              )}
              {p.description && <Text size="1" color="gray">{p.description}</Text>}
            </Flex>
          ))}
        </div>
      )}

      <Flex gap="3" align="end" wrap="wrap">
        <Button size="3" onClick={() => void run(false)} loading={busy === 'seed'} disabled={required.length > 0} className="press"><Plant weight="bold" /> Seed</Button>
        <Button size="3" variant="soft" onClick={() => void run(true)} loading={busy === 'dry'} disabled={required.length > 0} className="press">Dry run</Button>
        <Flex direction="column" gap="1" flexGrow="1" minWidth="160px">
          <Text as="label" size="1" color="gray" htmlFor="seed-note">Note (optional)</Text>
          <TextField.Root id="seed-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. TC-142 order history" />
        </Flex>
      </Flex>
      {required.length > 0 && <Text size="1" color="gray">Fill in {required.map((p) => p.name).join(', ')} first.</Text>}
      {error && <ErrorCallout error={error} />}

      {result && (
        <Box>
          <Card variant="surface" className="claim-done" mb="3">
            <Flex gap="3" align="center" justify="between" wrap="wrap">
              <Flex gap="2" align="center">
                <CheckCircle size={18} weight="fill" color={result.dryRun ? 'var(--amber-9)' : 'var(--grass-9)'} />
                <Text size="2">
                  {result.dryRun ? <>Dry run: would create {counts}. <Text color="gray">Nothing was saved.</Text></> : <>Created {counts} as <b>run #{result.runId}</b> ({result.ms} ms).</>}
                </Text>
              </Flex>
              {!result.dryRun && <Button size="1" variant="soft" onClick={() => onClean(result.runId!)}><Broom /> Clean up this run…</Button>}
            </Flex>
          </Card>
          <SeededRows result={result} />
        </Box>
      )}
    </Flex>
  );
}

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
function CleanPanel({ target, onDone, onClose, onRestore }: { target: CleanTarget; onDone: () => void; onClose: () => void; onRestore: (file: string) => void }) {
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

function Runs({ version, activeProfile, onClean }: { version: number; activeProfile: string | null; onClean: (t: CleanTarget) => void }) {
  const [all, setAll] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const data = useLoad(() => api<{ me: string; runs: Run[] }>('GET', `/runs${all ? '?all=1' : ''}`), [all, version, activeProfile]);
  const me = data.data?.me ?? '';
  const shown = (data.data?.runs ?? []).filter((r) => !mineOnly || r.createdBy === me);
  const mine = (data.data?.runs ?? []).filter((r) => r.createdBy === me && !r.cleanedAt);

  return (
    <Card size="3" mb="5">
      <Flex justify="between" align="center" mb="3" gap="3" wrap="wrap">
        <Box>
          <Heading as="h2" size="3">Seed runs</Heading>
          <Text as="p" size="1" color="gray">Every row a scenario created is tracked, so cleaning removes exactly those rows.</Text>
        </Box>
        <Flex gap="4" align="center" wrap="wrap">
          <Text as="label" size="2"><Flex gap="2" align="center"><Switch size="1" checked={mineOnly} onCheckedChange={setMineOnly} /> Only mine</Flex></Text>
          <Text as="label" size="2"><Flex gap="2" align="center"><Switch size="1" checked={all} onCheckedChange={setAll} /> Show cleaned</Flex></Text>
          <Button variant="soft" color="gray" disabled={mine.length === 0} onClick={() => onClean({ runIds: mine.map((r) => r.id), label: `Your ${mine.length} runs` })}>
            <Broom /> Clean all mine ({mine.length})…
          </Button>
        </Flex>
      </Flex>
      {data.error && <Box mb="3"><ErrorCallout error={data.error} /></Box>}
      {shown.length === 0 ? (
        <Text as="p" size="2" color="gray">{all ? 'Nothing has been seeded in this database yet.' : 'No runs with data left to clean.'}</Text>
      ) : (
        <Table.Root variant="surface" size="1">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Run</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Scenario</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>By</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Created</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Rows</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell><span className="sr-only">Actions</span></Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {shown.map((r) => (
              <Table.Row key={r.id}>
                <Table.RowHeaderCell><Text weight="medium">#{r.id}</Text></Table.RowHeaderCell>
                <Table.Cell>{r.scenario}{r.note && <Text as="div" size="1" color="gray">{r.note}</Text>}</Table.Cell>
                <Table.Cell>{r.createdBy === me ? <Badge color="grass" variant="soft">{r.createdBy} (you)</Badge> : r.createdBy}</Table.Cell>
                <Table.Cell><Text size="2">{formatWhen(r.createdAt)}</Text></Table.Cell>
                <Table.Cell><Text size="1" color="gray">{Object.entries(r.tables).map(([t, n]) => `${short(t)}: ${n}`).join(', ')}</Text></Table.Cell>
                <Table.Cell>
                  <Flex justify="end">
                    {r.cleanedAt
                      ? <Text size="1" color="gray">cleaned {formatWhen(r.cleanedAt)}</Text>
                      : <Button size="1" variant="soft" onClick={() => onClean({ runIds: [r.id], label: `Run #${r.id} · ${r.scenario}` })}><Broom /> Clean…</Button>}
                  </Flex>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
    </Card>
  );
}

/** Undo a recorded session (Tool 1): pick a stopped session and preview the undo. */
function UndoSession({ activeProfile, preselected, onClean }: { activeProfile: string | null; preselected?: string; onClean: (t: CleanTarget) => void }) {
  const list = useLoad(() => api<SessionPage>('GET', '/sessions?page=1&pageSize=50'), [activeProfile]);
  const stopped = (list.data?.sessions ?? []).filter((s) => s.stoppedAt && s.changeCount > 0);
  const [chosen, setChosen] = useState<string>(preselected ?? '');
  // Falls back to the newest one when nothing (or a session that can't be undone) is chosen.
  useEffect(() => { if (stopped[0] && !stopped.some((s) => s.id === chosen)) setChosen(stopped[0].id); }, [stopped, chosen]);
  const session = stopped.find((s) => s.id === chosen);

  return (
    <Card size="3" mb="5">
      <Heading as="h2" size="3">Undo a recorded session</Heading>
      <Text as="p" size="1" color="gray" mb="3">
        Puts the database back to how it was before a recording: rows the app inserted are deleted, updated values are set back, deleted rows are put back. Rows someone changed since are left alone.
      </Text>
      {list.error && <Box mb="3"><ErrorCallout error={list.error} /></Box>}
      {stopped.length === 0 ? <Text size="2" color="gray">No stopped sessions with changes yet. Record one on the Record page.</Text> : (
        <Flex gap="3" align="center" wrap="wrap">
          <Select.Root value={chosen} onValueChange={setChosen}>
            <Select.Trigger aria-label="Session to undo" style={{ minWidth: 280 }} />
            <Select.Content position="popper">
              {stopped.map((s) => <Select.Item key={s.id} value={s.id}>#{s.id} · {s.name} · {s.changeCount} {s.changeCount === 1 ? 'change' : 'changes'}</Select.Item>)}
            </Select.Content>
          </Select.Root>
          <Button variant="soft" disabled={!session} onClick={() => session && onClean({ sessionId: session.id, label: `Session #${session.id} · ${session.name}` })}>
            <ArrowCounterClockwise /> Preview undo…
          </Button>
        </Flex>
      )}
    </Card>
  );
}

function Backups({ version, activeProfile, onRestore }: { version: number; activeProfile: string | null; onRestore: (file: string) => void }) {
  const data = useLoad(() => api<{ dir: string; backups: BackupInfo[] }>('GET', '/backups'), [version, activeProfile]);
  const backups = data.data?.backups ?? [];
  return (
    <Card size="3">
      <Heading as="h2" size="3">Backups</Heading>
      <Text as="p" size="1" color="gray" mb="3">Every clean saves what it changed first{data.data ? <>, in <span className="mono">{data.data.dir}</span></> : ''}. Restoring puts it back.</Text>
      {data.error && <Box mb="3"><ErrorCallout error={data.error} /></Box>}
      {backups.length === 0 ? <Text size="2" color="gray">No backups for this database yet.</Text> : (
        <Table.Root variant="surface" size="1">
          <Table.Body>
            {backups.slice(0, 20).map((b) => (
              <Table.Row key={b.file}>
                <Table.Cell><Text size="2">{formatWhen(b.createdAt)}</Text></Table.Cell>
                <Table.RowHeaderCell>{b.title}</Table.RowHeaderCell>
                <Table.Cell><Text size="1" color="gray">{b.changes} {b.changes === 1 ? 'row' : 'rows'}</Text></Table.Cell>
                <Table.Cell><Flex justify="end"><Button size="1" variant="soft" onClick={() => onRestore(b.file)}><ArrowCounterClockwise /> Restore…</Button></Flex></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      )}
      {backups.length > 20 && <Text as="p" size="1" color="gray" mt="2">Showing the newest 20 of {backups.length}. Older ones are in the folder above: <span className="mono">propmaster restore &lt;file&gt;</span>.</Text>}
    </Card>
  );
}

const CHECK = {
  ok: <CheckCircle size={18} weight="fill" color="var(--grass-9)" />,
  skipped: <Warning size={18} color="var(--gray-9)" />,
  error: <XCircle size={18} weight="fill" color="var(--red-9)" />,
};

export function SeedPage({ activeProfile, session }: { activeProfile: string | null; session?: string }) {
  const source = useLoad(() => api<ScenariosSource>('GET', '/scenarios'), [activeProfile]);
  const [path, setPath] = useState('');
  const [selected, setSelected] = useState<string | null>(() => sessionStorage.getItem('propmaster-scenario'));
  const [busy, setBusy] = useState<'open' | 'check' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [checks, setChecks] = useState<ScenarioCheck[] | null>(null);
  const [version, setVersion] = useState(0);
  const [target, setTarget] = useState<CleanTarget | null>(null);

  const scenarios = useMemo(() => source.data?.scenarios ?? [], [source.data]);
  const scenario = scenarios.find((s) => s.id === selected) ?? scenarios[0] ?? null;
  useEffect(() => { if (source.data) setPath(source.data.path); }, [source.data]);
  // #seed/12 (from the Sessions page) opens the undo preview of session 12.
  useEffect(() => { if (session) setTarget({ sessionId: session, label: `Session #${session}` }); }, [session]);

  const act = async (kind: 'open' | 'check', fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try { await fn(); } catch (err) { setError(toError(err)); } finally { setBusy(null); }
  };
  const open = () => act('open', async () => { await api('PUT', '/scenarios', { path }); setChecks(null); await source.refresh(); });
  const check = () => act('check', async () => { setChecks((await api<{ results: ScenarioCheck[] }>('POST', '/scenarios/check')).results); });
  const select = (id: string) => { setSelected(id); sessionStorage.setItem('propmaster-scenario', id); };
  const clean = (t: CleanTarget) => {
    setTarget(t);
    requestAnimationFrame(() => document.getElementById('clean-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <Box>
      <PageHeader title="Seed & clean" description="Scenarios create the rows a test needs, linked correctly, and every row is tracked. Cleaning removes exactly those rows, or undoes what a recorded session changed." />
      {error && <Box mb="4"><ErrorCallout error={error} /></Box>}

      <Card size="2" mb="5">
        <Flex gap="2" wrap="wrap" align="center">
          <Box flexGrow="1" minWidth="280px">
            <TextField.Root value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\path\to\scenarios (a folder of .yml files, or one file)"
              aria-label="Scenario folder" className="mono" onKeyDown={(e) => { if (e.key === 'Enter' && path) void open(); }} />
          </Box>
          <Button variant="soft" onClick={() => void open()} loading={busy === 'open'} disabled={!path}><FolderOpen /> Open</Button>
          <Button variant="soft" color="gray" onClick={() => void check()} loading={busy === 'check'} disabled={scenarios.length === 0}><Stethoscope /> Check all scenarios</Button>
        </Flex>
        {source.data?.error && <Box mt="3"><ErrorCallout error={{ message: source.data.error }} /></Box>}
        {source.error && <Box mt="3"><ErrorCallout error={source.error} /></Box>}
        {checks && (
          <Box mt="3">
            <Table.Root variant="surface" size="1">
              <Table.Body>
                {checks.map((r) => (
                  <Table.Row key={r.scenario.id}>
                    <Table.Cell width="36px">{CHECK[r.status]}</Table.Cell>
                    <Table.RowHeaderCell>{r.scenario.name}</Table.RowHeaderCell>
                    <Table.Cell><Text size="2" color={r.status === 'error' ? 'red' : 'gray'}>{r.status === 'ok' ? `works · ${r.rows} rows (rolled back)` : r.error}</Text></Table.Cell>
                    <Table.Cell width="80px"><Text size="1" color="gray">{r.ms} ms</Text></Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        )}
      </Card>

      {scenarios.length === 0 ? (
        !source.loading && !source.data?.error && !source.error && (
          <Card size="3" mb="5">
            <EmptyState icon={<Plant size={36} />} title="Open a scenario folder">
              A scenario is a .yml file that lists the rows a test needs; Propmaster fills in the rest and links them. Try the demo: the demo/scenarios folder of Propmaster.
            </EmptyState>
          </Card>
        )
      ) : (
        <div className="find-grid">
          <Card size="2"><ScenarioList scenarios={scenarios} selected={scenario?.id ?? null} onSelect={select} /></Card>
          <Card size="3">{scenario && <ScenarioPanel scenario={scenario} onSeeded={() => setVersion((v) => v + 1)} onClean={(id) => clean({ runIds: [id], label: `Run #${id}` })} />}</Card>
        </div>
      )}

      <div id="clean-panel">
        {target && (
          <Box mb="5">
            <CleanPanel target={target} onClose={() => setTarget(null)} onDone={() => setVersion((v) => v + 1)}
              onRestore={(file) => clean({ file, label: 'Restore from backup' })} />
          </Box>
        )}
      </div>

      <Runs version={version} activeProfile={activeProfile} onClean={clean} />
      <UndoSession activeProfile={activeProfile} preselected={session} onClean={clean} />
      <Backups version={version} activeProfile={activeProfile} onRestore={(file) => clean({ file, label: 'Restore from backup' })} />
    </Box>
  );
}
