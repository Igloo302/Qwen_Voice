import assert from 'node:assert/strict'
import {
  appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEVLAB_PRESETS,
  SPARK_PRESETS,
  emptyCrystallizedContext,
  extractRecentRealDialogue,
  normalizeCrystallizedContext,
  readAmbientRecordings,
  readInsights,
  readSparks,
  registerDevLabRoutes,
  resolveMode,
  resolveRecordingsDir,
} from '../server/src/conversation/memory/devlab-api.mjs'

const CRYSTALLIZED_STUB = Object.freeze({
  latest_activity: {
    id: 12,
    activity_text: '佩戴者参与固件与交付讨论',
    user_role: 'participant',
    evidence_facts: ['[固件] 优先联系装栋'],
  },
  recent_activities: [],
  active_threads: [
    { id: 4, title: '空间屏应用与Device SDK交付', current_summary: '20号交付初步版本' },
    { id: 3, title: '面向未来 AI 眼镜的实验性项目', current_summary: 'AI native 开发模式' },
  ],
  situational_states: [
    { state_topic: '空间屏应用与device_sdk交付推进', state_text: '本周提供可集成内容', conditions: { 时间: '20号交付初步版本' } },
  ],
})

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qwen-devlab-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return {
    root,
    insightsPath: join(root, 'mbti_insights.jsonl'),
    sparksPath: join(root, 'spark_captures.jsonl'),
    recordingsDir: join(root, 'ambient-recordings'),
  }
}

function writeAsr(dir, name, segments, second = 0) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify({ batchId: name, segments }))
  const when = new Date(Date.UTC(2026, 4, 1, 0, 0, second))
  utimesSync(path, when, when)
  return path
}

function fakeApp() {
  const routes = new Map()
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler) },
    post(path, handler) { routes.set(`POST ${path}`, handler) },
  }
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(key, value) { this.headers[key] = value },
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

function insight(archetype, createdAt) {
  return JSON.stringify({
    archetype,
    field_energy: 'Fe → Ti',
    insight: '一段剖析',
    jungian_quote: '一句金句',
    recommended_action: '深呼吸',
    created_at: createdAt,
    model: 'qwen-plus',
  })
}

function spark(title, createdAt) {
  return JSON.stringify({
    has_spark: true,
    title,
    user_spark_quote: '我想做个能实时吐槽周围人的眼镜',
    the_pitch: '给眼镜加个毒舌模式',
    pros: '抓到真需求',
    cons: '延迟与伦理都是硬伤',
    extension: '社交情绪外骨骼',
    relevance: '端侧识别是真骨头',
    spicy_verdict: '这是社死加速器，不是产品',
    reality_check: '48 小时做一个粗糙 demo',
    created_at: createdAt,
    model: 'qwen-plus',
  })
}

test('devlab insights reader returns newest first and tolerates broken lines', t => {
  const { insightsPath } = fixture(t)
  appendFileSync(insightsPath, [
    insight('旧原型', '2026-01-01T00:00:00+08:00'),
    '{broken json',
    '',
    insight('新原型', '2026-02-01T00:00:00+08:00'),
  ].join('\n') + '\n')

  const items = readInsights(insightsPath, 10)
  assert.equal(items.length, 2)
  assert.equal(items[0].archetype, '新原型')
  assert.equal(items[1].archetype, '旧原型')
  assert.equal(items[0].model, 'qwen-plus')
  assert.equal(readInsights(insightsPath, 1).length, 1)
})

test('devlab spark reader returns newest first, tolerates broken lines and skips non-sparks', t => {
  const { sparksPath } = fixture(t)
  appendFileSync(sparksPath, [
    spark('旧灵感', '2026-01-01T00:00:00+08:00'),
    '{broken json',
    JSON.stringify({ has_spark: false, title: '不该落盘的寒暄' }),
    '',
    spark('新灵感', '2026-02-01T00:00:00+08:00'),
  ].join('\n') + '\n')

  const items = readSparks(sparksPath, 10)
  assert.equal(items.length, 2)
  assert.equal(items[0].title, '新灵感')
  assert.equal(items[1].title, '旧灵感')
  assert.equal(items[0].has_spark, true)
  assert.equal(items[0].spicy_verdict, '这是社死加速器，不是产品')
  assert.equal(readSparks(sparksPath, 1).length, 1)
})

