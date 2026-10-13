import { Box, Button, Callout, Code, DropdownMenu, Flex, IconButton, Select, Text, Theme, Tooltip } from '@radix-ui/themes';
import {
  ArrowClockwise, Desktop, FlagCheckered, GearSix, House, ListChecks, MagnifyingGlass, Moon, Plant, Record, Rows, Sun,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, STALE_SERVER_EVENT } from './api';
import { CommandPalette } from './components/CommandPalette';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ErrorCallout, RetryButton } from './components/Feedback';
import { Stepper } from './components/Stepper';
import { FinishTestDialog, NewTestDialog } from './components/TestDialogs';
import { floatingSupported, useFloatingWindow } from './floating';
import { toError, useLoad, useRoute, useTheme, type Route, type ThemeChoice } from './hooks';
import { FindPage } from './pages/FindPage';
import { HomePage } from './pages/HomePage';
import { RecordPage } from './pages/RecordPage';
import { RulesPage } from './pages/RulesPage';
import { SeedPage } from './pages/SeedPage';
import { SessionsPage } from './pages/SessionsPage';
import { SetupPage } from './pages/SetupPage';
import type { ApiError, Config, Recording, Status } from './types';
import { stagesOf, useWorkspace, WorkspaceProvider } from './workspace';

const TABS: { to: Route['page']; label: string; icon: ReactNode }[] = [
  { to: 'home', label: 'Home', icon: <House /> },
  { to: 'record', label: 'Record', icon: <Record /> },
  { to: 'sessions', label: 'Sessions', icon: <Rows /> },
  { to: 'find', label: 'Find data', icon: <MagnifyingGlass /> },
  { to: 'seed', label: 'Seed & clean', icon: <Plant /> },
  { to: 'rules', label: 'Rules', icon: <ListChecks /> },
];

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

const THEME_ICON: Record<ThemeChoice, ReactNode> = { light: <Sun />, dark: <Moon />, system: <Desktop /> };

