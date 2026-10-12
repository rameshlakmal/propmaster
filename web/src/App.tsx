import { Box, Button, Callout, Code, Flex, Select, Text } from '@radix-ui/themes';
import { ArrowClockwise, Database, ListChecks, MagnifyingGlass, Plant, PlugsConnected, Record, Rows } from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, STALE_SERVER_EVENT } from './api';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ErrorCallout, RetryButton } from './components/Feedback';
import { floatingSupported, useFloatingWindow } from './floating';
import { toError, useLoad, useRoute, useSystemAppearance } from './hooks';
import { FindPage } from './pages/FindPage';
import { RecordPage } from './pages/RecordPage';
import { RulesPage } from './pages/RulesPage';
import { SeedPage } from './pages/SeedPage';
import { SessionsPage } from './pages/SessionsPage';
import { SetupPage } from './pages/SetupPage';
import type { ApiError, Config, Recording, Status } from './types';

function NavItem({ to, current, icon, children }: { to: string; current: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <button type="button" className="nav-item" aria-current={current ? 'page' : undefined} onClick={() => { location.hash = to; }}>
      {icon}
      <span style={{ flex: 1 }}>{children}</span>
    </button>
  );
}

/** The page and the server are from different builds: say what to do, rather than show wrong data. */
function useStaleServer(): 'restart-server' | 'reload-page' | null {
  const [stale, setStale] = useState<'restart-server' | 'reload-page' | null>(null);
  useEffect(() => {
    const on = (e: Event) => setStale((e as CustomEvent<{ pageIsNewer: boolean }>).detail.pageIsNewer ? 'restart-server' : 'reload-page');
    window.addEventListener(STALE_SERVER_EVENT, on);
    return () => window.removeEventListener(STALE_SERVER_EVENT, on);
  }, []);
  return stale;
}

function StaleBanner({ kind }: { kind: 'restart-server' | 'reload-page' }) {
  return (
    <Callout.Root color="amber" mb="5" role="alert">
      <Callout.Text>
        {kind === 'restart-server'
          ? <>Propmaster was updated after this server started, so some pages may show nothing or the wrong thing. Stop <Code>npm run ui</Code> (Ctrl+C) and start it again.</>
          : <>Propmaster was updated. Reload this page to use the new version. <Button size="1" variant="soft" ml="2" onClick={() => location.reload()}><ArrowClockwise /> Reload</Button></>}
      </Callout.Text>
    </Callout.Root>
  );
}

/** Without settings there is no page to show: say why, instead of a blank screen. */
function ConfigError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <Flex direction="column" gap="3" align="start">
      <ErrorCallout error={error} />
      <RetryButton onClick={onRetry} />
    </Flex>
  );
}

