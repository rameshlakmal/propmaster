// Home: the test you are working on and where it stands, then what you hold on this database:
// claims, seed runs that still have data, and recent recordings.
import { Badge, Box, Button, Callout, Flex, Heading, IconButton, Skeleton, Text, TextField } from '@radix-ui/themes';
import {
  ArrowRight, Broom, CheckCircle, FlagCheckered, HandGrabbing, Info, PencilSimple, Plant, Play, Plus, Record, Rows, Warning,
} from '@phosphor-icons/react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { Stepper } from '../components/Stepper';
import { ago, greeting, useElapsed, useLoad } from '../hooks';
import type { ClaimRow, Run, SessionPage, Status } from '../types';
import { stagesOf, useWorkspace } from '../workspace';

const short = (table: string) => table.replace(/^public\./, '');

function timeLeft(iso: string): string {
  const m = Math.floor((new Date(iso).getTime() - Date.now()) / 60000);
  return m < 1 ? '< 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function Panel({ icon, title, action, children, tone }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode; tone: string }) {
  return (
    <section className="panel">
      <Flex justify="between" align="center" mb="3" gap="2">
        <Flex align="center" gap="2">
          <span className={`tile tile-${tone}`} aria-hidden>{icon}</span>
          <Heading as="h2" size="3">{title}</Heading>
        </Flex>
        {action}
      </Flex>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <Text as="p" size="2" color="gray" className="panel-empty">{children}</Text>;
}

function Loading() {
  return <Flex direction="column" gap="2"><Skeleton height="40px" /><Skeleton height="40px" /></Flex>;
}

function RecordingStrip({ status }: { status: Status }) {
  const active = status.active!;
  const elapsed = useElapsed(active.startedAt);
  return (
    <button type="button" className="live-strip" onClick={() => { location.hash = 'record'; }}>
      <span className={active.paused ? 'live-badge live-paused' : 'live-badge'}>{active.paused ? 'PAUSED' : <><span className="rec-dot" /> REC</>}</span>
      <span className="live-text">
        <b>{active.name}</b> · step {active.stepSeq}{active.stepName ? ` “${active.stepName}”` : ''} · {elapsed}
      </span>
      <span className="live-go">Open recorder <ArrowRight /></span>
    </button>
  );
}

function StartTest({ onStart }: { onStart: (name: string) => void }) {
  const [name, setName] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); onStart(name); };
  return (
    <div className="hero-card hero-empty">
      <Box>
        <Text as="p" size="1" weight="bold" className="eyebrow">New test</Text>
        <Heading as="h2" size="6" mb="2">What are you testing?</Heading>
        <Text as="p" size="2" color="gray" mb="4" style={{ maxWidth: 520 }}>
          Name it after your test case. Propmaster follows it from finding the data to leaving the database clean,
          so nothing is forgotten when you're done.
        </Text>
        <form onSubmit={submit}>
          <Flex gap="2" wrap="wrap">
            <Box flexGrow="1" minWidth="220px" maxWidth="420px">
              <TextField.Root size="3" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. TC-142 Guest checkout" aria-label="Test name" />
            </Box>
            <Button size="3" type="submit" className="press"><Play weight="fill" /> Start test</Button>
          </Flex>
        </form>
      </Box>
      <ol className="hero-steps" aria-label="How a test goes">
        {[
          ['Find', 'Claim rows in the state you need'],
          ['Seed', 'Or create exactly the rows you need'],
          ['Record', 'Capture what the app changes'],
          ['Check', 'Run your business rules on it'],
          ['Clean', 'Put the database back'],
        ].map(([t, d], i) => (
          <li key={t}><span className="hero-step-n">{i + 1}</span><span><b>{t}</b><br /><Text size="1" color="gray">{d}</Text></span></li>
        ))}
      </ol>
    </div>
  );
}

function CurrentTestCard({ status, onFinish, onNew }: { status: Status | null; onFinish: () => void; onNew: () => void }) {
  const ws = useWorkspace();
  const test = ws.test!;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(test.name);
  const stages = stagesOf(test, status?.active ?? null);
  const done = stages.filter((s) => s.state === 'done').length;
  const next = stages.find((s) => s.state === 'todo' && s.id !== 'clean') ?? stages[4]!;

  return (
    <div className="hero-card">
      <Flex justify="between" align="start" gap="3" wrap="wrap" mb="4">
        <Box minWidth="0">
          <Text as="p" size="1" weight="bold" className="eyebrow">Current test · started {ago(test.startedAt)}</Text>
          {editing ? (
            <form onSubmit={(e) => { e.preventDefault(); ws.rename(name); setEditing(false); }}>
              <Flex gap="2" mt="1">
                <TextField.Root size="3" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Test name"
                  onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }} />
                <Button size="3" type="submit">Save</Button>
              </Flex>
            </form>
          ) : (
            <Flex align="center" gap="2">
              <Heading as="h2" size="7" className="test-title">{test.name}</Heading>
              <IconButton variant="ghost" color="gray" aria-label="Rename the test" onClick={() => { setName(test.name); setEditing(true); }}><PencilSimple /></IconButton>
            </Flex>
          )}
          <Text as="p" size="2" color="gray" mt="1">
            {test.cleanedAt ? 'Cleaned up. Start the next test when you are ready.' : `${done} of 5 stages done. Next: ${next.label.toLowerCase()} — ${next.detail.toLowerCase()}.`}
          </Text>
        </Box>
        <Flex gap="2" wrap="wrap">
          {test.cleanedAt
            ? <Button size="2" onClick={onNew} className="press"><Plus /> New test</Button>
            : <>
                <Button size="2" variant="soft" color="gray" onClick={onNew}><Plus /> New test</Button>
                <Button size="2" onClick={onFinish} className="press"><FlagCheckered /> Finish &amp; clean up</Button>
              </>}
        </Flex>
      </Flex>
      <Stepper stages={stages} />
      {status?.active && <RecordingStrip status={status} />}
    </div>
  );
}

