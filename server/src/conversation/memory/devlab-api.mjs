// DevLab debug panel API.
//
// Low-intrusion read/simulate surface for creative AI-glasses experiments
// (MBTI field insight, ambient ASR, scenario triggering). It never touches the
// memory database or watermark state: insights are read from the JSONL written
// by the Python side-car, and "simulate" reuses that same side-car so the
// produced record is persisted in exactly the same shape as a real event.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../')
const BUNDLED_PYTHON = join(PROJECT_ROOT, 'memory/.venv/bin/python')
const DEFAULT_INSIGHTS_PATH = join(
  homedir(), '.config/qwaudio/data/memory/mbti_insights.jsonl',
)
const DEFAULT_RECORDINGS_DIR = join(
  homedir(), '.config/qwaudio/data/memory/ambient-recordings',
)
const DEFAULT_INSIGHT_LIMIT = 50
const DEFAULT_SIMULATE_TIMEOUT_MS = 180_000

// Scene presets mirror the three cards in the DevLab event simulator tab.
// speaker_0 is always the wearer, speaker_1 an external voice in the field.
export const DEVLAB_PRESETS = Object.freeze({
  dispute_compromise: [
    { speaker: 'speaker_1', text: '这个版本必须今天定下来，再拖就没有窗口了。我们直接按我的方案走吧。' },
    { speaker: 'speaker_0', text: '我其实还有几个顾虑……不过既然时间紧，先按你说的推进也行。' },
    { speaker: 'speaker_1', text: '顾虑具体是什么？你上次也是这么说的，最后也没拿出替代方案。' },
    { speaker: 'speaker_0', text: '主要是风险没人兜底。算了，我既然提不出更好的，就别卡大家了。' },
    { speaker: 'speaker_1', text: '这就对了嘛。你其实挺配合的，就是想太多。' },
    { speaker: 'speaker_0', text: '嗯，我想太多了。（沉默两秒）那后续的问题我来同步吧。' },
    { speaker: 'speaker_1', text: '等等，你刚才那句话什么意思？好像有点情绪。' },
    { speaker: 'speaker_0', text: '没有情绪，我只是觉得……算了，不重要。继续下一个议题吧。' },
    { speaker: 'speaker_0', text: '好。（低头记笔记，手指在纸上无意识地划圈）' },
  ],
  casual_chat: [
    { speaker: 'speaker_1', text: '我们要不先把所有疯狂的点子都丢出来？不评判，先发散。' },
    { speaker: 'speaker_0', text: '好啊，我想到可以把会议转录直接变成一首诗，让大家笑着看完纪要。' },
    { speaker: 'speaker_1', text: '这个妙！那要是再配一个会根据语气变色的灯呢？' },
    { speaker: 'speaker_0', text: '可以，情绪越激烈颜色越暖。诶，我们能不能让它自己挑一句金句念出来？' },
    { speaker: 'speaker_1', text: '当然，而且用户越困惑，它越要说得很玄。' },
    { speaker: 'speaker_0', text: '哈哈哈对，就是那种听不懂但好像被治愈了的感觉。这个方向太对了。' },
    { speaker: 'speaker_1', text: '那就这么定，明天我们做个最小原型。' },
    { speaker: 'speaker_0', text: '好，我现在脑子里全是画面，回家路上还要继续想。' },
  ],
  solitary_walk: [
    { speaker: 'speaker_0', text: '（一个人走在路上）今天那些话，我说得是不是太软了。' },
    { speaker: 'speaker_0', text: '其实我完全不认同那个方案，可我又怕扫了大家的兴。' },
    { speaker: 'speaker_0', text: '为什么我总要把「不对」说成「我想太多了」……' },
    { speaker: 'speaker_0', text: '（脚步停了一下）也许真正让我难受的，不是让步本身，而是没人看见我让了步。' },
    { speaker: 'speaker_0', text: '算了，风挺舒服的。明天再说吧，至少我刚才那句话是诚实的。' },
  ],
})

