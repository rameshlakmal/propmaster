import { Badge, Box, Button, Card, Flex, Heading, RadioCards, Switch, Text, TextField } from '@radix-ui/themes';
import { ArrowRight, Flag, Pause, PictureInPicture, Play, Plus, Stop } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { EmptyState, ErrorCallout, PageHeader, TimelineSkeleton } from '../components/Feedback';
import { Timeline } from '../components/Timeline';
import { toError, useElapsed, useLoad } from '../hooks';
import { useRecorderActions } from '../recorder';
import type { ApiError, Recording, Status } from '../types';

function StartForm({ installed, onStarted }: { installed: boolean; onStarted: () => void }) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'trigger' | 'snapshot'>(installed ? 'trigger' : 'snapshot');
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/record/start', { name: name.trim() || 'Test session', snapshot: mode === 'snapshot', autoSteps: auto && mode === 'trigger' });
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

        <Text as="label" size="2" mb="5" style={{ display: 'block' }}>
          <Flex gap="3" align="start">
            <Box pt="1"><Switch checked={auto && mode === 'trigger'} disabled={mode === 'snapshot'} onCheckedChange={setAuto} /></Box>
            <Box>
              <Text weight="medium">Name steps for me</Text>
              <Text as="p" size="1" color="gray">
                No typing: each action you take in the app becomes a step (3 quiet seconds end it), named after what changed.
                You can still name an action yourself.{mode === 'snapshot' && ' Needs live recording.'}
              </Text>
            </Box>
          </Flex>
        </Text>

        {error && <Box mb="4"><ErrorCallout error={error} /></Box>}
        <Button type="submit" size="3" loading={busy} className="press">
          <Play weight="fill" /> Start recording
        </Button>
      </form>
    </Card>
  );
}

export interface FloatingControl {
  supported: boolean;
  isOpen: boolean;
  open: () => Promise<void>;
  close: () => void;
}