export function HomePage({ status, me, onFinish, onNew }: { status: Status | null; me: string; onFinish: () => void; onNew: () => void }) {
  const ws = useWorkspace();
  // Reloaded as soon as the test changes (a claim, a seed, a finished cleanup), not only on the next poll.
  const changed = `${ws.test?.claims.length ?? 0}/${ws.test?.runs.length ?? 0}/${ws.test?.cleanedAt ?? ''}`;
  const claims = useLoad(() => api<{ me: string; claims: ClaimRow[] }>('GET', '/claims'), [changed], 30000);
  const runs = useLoad(() => api<{ me: string; runs: Run[] }>('GET', '/runs'), [changed], 30000);
  const sessions = useLoad(() => api<SessionPage>('GET', '/sessions?page=1&pageSize=5'), [status?.active?.id ?? '', changed], 15000);
  const who = claims.data?.me ?? me;
  const myClaims = (claims.data?.claims ?? []).filter((c) => c.claimedBy === who && !c.expired);
  const myRuns = (runs.data?.runs ?? []).filter((r) => r.createdBy === who);
  const inTest = (kind: 'claims' | 'runs', id: string) => (kind === 'claims' ? ws.test?.claims.some((c) => c.id === id) : ws.test?.runs.includes(id));

  return (
    <Box>
      <header className="home-head">
        <Text as="p" size="2" color="gray">{greeting()}{who ? `, ${who}` : ''}</Text>
        <Heading as="h1" size="8" className="display">Your test workspace</Heading>
        {status && <Text as="p" size="2" color="gray" mt="1">On <span className="mono">{status.profile.display}</span>{status.installed ? ` · ${status.watchedTables} tables watched` : ''}</Text>}
      </header>

      {status && !status.installed && (
        <Callout.Root color="amber" mb="5">
          <Callout.Icon><Info /></Callout.Icon>
          <Callout.Text>
            Live recording isn't set up on this database yet. <a href="#setup">Install the recorder</a>, or record with snapshots (read-only access is enough).
          </Callout.Text>
        </Callout.Root>
      )}

      {ws.test ? <CurrentTestCard status={status} onFinish={onFinish} onNew={onNew} /> : <StartTest onStart={(n) => ws.start(n)} />}
      {!ws.test && status?.active && <Box mt="3"><RecordingStrip status={status} /></Box>}

      <div className="panels">
        <Panel icon={<HandGrabbing weight="fill" />} title="Your claims" tone="blue"
          action={<Button size="1" variant="ghost" onClick={() => { location.hash = 'find'; }}>Find data <ArrowRight /></Button>}>
          {!claims.data ? <Loading /> : myClaims.length === 0 ? <Empty>No rows held. Claim test data on Find data so nobody else uses it meanwhile.</Empty> : (
            <ul className="item-list">
              {myClaims.slice(0, 5).map((c) => (
                <li key={c.id}>
                  <span className="item-main"><b>{short(c.table)} {c.key}</b>{inTest('claims', c.id) && <Badge size="1" variant="soft">this test</Badge>}</span>
                  <span className="item-meta">{timeLeft(c.expiresAt)} left</span>
                </li>
              ))}
              {myClaims.length > 5 && <li className="item-more">and {myClaims.length - 5} more</li>}
            </ul>
          )}
        </Panel>

        <Panel icon={<Plant weight="fill" />} title="Runs to clean" tone="green"
          action={<Button size="1" variant="ghost" onClick={() => { location.hash = 'seed'; }}>Seed &amp; clean <ArrowRight /></Button>}>
          {!runs.data ? <Loading /> : myRuns.length === 0 ? <Empty>Nothing of yours left in the database. Seeded rows show here until they are cleaned.</Empty> : (
            <ul className="item-list">
              {myRuns.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <span className="item-main"><b>#{r.id}</b> {r.scenario}{inTest('runs', r.id) && <Badge size="1" variant="soft">this test</Badge>}</span>
                  <span className="item-meta">{r.rows} rows · {ago(r.createdAt)}</span>
                </li>
              ))}
              {myRuns.length > 5 && <li className="item-more">and {myRuns.length - 5} more</li>}
            </ul>
          )}
          {myRuns.length > 0 && <Text as="p" size="1" color="gray" mt="2"><Broom size={12} /> Clean them from Seed &amp; clean, or with “Finish &amp; clean up”.</Text>}
        </Panel>

        <Panel icon={<Rows weight="fill" />} title="Recent sessions" tone="violet"
          action={<Button size="1" variant="ghost" onClick={() => { location.hash = 'sessions'; }}>All sessions <ArrowRight /></Button>}>
          {!sessions.data ? <Loading /> : sessions.data.sessions.length === 0 ? <Empty>No recordings yet. <a href="#record">Record your first test</a>.</Empty> : (
            <ul className="item-list">
              {sessions.data.sessions.map((s) => (
                <li key={s.id}>
                  <a className="item-main item-link" href={`#sessions/${s.id}`}>
                    {s.stoppedAt ? <CheckCircle size={14} weight="fill" color="var(--gray-9)" /> : <Record size={14} weight="fill" color="var(--red-9)" />}
                    <b>{s.name}</b> <Text color="gray">#{s.id}</Text>
                  </a>
                  <span className="item-meta">{s.changeCount} changes · {ago(s.startedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {(claims.error || runs.error || sessions.error) && (
        <Text as="p" size="1" color="red" mt="3"><Warning size={12} /> {(claims.error ?? runs.error ?? sessions.error)!.message}</Text>
      )}
    </Box>
  );
}