const PRESET_ALIASES = Object.freeze({
  brainstorm: 'casual_chat',
  casual_brainstorm: 'casual_chat',
  dispute: 'dispute_compromise',
  compromise: 'dispute_compromise',
  soliloquy: 'solitary_walk',
  self_talk: 'solitary_walk',
  walk: 'solitary_walk',
})

function clean(value, maxChars) {
  return [...String(value ?? '').replaceAll('\0', '').trim()].slice(0, maxChars).join('')
}

function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback
}

function resolvePreset(value) {
  const key = clean(value, 64).toLowerCase()
  if (!key) return ''
  if (Object.hasOwn(DEVLAB_PRESETS, key)) return key
  return PRESET_ALIASES[key] || ''
}

function normalizeTurns(value, maxChars = 4_000) {
  if (!Array.isArray(value)) return []
  const turns = []
  for (const candidate of value.slice(0, 200)) {
    if (!candidate || typeof candidate !== 'object') continue
    const text = clean(candidate.text ?? candidate.content ?? candidate.quote, maxChars)
    if (!text) continue
    const raw = clean(
      candidate.speaker ?? candidate.speaker_id ?? candidate.speakerId, 64,
    ).toLowerCase()
    turns.push({
      speaker: raw === 'speaker_0' || raw === 'user' ? 'speaker_0' : 'speaker_1',
      text,
    })
  }
  return turns
}

function normalizeInsight(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const insight = {
    archetype: clean(record.archetype, 80),
    field_energy: clean(record.field_energy, 400),
    insight: clean(record.insight, 2_000),
    jungian_quote: clean(record.jungian_quote, 400),
    recommended_action: clean(record.recommended_action, 400),
    created_at: clean(record.created_at, 60),
    model: clean(record.model, 120),
    source: clean(record.source, 80),
    provider: clean(record.provider, 80),
  }
  const turnCount = Number(record.turn_count)
  insight.turn_count = Number.isSafeInteger(turnCount) && turnCount >= 0 ? turnCount : null
  return insight
}

export function readInsights(insightsPath = DEFAULT_INSIGHTS_PATH, limit = DEFAULT_INSIGHT_LIMIT) {
  if (!insightsPath || !existsSync(insightsPath)) return []
  const text = readFileSync(insightsPath, 'utf8')
  const records = []
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      const insight = normalizeInsight(parsed)
      if (insight) records.push(insight)
    } catch {
      // A truncated or foreign line must not hide the valid records around it.
    }
  }
  return records.reverse().slice(0, boundedInteger(limit, DEFAULT_INSIGHT_LIMIT, 200))
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0
      ? new Date(value < 1e12 ? value * 1_000 : value).toISOString()
      : ''
  }
  const text = clean(value, 60)
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
}

function normalizeDuration(segment, startedAt, endedAt) {
  for (const key of ['duration', 'duration_seconds', 'durationSeconds']) {
    const value = Number(segment[key])
    if (Number.isFinite(value) && value >= 0) return Math.round(value * 1_000) / 1_000
  }
  if (startedAt && endedAt) {
    const span = (Date.parse(endedAt) - Date.parse(startedAt)) / 1_000
    if (Number.isFinite(span) && span >= 0) return Math.round(span * 1_000) / 1_000
  }
  return 0
}

function normalizeSegment(segment) {
  if (!segment || typeof segment !== 'object') return null
  const text = clean(segment.text ?? segment.content ?? segment.quote, 2_000)
  if (!text) return null
  const metadata = segment.metadata && typeof segment.metadata === 'object'
    ? segment.metadata
    : {}
  const speaker = clean(
    segment.speaker ?? segment.speaker_id ?? segment.speakerId ?? metadata.speaker, 64,
  ) || 'unknown_speaker'
  const startedAt = normalizeTimestamp(
    segment.started_at ?? segment.timestamp ?? segment.start ?? segment.startedAt
    ?? metadata.started_at,
  )
  const endedAt = normalizeTimestamp(
    segment.ended_at ?? segment.end ?? segment.endedAt ?? metadata.ended_at,
  )
  return {
    speaker,
    text,
    timestamp: startedAt,
    duration: normalizeDuration(segment, startedAt, endedAt),
  }
}

