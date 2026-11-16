import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import test from 'node:test'
import { parse } from 'yaml'
import { resolveAgentMemoryEnvironment, persistAutomaticAgentMemoryPaths } from '../shared/agent-memory-paths.mjs'
import { loadRuntimeEnvironment } from '../shared/runtime-environment.mjs'
import { desktopGatewayEnvironment } from '../desktop/src/gateway-process.mjs'
import { loadPwmYamlSettings } from '../desktop/src/pwm-model-service.mjs'
import { resolvePreWakeContextSidecarOptions } from '../shared/voice/prewake-context-runtime.mjs'
import { resolveAmbientAudioRecordingSidecarOptions } from '../shared/voice/ambient-audio-recording-runtime.mjs'

const paths = {
  AGENT_MEMORY_SIDECAR: 'memory/integrations/qwen_audio_agent/agent_memory_sidecar.py',
  AGENT_MEMORY_CONFIG: 'memory/config.yaml',
  AGENT_MEMORY_PREWAKE_CONTEXT_SIDECAR: 'memory/integrations/qwen_audio_agent/prewake_context_sidecar.py',
  AGENT_MEMORY_AMBIENT_RECORDING_SIDECAR: 'memory/integrations/qwen_audio_agent/ambient_audio_recording_sidecar.py',
}
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'qwen-memory-paths-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'checkout')
  for (const relative of Object.values(paths)) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, relative.endsWith('.yaml')
      ? 'personal_world_model:\n  llm_model:\n    llm_name: bundled-chat\n' : '# fixture\n')
  }
  const configDir = join(base, 'profile')
  mkdirSync(configDir)
  const configPath = join(configDir, 'config.env')
  const dataDirectory = join(configDir, 'data')
  return { base, root, configDir, configPath, dataDirectory }
}
function load(f, extra = {}) {
  const env = { QWAUDIO_CONFIG_DIR: f.configDir, ...extra }
  const runtime = loadRuntimeEnvironment({ root: f.root, env, prepareBackendRuntime: false, generateSecret: false })
  return { env, runtime }
}

test('auto follows a renamed checkout while durable data stays outside it', t => {
  const f = fixture(t)
  writeFileSync(f.configPath, 'QWEN_AUDIO_MEMORY_PROVIDER=agent-memory\nAGENT_MEMORY_SIDECAR=auto\nAGENT_MEMORY_CONFIG=auto\nAGENT_MEMORY_STATE_DIR=auto\n')
  const first = load(f).env
  renameSync(f.root, join(f.base, 'renamed-checkout'))
  f.root = join(f.base, 'renamed-checkout')
  const next = load(f).env
  assert.equal(next.AGENT_MEMORY_SIDECAR, join(f.root, paths.AGENT_MEMORY_SIDECAR))
  assert.equal(next.AGENT_MEMORY_CONFIG, join(f.root, paths.AGENT_MEMORY_CONFIG))
  assert.equal(first.AGENT_MEMORY_STATE_DIR, next.AGENT_MEMORY_STATE_DIR)
  assert.equal(next.AGENT_MEMORY_STATE_DIR, join(f.dataDirectory, 'memory/agent-memory'))
  assert.equal(existsSync(join(f.configPath + '.before-agent-memory-auto')), false)
})

