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
  readAmbientRecordings,
  readInsights,
  readSparks,
  registerDevLabRoutes,
} from '../server/src/conversation/memory/devlab-api.mjs'

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
  app.routes.get('GET /api/devlab/ambient-recordings')({ query: {} }, res)
  assert.equal(res.body.items[0].segments[0].text, '你好')

  res = fakeRes()
  await app.routes.get('POST /api/devlab/insights/simulate')(
    { body: { preset: 'casual_chat' } }, res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.insight.archetype, '新生成原型')
  assert.equal(res.body.items[0].archetype, '新生成原型')
  assert.equal(observed[0].preset, 'casual_chat')
  assert.deepEqual(observed[0].segments, DEVLAB_PRESETS.casual_chat)

  observed.length = 0
  res = fakeRes()
  await app.routes.get('POST /api/devlab/insights/simulate')(
    { body: { segments: [{ speaker: 'speaker_0', text: '自定义对白' }] } }, res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(observed[0].preset, '')
  assert.deepEqual(observed[0].segments, [{ speaker: 'speaker_0', text: '自定义对白' }])

  res = fakeRes()
  await app.routes.get('POST /api/devlab/insights/simulate')(
    { body: { preset: 'not_a_scene' } }, res,
  )
  assert.equal(res.statusCode, 400)

  res = fakeRes()
  await app.routes.get('POST /api/devlab/insights/simulate')(
    { body: { segments: [{ speaker: 'speaker_0', text: 'boom' }] } }, res,
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
    { body: { preset: 'roast_glasses' } }, res,
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
    { body: { segments: [{ speaker: 'speaker_0', text: '自定义灵感' }] } }, res,
  )
  assert.equal(res.statusCode, 200)
  assert.equal(sparkObserved[0].preset, '')
  assert.deepEqual(sparkObserved[0].segments, [{ speaker: 'speaker_0', text: '自定义灵感' }])

  res = fakeRes()
  await app.routes.get('POST /api/devlab/sparks/simulate')(
    { body: { preset: 'not_a_scene' } }, res,
  )
  assert.equal(res.statusCode, 400)

  res = fakeRes()
  await app.routes.get('POST /api/devlab/sparks/simulate')(
    { body: { segments: [{ speaker: 'speaker_0', text: 'boom' }] } }, res,
  )
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.code, 'devlab_simulation_unavailable')
  assert.equal(String(res.body.error).includes('/Users/me'), false)
})