test('crystallized context normalizer is defensive about malformed payloads', () => {
  assert.deepEqual(normalizeCrystallizedContext(null), emptyCrystallizedContext())
  assert.deepEqual(normalizeCrystallizedContext('nope'), emptyCrystallizedContext())
  const normalized = normalizeCrystallizedContext({
    latest_activity: { activity_text: '活动' },
    recent_activities: [null, { id: 1 }],
    active_threads: 'not-an-array',
    situational_states: [{ state_topic: '焦点' }],
  })
  assert.equal(normalized.latest_activity.activity_text, '活动')
  assert.equal(normalized.recent_activities.length, 1)
  assert.deepEqual(normalized.active_threads, [])
  assert.equal(normalized.situational_states[0].state_topic, '焦点')
})

test('devlab readers return empty collections when files are absent', t => {
  const { root, recordingsDir } = fixture(t)
  assert.deepEqual(readInsights(join(root, 'missing.jsonl')), [])
  assert.deepEqual(readSparks(join(root, 'missing.jsonl')), [])
  assert.deepEqual(readAmbientRecordings(join(recordingsDir, 'missing')), [])
})

test('devlab ambient reader takes the three newest transcripts and normalizes segments', t => {
  const { recordingsDir } = fixture(t)
  mkdirSync(recordingsDir, { recursive: true })
  for (let index = 0; index < 5; index += 1) {
    const path = join(recordingsDir, `batch-${index}.asr.json`)
    writeFileSync(path, JSON.stringify({
      batchId: `batch-${index}`,
      source: 'microphone',
      segments: [{
        speaker: 'speaker_0',
        text: `佩戴者片段 ${index}`,
        started_at: '2026-03-01T10:00:00+08:00',
        ended_at: '2026-03-01T10:00:03+08:00',
      }, {
        speaker: 'speaker_1',
        text: `外部片段 ${index}`,
        timestamp: '2026-03-01T10:00:05+08:00',
      }],
    }))
    const when = new Date(Date.UTC(2026, 2, 1, 0, 0, index))
    utimesSync(path, when, when)
  }
  const corruptPath = join(recordingsDir, 'corrupt.asr.json')
  writeFileSync(corruptPath, '{not json')
  const oldest = new Date(Date.UTC(2020, 0, 1))
  utimesSync(corruptPath, oldest, oldest)

  const items = readAmbientRecordings(recordingsDir, 3)
  assert.equal(items.length, 3)
  assert.ok(items.every(item => item.batchId.startsWith('batch-')))
  assert.equal(items[0].batchId, 'batch-4')
  assert.deepEqual(items[0].segments[0], {
    speaker: 'speaker_0',
    text: '佩戴者片段 4',
    timestamp: '2026-03-01T02:00:00.000Z',
    duration: 3,
  })
  assert.equal(items[0].segments[1].speaker, 'speaker_1')
  assert.equal(items[0].segments[1].duration, 0)
})