test('startup repairs deleted checkout paths, saves auto selectors and backs up the original file privately', t => {
  const f = fixture(t)
  const old = join(f.base, 'deleted-checkout')
  const original = ['# keep this comment', 'QWEN_AUDIO_MEMORY_PROVIDER=agent-memory', 'DASHSCOPE_API_KEY=fixture-secret',
    ...Object.entries(paths).map(([key, relative]) => `${key}=${join(old, relative)}`),
    `AGENT_MEMORY_STATE_DIR=${join(old, 'tmp/qwen_audio_agent_online')}`, ''].join('\n')
  writeFileSync(f.configPath, original)
  const { env, runtime } = load(f)
  const saved = parseEnv(readFileSync(f.configPath, 'utf8'))
  for (const [key, relative] of Object.entries(paths)) {
    assert.equal(env[key], join(f.root, relative))
    assert.equal(saved[key], 'auto')
  }
  assert.equal(saved.AGENT_MEMORY_STATE_DIR, 'auto')
  assert.equal(env.AGENT_MEMORY_STATE_DIR, join(f.dataDirectory, 'memory/agent-memory'))
  assert.equal(saved.DASHSCOPE_API_KEY, 'fixture-secret')
  assert.match(readFileSync(f.configPath, 'utf8'), /# keep this comment/)
  assert.equal(readFileSync(f.configPath + '.before-agent-memory-auto', 'utf8'), original)
  assert.equal(statSync(f.configPath + '.before-agent-memory-auto').mode & 0o777, 0o600)
  assert.equal(statSync(f.configPath).mode & 0o777, 0o600)
  assert.equal(runtime.automaticMemoryPathUpdates.length, 5)
  assert.equal(load(f).runtime.automaticMemoryPathUpdates.length, 0)
  assert.equal(existsSync(old), false)
})

test('missing selectors are initialized once without pinning the source root', t => {
  const f = fixture(t)
  writeFileSync(f.configPath, 'QWEN_AUDIO_MEMORY_PROVIDER=agent-memory\n')
  load(f)
  const saved = parseEnv(readFileSync(f.configPath, 'utf8'))
  assert.equal(saved.AGENT_MEMORY_SIDECAR, 'auto')
  assert.equal(saved.AGENT_MEMORY_CONFIG, 'auto')
  assert.equal(saved.AGENT_MEMORY_STATE_DIR, 'auto')
  assert.doesNotMatch(readFileSync(f.configPath, 'utf8'), /checkout/)
})

test('valid external Python, code, YAML, and existing databases are preserved', t => {
  const f = fixture(t)
  const external = join(f.base, 'custom')
  mkdirSync(external)
  const sidecar = join(external, 'custom.py')
  const yaml = join(external, 'custom.yaml')
  writeFileSync(sidecar, '# custom')
  writeFileSync(yaml, 'personal_world_model: {}')
  const state = join(f.root, 'tmp/qwen_audio_agent_online')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'memory.db'), 'existing database')
  const original = `AGENT_MEMORY_PYTHON=/custom/python\nAGENT_MEMORY_SIDECAR=${sidecar}\nAGENT_MEMORY_CONFIG=${yaml}\nAGENT_MEMORY_STATE_DIR=${state}\n`
  writeFileSync(f.configPath, original)
  const { env } = load(f)
  assert.equal(env.AGENT_MEMORY_SIDECAR, sidecar)
  assert.equal(env.AGENT_MEMORY_CONFIG, yaml)
  assert.equal(env.AGENT_MEMORY_STATE_DIR, state)
  assert.equal(env.AGENT_MEMORY_PYTHON, '/custom/python')
  assert.equal(readFileSync(f.configPath, 'utf8'), original)
  assert.equal(readFileSync(join(state, 'memory.db'), 'utf8'), 'existing database')
  assert.equal(existsSync(join(f.dataDirectory, 'memory/agent-memory')), false)
})

test('missing custom files and missing files inside existing checkouts never fall back silently', t => {
  const f = fixture(t)
  for (const path of [join(f.base, 'custom/missing.yaml'), join(f.root, 'memory/missing.yaml')]) {
    const { environment } = resolveAgentMemoryEnvironment({ root: f.root, dataDirectory: f.dataDirectory,
      env: { AGENT_MEMORY_CONFIG: path } })
    assert.equal(environment.AGENT_MEMORY_CONFIG, path)
  }
  const existing = join(f.base, 'other-checkout')
  mkdirSync(existing)
  const path = join(existing, paths.AGENT_MEMORY_CONFIG)
  const { environment } = resolveAgentMemoryEnvironment({ root: f.root, env: { AGENT_MEMORY_CONFIG: path } })
  assert.equal(environment.AGENT_MEMORY_CONFIG, path)
})

test('shell overrides are resolved for the process without overwriting stored selectors', t => {
  const f = fixture(t)
  const original = 'AGENT_MEMORY_CONFIG=/custom/stored.yaml\nAGENT_MEMORY_SIDECAR=auto\nAGENT_MEMORY_STATE_DIR=auto\n'
  writeFileSync(f.configPath, original)
  const { env } = load(f, { AGENT_MEMORY_CONFIG: join(f.base, 'deleted', paths.AGENT_MEMORY_CONFIG) })
  assert.equal(env.AGENT_MEMORY_CONFIG, join(f.root, paths.AGENT_MEMORY_CONFIG))
  assert.equal(readFileSync(f.configPath, 'utf8'), original)
})

