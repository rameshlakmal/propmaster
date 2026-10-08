import { Badge, Box, Button, Card, Flex, Heading, Select, Switch, Table, Text, TextField } from '@radix-ui/themes';
import { CheckCircle, FolderOpen, HandGrabbing, MagnifyingGlass, Stethoscope, Timer, Warning, XCircle } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { EmptyState, ErrorCallout, PageHeader } from '../components/Feedback';
import { toError, useLoad } from '../hooks';
import type { ApiError, ClaimRow, FindResult, Recipe, RecipeCheck, RecipesSource } from '../types';

const DURATIONS = [['30m', '30 minutes'], ['1h', '1 hour'], ['2h', '2 hours'], ['4h', '4 hours'], ['1d', '1 day']] as const;

function show(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

const short = (table: string) => table.replace(/^public\./, '');

/** "14:32", or "9 Oct 14:32" when it's not today. */
function until(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/** Every word must appear in the name, id, description or tags: the same search as `propmaster find`. */
function matches(recipe: Recipe, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [recipe.name, recipe.id, recipe.description, ...recipe.tags].join(' ').toLowerCase();
  return words.every((w) => haystack.includes(w));
}

const INPUT_TYPE: Partial<Record<Recipe['params'][number]['type'], 'number' | 'date'>> = { int: 'number', bigint: 'number', numeric: 'number', date: 'date' };

function RecipeList({ recipes, selected, onSelect }: { recipes: Recipe[]; selected: string | null; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const shown = recipes.filter((r) => matches(r, query));
  return (
    <Flex direction="column" gap="3">
      <TextField.Root value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search recipes and #tags" aria-label="Search recipes">
        <TextField.Slot><MagnifyingGlass /></TextField.Slot>
      </TextField.Root>
      <div className="recipe-list" role="listbox" aria-label="Recipes">
        {shown.map((r) => (
          <button key={r.id} type="button" role="option" aria-selected={r.id === selected} className="recipe-item" onClick={() => onSelect(r.id)}>
            <Text as="div" size="2" weight="medium">{r.name}</Text>
            {r.description && <Text as="div" size="1" color="gray" className="recipe-description">{r.description}</Text>}
            {(r.tags.length > 0 || r.claim) && (
              <Flex gap="1" wrap="wrap" mt="1">
                {r.tags.map((t) => <Badge key={t} size="1" variant="soft" color="gray">#{t}</Badge>)}
                {r.claim && <Badge size="1" variant="soft" color="indigo">claims {short(r.claim.table)}</Badge>}
              </Flex>
            )}
          </button>
        ))}
        {shown.length === 0 && <Text size="2" color="gray">No recipe matches "{query}".</Text>}
      </div>
    </Flex>
  );
}

function ClaimBadge({ claim, me }: { claim: ClaimRow; me: string }) {
  const mine = claim.claimedBy === me;
  return (
    <Badge color={mine ? 'grass' : 'amber'} variant="soft" title={claim.note ?? undefined}>
      {mine ? 'Yours' : claim.claimedBy} · until {until(claim.expiresAt)}
    </Badge>
  );
}

function Results({ result, me, busyKey, onClaim }: { result: FindResult; me: string; busyKey: string | null; onClaim: (key: string) => void }) {
  if (result.rows.length === 0) {
    return <EmptyState icon={<MagnifyingGlass size={32} />} title="No rows match">Try other parameter values, or create the data you need.</EmptyState>;
  }
  const more = result.matches - result.rows.length;
  return (
    <Box>
      <Table.Root variant="surface" size="1">
        <Table.Header>
          <Table.Row>
            {result.columns.map((h) => <Table.ColumnHeaderCell key={h}>{h}</Table.ColumnHeaderCell>)}
            {result.claim && <Table.ColumnHeaderCell width="170px"><span className="sr-only">Claim</span></Table.ColumnHeaderCell>}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {result.rows.map((r, i) => (
            <Table.Row key={r.key ?? i} className={r.claimedBy && r.claimedBy.claimedBy !== me ? 'row-held' : undefined}>
              {result.columns.map((h) => <Table.Cell key={h} className="mono">{show(r.values[h])}</Table.Cell>)}
              {result.claim && (
                <Table.Cell>
                  {r.claimedBy ? <ClaimBadge claim={r.claimedBy} me={me} />
                    : r.key !== null && (
                      <Button size="1" variant="soft" onClick={() => onClaim(r.key!)} loading={busyKey === r.key} className="press">
                        <HandGrabbing /> Claim
                      </Button>
                    )}
                </Table.Cell>
              )}
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {more > 0 && <Text as="p" size="1" color="gray" mt="2">…and {more} more. Make the recipe narrower to see them.</Text>}
    </Box>
  );
}

function RecipePanel({ recipe, me, onClaimed }: { recipe: Recipe; me: string; onClaimed: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [duration, setDuration] = useState(() => sessionStorage.getItem('propmaster-claim-duration') ?? '2h');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<FindResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [claimed, setClaimed] = useState<ClaimRow[]>([]);

  // A different recipe starts clean.
  useEffect(() => { setValues({}); setResult(null); setError(null); setClaimed([]); }, [recipe.id]);

  const act = async (kind: string, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try { await fn(); } catch (err) { setError(toError(err)); } finally { setBusy(null); }
  };
  const body = { recipe: recipe.id, params: values };
  const run = () => act('find', async () => {
    const res = await api<{ me: string; result: FindResult }>('POST', '/find', body);
    setResult(res.result);
    setClaimed([]);
  });
  const claim = (key?: string) => act(key ?? 'claim-first', async () => {
    const res = await api<{ claims: ClaimRow[]; result: FindResult }>('POST', '/find/claim', { ...body, key, duration, note });
    setResult(res.result);
    setClaimed(res.claims);
    onClaimed();
  });
  const required = recipe.params.filter((p) => p.default === undefined && !values[p.name]?.trim());

  return (
    <Flex direction="column" gap="4">
      <Box>
        <Heading as="h2" size="4">{recipe.name}</Heading>
        {recipe.description && <Text as="p" size="2" color="gray" mt="1">{recipe.description}</Text>}
        <Text as="p" size="1" color="gray" mt="1" className="mono">{recipe.file}, line {recipe.line}</Text>
      </Box>

      {recipe.params.length > 0 && (
        <div className="param-grid">
          {recipe.params.map((p) => (
            <Flex key={p.name} direction="column" gap="1">
              <Text as="label" size="2" weight="medium" htmlFor={`param-${p.name}`}>
                {p.name} <Text size="1" color="gray" weight="regular">{p.type}{p.default === undefined ? ' · required' : ''}</Text>
              </Text>
              {p.type === 'boolean' ? (
                <Select.Root value={values[p.name] ?? p.default ?? ''} onValueChange={(v) => setValues({ ...values, [p.name]: v })}>
                  <Select.Trigger id={`param-${p.name}`} placeholder="Choose" />
                  <Select.Content position="popper"><Select.Item value="true">true</Select.Item><Select.Item value="false">false</Select.Item></Select.Content>
                </Select.Root>
              ) : (
                <TextField.Root id={`param-${p.name}`} type={INPUT_TYPE[p.type] ?? 'text'} step={p.type === 'numeric' ? 'any' : undefined}
                  value={values[p.name] ?? ''} placeholder={p.default ?? ''} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} />
              )}
              {p.description && <Text size="1" color="gray">{p.description}</Text>}
            </Flex>
          ))}
        </div>
      )}

      <Flex gap="3" align="end" wrap="wrap">
        <Button size="3" onClick={() => void run()} loading={busy === 'find'} disabled={required.length > 0} className="press">
          <MagnifyingGlass weight="bold" /> Find
        </Button>
        {recipe.claim && (
          <>
            <Button size="3" variant="soft" onClick={() => void claim()} loading={busy === 'claim-first'} disabled={required.length > 0} className="press">
              <HandGrabbing /> Find and claim one
            </Button>
            <Flex direction="column" gap="1">
              <Text as="label" size="1" color="gray" htmlFor="claim-duration">Claim for</Text>
              <Select.Root value={duration} onValueChange={(v) => { setDuration(v); sessionStorage.setItem('propmaster-claim-duration', v); }}>
                <Select.Trigger id="claim-duration" />
                <Select.Content position="popper">{DURATIONS.map(([v, label]) => <Select.Item key={v} value={v}>{label}</Select.Item>)}</Select.Content>
              </Select.Root>
            </Flex>
            <Flex direction="column" gap="1" flexGrow="1" minWidth="160px">
              <Text as="label" size="1" color="gray" htmlFor="claim-note">Note (optional)</Text>
              <TextField.Root id="claim-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. TC-142 checkout" />
            </Flex>
          </>
        )}
      </Flex>
      {required.length > 0 && <Text size="1" color="gray">Fill in {required.map((p) => p.name).join(', ')} first.</Text>}

      {error && <ErrorCallout error={error} />}

      {claimed.length > 0 && (
        <Card variant="surface" className="claim-done">
          <Flex gap="2" align="center">
            <CheckCircle size={18} weight="fill" color="var(--grass-9)" />
            <Text size="2">
              Claimed {claimed.map((c) => `${short(c.table)} ${c.key}`).join(', ')} until {until(claimed[0]!.expiresAt)}. Release it below when your test is done.
            </Text>
          </Flex>
        </Card>
      )}

      {result && (
        <Box>
          <Flex gap="2" mb="3" wrap="wrap" align="center">
            <Badge size="2" color="indigo">{result.matches} {result.matches === 1 ? 'match' : 'matches'}</Badge>
            {result.claimed > 0 && <Badge size="2" color="amber">{result.claimed} claimed</Badge>}
            <Text size="1" color="gray">{result.ms} ms</Text>
          </Flex>
          <Results result={result} me={me} busyKey={busy} onClaim={(key) => void claim(key)} />
        </Box>
      )}
    </Flex>
  );
}

function TimeLeft({ iso }: { iso: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return <Text size="2" color="gray">expired</Text>;
  const m = Math.round(ms / 60000);
  return <Text size="2" color={m < 15 ? 'amber' : 'gray'}>{m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h ${m % 60} min left`}</Text>;
}

function Claims({ version, activeProfile }: { version: number; activeProfile: string | null }) {
  const [all, setAll] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const data = useLoad(() => api<{ me: string; claims: ClaimRow[] }>('GET', `/claims${all ? '?all=1' : ''}`), [all, version, activeProfile], 15000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const me = data.data?.me ?? '';
  const shown = (data.data?.claims ?? []).filter((c) => !mineOnly || c.claimedBy === me);
  const mine = (data.data?.claims ?? []).filter((c) => c.claimedBy === me && !c.expired).length;

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try { await fn(); await data.refresh(); } catch (err) { setError(toError(err)); } finally { setBusy(null); }
  };

  return (
    <Card size="3">
      <Flex justify="between" align="center" mb="3" gap="3" wrap="wrap">
        <Box>
          <Heading as="h2" size="3">Claims</Heading>
          <Text as="p" size="1" color="gray">Rows testers on this database are using. They are released automatically when they expire.</Text>
        </Box>
        <Flex gap="4" align="center" wrap="wrap">
          <Text as="label" size="2"><Flex gap="2" align="center"><Switch size="1" checked={mineOnly} onCheckedChange={setMineOnly} /> Only mine</Flex></Text>
          <Text as="label" size="2"><Flex gap="2" align="center"><Switch size="1" checked={all} onCheckedChange={setAll} /> Show expired</Flex></Text>
          <Button variant="soft" color="gray" disabled={mine === 0} loading={busy === 'mine'} onClick={() => void act('mine', () => api('POST', '/claims/release-mine'))}>
            Release all mine ({mine})
          </Button>
        </Flex>
      </Flex>
      {(error ?? data.error) && <Box mb="3"><ErrorCallout error={(error ?? data.error)!} /></Box>}
      {shown.length === 0 ? (
        <Text as="p" size="2" color="gray">{mineOnly ? 'You hold no claims.' : 'Nobody holds a claim right now.'}</Text>
      ) : (
        <Table.Root variant="surface" size="1">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Row</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>By</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Until</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Recipe / note</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell><span className="sr-only">Actions</span></Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {shown.map((c) => (
              <Table.Row key={c.id}>
                <Table.RowHeaderCell><Text weight="medium">{short(c.table)} {c.key}</Text> <Text size="1" color="gray">#{c.id}</Text></Table.RowHeaderCell>
                <Table.Cell>{c.claimedBy === me ? <Badge color="grass" variant="soft">{c.claimedBy} (you)</Badge> : c.claimedBy}</Table.Cell>
                <Table.Cell><Flex direction="column"><Text size="2">{until(c.expiresAt)}</Text><TimeLeft iso={c.expiresAt} /></Flex></Table.Cell>
                <Table.Cell><Text size="2" color="gray">{[c.recipe, c.note].filter(Boolean).join(' · ') || '–'}</Text></Table.Cell>
                <Table.Cell>
                  <Flex gap="2" justify="end">
                    {!c.expired && (
                      <Button size="1" variant="soft" color="gray" loading={busy === `extend-${c.id}`} onClick={() => void act(`extend-${c.id}`, () => api('POST', `/claims/${c.id}/extend`, { duration: '2h' }))}>
                        <Timer /> 2 more hours
                      </Button>
                    )}
                    <Button size="1" variant="soft" loading={busy === `release-${c.id}`} onClick={() => void act(`release-${c.id}`, () => api('POST', `/claims/${c.id}/release`))}>
                      Release
                    </Button>
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

const CHECK = {
  ok: { icon: <CheckCircle size={18} weight="fill" color="var(--grass-9)" />, color: 'grass' },
  empty: { icon: <Warning size={18} weight="fill" color="var(--amber-9)" />, color: 'amber' },
  error: { icon: <XCircle size={18} weight="fill" color="var(--red-9)" />, color: 'red' },
} as const;

function CheckResults({ results }: { results: RecipeCheck[] }) {
  return (
    <Table.Root variant="surface" size="1">
      <Table.Body>
        {results.map((r) => (
          <Table.Row key={r.recipe.id}>
            <Table.Cell width="36px">{CHECK[r.status].icon}</Table.Cell>
            <Table.RowHeaderCell>{r.recipe.name}</Table.RowHeaderCell>
            <Table.Cell>
              <Text size="2" color={CHECK[r.status].color}>
                {r.status === 'error' ? r.error
                  : r.status === 'empty' ? 'finds nothing right now'
                  : r.how === 'explain' ? 'works (planned only: it needs a parameter)'
                  : `works · ${r.matches} ${r.matches === 1 ? 'match' : 'matches'}`}
              </Text>
            </Table.Cell>
            <Table.Cell width="80px"><Text size="1" color="gray">{r.ms} ms</Text></Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}

export function FindPage({ activeProfile }: { activeProfile: string | null }) {
  const source = useLoad(() => api<RecipesSource>('GET', '/recipes'), [activeProfile]);
  const [path, setPath] = useState('');
  const [selected, setSelected] = useState<string | null>(() => sessionStorage.getItem('propmaster-recipe'));
  const [busy, setBusy] = useState<'open' | 'check' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [checks, setChecks] = useState<RecipeCheck[] | null>(null);
  const [claimsVersion, setClaimsVersion] = useState(0);
  const me = useLoad(() => api<{ me: string }>('GET', '/claims').then((r) => r.me), [activeProfile]);

  const recipes = useMemo(() => source.data?.recipes ?? [], [source.data]);
  const recipe = recipes.find((r) => r.id === selected) ?? recipes[0] ?? null;

  useEffect(() => { if (source.data) setPath(source.data.path); }, [source.data]);

  const act = async (kind: 'open' | 'check', fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try { await fn(); } catch (err) { setError(toError(err)); } finally { setBusy(null); }
  };
  const open = () => act('open', async () => { await api('PUT', '/recipes', { path }); setChecks(null); await source.refresh(); });
  const check = () => act('check', async () => { setChecks((await api<{ results: RecipeCheck[] }>('POST', '/recipes/check')).results); });
  const select = (id: string) => { setSelected(id); sessionStorage.setItem('propmaster-recipe', id); };

  return (
    <Box>
      <PageHeader title="Find data" description="Recipes are shared queries that find test data in the state you need. Claim a row so nobody else uses it while you test." />

      {error && <Box mb="4"><ErrorCallout error={error} /></Box>}

      <Card size="2" mb="5">
        <Flex gap="2" wrap="wrap" align="center">
          <Box flexGrow="1" minWidth="280px">
            <TextField.Root value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\path\to\recipes (a folder of .sql files, or one file)"
              aria-label="Recipe folder" className="mono" onKeyDown={(e) => { if (e.key === 'Enter' && path) void open(); }} />
          </Box>
          <Button variant="soft" onClick={() => void open()} loading={busy === 'open'} disabled={!path}><FolderOpen /> Open</Button>
          <Button variant="soft" color="gray" onClick={() => void check()} loading={busy === 'check'} disabled={recipes.length === 0}><Stethoscope /> Check all recipes</Button>
        </Flex>
        {source.data?.error && <Box mt="3"><ErrorCallout error={{ message: source.data.error }} /></Box>}
        {checks && <Box mt="3"><CheckResults results={checks} /></Box>}
      </Card>

      {recipes.length === 0 ? (
        !source.loading && !source.data?.error && (
          <Card size="3" mb="5">
            <EmptyState icon={<MagnifyingGlass size={36} />} title="Open a recipe folder">
              A recipe is a SELECT with a "-- recipe: name" line above it, kept in a .sql file next to your tests. Try the demo: the demo/recipes folder of Propmaster.
            </EmptyState>
          </Card>
        )
      ) : (
        <div className="find-grid">
          <Card size="2"><RecipeList recipes={recipes} selected={recipe?.id ?? null} onSelect={select} /></Card>
          <Card size="3">{recipe && <RecipePanel recipe={recipe} me={me.data ?? ''} onClaimed={() => setClaimsVersion((v) => v + 1)} />}</Card>
        </div>
      )}

      <Claims version={claimsVersion} activeProfile={activeProfile} />
    </Box>
  );
}
