// ⌘K / Ctrl+K: go anywhere and do the common things without the mouse. Pages and actions are always
// there; recipes, scenarios and recent sessions are loaded when it opens.
import { Dialog, Text, VisuallyHidden } from '@radix-ui/themes';
import {
  ArrowRight, Desktop, FlagCheckered, House, ListChecks, MagnifyingGlass, Moon, Plant, PlugsConnected, Plus, Record, Rows, Sun,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { ThemeChoice } from '../hooks';
import type { RecipesSource, ScenariosSource, SessionPage } from '../types';

export interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Goes to a page; `fresh` starts it afresh even when it is already showing. */
  go: (hash: string, fresh?: boolean) => void;
  setTheme: (c: ThemeChoice) => void;
  onNewTest: () => void;
  onFinishTest: () => void;
  hasProfile: boolean;
}

function score(c: Command, words: string[]): number {
  if (!words.length) return 1;
  const label = c.label.toLowerCase();
  const hay = `${label} ${c.hint ?? ''} ${c.group} ${c.keywords ?? ''}`.toLowerCase();
  if (!words.every((w) => hay.includes(w))) return 0;
  return label.startsWith(words[0]!) ? 3 : label.includes(words[0]!) ? 2 : 1;
}

export function CommandPalette({ open, onOpenChange, go, setTheme, onNewTest, onFinishTest, hasProfile }: Props) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [extra, setExtra] = useState<Command[]>([]);
  const list = useRef<HTMLDivElement>(null);

  // What there is to search, read fresh each time it opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    if (!hasProfile) { setExtra([]); return; }
    let live = true;
    const pick = (key: string, id: string, hash: string) => () => {
      try { sessionStorage.setItem(key, id); } catch { /* fine */ }
      go(hash, true);
    };
    void Promise.allSettled([
      api<RecipesSource>('GET', '/recipes'),
      api<ScenariosSource>('GET', '/scenarios'),
      api<SessionPage>('GET', '/sessions?page=1&pageSize=15'),
    ]).then(([recipes, scenarios, sessions]) => {
      if (!live) return;
      const out: Command[] = [];
      if (recipes.status === 'fulfilled') {
        for (const r of recipes.value.recipes) {
          out.push({ id: `recipe:${r.id}`, group: 'Recipes', label: r.name, hint: r.tags.map((t) => `#${t}`).join(' '), keywords: r.description, icon: <MagnifyingGlass />, run: pick('propmaster-recipe', r.id, 'find') });
        }
      }
      if (scenarios.status === 'fulfilled') {
        for (const s of scenarios.value.scenarios) {
          out.push({ id: `scenario:${s.id}`, group: 'Scenarios', label: s.name, hint: s.tags.map((t) => `#${t}`).join(' '), keywords: s.description, icon: <Plant />, run: pick('propmaster-scenario', s.id, 'seed') });
        }
      }
      if (sessions.status === 'fulfilled') {
        for (const s of sessions.value.sessions) {
          out.push({ id: `session:${s.id}`, group: 'Sessions', label: s.name, hint: `#${s.id} · ${s.changeCount} changes`, keywords: s.id, icon: <Rows />, run: () => go(`sessions/${s.id}`) });
        }
      }
      setExtra(out);
    });
    return () => { live = false; };
  }, [open, hasProfile, go]);

  const base = useMemo<Command[]>(() => [
    { id: 'go:home', group: 'Go to', label: 'Home', icon: <House />, keywords: 'dashboard test', run: () => go('home') },
    { id: 'go:record', group: 'Go to', label: 'Record', icon: <Record />, keywords: 'recording start stop step', run: () => go('record') },
    { id: 'go:sessions', group: 'Go to', label: 'Sessions', icon: <Rows />, keywords: 'recordings history export', run: () => go('sessions') },
    { id: 'go:find', group: 'Go to', label: 'Find data', icon: <MagnifyingGlass />, keywords: 'recipes claims', run: () => go('find') },
    { id: 'go:seed', group: 'Go to', label: 'Seed & clean', icon: <Plant />, keywords: 'scenarios runs backups restore undo', run: () => go('seed') },
    { id: 'go:rules', group: 'Go to', label: 'Rules', icon: <ListChecks />, keywords: 'check business', run: () => go('rules') },
    { id: 'go:setup', group: 'Go to', label: 'Setup', icon: <PlugsConnected />, keywords: 'connection database install settings', run: () => go('setup') },
    { id: 'do:new-test', group: 'Actions', label: 'Start a new test…', icon: <Plus />, keywords: 'test case begin', run: onNewTest },
    { id: 'do:finish-test', group: 'Actions', label: 'Finish test and clean up…', icon: <FlagCheckered />, keywords: 'release claims undo tidy done', run: onFinishTest },
    { id: 'theme:light', group: 'Appearance', label: 'Light theme', icon: <Sun />, run: () => setTheme('light') },
    { id: 'theme:dark', group: 'Appearance', label: 'Dark theme', icon: <Moon />, run: () => setTheme('dark') },
    { id: 'theme:system', group: 'Appearance', label: 'Match the system theme', icon: <Desktop />, run: () => setTheme('system') },
  ], [go, onNewTest, onFinishTest, setTheme]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Without a query: pages and actions. With one: everything, best matches first, at most 40.
  const shown = (words.length ? [...base, ...extra] : base)
    .map((c) => ({ c, s: score(c, words) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 40)
    .map((x) => x.c);
  const groups = [...new Set(shown.map((c) => c.group))];
  const ordered = groups.flatMap((g) => shown.filter((c) => c.group === g));
  const active = Math.min(index, Math.max(0, ordered.length - 1));

  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (c: Command | undefined) => {
    if (!c) return;
    onOpenChange(false);
    c.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content className="palette" maxWidth="600px" aria-describedby={undefined}>
        <VisuallyHidden><Dialog.Title>Search and commands</Dialog.Title></VisuallyHidden>
        <div className="palette-input">
          <MagnifyingGlass size={18} />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search pages, recipes, scenarios, sessions…"
            aria-label="Search" role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={ordered[active] ? `cmd-${active}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, ordered.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
              if (e.key === 'Enter') { e.preventDefault(); choose(ordered[active]); }
            }} />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {ordered.length === 0 && <Text as="p" size="2" color="gray" className="palette-empty">Nothing matches “{query}”.</Text>}
          {groups.map((g) => (
            <div key={g} role="group" aria-label={g}>
              <div className="palette-group">{g}</div>
              {ordered.map((c, i) => c.group !== g ? null : (
                <div key={c.id} id={`cmd-${i}`} data-index={i} role="option" aria-selected={i === active}
                  className="palette-item" onMouseMove={() => setIndex(i)} onClick={() => choose(c)}>
                  <span className="palette-icon">{c.icon}</span>
                  <span className="palette-label">{c.label}</span>
                  {c.hint && <span className="palette-hint">{c.hint}</span>}
                  <ArrowRight className="palette-go" size={14} />
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Ctrl</kbd><kbd>K</kbd> anywhere</span>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
