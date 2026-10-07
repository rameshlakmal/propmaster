// The floating recorder: a small always-on-top window (Document Picture-in-Picture, Chrome and Edge)
// with the recording controls, so testers can add steps without leaving the app they are testing.
//
// It is a separate React root inside the floating window's document: React portals don't receive
// events from another window. It polls with the floating window's own timers, because the browser
// slows down timers in the Propmaster tab once it is in the background. Radix components that open
// portals (Dialog, Select, Tooltip) would open in the main window, so the panel doesn't use them.
import { Badge, Box, Button, Flex, IconButton, Text, TextField, Theme } from '@radix-ui/themes';
import { ArrowSquareIn, Flag, Pause, Play, Plus, Stop, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api } from './api';
import { ErrorCallout } from './components/Feedback';
import { useElapsed, useLoad } from './hooks';
import { useRecorderActions, type RecorderCallbacks } from './recorder';
import type { Recording, Status } from './types';

interface DocumentPictureInPicture {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
  window: Window | null;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

export const floatingSupported = typeof window !== 'undefined' && 'documentPictureInPicture' in window;

const FEED_SIZE = 6;

/** Copies the app's styles into the floating window: the same fonts, theme and colours. */
function copyStyles(target: Document): void {
  for (const node of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
    const copy = node.cloneNode(true) as HTMLElement;
    if (copy instanceof HTMLLinkElement) copy.href = (node as HTMLLinkElement).href; // absolute, as the new document has no base URL of its own
    target.head.append(copy);
  }
}

export interface FloatingProps extends RecorderCallbacks {
  appearance: 'light' | 'dark';
}

/** Opens and closes the floating window, and keeps its panel rendered with the latest props. */
export function useFloatingWindow(props: FloatingProps) {
  const [win, setWin] = useState<Window | null>(null);
  const root = useRef<Root | null>(null);

  const open = async () => {
    const pip = window.documentPictureInPicture;
    if (!pip) return;
    if (pip.window) { pip.window.focus(); return; }
    const w = await pip.requestWindow({ width: 380, height: 520 });
    w.document.title = 'Propmaster recorder';
    copyStyles(w.document);
    const mount = w.document.createElement('div');
    w.document.body.style.margin = '0';
    w.document.body.append(mount);
    root.current = createRoot(mount);
    w.addEventListener('pagehide', () => {
      root.current?.unmount();
      root.current = null;
      setWin(null);
    });
    setWin(w);
  };

  const close = () => win?.close();

  // Render on every change of props, so the panel always has the current callbacks and appearance.
  useEffect(() => {
    if (!win || !root.current) return;
    root.current.render(
      <Theme appearance={props.appearance} accentColor="cyan" grayColor="slate" radius="medium" className="floating-theme">
        <FloatingPanel win={win} onChange={props.onChange} onStopped={props.onStopped} onClose={close} />
      </Theme>,
    );
  });

  // Closing the Propmaster tab closes the floating window too (the browser does that), and so does leaving the app.
  useEffect(() => () => window.documentPictureInPicture?.window?.close(), []);

  return { isOpen: win !== null, open, close };
}

function LiveFeed({ rec, stepSeq }: { rec: Recording; stepSeq: number }) {
  const all = rec.steps.flatMap((s) => s.changes.map((c) => ({ ...c, seq: s.seq })));
  const latest = all.slice(-FEED_SIZE).reverse();
  const inStep = rec.steps.find((s) => s.seq === stepSeq)?.changes.length ?? 0;
  return (
    <Box className="floating-feed">
      <Flex justify="between" align="baseline" mb="2">
        <Text size="1" weight="medium" color="gray">Latest changes</Text>
        <Text size="1" color="gray">{inStep} this step · {all.length} in all</Text>
      </Flex>
      {latest.length === 0
        ? <Text as="p" size="1" color="gray">Nothing yet. Changes appear here as the app makes them.</Text>
        : (
          <Flex direction="column" gap="1" asChild>
            <ul className="floating-list" aria-live="polite">
              {latest.map((c) => (
                <li key={c.id}>
                  <span className={`op op-${c.op}`}>{c.op.toLowerCase()}</span>
                  <Text size="1" weight="medium" className="floating-table">{c.table}</Text>
                  <Text size="1" color="gray" className="mono floating-key">{c.key ?? ''}</Text>
                  {c.seq !== stepSeq && <Text size="1" color="gray">s{c.seq}</Text>}
                </li>
              ))}
            </ul>
          </Flex>
        )}
    </Box>
  );
}

export function FloatingPanel({ win, onChange, onStopped, onClose }: RecorderCallbacks & { win: Window; onClose: () => void }) {
  const status = useLoad(() => api<Status>('GET', '/status'), [], 1500, win);
  const active = status.data?.active ?? null;
  const live = useLoad(() => (active ? api<Recording>('GET', `/sessions/${active.id}`) : Promise.resolve(null)), [active?.id, active?.stepSeq], 1500, win);
  const elapsed = useElapsed(active?.startedAt ?? null, win);
  const [stepName, setStepName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const stepInput = useRef<HTMLInputElement>(null);
  const noteInput = useRef<HTMLInputElement>(null);

  const actions = useRecorderActions({
    onChange: () => { onChange(); void status.refresh(); void live.refresh(); },
    onStopped,
  });

  const noting = note !== null;
  useEffect(() => { if (noting) noteInput.current?.focus(); }, [noting]);

  const addStep = async (e: FormEvent) => {
    e.preventDefault();
    if (stepName.trim() && (await actions.step(stepName.trim()))) setStepName('');
    stepInput.current?.focus();
  };
  const addFlag = async (e: FormEvent) => {
    e.preventDefault();
    if (await actions.flag(note ?? '')) setNote(null);
    stepInput.current?.focus();
  };

  if (!status.data) {
    return <Box p="4" className="floating"><Text size="2" color="gray">{status.error ? status.error.message : 'Connecting…'}</Text></Box>;
  }

  if (!active) {
    return (
      <Flex direction="column" gap="3" p="4" className="floating">
        <Text size="3" weight="bold">Not recording</Text>
        <Text size="2" color="gray">The recording stopped. Its timeline is in the Propmaster tab.</Text>
        <Flex gap="2">
          <Button variant="soft" onClick={() => { window.focus(); onClose(); }}><ArrowSquareIn /> Back to Propmaster</Button>
          <Button variant="ghost" color="gray" onClick={onClose}>Close</Button>
        </Flex>
      </Flex>
    );
  }

  const paused = active.paused;
  return (
    <Flex direction="column" gap="3" p="3" className="floating">
      <Flex align="center" justify="between" gap="2">
        <Flex align="center" gap="2" minWidth="0">
          {paused
            ? <Badge color="amber" variant="soft" size="2"><Pause weight="fill" size={10} /> PAUSED</Badge>
            : <Badge color="red" variant="soft" size="2"><span className="rec-dot" /> REC</Badge>}
          <Text size="2" weight="bold" truncate>{active.name}</Text>
        </Flex>
        <Flex align="center" gap="2">
          <Text size="2" color="gray" className="mono">{elapsed}</Text>
          <IconButton size="1" variant="ghost" color="gray" onClick={onClose} aria-label="Close the floating window"><X /></IconButton>
        </Flex>
      </Flex>

      <Box className="floating-step">
        <Text as="p" size="1" color="gray">Now on step {active.stepSeq}</Text>
        <Text as="p" size="2" weight="medium" truncate>{active.stepName}</Text>
        {paused && <Text as="p" size="1" color="amber" mt="1">Changes are not recorded until you resume.</Text>}
      </Box>

      <form onSubmit={addStep}>
        <Flex gap="2">
          <Box flexGrow="1">
            <TextField.Root ref={stepInput} autoFocus value={stepName} onChange={(e) => setStepName(e.target.value)}
              placeholder="Next step, then Enter" aria-label="Next step" />
          </Box>
          <IconButton type="submit" loading={actions.busy === 'step'} disabled={!stepName.trim()} aria-label="Add step" className="press"><Plus weight="bold" /></IconButton>
        </Flex>
      </form>

      <Flex gap="2">
        {paused
          ? <Button size="2" variant="soft" onClick={() => void actions.resume()} loading={actions.busy === 'resume'} className="press" style={{ flex: 1 }}><Play weight="fill" /> Resume</Button>
          : <Button size="2" variant="soft" color="amber" onClick={() => void actions.pause()} loading={actions.busy === 'pause'} className="press" style={{ flex: 1 }}><Pause weight="fill" /> Pause</Button>}
        <Button size="2" variant={note !== null ? 'solid' : 'soft'} color="amber" onClick={() => setNote(note === null ? '' : null)} aria-expanded={note !== null} className="press" style={{ flex: 1 }}>
          <Flag weight="fill" /> Flag
        </Button>
        <Button size="2" variant="soft" color="red" onClick={() => void actions.stop()} loading={actions.busy === 'stop'} className="press" style={{ flex: 1 }}><Stop weight="fill" /> Stop</Button>
      </Flex>

      {note !== null && (
        <form onSubmit={addFlag}>
          <Flex gap="2">
            <Box flexGrow="1">
              <TextField.Root ref={noteInput} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What looks wrong? (optional)" aria-label="Flag note"
                onKeyDown={(e) => { if (e.key === 'Escape') { setNote(null); stepInput.current?.focus(); } }} />
            </Box>
            <Button type="submit" color="amber" loading={actions.busy === 'flag'}>Flag step</Button>
          </Flex>
        </form>
      )}

      {actions.error && <ErrorCallout error={actions.error} />}
      {live.data && <LiveFeed rec={live.data} stepSeq={active.stepSeq} />}
    </Flex>
  );
}
