import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function createTestableConfigModule() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-config-"));
  const stubPath = path.join(tmpDir, "pi-coding-agent-stub.mjs");
  const modulePath = path.join(tmpDir, "config.testable.ts");
  const sourcePath = path.join(process.cwd(), "src", "config.ts");

  fs.writeFileSync(
    stubPath,
    `export function getAgentDir() { return process.env.PI_FORK_TEST_AGENT_DIR; }\n`,
  );

  const source = fs
    .readFileSync(sourcePath, "utf-8")
    .replace(
      'from "@earendil-works/pi-coding-agent"',
      'from "./pi-coding-agent-stub.mjs"',
    );
  fs.writeFileSync(modulePath, source);

  return {
    moduleUrl: pathToFileURL(modulePath).href,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function envObject(entries) {
  const env = {};
  for (const [key, value] of entries) {
    Object.defineProperty(env, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return env;
}

test("loadConfig reads pi-fork.extensions and resolves local paths relative to settings files", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-config-fixture-"));
  const agentDir = path.join(tmpDir, "agent");
  const projectDir = path.join(tmpDir, "project");
  const projectSettingsDir = path.join(projectDir, ".pi");
  const { moduleUrl, cleanup } = createTestableConfigModule();

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectSettingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      "pi-fork": {
        extensions: ["npm:global-extension", "./global-local"],
      },
    }),
  );
  fs.writeFileSync(
    path.join(projectSettingsDir, "settings.json"),
    JSON.stringify({
      "pi-fork": {
        extensions: ["npm:project-extension", "./project-local"],
      },
    }),
  );

  const previous = process.env.PI_FORK_TEST_AGENT_DIR;
  process.env.PI_FORK_TEST_AGENT_DIR = agentDir;

  try {
    const { loadConfig } = await import(`${moduleUrl}?t=${Date.now()}`);
    assert.deepEqual(loadConfig(projectDir), {
      extensions: [
        "npm:project-extension",
        path.join(projectSettingsDir, "project-local"),
      ],
      costFooter: true,
      environment: {},
    });
  } finally {
    if (previous === undefined) delete process.env.PI_FORK_TEST_AGENT_DIR;
    else process.env.PI_FORK_TEST_AGENT_DIR = previous;
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig treats null extensions as normal Pi extension loading", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-config-fixture-"));
  const agentDir = path.join(tmpDir, "agent");
  const projectDir = path.join(tmpDir, "project");
  const projectSettingsDir = path.join(projectDir, ".pi");
  const { moduleUrl, cleanup } = createTestableConfigModule();

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectSettingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      "pi-fork": {
        extensions: ["npm:global-extension"],
      },
    }),
  );
  fs.writeFileSync(
    path.join(projectSettingsDir, "settings.json"),
    JSON.stringify({
      "pi-fork": {
        extensions: null,
      },
    }),
  );

  const previous = process.env.PI_FORK_TEST_AGENT_DIR;
  process.env.PI_FORK_TEST_AGENT_DIR = agentDir;

  try {
    const { loadConfig } = await import(`${moduleUrl}?t=${Date.now()}-null`);
    assert.deepEqual(loadConfig(projectDir), {
      extensions: null,
      costFooter: true,
      environment: {},
    });
  } finally {
    if (previous === undefined) delete process.env.PI_FORK_TEST_AGENT_DIR;
    else process.env.PI_FORK_TEST_AGENT_DIR = previous;
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig preserves empty extensions array as no child extensions", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-config-fixture-"));
  const agentDir = path.join(tmpDir, "agent");
  const projectDir = path.join(tmpDir, "project");
  const { moduleUrl, cleanup } = createTestableConfigModule();

  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      "pi-fork": {
        extensions: [],
      },
    }),
  );

  const previous = process.env.PI_FORK_TEST_AGENT_DIR;
  process.env.PI_FORK_TEST_AGENT_DIR = agentDir;

  try {
    const { loadConfig } = await import(`${moduleUrl}?t=${Date.now()}-empty`);
    assert.deepEqual(loadConfig(projectDir), {
      extensions: [],
      costFooter: true,
      environment: {},
    });
  } finally {
    if (previous === undefined) delete process.env.PI_FORK_TEST_AGENT_DIR;
    else process.env.PI_FORK_TEST_AGENT_DIR = previous;
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig allows disabling cost footer", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-config-fixture-"));
  const agentDir = path.join(tmpDir, "agent");
  const projectDir = path.join(tmpDir, "project");
  const projectSettingsDir = path.join(projectDir, ".pi");
  const { moduleUrl, cleanup } = createTestableConfigModule();

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectSettingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectSettingsDir, "settings.json"),
    JSON.stringify({
      "pi-fork": {
        costFooter: false,
      },
    }),
  );

  const previous = process.env.PI_FORK_TEST_AGENT_DIR;
  process.env.PI_FORK_TEST_AGENT_DIR = agentDir;

  try {
    const { loadConfig } = await import(`${moduleUrl}?t=${Date.now()}-cost-footer`);
    assert.deepEqual(loadConfig(projectDir), {
      extensions: null,
      costFooter: false,
      environment: {},
    });
  } finally {
    if (previous === undefined) delete process.env.PI_FORK_TEST_AGENT_DIR;
    else process.env.PI_FORK_TEST_AGENT_DIR = previous;
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig merges pi-fork.environment with project overriding global", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-config-fixture-"));
  const agentDir = path.join(tmpDir, "agent");
  const projectDir = path.join(tmpDir, "project");
  const projectSettingsDir = path.join(projectDir, ".pi");
  const { moduleUrl, cleanup } = createTestableConfigModule();

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectSettingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      "pi-fork": {
        environment: {
          SHARED: "global",
          GLOBAL_ONLY: "yes",
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(projectSettingsDir, "settings.json"),
    JSON.stringify({
      "pi-fork": {
        environment: {
          SHARED: "project",
          PROJECT_ONLY: "yes",
        },
      },
    }),
  );

  const previous = process.env.PI_FORK_TEST_AGENT_DIR;
  process.env.PI_FORK_TEST_AGENT_DIR = agentDir;

  try {
    const { loadConfig } = await import(`${moduleUrl}?t=${Date.now()}-environment`);
    assert.deepEqual(loadConfig(projectDir), {
      extensions: null,
      costFooter: true,
      environment: {
        SHARED: "project",
        GLOBAL_ONLY: "yes",
        PROJECT_ONLY: "yes",
      },
    });
  } finally {
    if (previous === undefined) delete process.env.PI_FORK_TEST_AGENT_DIR;
    else process.env.PI_FORK_TEST_AGENT_DIR = previous;
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseEnvironment ignores invalid entries and allows empty string values", async () => {
  const { moduleUrl, cleanup } = createTestableConfigModule();

  try {
    const { parseEnvironment } = await import(`${moduleUrl}?t=${Date.now()}-parse-env`);
    const raw = {
      VALID: "value",
      EMPTY_VALUE: "",
      "  WHITESPACE_KEY  ": "preserved",
      "": "empty key",
      "BAD=KEY": "equals",
      "BAD\0KEY": "null key",
      NULL_VALUE: "bad\0value",
      NUMBER: 1,
      BOOLEAN: true,
      OBJECT: { nested: "no" },
    };
    Object.defineProperty(raw, "__proto__", {
      value: "proto-value",
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const environment = parseEnvironment(raw);
    assert.deepEqual(
      environment,
      envObject([
        ["VALID", "value"],
        ["EMPTY_VALUE", ""],
        ["  WHITESPACE_KEY  ", "preserved"],
        ["__proto__", "proto-value"],
      ]),
    );
    assert.equal(Object.getOwnPropertyDescriptor(environment, "__proto__")?.value, "proto-value");
    assert.equal(parseEnvironment(undefined), undefined);
    assert.equal(parseEnvironment(null), undefined);
    assert.equal(parseEnvironment([]), undefined);
    assert.equal(parseEnvironment("nope"), undefined);
  } finally {
    cleanup();
  }
});

test("mergeEnvironment uses case-insensitive overrides on Windows", async () => {
  const { moduleUrl, cleanup } = createTestableConfigModule();

  try {
    const { mergeEnvironment } = await import(`${moduleUrl}?t=${Date.now()}-merge-env`);
    assert.deepEqual(
      mergeEnvironment(
        { FOO: "global", KEEP: "global" },
        { foo: "project", NEW: "project" },
        "win32",
      ),
      { KEEP: "global", foo: "project", NEW: "project" },
    );
    assert.deepEqual(
      mergeEnvironment(
        { FOO: "global", foo: "also-global" },
        { FoO: "project" },
        "win32",
      ),
      { FoO: "project" },
    );

    const merged = mergeEnvironment(
      envObject([
        ["__proto__", "global-proto"],
        ["KEEP", "global"],
      ]),
      envObject([["__proto__", "project-proto"]]),
      "win32",
    );
    assert.deepEqual(
      merged,
      envObject([
        ["KEEP", "global"],
        ["__proto__", "project-proto"],
      ]),
    );
    assert.equal(Object.getOwnPropertyDescriptor(merged, "__proto__")?.value, "project-proto");
  } finally {
    cleanup();
  }
});

test("mergeEnvironment keeps case-sensitive keys distinct on non-Windows", async () => {
  const { moduleUrl, cleanup } = createTestableConfigModule();

  try {
    const { mergeEnvironment } = await import(`${moduleUrl}?t=${Date.now()}-merge-env-posix`);
    assert.deepEqual(
      mergeEnvironment({ FOO: "global" }, { foo: "project" }, "linux"),
      { FOO: "global", foo: "project" },
    );
  } finally {
    cleanup();
  }
});

test("loadConfig parses defaultEffort and complete effortProfiles", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-config-fixture-"));
  const agentDir = path.join(tmpDir, "agent");
  const projectDir = path.join(tmpDir, "project");
  const projectSettingsDir = path.join(projectDir, ".pi");
  const { moduleUrl, cleanup } = createTestableConfigModule();

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectSettingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectSettingsDir, "settings.json"),
    JSON.stringify({
      "pi-fork": {
        defaultEffort: "balanced",
        effortProfiles: {
          fast: { provider: "openai-codex", id: "gpt-fast", thinking: "minimal" },
          balanced: { provider: "openai-codex", id: "gpt-balanced", thinking: "medium" },
          deep: { provider: "openai-codex", id: "gpt-deep", thinking: "high" },
        },
      },
    }),
  );

  const previous = process.env.PI_FORK_TEST_AGENT_DIR;
  process.env.PI_FORK_TEST_AGENT_DIR = agentDir;

  try {
    const { loadConfig } = await import(`${moduleUrl}?t=${Date.now()}`);
    assert.deepEqual(loadConfig(projectDir), {
      extensions: null,
      costFooter: true,
      environment: {},
      defaultEffort: "balanced",
      effortProfiles: {
        fast: { provider: "openai-codex", id: "gpt-fast", thinking: "minimal" },
        balanced: { provider: "openai-codex", id: "gpt-balanced", thinking: "medium" },
        deep: { provider: "openai-codex", id: "gpt-deep", thinking: "high" },
      },
    });
  } finally {
    if (previous === undefined) delete process.env.PI_FORK_TEST_AGENT_DIR;
    else process.env.PI_FORK_TEST_AGENT_DIR = previous;
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig merges effortProfiles by key with project overrides", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-config-fixture-"));
  const agentDir = path.join(tmpDir, "agent");
  const projectDir = path.join(tmpDir, "project");
  const projectSettingsDir = path.join(projectDir, ".pi");
  const { moduleUrl, cleanup } = createTestableConfigModule();

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectSettingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      "pi-fork": {
        defaultEffort: "fast",
        effortProfiles: {
          fast: { provider: "global", id: "fast", thinking: "minimal" },
          balanced: { provider: "global", id: "balanced", thinking: "medium" },
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(projectSettingsDir, "settings.json"),
    JSON.stringify({
      "pi-fork": {
        defaultEffort: "deep",
        effortProfiles: {
          balanced: { provider: "project", id: "balanced", thinking: "high" },
          deep: { provider: "project", id: "deep", thinking: "xhigh" },
        },
      },
    }),
  );

  const previous = process.env.PI_FORK_TEST_AGENT_DIR;
  process.env.PI_FORK_TEST_AGENT_DIR = agentDir;

  try {
    const { loadConfig } = await import(`${moduleUrl}?t=${Date.now()}`);
    assert.deepEqual(loadConfig(projectDir).effortProfiles, {
      fast: { provider: "global", id: "fast", thinking: "minimal" },
      balanced: { provider: "project", id: "balanced", thinking: "high" },
      deep: { provider: "project", id: "deep", thinking: "xhigh" },
    });
    assert.equal(loadConfig(projectDir).defaultEffort, "deep");
  } finally {
    if (previous === undefined) delete process.env.PI_FORK_TEST_AGENT_DIR;
    else process.env.PI_FORK_TEST_AGENT_DIR = previous;
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig ignores invalid effort names and incomplete effortProfiles", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-config-fixture-"));
  const agentDir = path.join(tmpDir, "agent");
  const projectDir = path.join(tmpDir, "project");
  const projectSettingsDir = path.join(projectDir, ".pi");
  const { moduleUrl, cleanup } = createTestableConfigModule();

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectSettingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectSettingsDir, "settings.json"),
    JSON.stringify({
      "pi-fork": {
        defaultEffort: "maximum",
        effortProfiles: {
          fast: { provider: "", id: "gpt-fast", thinking: "minimal" },
          balanced: { provider: "openai-codex", thinking: "medium" },
          deep: { provider: "openai-codex", id: "gpt-deep", thinking: "massive" },
        },
      },
    }),
  );

  const previous = process.env.PI_FORK_TEST_AGENT_DIR;
  process.env.PI_FORK_TEST_AGENT_DIR = agentDir;

  try {
    const { loadConfig } = await import(`${moduleUrl}?t=${Date.now()}`);
    const config = loadConfig(projectDir);
    assert.equal(config.defaultEffort, undefined);
    assert.equal(config.effortProfiles, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_FORK_TEST_AGENT_DIR;
    else process.env.PI_FORK_TEST_AGENT_DIR = previous;
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig keeps no-profile config backward compatible", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fork-config-fixture-"));
  const agentDir = path.join(tmpDir, "agent");
  const projectDir = path.join(tmpDir, "project");
  const { moduleUrl, cleanup } = createTestableConfigModule();

  fs.mkdirSync(agentDir, { recursive: true });

  const previous = process.env.PI_FORK_TEST_AGENT_DIR;
  process.env.PI_FORK_TEST_AGENT_DIR = agentDir;

  try {
    const { loadConfig } = await import(`${moduleUrl}?t=${Date.now()}`);
    assert.deepEqual(loadConfig(projectDir), {
      extensions: null,
      costFooter: true,
      environment: {},
    });
  } finally {
    if (previous === undefined) delete process.env.PI_FORK_TEST_AGENT_DIR;
    else process.env.PI_FORK_TEST_AGENT_DIR = previous;
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