function ThemeMenu({ choice, onChange }: { choice: ThemeChoice; onChange: (c: ThemeChoice) => void }) {
  return (
    <DropdownMenu.Root>
      <Tooltip content="Appearance">
        <DropdownMenu.Trigger>
          <IconButton variant="ghost" color="gray" size="2" aria-label={`Appearance: ${choice}`}>{THEME_ICON[choice]}</IconButton>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Content align="end">
        <DropdownMenu.RadioGroup value={choice} onValueChange={(v) => onChange(v as ThemeChoice)}>
          <DropdownMenu.RadioItem value="light"><Sun /> Light</DropdownMenu.RadioItem>
          <DropdownMenu.RadioItem value="dark"><Moon /> Dark</DropdownMenu.RadioItem>
          <DropdownMenu.RadioItem value="system"><Desktop /> Match the system</DropdownMenu.RadioItem>
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

/** The test you are on, shown under the top bar on every working page. */
function TestStrip({ status, page, onFinish }: { status: Status | null; page: string; onFinish: () => void }) {
  const ws = useWorkspace();
  if (!ws.test) return null;
  return (
    <div className="test-strip">
      <div className="test-strip-inner">
        <a href="#home" className="test-strip-name" title="Open the test on Home">
          <span className="eyebrow">Test</span> <span className="test-strip-text">{ws.test.name}</span>
        </a>
        <Stepper stages={stagesOf(ws.test, status?.active ?? null)} compact current={page} />
        {!ws.test.cleanedAt && <Button size="1" variant="soft" onClick={onFinish}><FlagCheckered /> Finish</Button>}
      </div>
    </div>
  );
}

interface ShellProps {
  route: Route;
  config: ReturnType<typeof useLoad<Config>>;
  status: ReturnType<typeof useLoad<Status>>;
  theme: ReturnType<typeof useTheme>;
  stopped: Recording | null;
  setStopped: (r: Recording | null) => void;
  floating: ReturnType<typeof useFloatingWindow>;
}

function Shell({ route, config, status, theme, stopped, setStopped, floating }: ShellProps) {
  const ws = useWorkspace();
  const stale = useStaleServer();
  const hasProfile = (config.data?.profiles.length ?? 0) > 0;
  const recording = status.data?.active ?? null;
  const [palette, setPalette] = useState(false);
  const [newTest, setNewTest] = useState(false);
  const [finishing, setFinishing] = useState(false);
  // Bumped to start the current page afresh (the palette picked a recipe on the Find page, say).
  const [fresh, setFresh] = useState(0);
  const me = useLoad(() => api<{ me: string }>('GET', '/claimer').then((r) => r.me), [config.data?.active]);

  // A recording started from here, the floating window or the terminal belongs to the current test.
  useEffect(() => {
    if (recording?.id) ws.addSession(recording.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording?.id]);

  // Another tab (or the terminal) switched the database: follow the server, so this tab never shows one
  // database's name while acting on another.
  const serverActive = status.data?.profile.name;
  useEffect(() => {
    if (serverActive && config.data && serverActive !== config.data.active) void config.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverActive, config.data?.active]);

  // Ctrl+K / ⌘K anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The tab title shows a live recording on every page, and clears when it stops (also from the floating window).
  useEffect(() => {
    document.title = recording ? `${recording.paused ? '‖ PAUSED' : '● REC'} ${recording.name} · Propmaster` : 'Propmaster';
  }, [recording?.name, recording?.paused, Boolean(recording)]);

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
  const go = useCallback((hash: string, startFresh = false) => {
    if (startFresh) setFresh((n) => n + 1);
    location.hash = hash;
  }, []);
  const openFinish = useCallback(() => setFinishing(true), []);
  const openNew = useCallback(() => setNewTest(true), []);

  const page = !config.data ? null
    : !hasProfile || route.page === 'setup'
      ? <SetupPage config={config.data} status={status.data} onChanged={onProfilesChanged} />
      : route.page === 'home' ? <HomePage status={status.data} me={me.data ?? ''} onFinish={openFinish} onNew={openNew} />
      : route.page === 'sessions' ? <SessionsPage selectedId={route.id} activeProfile={config.data.active} />
      : route.page === 'rules' ? <RulesPage activeProfile={config.data.active} />
      : route.page === 'find' ? <FindPage activeProfile={config.data.active} />
      : route.page === 'seed' ? <SeedPage activeProfile={config.data.active} session={route.session} />
      : <RecordPage status={status.data} statusError={status.error} onChange={status.refresh} stopped={stopped} onStopped={setStopped}
          defaultName={ws.test && !ws.test.cleanedAt ? ws.test.name : ''}
          floating={{ supported: floatingSupported, isOpen: floating.isOpen, open: floating.open, close: floating.close }} />;

  const current = !hasProfile ? 'setup' : route.page;
  const showStrip = hasProfile && route.page !== 'home' && route.page !== 'setup';

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-row">
          <a href="#home" className="brand" aria-label="Propmaster home">
            <span className="brand-mark" aria-hidden>P</span>
            <span className="brand-name">Propmaster</span>
          </a>

          {hasProfile && (
            <nav className="tabs" aria-label="Main">
              {TABS.map((t) => (
                <a key={t.to} href={`#${t.to}`} className="tab" aria-current={current === t.to ? 'page' : undefined}>
                  {t.icon}<span>{t.label}</span>
                  {t.to === 'record' && recording && <span className="rec-dot" aria-label="recording" />}
                </a>
              ))}
            </nav>
          )}

          <div className="topbar-tools">
            {hasProfile && (
              <button type="button" className="search-button" onClick={() => setPalette(true)} aria-label="Search and commands (Ctrl+K)">
                <MagnifyingGlass /><span className="search-label">Search or jump to…</span><kbd>Ctrl K</kbd>
              </button>
            )}
            {recording && (
              <a href="#record" className={recording.paused ? 'rec-pill rec-pill-paused' : 'rec-pill'} title={`Recording “${recording.name}”`}>
                {recording.paused ? '‖' : <span className="rec-dot" />} <span className="rec-pill-text">{recording.paused ? 'Paused' : 'REC'}</span>
              </a>
            )}
            {hasProfile && config.data && (
              <Select.Root value={config.data.active ?? undefined} onValueChange={(v) => void switchProfile(v)} disabled={Boolean(recording)}>
                <Tooltip content={recording ? 'Stop the recording to switch databases' : (status.data?.profile.display ?? 'Database')}>
                  <Select.Trigger id="profile-select" variant="soft" color="gray" className="db-select" aria-label="Database" />
                </Tooltip>
                <Select.Content position="popper" align="end">
                  {config.data.profiles.map((p) => <Select.Item key={p.name} value={p.name}>{p.name}</Select.Item>)}
                </Select.Content>
              </Select.Root>
            )}
            <ThemeMenu choice={theme.choice} onChange={theme.setChoice} />
            <Tooltip content="Setup">
              <IconButton variant={current === 'setup' ? 'soft' : 'ghost'} color="gray" size="2" aria-label="Setup" onClick={() => go('setup')}>
                <GearSix />
              </IconButton>
            </Tooltip>
          </div>
        </div>
        {showStrip && <TestStrip status={status.data} page={route.page} onFinish={openFinish} />}
      </header>

      <main className="main">
        <div className="page">
          {stale && <StaleBanner kind={stale} />}
          {switchError && <Box mb="4"><ErrorCallout error={switchError} /></Box>}
          {config.error && !config.data && <ConfigError error={config.error} onRetry={() => void config.refresh()} />}
          {/* Keyed by database and page: switching either starts the page afresh (no selection, preview or
              result from the other database survives), and moving to another page clears a crash. */}
          <ErrorBoundary key={`${config.data?.active ?? ''}/${route.page}/${'id' in route ? route.id ?? '' : 'session' in route ? route.session ?? '' : ''}/${fresh}`}>
            <div className="page-enter">{page}</div>
          </ErrorBoundary>
        </div>
      </main>

      <CommandPalette open={palette} onOpenChange={setPalette} go={go} setTheme={theme.setChoice} hasProfile={hasProfile}
        onNewTest={openNew} onFinishTest={() => { go('home'); openFinish(); }} />
      <NewTestDialog open={newTest} onOpenChange={setNewTest} />
      <FinishTestDialog open={finishing} onOpenChange={setFinishing} recording={Boolean(recording)} />
      <Text as="span" className="sr-only" aria-live="polite">{recording ? `Recording ${recording.name}` : ''}</Text>
    </div>
  );
}

export function App() {
  const [route] = useRoute();
  const theme = useTheme();
  const config = useLoad(() => api<Config>('GET', '/config'), []);
  const hasProfile = (config.data?.profiles.length ?? 0) > 0;
  // The top bar's recording indicator, and every page, use the same live status.
  const status = useLoad(() => api<Status>('GET', '/status'), [config.data?.active], hasProfile ? 2000 : undefined);
  // The last stopped recording, shown on the Record page whether it was stopped there or in the floating window.
  const [stopped, setStopped] = useState<Recording | null>(null);
  // Lives here, not on the Record page, so the floating window stays open while you look at other pages.
  const floating = useFloatingWindow({ appearance: theme.appearance, onChange: () => void status.refresh(), onStopped: setStopped });

  return (
    <Theme appearance={theme.appearance} accentColor="indigo" grayColor="slate" radius="large" scaling="100%" panelBackground="solid">
      <WorkspaceProvider profile={config.data?.active ?? null}>
        <Shell route={route} config={config} status={status} theme={theme} stopped={stopped} setStopped={setStopped} floating={floating} />
      </WorkspaceProvider>
    </Theme>
  );
}