export function readAmbientRecordings(recordingsDir = DEFAULT_RECORDINGS_DIR, limit = 3) {
  if (!recordingsDir || !existsSync(recordingsDir)) return []
  let files
  try {
    files = readdirSync(recordingsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.asr.json'))
      .map(entry => {
        const path = join(recordingsDir, entry.name)
        let modifiedAt = 0
        try { modifiedAt = statSync(path).mtimeMs } catch {}
        return { path, name: entry.name, modifiedAt }
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, boundedInteger(limit, 3, 20))
  } catch {
    return []
  }
  const recordings = []
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(file.path, 'utf8'))
      const segments = (Array.isArray(parsed.segments) ? parsed.segments : [])
        .map(normalizeSegment)
        .filter(Boolean)
        .slice(0, 300)
      recordings.push({
        file: clean(file.name, 200),
        batchId: clean(parsed.batchId ?? parsed.batch_id, 200),
        recordingId: clean(parsed.recordingId ?? parsed.recording_id, 200),
        source: clean(parsed.source, 80),
        startedAt: normalizeTimestamp(parsed.startedAt ?? parsed.started_at),
        endedAt: normalizeTimestamp(parsed.endedAt ?? parsed.ended_at),
        durationSeconds: Number.isFinite(Number(parsed.durationSeconds))
          ? Number(parsed.durationSeconds)
          : 0,
        segmentCount: segments.length,
        segments,
      })
    } catch {
      // Skip a single corrupt transcript without failing the whole listing.
    }
  }
  return recordings
}

// The Python module is executed inline via `-c` (no shell): the payload is a
// separate argv entry, so user text can never be interpreted as a command.
const PYTHON_SIMULATE_SCRIPT = `
import importlib.util
import json
import sys
from pathlib import Path

repo_root = Path(sys.argv[1])
sys.path.insert(0, str(repo_root))
# Load by file path: the repo also ships a memory/src/memory package that would
# shadow the namespace path used by -m memory.integrations... otherwise.
service_path = repo_root / "memory" / "integrations" / "qwen_audio_agent" / "mbti_insight_service.py"
spec = importlib.util.spec_from_file_location("devlab_mbti_insight_service", service_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
MBTIInsightService = module.MBTIInsightService

payload = json.loads(sys.argv[2])
MBTIInsightService._apply_desktop_pwm_env()
service = MBTIInsightService(
    output_path=payload.get("outputPath") or None,
    config_path=payload.get("configPath") or None,
)
record = service.generate_insight(
    segments=payload.get("segments") or None,
    messages=payload.get("messages") or None,
    source=payload.get("source") or "devlab_simulate",
)
sys.stdout.write(json.dumps(record or {}, ensure_ascii=False) + "\\n")
`

export function resolvePythonCommand(options = {}, env = process.env) {
  if (options.pythonCommand) return options.pythonCommand
  const configured = String(env.AGENT_MEMORY_PYTHON || '').trim()
  if (configured) return configured
  if (existsSync(BUNDLED_PYTHON)) return BUNDLED_PYTHON
  return process.platform === 'win32' ? 'python' : 'python3'
}