test('devlab routes expose insights, sparks, simulation and ambient endpoints with tolerant errors', async t => {
  const { insightsPath, sparksPath, recordingsDir } = fixture(t)
  mkdirSync(recordingsDir, { recursive: true })
  writeFileSync(insightsPath, insight('历史原型', '2026-04-01T00:00:00+08:00') + '\n')
  writeFileSync(sparksPath, spark('历史灵感', '2026-04-01T00:00:00+08:00') + '\n')
  writeFileSync(join(recordingsDir, 'one.asr.json'), JSON.stringify({
    segments: [{ speaker: 'speaker_0', text: '你好', timestamp: '2026-04-01T09:00:00+08:00' }],
  }))

  const observed = []
  const sparkObserved = []
  const app = fakeApp()
  registerDevLabRoutes(app, {
    crystallizedContextLoader: async () => CRYSTALLIZED_STUB,
    insightsPath,
    sparksPath,
    recordingsDir,
    simulate: async payload => {
      observed.push(payload)
      if (payload.segments[0]?.text === 'boom') {
        throw new Error('secret /Users/me/.config/key leaked')
      }
      appendFileSync(insightsPath, insight('新生成原型', '2026-04-02T00:00:00+08:00') + '\n')
      return {
        archetype: '新生成原型',
        field_energy: 'Ni → Fi',
        insight: '洞察正文',
        jungian_quote: '金句',
        recommended_action: '微行动',
        created_at: '2026-04-02T00:00:00+08:00',
        model: 'qwen-plus',
      }
    },
    sparkSimulate: async payload => {
      sparkObserved.push(payload)
      if (payload.segments[0]?.text === 'boom') {
        throw new Error('secret /Users/me/.config/key leaked')
      }
      appendFileSync(sparksPath, spark('新生成灵感', '2026-04-02T00:00:00+08:00') + '\n')
      return {
        has_spark: true,
        title: '新生成灵感',
        user_spark_quote: '我想做个能实时吐槽周围人的眼镜',
        the_pitch: '给眼镜加个毒舌模式',
        pros: '抓到真需求',
        cons: '延迟与伦理都是硬伤',
        extension: '社交情绪外骨骼',
        relevance: '端侧识别是真骨头',
        spicy_verdict: '这是社死加速器，不是产品',
        reality_check: '48 小时做一个粗糙 demo',
        created_at: '2026-04-02T00:00:00+08:00',
        model: 'qwen-plus',
      }
    },
  })
  assert.deepEqual([...app.routes.keys()].sort(), [
    'GET /api/devlab/ambient-recordings',
    'GET /api/devlab/crystallized-context',
    'GET /api/devlab/insights',
    'GET /api/devlab/sparks',
    'POST /api/devlab/insights/simulate',
    'POST /api/devlab/sparks/simulate',
  ])

  let res = fakeRes()
  app.routes.get('GET /api/devlab/insights')({}, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.body.items[0].archetype, '历史原型')

  res = fakeRes()
  await app.routes.get('GET /api/devlab/crystallized-context')({}, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.crystallized_context.latest_activity.id, 12)
  assert.equal(res.body.crystallized_context.active_threads.length, 2)

  res = fakeRes()
  app.routes.get('GET /api/devlab/ambient-recordings')({ query: {} }, res)
  assert.equal(res.body.items[0].segments[0].text, '你好')

  res = fakeRes()
  await app.routes.get('POST /api/devlab/insights/simulate')(
    { body: { mode: 'preset', preset: 'casual_chat' } }, res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.insight.archetype, '新生成原型')
  assert.equal(res.body.items[0].archetype, '新生成原型')
  assert.equal(observed[0].preset, 'casual_chat')
  assert.deepEqual(observed[0].segments, DEVLAB_PRESETS.casual_chat)

  observed.length = 0
  res = fakeRes()
  await app.routes.get('POST /api/devlab/insights/simulate')(
    { body: { mode: 'preset', segments: [{ speaker: 'speaker_0', text: '自定义对白' }] } }, res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(observed[0].preset, '')
  assert.deepEqual(observed[0].segments, [{ speaker: 'speaker_0', text: '自定义对白' }])

  res = fakeRes()
  await app.routes.get('POST /api/devlab/insights/simulate')(
    { body: { mode: 'preset', preset: 'not_a_scene' } }, res,
  )
  assert.equal(res.statusCode, 400)

  res = fakeRes()
  await app.routes.get('POST /api/devlab/insights/simulate')(
    { body: { mode: 'preset', segments: [{ speaker: 'speaker_0', text: 'boom' }] } }, res,
  )
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.code, 'devlab_simulation_unavailable')
  assert.equal(String(res.body.error).includes('/Users/me'), false)

  res = fakeRes()
  app.routes.get('GET /api/devlab/sparks')({}, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.body.items[0].title, '历史灵感')

  res = fakeRes()
  await app.routes.get('POST /api/devlab/sparks/simulate')(
    { body: { mode: 'preset', preset: 'roast_glasses' } }, res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.spark.has_spark, true)
  assert.equal(res.body.spark.title, '新生成灵感')
  assert.equal(res.body.items[0].title, '新生成灵感')
  assert.equal(sparkObserved[0].preset, 'roast_glasses')
  assert.deepEqual(sparkObserved[0].segments, SPARK_PRESETS.roast_glasses)

  sparkObserved.length = 0
  res = fakeRes()
  await app.routes.get('POST /api/devlab/sparks/simulate')(
    { body: { mode: 'preset', segments: [{ speaker: 'speaker_0', text: '自定义灵感' }] } }, res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(sparkObserved[0].preset, '')
  assert.deepEqual(sparkObserved[0].segments, [{ speaker: 'speaker_0', text: '自定义灵感' }])

  res = fakeRes()
  await app.routes.get('POST /api/devlab/sparks/simulate')(
    { body: { mode: 'preset', preset: 'not_a_scene' } }, res,
  )
  assert.equal(res.statusCode, 400)

  res = fakeRes()
  await app.routes.get('POST /api/devlab/sparks/simulate')(
    { body: { mode: 'preset', segments: [{ speaker: 'speaker_0', text: 'boom' }] } }, res,
  )
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.code, 'devlab_simulation_unavailable')
  assert.equal(String(res.body.error).includes('/Users/me'), false)
})

