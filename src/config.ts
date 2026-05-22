import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ForkEffort, ForkEffortProfile, ForkThinkingLevel } from "./types.js";

export const EFFORT_LEVELS = ["fast", "balanced", "deep"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export interface ForkConfig {
  /**
   * Extensions to load in child fork processes.
   * - null: load normal Pi extensions from settings/auto-discovery
   * - []: load no extensions
   * - non-empty: load only these extension sources
   */
  extensions: string[] | null;

  /** Environment variables to overlay onto child fork processes. */
  environment: Record<string, string>;

  /** Show fork cost as an extra footer status line. */
  costFooter: boolean;

  /** Effort to use when a fork call omits the effort parameter. */
  defaultEffort?: ForkEffort;

  /** Per-effort child model and thinking profiles. */
  effortProfiles?: Partial<Record<ForkEffort, ForkEffortProfile>>;
}

const SETTINGS_KEY = "pi-fork";

export const DEFAULT_CONFIG: ForkConfig = {
  extensions: null,
  environment: {},
  costFooter: true,
};

function isPackageSource(value: string): boolean {
  return value.startsWith("npm:") || value.startsWith("git:");
}

function resolveConfiguredPath(value: string, baseDir: string): string {
  if (!value) return value;
  if (isPackageSource(value)) return value;
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value)) return value;
  return path.resolve(baseDir, value);
}

function isEffort(value: unknown): value is ForkEffort {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

function isThinkingLevel(value: unknown): value is ForkThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function parseDefaultEffort(raw: unknown): ForkEffort | undefined {
  return isEffort(raw) ? raw : undefined;
}

function parseEffortProfile(raw: unknown): ForkEffortProfile | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const profile = raw as Record<string, unknown>;
  const provider = typeof profile.provider === "string" ? profile.provider.trim() : "";
  const id = typeof profile.id === "string" ? profile.id.trim() : "";
  if (!provider || !id || !isThinkingLevel(profile.thinking)) return undefined;
  return { provider, id, thinking: profile.thinking };
}

function parseEffortProfiles(raw: unknown): Partial<Record<ForkEffort, ForkEffortProfile>> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const profiles: Partial<Record<ForkEffort, ForkEffortProfile>> = {};
  for (const effort of EFFORT_LEVELS) {
    const profile = parseEffortProfile((raw as Record<string, unknown>)[effort]);
    if (profile) profiles[effort] = profile;
  }
  return Object.keys(profiles).length > 0 ? profiles : undefined;
}

function mergeEffortProfiles(
  base: Partial<Record<ForkEffort, ForkEffortProfile>> | undefined,
  overrides: Partial<Record<ForkEffort, ForkEffortProfile>> | undefined,
): Partial<Record<ForkEffort, ForkEffortProfile>> | undefined {
  const merged = { ...(base || {}), ...(overrides || {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function parseExtensions(raw: unknown, baseDir: string): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!Array.isArray(raw)) return undefined;

  const extensions: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    extensions.push(resolveConfiguredPath(trimmed, baseDir));
  }
  return extensions;
}

function defineEnvironmentValue(
  target: Record<string, string>,
  key: string,
  value: string,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function copyEnvironment(source: Record<string, string> | undefined): Record<string, string> {
  const target: Record<string, string> = {};
  if (!source) return target;

  for (const [key, value] of Object.entries(source)) {
    defineEnvironmentValue(target, key, value);
  }
  return target;
}

export function parseEnvironment(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const environment: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (
      !key ||
      key.includes("=") ||
      key.includes("\0") ||
      typeof rawValue !== "string" ||
      rawValue.includes("\0")
    ) {
      continue;
    }
    defineEnvironmentValue(environment, key, rawValue);
  }
  return environment;
}

export function mergeEnvironment(
  base: Record<string, string> | undefined,
  overrides: Record<string, string> | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const environment = copyEnvironment(base);
  if (!overrides) return environment;

  if (platform === "win32") {
    for (const [overrideKey, overrideValue] of Object.entries(overrides)) {
      const normalizedKey = overrideKey.toLowerCase();
      for (const key of Object.keys(environment)) {
        if (key.toLowerCase() === normalizedKey) delete environment[key];
      }
      defineEnvironmentValue(environment, overrideKey, overrideValue);
    }
    return environment;
  }

  for (const [overrideKey, overrideValue] of Object.entries(overrides)) {
    defineEnvironmentValue(environment, overrideKey, overrideValue);
  }
  return environment;
}

function readNamespacedConfig(settingsPath: string, baseDir: string): Partial<ForkConfig> {
  if (!existsSync(settingsPath)) return {};

  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const nested = raw[SETTINGS_KEY];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return {};

    const config = nested as Record<string, unknown>;
    const extensions = parseExtensions(config.extensions, baseDir);
    const environment = parseEnvironment(config.environment);
    const parsed: Partial<ForkConfig> = {};
    const defaultEffort = parseDefaultEffort(config.defaultEffort);
    const effortProfiles = parseEffortProfiles(config.effortProfiles);
    if (extensions !== undefined) parsed.extensions = extensions;
    if (environment !== undefined) parsed.environment = environment;
    if (typeof config.costFooter === "boolean") parsed.costFooter = config.costFooter;
    if (defaultEffort !== undefined) parsed.defaultEffort = defaultEffort;
    if (effortProfiles !== undefined) parsed.effortProfiles = effortProfiles;
    return parsed;
  } catch {
    return {};
  }
}

export function loadConfig(cwd: string): ForkConfig {
  const agentDir = getAgentDir();
  const globalPath = path.join(agentDir, "settings.json");
  const projectSettingsDir = path.join(cwd, ".pi");
  const projectPath = path.join(projectSettingsDir, "settings.json");
  const globalConfig = readNamespacedConfig(globalPath, agentDir);
  const projectConfig = readNamespacedConfig(projectPath, projectSettingsDir);

  const effortProfiles = mergeEffortProfiles(globalConfig.effortProfiles, projectConfig.effortProfiles);
  const resolved: ForkConfig = {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...projectConfig,
    environment: mergeEnvironment(globalConfig.environment, projectConfig.environment),
  };
  if (effortProfiles !== undefined) resolved.effortProfiles = effortProfiles;
  else delete resolved.effortProfiles;
  return resolved;
}