function Recorder({ status, onChange, onStopped, floating }: { status: Status; onChange: () => void; onStopped: (rec: Recording) => void; floating: FloatingControl }) {
  const active = status.active!;
  const elapsed = useElapsed(active.startedAt);
  const [stepName, setStepName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const noteInput = useRef<HTMLInputElement>(null);
  const live = useLoad(() => api<Recording>('GET', `/sessions/${active.id}`), [active.id, active.stepSeq], 1500);
  const actions = useRecorderActions({ onChange: () => { onChange(); void live.refresh(); }, onStopped });
  const noting = note !== null;
  // With auto steps, the current step is the last one worked out from the changes.
  const auto = active.autoSplitMs !== null;
  const lastStep = live.data?.steps[live.data.steps.length - 1];
  const current = auto && lastStep ? { seq: lastStep.seq, name: lastStep.name } : { seq: active.stepSeq, name: active.stepName };

  useEffect(() => { if (noting) noteInput.current?.focus(); }, [noting]);

  const addStep = async (e: FormEvent) => {
    e.preventDefault();
    if (!stepName.trim()) { input.current?.focus(); return; }
    if (await actions.step(stepName.trim())) setStepName('');
    input.current?.focus();
  };
  const addFlag = async (e: FormEvent) => {
    e.preventDefault();
    if (await actions.flag(note ?? '')) setNote(null);
  };

  return (
    <Box>
      <Card size="3" mb="5">
        <Flex justify="between" align="center" gap="3" wrap="wrap" mb="4">
          <Flex align="center" gap="3">
            {active.paused
              ? <Badge color="amber" variant="soft" size="2"><Pause weight="fill" size={10} /> PAUSED</Badge>
              : <Badge color="red" variant="soft" size="2"><span className="rec-dot" /> REC</Badge>}
            <Heading size="4">{active.name}</Heading>
            <Text size="2" color="gray">#{active.id}</Text>
            {auto && <Badge color="cyan" variant="outline">auto steps</Badge>}
          </Flex>
          <Flex align="center" gap="3" wrap="wrap">
            <Text size="2" color="gray" className="mono">{elapsed}</Text>
            {active.mode === 'snapshot' && <Badge variant="outline" color="gray">snapshot mode</Badge>}
            {floating.supported
              ? (
                <Button variant="soft" color="gray" onClick={() => void (floating.isOpen ? floating.close() : floating.open())} className="press">
                  <PictureInPicture /> {floating.isOpen ? 'Close floating window' : 'Pop out'}
                </Button>
              )
              : <Text size="1" color="gray">Pop out needs Chrome or Edge</Text>}
            {active.paused
              ? <Button variant="soft" onClick={() => void actions.resume()} loading={actions.busy === 'resume'} className="press"><Play weight="fill" /> Resume</Button>
              : <Button variant="soft" color="amber" onClick={() => void actions.pause()} loading={actions.busy === 'pause'} className="press"><Pause weight="fill" /> Pause</Button>}
            <Button variant={noting ? 'solid' : 'soft'} color="amber" onClick={() => setNote(noting ? null : '')} aria-expanded={noting} className="press">
              <Flag weight="fill" /> Flag
            </Button>
            <Button color="red" variant="soft" onClick={() => void actions.stop()} loading={actions.busy === 'stop'} className="press">
              <Stop weight="fill" /> Stop
            </Button>
          </Flex>
        </Flex>

        {noting && (
          <form onSubmit={addFlag}>
            <Flex gap="2" mb="4">
              <Box flexGrow="1">
                <TextField.Root ref={noteInput} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Flag note"
                  placeholder="What looks wrong? (optional) e.g. the total shows 0.00"
                  onKeyDown={(e) => { if (e.key === 'Escape') setNote(null); }} />
              </Box>
              <Button type="submit" color="amber" loading={actions.busy === 'flag'}>Flag step {current.seq}</Button>
            </Flex>
          </form>
        )}

        <form onSubmit={addStep}>
          <Text as="label" size="2" weight="medium" htmlFor="step-name">{auto ? 'Name the next action (optional)' : 'Next step'}</Text>
          <Flex gap="2" mt="2">
            <Box flexGrow="1">
              <TextField.Root id="step-name" ref={input} size="3" autoFocus value={stepName}
                onChange={(e) => setStepName(e.target.value)} placeholder={auto ? 'Leave empty and Propmaster names it, e.g. Click Place Order' : 'What are you about to do? e.g. Click Place Order'} />
            </Box>
            <Button type="submit" size="3" loading={actions.busy === 'step'} className="press">
              <Plus weight="bold" /> Add step
            </Button>
          </Flex>
          <Text as="p" size="1" color={active.paused ? 'amber' : 'gray'} mt="2">
            {active.paused
              ? `Paused: changes are not recorded until you resume. Now on step ${current.seq}: ${current.name}.`
              : auto
                ? `Just test: each action becomes a step when the app goes quiet for ${active.autoSplitMs! / 1000} s. Type a name first if you want to choose it.`
                : `Press Enter to add it, then do that action in the app. Now on step ${current.seq}: ${current.name}.`}
            {floating.supported && !floating.isOpen && ' Pop out keeps these controls on top of the app you are testing.'}
          </Text>
        </form>
        {actions.error && <Box mt="4"><ErrorCallout error={actions.error} /></Box>}
      </Card>

      {live.error && <Box mb="4"><ErrorCallout error={live.error} /></Box>}
      {!live.data ? <TimelineSkeleton /> : (
        live.data.summary.changes === 0 && active.stepSeq === 0 && live.data.steps.every((st) => st.markers.length === 0)
          ? auto
            ? <EmptyState icon={<Plus size={32} />} title="Waiting for the first action">Do something in the app. Each action appears here as a step, named after what it changed.</EmptyState>
            : <EmptyState icon={<Plus size={32} />} title="No steps yet">Add your first step above, then do it in the app. Changes appear here as they happen.</EmptyState>
          : <Timeline steps={live.data.steps} currentSeq={current.seq} sessionId={active.id} onRenamed={() => void live.refresh()} />
      )}
    </Box>
  );
}

function StoppedView({ stopped, onAgain, onRenamed }: { stopped: Recording; onAgain: () => void; onRenamed: () => void }) {
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
      <Timeline steps={stopped.steps} sessionId={stopped.id} onRenamed={onRenamed} />
    </Box>
  );
}

interface RecordPageProps {
  status: Status | null;
  statusError: ApiError | null;
  onChange: () => void;
  stopped: Recording | null;
  onStopped: (rec: Recording | null) => void;
  floating: FloatingControl;
}

export function RecordPage({ status, statusError, onChange, stopped, onStopped, floating }: RecordPageProps) {
  // Keep the page title in step with the recording, so the browser tab shows it too.
  useEffect(() => {
    document.title = status?.active ? `${status.active.paused ? '‖ PAUSED' : '● REC'} ${status.active.name} · Propmaster` : 'Propmaster';
  }, [status?.active]);

  if (!status) {
    return statusError ? <ErrorCallout error={statusError} /> : <TimelineSkeleton />;
  }
  return (
    <Box>
      <PageHeader
        title="Record"
        description={!status.active ? 'Record what your test does to the database, step by step.'
          : status.active.autoSplitMs ? 'Just test: each action becomes a step, named after what it changed.'
          : 'Add a step before each action. Changes appear as the app makes them.'}
      />
      {status.active
        ? <Recorder key={status.active.id} status={status} onChange={onChange} onStopped={onStopped} floating={floating} />
        : stopped
          ? <StoppedView stopped={stopped} onAgain={() => onStopped(null)}
              onRenamed={() => void api<Recording>('GET', `/sessions/${stopped.id}`).then(onStopped)} />
          : <StartForm installed={status.installed} onStarted={() => { onStopped(null); onChange(); }} />}
    </Box>
  );
}
