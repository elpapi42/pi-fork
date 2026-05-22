const PI_OFFLINE_ENV = "PI_OFFLINE";

function defineEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string | undefined,
): void {
  Object.defineProperty(env, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function setEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32") {
    const normalizedKey = key.toLowerCase();
    for (const existingKey of Object.keys(env)) {
      if (existingKey.toLowerCase() === normalizedKey) delete env[existingKey];
    }
  }
  defineEnvValue(env, key, value);
}

function deleteEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): void {
  if (platform === "win32") {
    const normalizedKey = key.toLowerCase();
    for (const existingKey of Object.keys(env)) {
      if (existingKey.toLowerCase() === normalizedKey) delete env[existingKey];
    }
    return;
  }
  delete env[key];
}

export function buildChildEnv(
  environment: Record<string, string> = {},
  parentEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  offline = true,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    defineEnvValue(env, key, value);
  }
  for (const [key, value] of Object.entries(environment)) {
    setEnvValue(env, key, value, platform);
  }
  if (offline) setEnvValue(env, PI_OFFLINE_ENV, "1", platform);
  else deleteEnvValue(env, PI_OFFLINE_ENV, platform);
  return env;
}