test('extractRecentRealDialogue scans newest ASR files, drops filler and maps speakers', t => {
  const { recordingsDir } = fixture(t)
  for (let index = 0; index < 6; index += 1) {
    writeAsr(recordingsDir, `batch-${index}.asr.json`, [
      {
        speaker: index === 5 ? 'user' : `speaker_${index + 1}`,
        text: `这是第 ${index} 个真实文件里的一句完整对白。`,
        started_at: '2026-05-01T10:00:00+08:00',
      },
      { speaker: 'unknown_speaker', text: '嗯。' },
      { speaker: 'speaker_0', text: '嗯嗯' },
    ], index)
  }

  const result = extractRecentRealDialogue(recordingsDir)
  assert.equal(result.fileNames.length, 5)
  assert.equal(result.fileNames[0], 'batch-5.asr.json')
  assert.equal(result.totalTurns, 5)
  assert.ok(result.totalChars > 30)
  assert.equal(result.turns[0].speaker, 'speaker_0')
  assert.equal(result.turns[1].speaker, 'speaker_1')
  // rawSegments keeps everything that was scanned, turns keep only meaningful lines.
  assert.ok(result.rawSegments.length >= 15)
  assert.ok(!result.turns.some(turn => ['嗯。', '嗯嗯'].includes(turn.text)))
  assert.equal(extractRecentRealDialogue(recordingsDir, { maxFiles: 2 }).fileNames.length, 2)
})

test('mode defaults to real and recordings dir adapts to either install location', t => {
  assert.equal(resolveMode(undefined), 'real')
  assert.equal(resolveMode('REAL'), 'real')
  assert.equal(resolveMode('preset'), 'preset')
  const { root } = fixture(t)
  const missing = join(root, 'missing')
  const present = join(root, 'present')
  mkdirSync(present, { recursive: true })
  assert.equal(resolveRecordingsDir(undefined, [missing, present]), present)
  assert.equal(resolveRecordingsDir(undefined, [missing]), missing)
  assert.equal(resolveRecordingsDir(join(root, 'explicit'), [missing, present]), join(root, 'explicit'))
})

