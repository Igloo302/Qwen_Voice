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
const DEFAULT_SPARK_PATH = join(
  homedir(), '.config/qwaudio/data/memory/spark_captures.jsonl',
)
// Real ambient transcripts may live in either location depending on the app
// version. The agent-memory path is the current one; the plain memory path is
// kept as a tolerance fallback for older installations.
const PRIMARY_RECORDINGS_DIR = join(
  homedir(), '.config/qwaudio/data/memory/agent-memory/ambient-recordings',
)
const DEFAULT_RECORDINGS_DIR = join(
  homedir(), '.config/qwaudio/data/memory/ambient-recordings',
)
const RECORDINGS_DIR_CANDIDATES = Object.freeze([
  PRIMARY_RECORDINGS_DIR,
  DEFAULT_RECORDINGS_DIR,
])
const DEFAULT_INSIGHT_LIMIT = 50
const DEFAULT_SIMULATE_TIMEOUT_MS = 180_000
const CRYSTALLIZED_CONTEXT_TIMEOUT_MS = 15_000

// Minimum evidence required before a real recording is allowed to "become" a
// field. A single monosyllable ("嗯") or a lone turn is never enough to form an
// interpersonal game worth interpreting.
const MIN_REAL_DIALOGUE_CHARS = 30
const MIN_REAL_DIALOGUE_TURNS = 2
const MAX_REAL_DIALOGUE_FILES = 5

// Mirror of the Python services' owner label set: speaker_0 / user / 本人 are
// the wearer, everyone else folds into speaker_1 (external field voices).
const OWNER_SPEAKER_LABELS = new Set([
  'speaker_0', 'user', 'human', 'self', 'me', 'i', 'wearer', 'owner',
  '用户', '用户本人', '佩戴者', '本人', '我', 'speaker_用户本人',
])

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

// Spark presets always put the new idea in speaker_0's mouth: the wearer must
// actively voice the spark, otherwise the Python service returns no_spark.
export const SPARK_PRESETS = Object.freeze({
  roast_glasses: [
    { speaker: 'speaker_1', text: '下班了，随便聊聊。你最近那副眼镜还顺手吗？' },
    { speaker: 'speaker_0', text: '还行吧，就是它只会提醒我开会，太没劲了。诶我有个想法——' },
    { speaker: 'speaker_0', text: '给眼镜加个 real-time 吐槽模式：看到谁就在我耳朵边小声毒舌他，只给我一个人听，脸上还得保持微笑，外人完全看不出来。' },
    { speaker: 'speaker_1', text: '哈哈这不就是缺德版 AR 滤镜吗？' },
    { speaker: 'speaker_0', text: '对，但重点是它得学会我的刻薄语气，越熟的人吐槽越狠；我觉得这比什么 AI 秘书有用一万倍。' },
    { speaker: 'speaker_0', text: '甚至可以做会员订阅：升级后连对方的心率都能编成段子。' },
  ],
  subconscious_cloud: [
    { speaker: 'speaker_0', text: '（一个人戴着眼镜散步，突然停下来）我刚才想到一个有点疯的东西。' },
    { speaker: 'speaker_0', text: '能不能让眼镜把我的梦和潜意识也记下来？睡着后它继续看、继续听，早上给我一份「昨夜的我到底在想什么」的简报。' },
    { speaker: 'speaker_1', text: '你这是要把脑子外包给硬件啊？' },
    { speaker: 'speaker_0', text: '对，就叫赛博外脑：把潜意识外包给眼镜。比记事本狠多了，它记得连我自己都不承认的念头。' },
  ],
})

