import { Badge, Box, Button, Card, Code, Flex, Heading, IconButton, Text, TextField } from '@radix-ui/themes';
import { CheckCircle, Eye, EyeSlash, Plugs, Trash, Warning, X, XCircle } from '@phosphor-icons/react';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorCallout, PageHeader } from '../components/Feedback';
import { toError } from '../hooks';
import type { ApiError, Config, Doctor, Status } from '../types';

const LEVEL = {
  ok: <CheckCircle size={18} weight="fill" color="var(--grass-9)" />,
  warn: <Warning size={18} weight="fill" color="var(--amber-9)" />,
  fail: <XCircle size={18} weight="fill" color="var(--red-9)" />,
};

function DoctorReport({ report }: { report: Doctor }) {
  return (
    <Flex direction="column" gap="2">
      {report.findings.map((f) => (
        <Flex key={f.text} gap="2" align="start">
          <Box pt="1px">{LEVEL[f.level]}</Box>
          <Text size="2">{f.text}</Text>
        </Flex>
      ))}
      <Text size="2" weight="medium" mt="2">
        {report.recommended === 'trigger' ? 'Live recording (triggers) will work here.'
          : report.recommended === 'snapshot' ? 'Use snapshot recording here: it needs only read access.'
          : 'This database user cannot record. Ask for the access below.'}
      </Text>
      {report.grants.length > 0 && (
        <Box>
          <Text as="p" size="2" color="gray" mb="1">For live recording, ask a DBA to run:</Text>
          {report.grants.map((g) => <Code key={g} size="2" style={{ display: 'block', marginBottom: 4 }}>{g}</Code>)}
        </Box>
      )}
    </Flex>
  );
}