export function App() {
  const [route] = useRoute();
  const stale = useStaleServer();
  const config = useLoad(() => api<Config>('GET', '/config'), []);
  const hasProfile = (config.data?.profiles.length ?? 0) > 0;
  // The sidebar's recording indicator, and every page, use the same live status.
  const status = useLoad(() => api<Status>('GET', '/status'), [config.data?.active], hasProfile ? 2000 : undefined);
  // The last stopped recording, shown on the Record page whether it was stopped there or in the floating window.
  const [stopped, setStopped] = useState<Recording | null>(null);
  // Lives here, not on the Record page, so the floating window stays open while you look at other pages.
  const floating = useFloatingWindow({ appearance: useSystemAppearance(), onChange: () => void status.refresh(), onStopped: setStopped });

  // Another tab (or the terminal) switched the database: follow the server, so this tab never shows one
  // database's name while acting on another.
  const serverActive = status.data?.profile.name;
  useEffect(() => {
    if (serverActive && config.data && serverActive !== config.data.active) void config.refresh();
  }, [serverActive, config.data?.active]);

  const [switchError, setSwitchError] = useState<ApiError | null>(null);
  const switchProfile = async (name: string) => {
    setSwitchError(null);
    try {
      await api('POST', `/profiles/${encodeURIComponent(name)}/activate`);
    } catch (err) {
      setSwitchError(toError(err));
    }
    setStopped(null); // it belongs to the other database
    await config.refresh();
    await status.refresh();
  };
  const onProfilesChanged = async () => {
    setStopped(null);
    await config.refresh();
    await status.refresh();
  };

  const page = !config.data ? null
    : !hasProfile || route.page === 'setup'
      ? <SetupPage config={config.data} status={status.data} onChanged={onProfilesChanged} />
      : route.page === 'sessions' ? <SessionsPage selectedId={route.id} activeProfile={config.data.active} />
      : route.page === 'rules' ? <RulesPage activeProfile={config.data.active} />
      : route.page === 'find' ? <FindPage activeProfile={config.data.active} />
      : route.page === 'seed' ? <SeedPage activeProfile={config.data.active} session={route.session} />
      : <RecordPage status={status.data} statusError={status.error} onChange={status.refresh} stopped={stopped} onStopped={setStopped}
          floating={{ supported: floatingSupported, isOpen: floating.isOpen, open: floating.open, close: floating.close }} />;

  const recording = status.data?.active;

  // The tab title shows a live recording on every page, and clears when it stops (also from the floating window).
  useEffect(() => {
    document.title = recording ? `${recording.paused ? '‖ PAUSED' : '● REC'} ${recording.name} · Propmaster` : 'Propmaster';
  }, [recording?.name, recording?.paused, Boolean(recording)]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>P</div>
          <Text size="3" weight="bold">Propmaster</Text>
        </div>

        {hasProfile && config.data && (
          <Box px="2">
            <Text as="label" size="1" color="gray" htmlFor="profile-select" weight="medium">Database</Text>
            <Select.Root value={config.data.active ?? undefined} onValueChange={(v) => void switchProfile(v)} disabled={Boolean(recording)}>
              <Select.Trigger id="profile-select" style={{ width: '100%', marginTop: 6 }} variant="surface" />
              <Select.Content position="popper">
                {config.data.profiles.map((p) => (
                  <Select.Item key={p.name} value={p.name}>{p.name}</Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            {status.data && <Text as="p" size="1" color="gray" mt="1" className="mono">{status.data.profile.display}</Text>}
          </Box>
        )}

        <nav className="nav" aria-label="Main">
          <NavItem to="record" current={route.page === 'record' && hasProfile} icon={<Record size={18} weight={recording ? 'fill' : 'regular'} />}>
            <Flex align="center" justify="between">
              Record
              {recording && <Flex align="center" gap="2"><span className="rec-dot" /><Text size="1" color="red" weight="medium">REC</Text></Flex>}
            </Flex>
          </NavItem>
          <NavItem to="sessions" current={route.page === 'sessions'} icon={<Rows size={18} />}>Sessions</NavItem>
          <NavItem to="rules" current={route.page === 'rules'} icon={<ListChecks size={18} />}>Rules</NavItem>
          <NavItem to="find" current={route.page === 'find'} icon={<MagnifyingGlass size={18} />}>Find data</NavItem>
          <NavItem to="seed" current={route.page === 'seed'} icon={<Plant size={18} />}>Seed &amp; clean</NavItem>
          <NavItem to="setup" current={route.page === 'setup' || !hasProfile} icon={<PlugsConnected size={18} />}>Setup</NavItem>
        </nav>

        <Box mt="auto" px="2">
          {status.data && (
            <Flex align="center" gap="2">
              <Database size={14} color="var(--gray-9)" />
              <Text size="1" color="gray">
                {status.data.installed ? `${status.data.watchedTables} tables watched` : 'Recorder not installed'}
              </Text>
            </Flex>
          )}
        </Box>
      </aside>

      <main className="main">
        <div className="page">
          {stale && <StaleBanner kind={stale} />}
          {switchError && <Box mb="4"><ErrorCallout error={switchError} /></Box>}
          {config.error && !config.data && <ConfigError error={config.error} onRetry={() => void config.refresh()} />}
          {/* Keyed by database and page: switching either starts the page afresh (no selection, preview or
              result from the other database survives), and moving to another page clears a crash. */}
          <ErrorBoundary key={`${config.data?.active ?? ''}/${route.page}/${'id' in route ? route.id ?? '' : 'session' in route ? route.session ?? '' : ''}`}>{page}</ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