const SPARK_PRESET_ALIASES = Object.freeze({
  glasses: 'roast_glasses',
  roast: 'roast_glasses',
  toxic_glasses: 'roast_glasses',
  cyber_brain: 'subconscious_cloud',
  dream: 'subconscious_cloud',
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

function resolveSparkPreset(value) {
  const key = clean(value, 64).toLowerCase()
  if (!key) return ''
  if (Object.hasOwn(SPARK_PRESETS, key)) return key
  return SPARK_PRESET_ALIASES[key] || ''
}

function normalizeSpeakerLabel(value) {
  const raw = clean(value, 64).trim().toLowerCase()
  return OWNER_SPEAKER_LABELS.has(raw) ? 'speaker_0' : 'speaker_1'
}

function normalizeTurns(value, maxChars = 4_000) {
  if (!Array.isArray(value)) return []
  const turns = []
  for (const candidate of value.slice(0, 200)) {
    if (!candidate || typeof candidate !== 'object') continue
    const text = clean(candidate.text ?? candidate.content ?? candidate.quote, maxChars)
    if (!text) continue
    turns.push({
      speaker: normalizeSpeakerLabel(
        candidate.speaker ?? candidate.speaker_id ?? candidate.speakerId,
      ),
      text,
    })
  }
  return turns
}

// Strip punctuation / symbols / whitespace. "嗯。" leaves a single character
// and is discarded; "嗯嗯，我不准确" keeps its meaningful content.
function meaningfulChars(text) {
  return [...String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '')]
}

function isMeaningfulSegment(text) {
  const chars = meaningfulChars(text)
  if (chars.length < 2) return false
  // Pure interjections ("嗯嗯", "啊啊", "呃呃") carry no information either.
  if (/^[嗯啊呃哦诶唉额唔嘿]+$/u.test(chars.join(''))) return false
  return true
}

export function resolveMode(value) {
  return clean(value, 16).toLowerCase() === 'preset' ? 'preset' : 'real'
}

export function resolveRecordingsDir(explicit, candidates = RECORDINGS_DIR_CANDIDATES) {
  if (explicit) return explicit
  return candidates.find(dir => dir && existsSync(dir)) || candidates[0] || PRIMARY_RECORDINGS_DIR
}

function buildRealSource(fileNames = []) {
  return ['devlab:real', ...fileNames.map(name => clean(name, 200))].join('|')
}

function realSourceFiles(source) {
  const text = String(source ?? '')
  if (!text.startsWith('devlab:real')) return []
  return text.split('|').slice(1).filter(Boolean).map(name => clean(name, 200))
}

function markRealItems(items, source, fileNames) {
  return items.map(item => (item.source === source
    ? { ...item, is_real_data: true, source_files: fileNames }
    : item))
}

// Core of the "real data driven" upgrade: scan the newest ASR transcripts in
// reverse chronological order, drop noise-only segments and fold every speaker
// into wearer (speaker_0) vs external (speaker_1).
export function extractRecentRealDialogue(recordingsDir, options = {}) {
  const dir = resolveRecordingsDir(recordingsDir)
  const empty = { turns: [], fileNames: [], totalChars: 0, totalTurns: 0, rawSegments: [] }
  if (!dir || !existsSync(dir)) return empty
  const maxFiles = boundedInteger(options.maxFiles, MAX_REAL_DIALOGUE_FILES, 20)
  let files
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.asr.json'))
      .map(entry => {
        const path = join(dir, entry.name)
        let modifiedAt = 0
        try { modifiedAt = statSync(path).mtimeMs } catch {}
        return { path, name: entry.name, modifiedAt }
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, maxFiles)
  } catch {
    return empty
  }

  const turns = []
  const fileNames = []
  const rawSegments = []
  for (const file of files) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file.path, 'utf8'))
    } catch {
      // A single corrupt transcript must not hide the other real recordings.
      continue
    }
    fileNames.push(file.name)
    const segments = (Array.isArray(parsed.segments) ? parsed.segments : [])
      .map(normalizeSegment)
      .filter(Boolean)
      .slice(0, 300)
      .map(segment => ({ ...segment, file: file.name }))
    rawSegments.push(...segments)
    for (const segment of segments) {
      if (!isMeaningfulSegment(segment.text)) continue
      turns.push({ speaker: normalizeSpeakerLabel(segment.speaker), text: segment.text })
    }
  }
  const totalChars = turns.reduce((sum, turn) => sum + [...turn.text].length, 0)
  return { turns, fileNames, totalChars, totalTurns: turns.length, rawSegments }
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
    source: clean(record.source, 1_000),
    provider: clean(record.provider, 80),
    activity_id: record.activity_id ?? null,
    activity_summary: clean(record.activity_summary, 1_000),
    situational_focus: clean(record.situational_focus, 1_000),
    active_thread_titles: Array.isArray(record.active_thread_titles)
      ? record.active_thread_titles.map(name => clean(name, 200))
      : [],
    is_real_data: record.is_real_data === true || realSourceFiles(record.source).length > 0,
    source_files: Array.isArray(record.source_files)
      ? record.source_files.map(name => clean(name, 200))
      : realSourceFiles(record.source),
  }
  if (record.crystallized_context && typeof record.crystallized_context === 'object') {
    insight.crystallized_context = normalizeCrystallizedContext(record.crystallized_context)
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

function normalizeSpark(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const spark = {
    has_spark: record.has_spark === true,
    title: clean(record.title, 120),
    user_spark_quote: clean(record.user_spark_quote, 1_000),
    the_pitch: clean(record.the_pitch, 1_000),
    pros: clean(record.pros, 2_000),
    cons: clean(record.cons, 2_000),
    extension: clean(record.extension, 2_000),
    relevance: clean(record.relevance, 2_000),
    spicy_verdict: clean(record.spicy_verdict, 1_000),
    reality_check: clean(record.reality_check, 1_000),
    created_at: clean(record.created_at, 60),
    model: clean(record.model, 120),
    source: clean(record.source, 1_000),
    provider: clean(record.provider, 80),
    linked_thread_titles: Array.isArray(record.linked_thread_titles)
      ? record.linked_thread_titles.map(name => clean(name, 200))
      : [],
    is_real_data: record.is_real_data === true || realSourceFiles(record.source).length > 0,
    source_files: Array.isArray(record.source_files)
      ? record.source_files.map(name => clean(name, 200))
      : realSourceFiles(record.source),
  }
  if (record.crystallized_context && typeof record.crystallized_context === 'object') {
    spark.crystallized_context = normalizeCrystallizedContext(record.crystallized_context)
  }
  const turnCount = Number(record.turn_count)
  spark.turn_count = Number.isSafeInteger(turnCount) && turnCount >= 0 ? turnCount : null
  return spark
}

export function readSparks(sparksPath = DEFAULT_SPARK_PATH, limit = DEFAULT_INSIGHT_LIMIT) {
  if (!sparksPath || !existsSync(sparksPath)) return []
  const text = readFileSync(sparksPath, 'utf8')
  const records = []
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      // Only cards that actually passed the wearer-authored spark gate are
      // ever persisted, but stay defensive about foreign/old lines.
      if (parsed?.has_spark !== true) continue
      const spark = normalizeSpark(parsed)
      if (spark) records.push(spark)
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

export function readAmbientRecordings(recordingsDir = resolveRecordingsDir(), limit = 3) {
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
    memory_context=payload.get("memoryContext") or None,
)
sys.stdout.write(json.dumps(record or {}, ensure_ascii=False) + "\\n")
`

// Same inline-execution strategy for spark capture. A no-spark conversation
// returns {"has_spark": false} and is never persisted by the Python service.
const PYTHON_SPARK_SIMULATE_SCRIPT = `
import importlib.util
import json
import sys
from pathlib import Path

repo_root = Path(sys.argv[1])
sys.path.insert(0, str(repo_root))
service_path = repo_root / "memory" / "integrations" / "qwen_audio_agent" / "spark_capture_service.py"
spec = importlib.util.spec_from_file_location("devlab_spark_capture_service", service_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SparkCaptureService = module.SparkCaptureService

payload = json.loads(sys.argv[2])
SparkCaptureService._apply_desktop_pwm_env()
service = SparkCaptureService(
    output_path=payload.get("sparksPath") or None,
    config_path=payload.get("configPath") or None,
)
record = service.generate_spark(
    segments=payload.get("segments") or None,
    messages=payload.get("messages") or None,
    source=payload.get("source") or "devlab_simulate",
    memory_context=payload.get("memoryContext") or None,
)
sys.stdout.write(json.dumps(record or {}, ensure_ascii=False) + "\\n")
`

// Read-only extraction of the distilled world-model memory. Kept in a tiny
// inline Python script so the helper module is the single source of truth for
// both the side-car and the HTTP surface (no duplicate SQL in Node).
const PYTHON_CRYSTALLIZED_SCRIPT = `
import importlib.util
import json
import sys
from pathlib import Path

repo_root = Path(sys.argv[1])
helper_path = repo_root / "memory" / "integrations" / "qwen_audio_agent" / "crystallized_memory_helper.py"
spec = importlib.util.spec_from_file_location("devlab_crystallized_memory_helper", helper_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

payload = json.loads(sys.argv[2])
context = module.get_crystallized_memory_context(
    owner_dir=payload.get("ownerDir") or None,
    memory_db_path=payload.get("memoryDb") or None,
    user_model_db_path=payload.get("userModelDb") or None,
    limit_activities=payload.get("limitActivities") or 3,
    limit_threads=payload.get("limitThreads") or 5,
    limit_states=payload.get("limitStates") or 3,
)
sys.stdout.write(json.dumps(context, ensure_ascii=False) + "\\n")
`

export function resolvePythonCommand(options = {}, env = process.env) {
  if (options.pythonCommand) return options.pythonCommand
  const configured = String(env.AGENT_MEMORY_PYTHON || '').trim()
  if (configured) return configured
  if (existsSync(BUNDLED_PYTHON)) return BUNDLED_PYTHON
  return process.platform === 'win32' ? 'python' : 'python3'
}

function createInlinePythonSimulator(script, options, { optionsKey, payloadKey, defaultPath, normalizer }) {
  const command = resolvePythonCommand(options)
  const projectRoot = options.projectRoot || PROJECT_ROOT
  const timeoutMs = options.simulateTimeoutMs || DEFAULT_SIMULATE_TIMEOUT_MS
  return function simulateWithPython({ segments = [], messages = [], source = '' } = {}) {
    const payload = {
      segments,
      messages,
      source: clean(source, 80) || 'devlab_simulate',
      [payloadKey]: options[optionsKey] || defaultPath,
      configPath: options.configPath || '',
    }
    return new Promise((resolveSim, rejectSim) => {
      let child
      try {
        child = spawn(command, ['-c', script, projectRoot, JSON.stringify(payload)], {
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
        finish(null, normalizer(parsed))
      })
    })
  }
}

export function createPythonSimulator(options = {}) {
  return createInlinePythonSimulator(PYTHON_SIMULATE_SCRIPT, options, {
    optionsKey: 'insightsPath',
    payloadKey: 'outputPath',
    defaultPath: DEFAULT_INSIGHTS_PATH,
    normalizer: normalizeInsight,
  })
}

export function createSparkPythonSimulator(options = {}) {
  return createInlinePythonSimulator(PYTHON_SPARK_SIMULATE_SCRIPT, options, {
    optionsKey: 'sparksPath',
    payloadKey: 'sparksPath',
    defaultPath: DEFAULT_SPARK_PATH,
    normalizer: normalizeSpark,
  })
}

export function emptyCrystallizedContext() {
  return {
    latest_activity: {},
    recent_activities: [],
    active_threads: [],
    situational_states: [],
  }
}

// Keep the Python helper's snake_case shape so the same object can be stored
// on insight/spark records and forwarded to the LLM service unchanged.
export function normalizeCrystallizedContext(raw) {
  const empty = emptyCrystallizedContext()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const safeList = value => (Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item))
    : [])
  const latest = raw.latest_activity
  return {
    latest_activity: latest && typeof latest === 'object' && !Array.isArray(latest)
      ? latest
      : {},
    recent_activities: safeList(raw.recent_activities),
    active_threads: safeList(raw.active_threads),
    situational_states: safeList(raw.situational_states),
  }
}

// Never throws: a missing database, corrupt file or Python failure simply
// yields an empty context so the UI and simulations degrade gracefully.
export function readCrystallizedContext(options = {}) {
  const command = resolvePythonCommand(options)
  const projectRoot = options.projectRoot || PROJECT_ROOT
  const payload = {
    ownerDir: options.ownerDir || '',
    memoryDb: options.memoryDb || '',
    userModelDb: options.userModelDb || '',
    limitActivities: options.limitActivities || 3,
    limitThreads: options.limitThreads || 5,
    limitStates: options.limitStates || 3,
  }
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, ['-c', PYTHON_CRYSTALLIZED_SCRIPT, projectRoot, JSON.stringify(payload)], {
        cwd: projectRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve(emptyCrystallizedContext())
      return
    }
    let stdout = ''
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish(emptyCrystallizedContext())
    }, options.crystallizedContextTimeoutMs || CRYSTALLIZED_CONTEXT_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.on('data', chunk => { stdout = clean(stdout + String(chunk), 200_000) })
    child.once('error', () => finish(emptyCrystallizedContext()))
    child.once('close', code => {
      if (code !== 0) return finish(emptyCrystallizedContext())
      const line = stdout.split(/\r?\n/u).map(item => item.trim()).filter(Boolean).pop()
      if (!line) return finish(emptyCrystallizedContext())
      try {
        finish(normalizeCrystallizedContext(JSON.parse(line)))
      } catch {
        finish(emptyCrystallizedContext())
      }
    })
  })
}

export function registerDevLabRoutes(app, options = {}) {
  const insightsPath = options.insightsPath || DEFAULT_INSIGHTS_PATH
  const sparksPath = options.sparksPath || DEFAULT_SPARK_PATH
  const recordingsDir = resolveRecordingsDir(options.recordingsDir)
  const insightLimit = boundedInteger(options.insightLimit, DEFAULT_INSIGHT_LIMIT, 200)
  const simulate = typeof options.simulate === 'function'
    ? options.simulate
    : createPythonSimulator(options)
  const sparkSimulate = typeof options.sparkSimulate === 'function'
    ? options.sparkSimulate
    : createSparkPythonSimulator(options)
  const loadCrystallized = typeof options.crystallizedContextLoader === 'function'
    ? options.crystallizedContextLoader
    : () => readCrystallizedContext(options)

  app.get('/api/devlab/crystallized-context', async (_req, res) => {
    res.setHeader('cache-control', 'no-store')
    try {
      const crystallized_context = normalizeCrystallizedContext(await loadCrystallized())
      return res.json({ ok: true, crystallized_context })
    } catch {
      return res.json({ ok: false, ...emptyCrystallizedContext() })
    }
  })

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

    // Real-data mode is the default. Presets are opt-in via mode="preset".
    if (resolveMode(body.mode) === 'real') {
      const real = extractRecentRealDialogue(recordingsDir)
      const stats = {
        filesScanned: real.fileNames.length,
        totalChars: real.totalChars,
        totalTurns: real.totalTurns,
      }
      if (
        real.totalChars < MIN_REAL_DIALOGUE_CHARS
        || real.totalTurns < MIN_REAL_DIALOGUE_TURNS
      ) {
        return res.json({
          success: false,
          evaluated: true,
          reason: 'insufficient_dialogue',
          message: '最近真实录音有效字数不足 30 字（仅检测到零星应答），未能凝聚出有效的人际博弈场域，规则判定不生成洞察。',
          sourceFiles: real.fileNames,
          stats,
        })
      }
      const source = buildRealSource(real.fileNames)
      // Anchor the reading in the distilled world-model pyramid (activities,
      // threads, situational states) instead of raw ASR noise alone.
      const crystallized_context = normalizeCrystallizedContext(await loadCrystallized())
      try {
        const raw = await simulate({
          segments: real.turns,
          messages: [],
          source,
          preset: '',
          memoryContext: crystallized_context,
        })
        if (!raw) return res.status(502).json({ code: 'devlab_simulation_empty' })
        const insight = {
          ...raw,
          is_real_data: true,
          source_files: real.fileNames,
          crystallized_context,
        }
        let items = []
        try { items = readInsights(insightsPath, insightLimit) } catch {}
        return res.json({
          success: true,
          insight,
          crystallizedContext: crystallized_context,
          items: markRealItems(items, source, real.fileNames),
        })
      } catch {
        // Never leak raw stderr (paths / credentials) to the UI.
        return res.status(503).json({
          code: 'devlab_simulation_unavailable',
          error: '模拟生成失败，请检查 Python side-car 与模型配置后重试',
        })
      }
    }

    // Legacy preset mode — kept for the event simulator tab / full coverage.
    const preset = resolvePreset(body.preset)
    if (body.preset !== undefined && body.preset !== null && body.preset !== '' && !preset) {
      return res.status(400).json({ code: 'invalid_devlab_preset' })
    }
    let turns = normalizeTurns(body.segments)
    if (!turns.length) turns = normalizeTurns(body.messages)
    if (!turns.length) turns = preset ? [...DEVLAB_PRESETS[preset]] : [...DEVLAB_PRESETS.dispute_compromise]
    const source = preset ? `devlab:${preset}` : 'devlab:custom'
    try {
      const insight = await simulate({ segments: turns, messages: [], source, preset })
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

  app.get('/api/devlab/sparks', (_req, res) => {
    res.setHeader('cache-control', 'no-store')
    try {
      const items = readSparks(sparksPath, insightLimit)
      return res.json({ items, total: items.length })
    } catch {
      return res.status(503).json({ code: 'devlab_sparks_unavailable', items: [] })
    }
  })

  app.post('/api/devlab/sparks/simulate', async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    const body = req.body && typeof req.body === 'object' ? req.body : {}

    // Real-data mode is the default. Presets are opt-in via mode="preset".
    if (resolveMode(body.mode) === 'real') {
      const real = extractRecentRealDialogue(recordingsDir)
      const stats = {
        filesScanned: real.fileNames.length,
        totalChars: real.totalChars,
        totalTurns: real.totalTurns,
      }
      if (real.turns.length === 0) {
        return res.json({
          success: false,
          evaluated: true,
          reason: 'no_voice',
          message: '最近没有可用的真实语音转录，暂无法扫描灵感。请先在环境音轨中捕获一段真实对白。',
          sourceFiles: real.fileNames,
          stats,
        })
      }
      const source = buildRealSource(real.fileNames)
      // Anchor the critique in the wearer's real project threads / focus.
      const crystallized_context = normalizeCrystallizedContext(await loadCrystallized())
      try {
        const raw = await sparkSimulate({
          segments: real.turns,
          messages: [],
          source,
          preset: '',
          memoryContext: crystallized_context,
        })
        if (!raw) return res.status(502).json({ code: 'devlab_simulation_empty' })
        // The model judged this to be ordinary business chatter: report the
        // rule outcome transparently and never fabricate a spicy card.
        if (raw.has_spark !== true) {
          return res.json({
            success: true,
            evaluated: true,
            has_spark: false,
            message: `已分析最近真实对白（包含 ${real.totalTurns} 轮讨论），佩戴者未提出新颖创意或假设，规则判定无灵感火花。`,
            sourceFiles: real.fileNames,
            stats,
            crystallizedContext: crystallized_context,
          })
        }
        const spark = {
          ...raw,
          is_real_data: true,
          source_files: real.fileNames,
          crystallized_context,
        }
        let items = []
        try { items = readSparks(sparksPath, insightLimit) } catch {}
        return res.json({
          success: true,
          spark,
          crystallizedContext: crystallized_context,
          items: markRealItems(items, source, real.fileNames),
        })
      } catch {
        return res.status(503).json({
          code: 'devlab_simulation_unavailable',
          error: '模拟生成失败，请检查 Python side-car 与模型配置后重试',
        })
      }
    }

    // Legacy preset mode — kept for the event simulator tab / full coverage.
    const preset = resolveSparkPreset(body.preset)
    if (body.preset !== undefined && body.preset !== null && body.preset !== '' && !preset) {
      return res.status(400).json({ code: 'invalid_devlab_preset' })
    }
    let turns = normalizeTurns(body.segments)
    if (!turns.length) turns = normalizeTurns(body.messages)
    if (!turns.length) turns = preset ? [...SPARK_PRESETS[preset]] : [...SPARK_PRESETS.roast_glasses]
    const source = preset ? `devlab:spark:${preset}` : 'devlab:spark:custom'
    try {
      const spark = await sparkSimulate({ segments: turns, messages: [], source, preset })
      if (!spark) {
        return res.status(502).json({ code: 'devlab_simulation_empty' })
      }
      let items = []
      try { items = readSparks(sparksPath, insightLimit) } catch {}
      return res.json({ spark, items })
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