test('read-only inspection resolves paths without creating data, backups, or changing config', t => {
  const f = fixture(t)
  const original = `AGENT_MEMORY_SIDECAR=${join(f.base, 'deleted', paths.AGENT_MEMORY_SIDECAR)}\n`
  writeFileSync(f.configPath, original)
  const env = { QWAUDIO_CONFIG_DIR: f.configDir }
  loadRuntimeEnvironment({ root: f.root, env, readOnly: true })
  assert.equal(env.AGENT_MEMORY_SIDECAR, join(f.root, paths.AGENT_MEMORY_SIDECAR))
  assert.equal(readFileSync(f.configPath, 'utf8'), original)
  assert.equal(existsSync(f.configPath + '.before-agent-memory-auto'), false)
  assert.equal(existsSync(f.dataDirectory), false)
})

test('a concurrent settings change wins over a stale migration plan', t => {
  const f = fixture(t)
  writeFileSync(f.configPath, 'AGENT_MEMORY_CONFIG=/custom/new.yaml\n')
  const updated = persistAutomaticAgentMemoryPaths({ configPath: f.configPath,
    rawEnvironment: { AGENT_MEMORY_CONFIG: '/old/value.yaml' }, automaticKeys: ['AGENT_MEMORY_CONFIG'] })
  assert.deepEqual(updated, [])
  assert.equal(readFileSync(f.configPath, 'utf8'), 'AGENT_MEMORY_CONFIG=/custom/new.yaml\n')
})

test('desktop rereads auto selectors into one consistent Gateway, pre-wake and ambient environment', t => {
  const f = fixture(t)
  const env = desktopGatewayEnvironment({ env: { QWAUDIO_CONFIG_DIR: f.configDir }, runtimeRoot: f.root,
    configured: { AGENT_MEMORY_SIDECAR: 'auto', AGENT_MEMORY_CONFIG: 'auto', AGENT_MEMORY_STATE_DIR: 'auto' } })
  const prewake = resolvePreWakeContextSidecarOptions(env)
  const ambient = resolveAmbientAudioRecordingSidecarOptions(env)
  assert.equal(env.AGENT_MEMORY_SIDECAR, join(f.root, paths.AGENT_MEMORY_SIDECAR))
  assert.equal(prewake.sidecarPath, join(f.root, paths.AGENT_MEMORY_PREWAKE_CONTEXT_SIDECAR))
  assert.equal(ambient.sidecarPath, join(f.root, paths.AGENT_MEMORY_AMBIENT_RECORDING_SIDECAR))
  assert.equal(prewake.configPath, env.AGENT_MEMORY_CONFIG)
  assert.equal(ambient.configPath, env.AGENT_MEMORY_CONFIG)
  assert.equal(ambient.stateDirectory, env.AGENT_MEMORY_STATE_DIR)
  assert.equal(ambient.recordingsDirectory, join(env.AGENT_MEMORY_STATE_DIR, 'ambient-recordings'))
  assert.equal(prewake.logPath, join(env.AGENT_MEMORY_STATE_DIR, 'prewake-context-sidecar.log'))
})

test('PWM settings read the same YAML when the persisted selector is auto', t => {
  const f = fixture(t)
  const result = loadPwmYamlSettings({ env: { AGENT_MEMORY_CONFIG: 'auto' }, sourceRoot: f.root })
  assert.equal(result.pwmLlmModel, 'bundled-chat')
})

test('release resources include Python and YAML outside asar, excluding runtime databases', () => {
  const config = parse(readFileSync(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8'))
  const resource = config.extraResources.find(item => item.from === 'memory')
  assert.equal(resource.to, 'runtime/memory')
  assert.deepEqual(resource.filter, ['src/**/*.py', 'integrations/qwen_audio_agent/*.py', 'config.yaml', 'requirements.txt'])
})

test('a missing bundled runtime cannot conceal an invalid custom configuration', t => {
  const f = fixture(t)
  const root = join(f.base, 'unbundled')
  const file = join(f.base, 'deleted', paths.AGENT_MEMORY_SIDECAR)
  const result = resolveAgentMemoryEnvironment({ root, env: { AGENT_MEMORY_SIDECAR: file } })
  assert.equal(result.environment.AGENT_MEMORY_SIDECAR, file)
  assert.equal(result.repairedKeys.includes('AGENT_MEMORY_SIDECAR'), false)
})
