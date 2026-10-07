import { Badge, Box, Button, Card, Flex, Heading, RadioCards, Text, TextField } from '@radix-ui/themes';
import { ArrowRight, Play, Plus, Stop } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { EmptyState, ErrorCallout, PageHeader, TimelineSkeleton } from '../components/Feedback';
import { Timeline } from '../components/Timeline';
import { toError, useElapsed, useLoad } from '../hooks';
import type { ApiError, Recording, Status } from '../types';

function StartForm({ installed, onStarted }: { installed: boolean; onStarted: () => void }) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'trigger' | 'snapshot'>(installed ? 'trigger' : 'snapshot');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/record/start', { name: name.trim() || 'Test session', snapshot: mode === 'snapshot' });
      onStarted();
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card size="4" style={{ maxWidth: 640 }}>
      <form onSubmit={start}>
        <Heading size="4" mb="1">Start a recording</Heading>
        <Text as="p" size="2" color="gray" mb="5">
          Name it after your test case. Then add a step before each action you take in the app.
        </Text>

        <Flex direction="column" gap="2" mb="4">
          <Text as="label" size="2" weight="medium" htmlFor="session-name">Test case</Text>
          <TextField.Root id="session-name" size="3" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. TC-01 Guest checkout" />
        </Flex>

        <Flex direction="column" gap="2" mb="5">
          <Text as="span" size="2" weight="medium" id="mode-label">How to record</Text>
          <RadioCards.Root value={mode} onValueChange={(v) => setMode(v as 'trigger' | 'snapshot')} aria-labelledby="mode-label" columns={{ initial: '1', sm: '2' }}>
            <RadioCards.Item value="trigger" disabled={!installed}>
              <Flex direction="column" width="100%">
                <Text weight="bold">Live</Text>
                <Text size="1" color="gray">Every change as it happens, with who made it.{!installed && ' Install the recorder first (Setup).'}</Text>
              </Flex>
            </RadioCards.Item>
            <RadioCards.Item value="snapshot">
              <Flex direction="column" width="100%">
                <Text weight="bold">Snapshots</Text>
                <Text size="1" color="gray">Read-only access is enough. Changes appear when you add the next step.</Text>
              </Flex>
            </RadioCards.Item>
          </RadioCards.Root>
        </Flex>

        {error && <Box mb="4"><ErrorCallout error={error} /></Box>}
        <Button type="submit" size="3" loading={busy} className="press">
          <Play weight="fill" /> Start recording
        </Button>
      </form>
    </Card>
  );
}

function Recorder({ status, onChange, onStopped }: { status: Status; onChange: () => void; onStopped: (rec: Recording) => void }) {
  const active = status.active!;
  const elapsed = useElapsed(active.startedAt);
  const [stepName, setStepName] = useState('');
  const [busy, setBusy] = useState<'step' | 'stop' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const live = useLoad(() => api<Recording>('GET', `/sessions/${active.id}`), [active.id, active.stepSeq], 1500);

  const addStep = async (e: FormEvent) => {
    e.preventDefault();
    if (!stepName.trim()) { input.current?.focus(); return; }
    setBusy('step');
    setError(null);
    try {
      await api('POST', '/record/step', { name: stepName.trim() });
      setStepName('');
      onChange();
      void live.refresh();
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(null);
      input.current?.focus();
    }
  };

  const stop = async () => {
    setBusy('stop');
    setError(null);
    try {
      onStopped(await api<Recording>('POST', '/record/stop'));
      onChange();
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Box>
      <Card size="3" mb="5">
        <Flex justify="between" align="center" gap="3" wrap="wrap" mb="4">
          <Flex align="center" gap="3">
            <Badge color="red" variant="soft" size="2"><span className="rec-dot" /> REC</Badge>
            <Heading size="4">{active.name}</Heading>
            <Text size="2" color="gray">#{active.id}</Text>
          </Flex>
          <Flex align="center" gap="3">
            <Text size="2" color="gray" className="mono">{elapsed}</Text>
            {active.mode === 'snapshot' && <Badge variant="outline" color="gray">snapshot mode</Badge>}
            <Button color="red" variant="soft" onClick={() => void stop()} loading={busy === 'stop'} className="press">
              <Stop weight="fill" /> Stop
            </Button>
          </Flex>
        </Flex>

        <form onSubmit={addStep}>
          <Text as="label" size="2" weight="medium" htmlFor="step-name">Next step</Text>
          <Flex gap="2" mt="2">
            <Box flexGrow="1">
              <TextField.Root id="step-name" ref={input} size="3" autoFocus value={stepName}
                onChange={(e) => setStepName(e.target.value)} placeholder="What are you about to do? e.g. Click Place Order" />
            </Box>
            <Button type="submit" size="3" loading={busy === 'step'} className="press">
              <Plus weight="bold" /> Add step
            </Button>
          </Flex>
          <Text as="p" size="1" color="gray" mt="2">
            Press Enter to add it, then do that action in the app. Now on step {active.stepSeq}: {active.stepName}.
          </Text>
        </form>
        {error && <Box mt="4"><ErrorCallout error={error} /></Box>}
      </Card>

      {live.error && <Box mb="4"><ErrorCallout error={live.error} /></Box>}
      {!live.data ? <TimelineSkeleton /> : (
        live.data.summary.changes === 0 && active.stepSeq === 0
          ? <EmptyState icon={<Plus size={32} />} title="No steps yet">Add your first step above, then do it in the app. Changes appear here as they happen.</EmptyState>
          : <Timeline steps={live.data.steps} currentSeq={active.stepSeq} />
      )}
    </Box>
  );
}

function StoppedView({ stopped, onAgain }: { stopped: Recording; onAgain: () => void }) {
  return (
    <Box>
      <Card size="3" mb="5">
        <Flex justify="between" align="center" gap="4" wrap="wrap">
          <Box>
            <Heading size="4">Recording stopped</Heading>
            <Text size="2" color="gray">
              {stopped.name}, session #{stopped.id}: {stopped.summary.changes} changes across {stopped.summary.tables} tables
            </Text>
          </Box>
          <Flex gap="2">
            <Button variant="soft" onClick={() => { location.hash = `sessions/${stopped.id}`; }}>
              Open session <ArrowRight />
            </Button>
            <Button onClick={onAgain} className="press">Record another</Button>
          </Flex>
        </Flex>
      </Card>
      <Timeline steps={stopped.steps} />
    </Box>
  );
}

export function RecordPage({ status, statusError, onChange }: { status: Status | null; statusError: ApiError | null; onChange: () => void }) {
  const [stopped, setStopped] = useState<Recording | null>(null);
  // Keep the page title in step with the recording, so the browser tab shows it too.
  useEffect(() => {
    document.title = status?.active ? `● REC ${status.active.name} · Propmaster` : 'Propmaster';
  }, [status?.active]);

  if (!status) {
    return statusError ? <ErrorCallout error={statusError} /> : <TimelineSkeleton />;
  }
  return (
    <Box>
      <PageHeader
        title="Record"
        description={status.active ? 'Add a step before each action. Changes appear as the app makes them.' : 'Record what your test does to the database, step by step.'}
      />
      {status.active
        ? <Recorder key={status.active.id} status={status} onChange={onChange} onStopped={setStopped} />
        : stopped
          ? <StoppedView stopped={stopped} onAgain={() => setStopped(null)} />
          : <StartForm installed={status.installed} onStarted={() => { setStopped(null); onChange(); }} />}
    </Box>
  );
}