test('insights simulate defaults to real mode and refuses filler-only dialogue', async t => {
  const { insightsPath, recordingsDir } = fixture(t)
  writeAsr(recordingsDir, 'only-filler.asr.json', [
    { speaker: 'speaker_0', text: '嗯。' },
    { speaker: 'unknown_speaker', text: '啊' },
    { speaker: 'speaker_1', text: '……' },
  ])
  const observed = []
  const app = fakeApp()
  registerDevLabRoutes(app, {
    crystallizedContextLoader: async () => CRYSTALLIZED_STUB,
    insightsPath,
    recordingsDir,
    simulate: async payload => {
      observed.push(payload)
      return { archetype: '不该出现的洞察' }
    },
  })

  const res = fakeRes()
  await app.routes.get('POST /api/devlab/insights/simulate')({ body: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, false)
  assert.equal(res.body.evaluated, true)
  assert.equal(res.body.reason, 'insufficient_dialogue')
  assert.match(res.body.message, /30 字/)
  assert.deepEqual(res.body.sourceFiles, ['only-filler.asr.json'])
  assert.equal(observed.length, 0)
})

test('insights simulate in real mode feeds extracted turns to Python and flags provenance', async t => {
  const { insightsPath, recordingsDir } = fixture(t)
  writeAsr(recordingsDir, 'real-a.asr.json', [
    { speaker: 'user', text: '我们最近在讨论硬件 SDK 的功耗问题。' },
    { speaker: 'speaker_2', text: '手势唤醒一直开着，待机电流偏高。' },
  ], 1)
  writeAsr(recordingsDir, 'real-b.asr.json', [
    { speaker: 'user', text: '也许可以改成事件触发，只在抬手时采样。' },
  ], 2)
  const observed = []
  const app = fakeApp()
  registerDevLabRoutes(app, {
    crystallizedContextLoader: async () => CRYSTALLIZED_STUB,
    insightsPath,
    recordingsDir,
    simulate: async payload => {
      observed.push(payload)
      appendFileSync(insightsPath, insight('真实场域原型', '2026-05-02T00:00:00+08:00') + '\n')
      return { archetype: '真实场域原型', turn_count: payload.segments.length }
    },
  })

  const res = fakeRes()
  await app.routes.get('POST /api/devlab/insights/simulate')({ body: { mode: 'real' } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.insight.archetype, '真实场域原型')
  assert.equal(res.body.insight.is_real_data, true)
  assert.deepEqual(res.body.insight.source_files, ['real-b.asr.json', 'real-a.asr.json'])
  assert.match(observed[0].source, /^devlab:real\|/)
  assert.equal(observed[0].segments.length, 3)
  assert.equal(observed[0].segments[0].speaker, 'speaker_0')
  assert.equal(observed[0].memoryContext.latest_activity.id, 12)
  assert.equal(res.body.insight.crystallized_context.active_threads.length, 2)
  assert.equal(res.body.crystallizedContext.active_threads[0].title, '空间屏应用与Device SDK交付')
  assert.equal(res.body.items[0].archetype, '真实场域原型')
})

test('sparks simulate defaults to real mode and reports no_voice with no transcript', async t => {
  const { sparksPath, recordingsDir } = fixture(t)
  writeAsr(recordingsDir, 'empty.asr.json', [])
  const app = fakeApp()
  registerDevLabRoutes(app, {
    crystallizedContextLoader: async () => CRYSTALLIZED_STUB,
    sparksPath,
    recordingsDir,
    sparkSimulate: async () => { throw new Error('should not be called') },
  })

  const res = fakeRes()
  await app.routes.get('POST /api/devlab/sparks/simulate')({ body: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, false)
  assert.equal(res.body.reason, 'no_voice')
  assert.deepEqual(res.body.sourceFiles, ['empty.asr.json'])
})

test('sparks simulate in real mode reports has_spark=false without fabricating a card', async t => {
  const { sparksPath, recordingsDir } = fixture(t)
  writeAsr(recordingsDir, 'business.asr.json', [
    { speaker: 'user', text: '这个需求明天评审，硬件那边再确认一下。' },
    { speaker: 'speaker_2', text: '好，我把功耗数据整理一下发你。' },
  ], 1)
  writeAsr(recordingsDir, 'business-2.asr.json', [
    { speaker: 'user', text: '收到，那就按这个排期推进。' },
  ], 2)
  const observed = []
  const app = fakeApp()
  registerDevLabRoutes(app, {
    crystallizedContextLoader: async () => CRYSTALLIZED_STUB,
    sparksPath,
    recordingsDir,
    sparkSimulate: async payload => {
      observed.push(payload)
      return { has_spark: false, turn_count: payload.segments.length }
    },
  })

  const res = fakeRes()
  await app.routes.get('POST /api/devlab/sparks/simulate')({ body: { mode: 'real' } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.evaluated, true)
  assert.equal(res.body.has_spark, false)
  assert.match(res.body.message, /3 轮讨论/)
  assert.deepEqual(res.body.sourceFiles, ['business-2.asr.json', 'business.asr.json'])
  assert.equal(res.body.spark, undefined)
  assert.equal(observed[0].segments.length, 3)
})

test('sparks simulate in real mode flags a genuine spark with provenance', async t => {
  const { sparksPath, recordingsDir } = fixture(t)
  writeAsr(recordingsDir, 'idea.asr.json', [
    { speaker: 'user', text: '我有个新想法，让眼镜在抬手时自动播报一条毒舌点评。' },
    { speaker: 'speaker_2', text: '这不就是缺德版 AR 滤镜吗？' },
  ])
  const app = fakeApp()
  registerDevLabRoutes(app, {
    crystallizedContextLoader: async () => CRYSTALLIZED_STUB,
    sparksPath,
    recordingsDir,
    sparkSimulate: async () => {
      appendFileSync(sparksPath, spark('真实灵感', '2026-05-02T00:00:00+08:00') + '\n')
      return { has_spark: true, title: '真实灵感', turn_count: 2 }
    },
  })

  const res = fakeRes()
  await app.routes.get('POST /api/devlab/sparks/simulate')({ body: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.spark.is_real_data, true)
  assert.deepEqual(res.body.spark.source_files, ['idea.asr.json'])
  assert.equal(res.body.spark.crystallized_context.situational_states.length, 1)
})
