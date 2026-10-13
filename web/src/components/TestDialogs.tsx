// Starting a test (a name), and finishing one: release its claims, delete the rows seeded for it and,
// if wanted, undo what the app changed while it was recorded, with the usual preview first.
import { Box, Button, Callout, Checkbox, Dialog, Flex, Text, TextField } from '@radix-ui/themes';
import { FlagCheckered, Info } from '@phosphor-icons/react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { toError } from '../hooks';
import type { ApiError, ClaimRow, Run, SessionSummary } from '../types';
import { useWorkspace } from '../workspace';
import { CleanPanel, type CleanTarget } from './CleanPanel';
import { ErrorCallout } from './Feedback';

export function NewTestDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const [name, setName] = useState('');
  useEffect(() => { if (open) setName(''); }, [open]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    ws.start(name);
    onOpenChange(false);
    location.hash = 'home';
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="480px">
        <Dialog.Title>Start a new test</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          Name it after your test case. The data you claim and seed, what you record, and the rules you check are gathered under it, so you can tidy up in one go at the end.
        </Dialog.Description>
        {ws.test && !ws.test.cleanedAt && (ws.test.claims.length > 0 || ws.test.runs.length > 0) && (
          <Callout.Root color="amber" size="1" mb="4">
            <Callout.Icon><Info /></Callout.Icon>
            <Callout.Text>“{ws.test.name}” hasn't been cleaned up. Its claims and seeded rows stay in the database; you can still clean them on the Seed &amp; clean and Find data pages.</Callout.Text>
          </Callout.Root>
        )}
        <form onSubmit={submit}>
          <TextField.Root size="3" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. TC-142 Guest checkout" aria-label="Test name" />
          <Flex gap="3" mt="4" justify="end">
            <Dialog.Close><Button type="button" variant="soft" color="gray">Cancel</Button></Dialog.Close>
            <Button type="submit">Start test</Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

interface Loaded {
  claims: ClaimRow[];
  runs: Run[];
  sessions: SessionSummary[];
}

export function FinishTestDialog({ open, onOpenChange, recording }: { open: boolean; onOpenChange: (open: boolean) => void; recording: boolean }) {
  const ws = useWorkspace();
  const test = ws.test;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [release, setRelease] = useState(true);
  const [cleanRuns, setCleanRuns] = useState(true);
  const [undo, setUndo] = useState(false);
  const [target, setTarget] = useState<CleanTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [released, setReleased] = useState<number | null>(null);

  // What is still there to tidy: live claims, runs not cleaned yet, stopped sessions with changes.
  useEffect(() => {
    if (!open || !test) return;
    setLoaded(null); setError(null); setTarget(null); setReleased(null); setUndo(false); setRelease(true); setCleanRuns(true);
    let live = true;
    void Promise.all([
      api<{ claims: ClaimRow[] }>('GET', '/claims'),
      api<{ runs: Run[] }>('GET', '/runs'),
      api<{ sessions: SessionSummary[] }>('GET', '/sessions?page=1&pageSize=100'),
    ]).then(([c, r, s]) => {
      if (!live) return;
      const ids = new Set(test.claims.map((x) => x.id));
      setLoaded({
        claims: c.claims.filter((x) => ids.has(x.id) && !x.expired),
        runs: r.runs.filter((x) => test.runs.includes(x.id)),
        sessions: s.sessions.filter((x) => test.sessions.includes(x.id) && x.stoppedAt && x.changeCount > 0),
      });
    }, (err) => { if (live) setError(toError(err)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!test) return null;
  const session = loaded?.sessions.at(-1);
  const nothing = loaded && loaded.claims.length === 0 && loaded.runs.length === 0 && !session;

  const go = async () => {
    if (!loaded) return;
    setBusy(true);
    setError(null);
    try {
      if (release && loaded.claims.length) {
        let n = 0;
        for (const c of loaded.claims) {
          try { await api('POST', `/claims/${c.id}/release`); n++; } catch { /* gone or taken over: nothing to release */ }
        }
        setReleased(n);
      }
      const runIds = cleanRuns ? loaded.runs.map((r) => r.id) : [];
      const sessionId = undo && session ? session.id : undefined;
      if (runIds.length || sessionId) {
        setTarget({ runIds: runIds.length ? runIds : undefined, sessionId, label: test.name });
      } else {
        ws.markCleaned();
      }
    } catch (err) {
      setError(toError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth={target ? '920px' : '520px'}>
        <Dialog.Title><Flex align="center" gap="2"><FlagCheckered /> Finish “{test.name}”</Flex></Dialog.Title>
        {recording && (
          <Callout.Root color="amber" size="1" mb="3">
            <Callout.Icon><Info /></Callout.Icon>
            <Callout.Text>A recording is still running. Stop it on the Record page first, so everything it changed can be undone.</Callout.Text>
          </Callout.Root>
        )}
        {error && <Box mb="3"><ErrorCallout error={error} /></Box>}
        {!loaded && !error && <Text size="2" color="gray">Looking at what this test left behind…</Text>}

        {loaded && !target && (
          nothing ? (
            <Flex direction="column" gap="4">
              <Text size="2">Nothing is left to tidy: no live claims, no seeded rows, no recorded changes.</Text>
              <Flex gap="3" justify="end">
                <Button variant="soft" color="gray" onClick={() => { ws.markCleaned(); onOpenChange(false); }}>Mark as done</Button>
                <Button onClick={() => { ws.end(); onOpenChange(false); }}>Close the test</Button>
              </Flex>
            </Flex>
          ) : (
            <Flex direction="column" gap="3">
              <Text size="2" color="gray">Leave the database as you found it, for the next tester.</Text>
              <Choice checked={release} onChange={setRelease} disabled={!loaded.claims.length}
                title={`Release ${loaded.claims.length} ${loaded.claims.length === 1 ? 'claim' : 'claims'}`}
                detail={loaded.claims.length ? loaded.claims.map((c) => `${c.table.replace(/^public\./, '')} ${c.key}`).join(', ') : 'No live claims.'} />
              <Choice checked={cleanRuns} onChange={setCleanRuns} disabled={!loaded.runs.length}
                title={`Delete the rows seeded for it (${loaded.runs.reduce((n, r) => n + r.rows, 0)} rows)`}
                detail={loaded.runs.length ? loaded.runs.map((r) => `run #${r.id} ${r.scenario}`).join(', ') : 'Nothing seeded, or already cleaned.'} />
              <Choice checked={undo} onChange={setUndo} disabled={!session}
                title="Undo what the app changed while recording"
                detail={session ? `Session #${session.id} “${session.name}”: ${session.changeCount} changes, put back newest first. Rows someone changed since are left alone.` : 'No stopped recording with changes.'} />
              <Flex gap="3" justify="end" mt="2">
                <Dialog.Close><Button variant="soft" color="gray">Not now</Button></Dialog.Close>
                <Button onClick={() => void go()} loading={busy} disabled={!release && !cleanRuns && !undo}>
                  {cleanRuns && loaded.runs.length || undo && session ? 'Preview cleanup' : 'Release claims'}
                </Button>
              </Flex>
            </Flex>
          )
        )}

        {released !== null && <Text as="p" size="2" color="grass" mb="3">Released {released} {released === 1 ? 'claim' : 'claims'}.</Text>}
        {target && (
          <CleanPanel target={target} onClose={() => onOpenChange(false)} onRestore={() => { onOpenChange(false); location.hash = 'seed'; }}
            onDone={() => ws.markCleaned()} />
        )}
        {!target && released !== null && (
          <Flex justify="end" mt="2"><Button onClick={() => onOpenChange(false)}>Done</Button></Flex>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function Choice({ checked, onChange, disabled, title, detail }: { checked: boolean; onChange: (v: boolean) => void; disabled: boolean; title: string; detail: string }) {
  return (
    <Text as="label" size="2" className={`choice${disabled ? ' choice-disabled' : ''}`}>
      <Flex gap="3" align="start">
        <Checkbox mt="1" checked={checked && !disabled} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} />
        <Box>
          <Text as="div" weight="medium">{title}</Text>
          <Text as="div" size="1" color="gray">{detail}</Text>
        </Box>
      </Flex>
    </Text>
  );
}