export function createPythonSimulator(options = {}) {
  const command = resolvePythonCommand(options)
  const projectRoot = options.projectRoot || PROJECT_ROOT
  const timeoutMs = options.simulateTimeoutMs || DEFAULT_SIMULATE_TIMEOUT_MS
  return function simulateWithPython({ segments = [], messages = [], source = '' } = {}) {
    const payload = {
      segments,
      messages,
      source: clean(source, 80) || 'devlab_simulate',
      outputPath: options.insightsPath || DEFAULT_INSIGHTS_PATH,
      configPath: options.configPath || '',
    }
    return new Promise((resolveSim, rejectSim) => {
      let child
      try {
        child = spawn(command, ['-c', PYTHON_SIMULATE_SCRIPT, projectRoot, JSON.stringify(payload)], {
          cwd: projectRoot,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        rejectSim(error)
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (error, record) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) rejectSim(error)
        else resolveSim(record)
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(new Error('DevLab simulation timed out'))
      }, timeoutMs)
      timer.unref?.()
      child.stdout?.on('data', chunk => {
        stdout = clean(stdout + String(chunk), 200_000)
      })
      child.stderr?.on('data', chunk => {
        stderr = clean(stderr + String(chunk), 2_000)
      })
      child.once('error', error => finish(error))
      child.once('close', code => {
        const line = stdout.split(/\r?\n/u).map(item => item.trim()).filter(Boolean).pop()
        let parsed = null
        if (line) {
          try { parsed = JSON.parse(line) } catch {}
        }
        if (code !== 0 || !parsed || typeof parsed !== 'object') {
          finish(new Error(
            stderr ? 'DevLab simulation failed inside the Python service'
              : 'DevLab simulation returned no insight',
          ))
          return
        }
        finish(null, normalizeInsight(parsed))
      })
    })
  }
}

export function registerDevLabRoutes(app, options = {}) {
  const insightsPath = options.insightsPath || DEFAULT_INSIGHTS_PATH
  const recordingsDir = options.recordingsDir || DEFAULT_RECORDINGS_DIR
  const insightLimit = boundedInteger(options.insightLimit, DEFAULT_INSIGHT_LIMIT, 200)
  const simulate = typeof options.simulate === 'function'
    ? options.simulate
    : createPythonSimulator(options)

  app.get('/api/devlab/insights', (_req, res) => {
    res.setHeader('cache-control', 'no-store')
    try {
      const items = readInsights(insightsPath, insightLimit)
      return res.json({ items, total: items.length })
    } catch {
      return res.status(503).json({ code: 'devlab_insights_unavailable', items: [] })
    }
  })

  app.post('/api/devlab/insights/simulate', async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const preset = resolvePreset(body.preset)
    if (body.preset !== undefined && body.preset !== null && body.preset !== '' && !preset) {
      return res.status(400).json({ code: 'invalid_devlab_preset' })
    }
    let turns = normalizeTurns(body.segments)
    if (!turns.length) turns = normalizeTurns(body.messages)
    if (!turns.length) turns = preset ? [...DEVLAB_PRESETS[preset]] : [...DEVLAB_PRESETS.dispute_compromise]
    const source = preset ? `devlab:${preset}` : 'devlab:custom'
    try {
      const insight = await simulate({
        segments: turns,
        messages: [],
        source,
        preset,
      })
      if (!insight) {
        return res.status(502).json({ code: 'devlab_simulation_empty' })
      }
      let items = []
      try { items = readInsights(insightsPath, insightLimit) } catch {}
      return res.json({ insight, items })
    } catch {
      // Raw stderr/paths may contain credentials or absolute locations: only a
      // fixed, friendly message is sent to the UI (details stay in the logs of
      // the Python side-car that produced them).
      return res.status(503).json({
        code: 'devlab_simulation_unavailable',
        error: '模拟生成失败，请检查 Python side-car 与模型配置后重试',
      })
    }
  })

  app.get('/api/devlab/ambient-recordings', (req, res) => {
    res.setHeader('cache-control', 'no-store')
    try {
      const items = readAmbientRecordings(recordingsDir, boundedInteger(req?.query?.limit, 3, 20))
      return res.json({ items, total: items.length })
    } catch {
      return res.status(503).json({ code: 'devlab_ambient_unavailable', items: [] })
    }
  })
}
