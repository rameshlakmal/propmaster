// Saved database connections for the web app, so a tester sets a connection up once.
// Stored in ~/.propmaster/ui.json (or PROPMASTER_UI_CONFIG). Connection strings include passwords:
// fine for local test databases, which is all Propmaster connects to.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { UserError } from '../core/errors.js';
import { assertNotProduction } from '../core/guard.js';

export interface Profile {
  name: string;
  url: string;
  /** Path of the rules file used on the Rules page. */
  rulesFile?: string;
  /** Recipe folder (or .sql file) used on the Find page. */
  recipesPath?: string;
}

export interface UiConfig {
  profiles: Profile[];
  active?: string;
}

function configPath(): string {
  return process.env.PROPMASTER_UI_CONFIG ?? join(homedir(), '.propmaster', 'ui.json');
}

export async function readConfig(): Promise<UiConfig> {
  const path = configPath();
  if (!existsSync(path)) return { profiles: [] };
  let config: UiConfig;
  try {
    config = JSON.parse(await readFile(path, 'utf8')) as UiConfig;
  } catch (err) {
    // Never treat a broken file as empty: the next save would overwrite the user's connections.
    throw new UserError(`Can't read the settings file ${path}: ${err instanceof Error ? err.message : String(err)}`,
      'Fix the file, or delete it to start again (your saved connections are in it).');
  }
  return { profiles: Array.isArray(config.profiles) ? config.profiles : [], active: config.active };
}

async function writeConfig(config: UiConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(config, null, 2), 'utf8');
  await rename(`${path}.tmp`, path);
}

/** Adds or replaces a profile (by name) and makes it the active one. */
export async function saveProfile(profile: Profile): Promise<UiConfig> {
  const name = profile.name.trim();
  if (!name) throw new UserError('Give the connection a name.');
  assertNotProduction(profile.url);
  const config = await readConfig();
  const existing = config.profiles.find((p) => p.name === name);
  const saved: Profile = { name, url: profile.url.trim(), rulesFile: profile.rulesFile ?? existing?.rulesFile, recipesPath: profile.recipesPath ?? existing?.recipesPath };
  config.profiles = [...config.profiles.filter((p) => p.name !== name), saved];
  config.active = name;
  await writeConfig(config);
  return config;
}

export async function removeProfile(name: string): Promise<UiConfig> {
  const config = await readConfig();
  config.profiles = config.profiles.filter((p) => p.name !== name);
  if (config.active === name) config.active = config.profiles[0]?.name;
  await writeConfig(config);
  return config;
}

export async function activateProfile(name: string): Promise<UiConfig> {
  const config = await readConfig();
  if (!config.profiles.some((p) => p.name === name)) throw new UserError(`There is no connection called "${name}".`);
  config.active = name;
  await writeConfig(config);
  return config;
}

export async function setRulesFile(name: string, rulesFile: string): Promise<UiConfig> {
  const config = await readConfig();
  const profile = config.profiles.find((p) => p.name === name);
  if (!profile) throw new UserError(`There is no connection called "${name}".`);
  profile.rulesFile = rulesFile;
  await writeConfig(config);
  return config;
}

export async function setRecipesPath(name: string, recipesPath: string): Promise<UiConfig> {
  const config = await readConfig();
  const profile = config.profiles.find((p) => p.name === name);
  if (!profile) throw new UserError(`There is no connection called "${name}".`);
  profile.recipesPath = recipesPath;
  await writeConfig(config);
  return config;
}

export async function activeProfile(): Promise<Profile> {
  const config = await readConfig();
  const profile = config.profiles.find((p) => p.name === config.active) ?? config.profiles[0];
  if (!profile) throw new UserError('No database connection yet.', 'Add one on the Setup page.');
  return profile;
}

/** The profile as the browser may see it: the password replaced by asterisks. */
export function publicProfile(profile: Profile): Profile & { display: string } {
  let display = profile.url;
  try {
    const u = new URL(profile.url);
    if (u.password) u.password = '****';
    display = `${u.hostname}:${u.port || '5432'}${u.pathname}`;
    return { name: profile.name, url: u.toString(), rulesFile: profile.rulesFile, recipesPath: profile.recipesPath, display };
  } catch {
    return { ...profile, display };
  }
}