function ConnectionForm({ first, onSaved }: { first: boolean; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [report, setReport] = useState<Doctor | null>(null);

  const test = async () => {
    setBusy('test'); setError(null); setReport(null);
    try { setReport((await api<{ doctor: Doctor }>('POST', '/connections/test', { url })).doctor); }
    catch (err) { setError(toError(err)); }
    finally { setBusy(null); }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save'); setError(null);
    try {
      await api('POST', '/profiles', { name, url });
      setName(''); setUrl(''); setReport(null);
      onSaved();
    } catch (err) { setError(toError(err)); }
    finally { setBusy(null); }
  };

  return (
    <Card size="3">
      <form onSubmit={save}>
        <Heading as="h2" size="4" mb="1">{first ? 'Connect to your test database' : 'Add a connection'}</Heading>
        <Text as="p" size="2" color="gray" mb="5">
          The PostgreSQL database behind the app you test. Never production: names with "prod" in them are refused.
        </Text>
        <Flex direction="column" gap="4">
          <Flex direction="column" gap="2">
            <Text as="label" size="2" weight="medium" htmlFor="conn-name">Name</Text>
            <TextField.Root id="conn-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. EverShop local" />
          </Flex>
          <Flex direction="column" gap="2">
            <Text as="label" size="2" weight="medium" htmlFor="conn-url">Connection string</Text>
            <TextField.Root id="conn-url" className="mono" type={reveal ? 'text' : 'password'} value={url}
              onChange={(e) => { setUrl(e.target.value); setReport(null); }} placeholder="postgres://user:password@localhost:5432/database" autoComplete="off">
              <TextField.Slot side="right">
                <IconButton type="button" variant="ghost" color="gray" size="1" onClick={() => setReveal(!reveal)} aria-label={reveal ? 'Hide connection string' : 'Show connection string'}>
                  {reveal ? <EyeSlash /> : <Eye />}
                </IconButton>
              </TextField.Slot>
            </TextField.Root>
            <Text size="1" color="gray">Ask your developers for it, or find it in the app's configuration.</Text>
          </Flex>
          {error && <ErrorCallout error={error} />}
          {report && <Card variant="surface"><DoctorReport report={report} /></Card>}
          <Flex gap="2">
            <Button type="button" variant="soft" onClick={() => void test()} loading={busy === 'test'} disabled={!url}><Plugs /> Test</Button>
            <Button type="submit" loading={busy === 'save'} disabled={!url || !name} className="press">Save connection</Button>
          </Flex>
        </Flex>
      </form>
    </Card>
  );
}

function ActiveDatabase({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [report, setReport] = useState<Doctor | null>(null);
  const [exclude, setExclude] = useState('');

  const act = async (kind: string, fn: () => Promise<void>) => {
    setBusy(kind); setError(null);
    try { await fn(); onChanged(); } catch (err) { setError(toError(err)); } finally { setBusy(null); }
  };

  return (
    <Card size="3">
      <Flex justify="between" align="center" mb="4" gap="3" wrap="wrap">
        <Box>
          <Heading as="h2" size="4">{status.profile.name}</Heading>
          <Text size="2" color="gray" className="mono">{status.profile.display}</Text>
        </Box>
        <Button variant="soft" onClick={() => void act('check', async () => setReport(await api<Doctor>('GET', '/doctor')))} loading={busy === 'check'}>
          Check access
        </Button>
      </Flex>

      {report && <Box mb="4"><DoctorReport report={report} /></Box>}
      {error && <Box mb="4"><ErrorCallout error={error} /></Box>}

      {status.installed ? (
        <Flex direction="column" gap="3">
          <Flex align="center" gap="2"><CheckCircle size={18} weight="fill" color="var(--grass-9)" /><Text size="2">Recorder installed, watching {status.watchedTables} tables.</Text></Flex>
          {status.outdated && (
            <Flex align="center" gap="3" wrap="wrap">
              <Warning size={18} weight="fill" color="var(--amber-9)" />
              <Text size="2">This recorder is from an older version: pause, resume and flag need the upgrade. Recordings are kept.</Text>
              <Button size="2" onClick={() => void act('install', () => api('POST', '/install'))} loading={busy === 'install'} className="press">Upgrade recorder</Button>
            </Flex>
          )}
          <Box>
            <Text as="p" size="2" weight="medium" mb="2">Not watched</Text>
            {status.excludedTables.length === 0 && <Text as="p" size="2" color="gray" mb="2">No tables excluded. Exclude busy tables (sessions, logs) that change on every page view.</Text>}
            <Flex gap="2" wrap="wrap" mb="3">
              {status.excludedTables.map((t) => (
                <Badge key={t} size="2" variant="soft" color="gray">
                  {t}
                  <IconButton size="1" variant="ghost" color="gray" aria-label={`Watch ${t} again`}
                    onClick={() => void act(`include-${t}`, () => api('POST', '/tables/include', { table: t }))}>
                    <X size={12} />
                  </IconButton>
                </Badge>
              ))}
            </Flex>
            <Flex gap="2" maxWidth="420px">
              <TextField.Root value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="table name, e.g. session" aria-label="Table to exclude" style={{ flex: 1 }} />
              <Button variant="soft" disabled={!exclude.trim()} loading={busy === 'exclude'}
                onClick={() => void act('exclude', async () => { await api('POST', '/tables/exclude', { table: exclude.trim() }); setExclude(''); })}>
                Exclude
              </Button>
            </Flex>
          </Box>
        </Flex>
      ) : (
        <Flex direction="column" gap="3" align="start">
          <Text size="2">
            Live recording needs a small recorder installed in this database (its own schema, removable at any time).
            Without it, use snapshot recording.
          </Text>
          <Button onClick={() => void act('install', () => api('POST', '/install'))} loading={busy === 'install'} className="press">Install recorder</Button>
        </Flex>
      )}
    </Card>
  );
}

export function SetupPage({ config, status, onChanged }: { config: Config; status: Status | null; onChanged: () => void }) {
  const [error, setError] = useState<ApiError | null>(null);
  const first = config.profiles.length === 0;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); onChanged(); } catch (err) { setError(toError(err)); }
  };

  return (
    <Box>
      <PageHeader title={first ? 'Welcome to Propmaster' : 'Setup'}
        description={first ? 'Connect a test database, and you can start recording what your tests do to it.' : 'Your database connections and the recorder.'} />
      {error && <Box mb="4"><ErrorCallout error={error} /></Box>}

      <Flex direction="column" gap="5">
        {!first && status && <ActiveDatabase status={status} onChanged={onChanged} />}

        {!first && (
          <Card size="3">
            <Heading as="h2" size="4" mb="3">Saved connections</Heading>
            <Flex direction="column" gap="2">
              {config.profiles.map((p) => (
                <Flex key={p.name} justify="between" align="center" gap="3" py="2" wrap="wrap">
                  <Box>
                    <Flex gap="2" align="center">
                      <Text weight="medium">{p.name}</Text>
                      {p.name === config.active && <Badge color="cyan" variant="soft">in use</Badge>}
                    </Flex>
                    <Text size="1" color="gray" className="mono">{p.display}</Text>
                  </Box>
                  <Flex gap="2">
                    {p.name !== config.active && (
                      <Button size="1" variant="soft" onClick={() => void run(() => api('POST', `/profiles/${encodeURIComponent(p.name)}/activate`))}>Use</Button>
                    )}
                    <IconButton size="1" variant="ghost" color="red" aria-label={`Remove ${p.name}`}
                      onClick={() => void run(() => api('DELETE', `/profiles/${encodeURIComponent(p.name)}`))}>
                      <Trash />
                    </IconButton>
                  </Flex>
                </Flex>
              ))}
            </Flex>
          </Card>
        )}

        <ConnectionForm first={first} onSaved={() => { onChanged(); if (first) location.hash = 'record'; }} />
      </Flex>
    </Box>
  );
}
