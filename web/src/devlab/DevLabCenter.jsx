import { useCallback, useEffect, useRef, useState } from 'react'
import { gatewayFetch } from '../gateway-transport.js'
import { t } from '../i18n.js'
import './devlab.css'

const TABS = [
  { id: 'insights', icon: '🔮', label: '场域洞察', sub: 'MBTI INSIGHTS' },
  { id: 'sparks', icon: '💡', label: '灵感捕获 (Sparks)', sub: 'SPARK CAPTURE' },
  { id: 'ambient', icon: '🎙️', label: '环境音轨探针', sub: 'AMBIENT ASR' },
  { id: 'events', icon: '⚡', label: '场景事件模拟器', sub: 'EVENT SIMULATOR' },
]

const SCENARIOS = [
  {
    preset: 'dispute_compromise',
    icon: '🗯️',
    title: '激烈讨论后妥协',
    tag: '内倾妥协 · 防御洞察',
    desc: '一场高压会议，佩戴者反复退让、把顾虑咽回去，用沉默完成微型献祭。',
  },
  {
    preset: 'casual_chat',
    icon: '💡',
    title: '轻松头脑风暴',
    tag: '外倾直觉 · 共鸣洞察',
    desc: '天马行空的共创对话，点子互相点燃，佩戴者在外倾直觉里闪闪发光。',
  },
  {
    preset: 'solitary_walk',
    icon: '🌙',
    title: '独自散步自言自语',
    tag: '内省沉思 · 影子浮现',
    desc: '只有佩戴者一个人的声音，脚步与风声之间，那些没说出口的话浮上来。',
  },
  {
    preset: 'roast_glasses',
    kind: 'spark',
    icon: '💡',
    title: '毒舌眼镜：实时吐槽周围人',
    tag: '灵感火花 · 毒舌诊断',
    desc: '佩戴者主动提出给眼镜做个能实时吐槽周围人的功能，验证灵感捕获与辣评链路。',
  },
  {
    preset: 'subconscious_cloud',
    kind: 'spark',
    icon: '🧠',
    title: '赛博外脑：外包潜意识',
    tag: '灵感火花 · 脑洞延伸',
    desc: '佩戴者想把梦和潜意识也交给眼镜记录，看看毒舌投资人怎么拆穿这场自嗨。',
  },
]

const AMBIENT_POLL_MS = 10_000

async function readJson(path, options = {}, signal) {
  const cleanPath = String(path).replace(/^\//, '')
  const response = await gatewayFetch(cleanPath, { cache: 'no-store', ...options, signal })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(
      payload?.error || payload?.code || `${t('请求失败')} (${response.status})`,
    )
  }
  return payload
}

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 25)
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function formatDuration(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return ''
  return value < 1 ? `${Math.round(value * 1000)}ms` : `${value.toFixed(1)}s`
}

function isOwner(speaker) {
  return /speaker_0|佩戴者|本人|用户本人|^user$/iu.test(String(speaker || ''))
}

function isRealData(item) {
  return item?.is_real_data === true || String(item?.source || '').startsWith('devlab:real')
}

function sourceFilesOf(item) {
  if (Array.isArray(item?.source_files) && item.source_files.length) return item.source_files
  const source = String(item?.source || '')
  return source.startsWith('devlab:real|')
    ? source.split('|').slice(1).filter(Boolean)
    : []
}

function evaluationStats(stats) {
  if (!stats) return ''
  const parts = []
  if (stats.filesScanned) parts.push(t('已扫描近 {n} 个录音切片', { n: stats.filesScanned }))
  if (stats.totalTurns) parts.push(t('共 {n} 句对白', { n: stats.totalTurns }))
  if (stats.totalChars) parts.push(t('有效字数 {n}', { n: stats.totalChars }))
  return parts.join('，')
}

function RuleBanner({ evaluation }) {
  if (!evaluation) return null
  const files = Array.isArray(evaluation.sourceFiles) ? evaluation.sourceFiles : []
  return <div className={`devlab-rule-banner ${evaluation.tone || ''}`} role="status">
    <span className="rule-banner-icon">{evaluation.icon || '🧊'}</span>
    <div className="rule-banner-body">
      <strong>{evaluation.title}</strong>
      {evaluation.message && <p>{evaluation.message}</p>}
      {evaluationStats(evaluation.stats) && <p className="rule-banner-stats">{evaluationStats(evaluation.stats)}</p>}
      {files.length > 0 && <div className="rule-banner-files">
        <span>{t('涉及录音文件')}</span>
        {files.map(file => <code key={file}>{file}</code>)}
      </div>}
    </div>
  </div>
}

const ACTIVITY_ROLE_LABELS = {
  actor: '主导者 · actor',
  participant: '参与者 · participant',
  contextual: '背景 · contextual',
}

function CrystallizedAnchor({ context, loading, error, onRefresh }) {
  const [open, setOpen] = useState(true)
  const latest = context?.latest_activity || {}
  const activities = context?.recent_activities || []
  const threads = context?.active_threads || []
  const states = context?.situational_states || []
  const hasContent = Boolean(latest.activity_text || threads.length || states.length)

  return <section className={`crystal-anchor ${open ? 'open' : ''}`}>
    <header className="crystal-anchor-head">
      <button
        type="button"
        className="crystal-anchor-toggle"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
      >
        <span className="crystal-icon">🧠</span>
        <span className="crystal-title">
          <b>{t('个人世界模型认知基底')}</b>
          <small>CRYSTALLIZED MEMORY ANCHOR · {t('五层记忆蒸馏金字塔的高维产物')}</small>
        </span>
        <span className="crystal-chevron">{open ? '▾' : '▸'}</span>
      </button>
      <button type="button" className="devlab-button" onClick={onRefresh} disabled={loading}>
        {loading ? t('读取中…') : `↻ ${t('刷新基底')}`}
      </button>
    </header>
    {open && <div className="crystal-anchor-body">
      {error && <div className="devlab-alert" role="alert">⚠ {error}</div>}
      {!loading && !error && !hasContent && <p className="crystal-empty">
        {t('尚无结晶记忆：当环境录音被蒸馏为活动、主线与处境后，这里会自动点亮。')}
      </p>}
      <div className="crystal-grid">
        <div className="crystal-section">
          <h3>{t('🎯 当前高阶活动 · USER ACTIVITY')}</h3>
          {latest.activity_text
            ? <div className="crystal-card activity">
                <p>{latest.activity_text}</p>
                <div className="crystal-tags">
                  {latest.user_role && <span className="crystal-tag role">
                    {t(ACTIVITY_ROLE_LABELS[latest.user_role] || latest.user_role)}
                  </span>}
                  {(latest.evidence_facts || []).slice(0, 4).map((fact, index) => (
                    <span className="crystal-tag fact" key={index}># {fact}</span>
                  ))}
                </div>
                {activities.length > 1 && <small className="crystal-more">
                  {t('近期活动')}：{activities.slice(1, 3).map(item => item.activity_text).join(' ｜ ')}
                </small>}
              </div>
            : <p className="crystal-muted">—</p>}
        </div>
        <div className="crystal-section">
          <h3>{t('🔗 进行中的主线 · USER THREADS')}</h3>
          {threads.length
            ? <ul className="crystal-list">
                {threads.map(thread => <li key={thread.id || thread.title}>
                  <b>《{thread.title}》</b>
                  <p>{thread.current_summary}</p>
                </li>)}
              </ul>
            : <p className="crystal-muted">—</p>}
        </div>
        <div className="crystal-section">
          <h3>{t('⚡ 当前处境焦点 · SITUATIONAL STATE')}</h3>
          {states.length
            ? <ul className="crystal-list">
                {states.map(state => <li key={state.id || state.state_topic}>
                  <b>{state.state_topic}</b>
                  <p>{state.state_text}</p>
                  {state.conditions && typeof state.conditions === 'object'
                    && Object.keys(state.conditions).length > 0
                    && <small className="crystal-conditions">
                      {Object.entries(state.conditions)
                        .filter(([, value]) => value)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(' · ')}
                    </small>}
                </li>)}
              </ul>
            : <p className="crystal-muted">—</p>}
        </div>
      </div>
    </div>}
  </section>
}

function EmptyState({ icon, title, hint }) {
  return <div className="devlab-empty">
    <div className="devlab-empty-icon">{icon}</div>
    <strong>{title}</strong>
    <p>{hint}</p>
  </div>
}

function InsightCard({ item, index }) {
  const real = isRealData(item)
  const sourceFiles = sourceFilesOf(item)
  return <article className="insight-card" style={{ '--card-delay': `${Math.min(index, 8) * 45}ms` }}>
    <header className="insight-head">
      <span className="archetype-badge">{item.archetype || t('未命名原型')}</span>
      <div className="insight-head-meta">
        {real && <span className="real-data-flag">🟢 {t('真实录音提炼')}</span>}
        <time>{formatTime(item.created_at)}</time>
      </div>
    </header>
    {(item.activity_summary || item.situational_focus || item.active_thread_titles?.length > 0)
      && <div className="anchor-badges">
        {item.activity_summary && <span className="anchor-badge activity" title={item.activity_summary}>
          🎯 {t('锚定活动')}：{item.activity_summary}
        </span>}
        {item.situational_focus && <span className="anchor-badge focus" title={item.situational_focus}>
          ⚡ {t('处境焦点')}：{item.situational_focus}
        </span>}
        {item.active_thread_titles?.length > 0 && <span className="anchor-badge thread">
          🔗 {t('关联主线')}：{item.active_thread_titles.join(' · ')}
        </span>}
      </div>}
    <div className="energy-line">
      <span className="energy-dot" />
      <span>{item.field_energy || t('能量场域未记录')}</span>
    </div>
    <p className="insight-body">{item.insight || t('暂无剖析正文')}</p>
    {item.jungian_quote && <blockquote className="jungian-quote">“{item.jungian_quote}”</blockquote>}
    {real && sourceFiles.length > 0 && <div className="real-source-line">
      🎙️ {t('录音来源')}：{sourceFiles.join(' · ')}
    </div>}
    <footer className="insight-foot">
      <span className="micro-action"><b>⚡ {t('微行动')}</b>{item.recommended_action || '—'}</span>
      <span className="insight-meta">
        {item.model ? `⌘ ${item.model}` : ''}
        {item.turn_count ? ` · ${t('{n} 轮对白', { n: item.turn_count })}` : ''}
      </span>
    </footer>
  </article>
}

function InsightsTab({ items, loading, error, busy, evaluation, onRefresh, onSimulate }) {
  return <section className="tab-panel">
    <div className="panel-toolbar">
      <div>
        <h2>{t('场域洞察流')}</h2>
        <p className="panel-sub">{t('严格基于最近真实录音 · 字数或轮数不足时规则判定不生成 · 最新在前')}</p>
      </div>
      <div className="toolbar-actions">
        <button type="button" className="devlab-button" onClick={onRefresh} disabled={loading}>
          {loading ? t('读取中…') : `↻ ${t('刷新')}`}
        </button>
        <button
          type="button"
          className="devlab-button primary"
          onClick={() => onSimulate('')}
          disabled={busy}
        >
          {busy ? t('扫描中…', {}) : `⚡ ${t('从最近真实录音提炼洞察')}`}
        </button>
      </div>
    </div>
    {error && <div className="devlab-alert" role="alert">⚠ {error}</div>}
    {!error && <RuleBanner evaluation={evaluation} />}
    {!loading && !error && items.length === 0 && <EmptyState
      icon="🔮"
      title={t('还没有洞察记录')}
      hint={t('点击「从最近真实录音提炼洞察」，让随身荣格心理导师读一次刚才的真实场域。')}
    />}
    <div className="insight-list">
      {items.map((item, index) => <InsightCard key={`${item.created_at}:${index}`} item={item} index={index} />)}
    </div>
  </section>
}

function SparkCard({ item, index }) {
  const real = isRealData(item)
  const sourceFiles = sourceFilesOf(item)
  return <article className="spark-card" style={{ '--card-delay': `${Math.min(index, 8) * 45}ms` }}>
    <header className="spark-head">
      <span className="spark-title">{item.title || t('未命名火花')}</span>
      <div className="spark-head-meta">
        {real && <span className="real-data-flag">🟢 {t('真实录音提炼')}</span>}
        <time>{formatTime(item.created_at)}</time>
      </div>
    </header>
    {item.linked_thread_titles?.length > 0 && <div className="anchor-badges">
      <span className="anchor-badge thread" title={item.linked_thread_titles.join(' · ')}>
        🔗 {t('关联合约/主线')}：{item.linked_thread_titles.join(' · ')}
      </span>
    </div>}
    {item.user_spark_quote && <blockquote className="spark-quote">
      <span>{t('你的原话 · WEARER SAID')}</span>“{item.user_spark_quote}”
    </blockquote>}
    {item.the_pitch && <p className="spark-pitch">{item.the_pitch}</p>}
    <div className="spark-duo">
      <div className="spark-capsule pro">
        <b>✦ PROS · {t('诱人之处')}</b>
        <p>{item.pros || '—'}</p>
      </div>
      <div className="spark-capsule con">
        <b>✕ CONS · {t('致命盲点')}</b>
        <p>{item.cons || '—'}</p>
      </div>
    </div>
    {(item.extension || item.relevance) && <div className="spark-sections">
      {item.extension && <div className="spark-section">
        <b>∞ {t('极致延伸')}</b>
        <p>{item.extension}</p>
      </div>}
      {item.relevance && <div className={`spark-section${item.linked_thread_titles?.length ? ' relevance-anchored' : ''}`}>
        <b>◎ {t('现实关联 · 与真实主线的碰撞')}</b>
        <p>{item.relevance}</p>
      </div>}
    </div>}
    {item.spicy_verdict && <blockquote className="spark-verdict">
      <span>{t('毒舌终审 · SPICY VERDICT')}</span>
      {item.spicy_verdict}
    </blockquote>}
    {item.reality_check && <div className="spark-reality">
      <b>⚗ {t('试金石 · REALITY CHECK')}</b>
      <p>{item.reality_check}</p>
    </div>}
    {real && sourceFiles.length > 0 && <div className="real-source-line">
      🎙️ {t('录音来源')}：{sourceFiles.join(' · ')}
    </div>}
    <footer className="spark-foot">
      <span className="insight-meta">
        {item.model ? `⌘ ${item.model}` : ''}
        {item.turn_count ? ` · ${t('{n} 轮对白', { n: item.turn_count })}` : ''}
      </span>
    </footer>
  </article>
}

function SparksTab({ items, loading, error, busy, evaluation, onRefresh, onSimulate }) {
  return <section className="tab-panel">
    <div className="panel-toolbar">
      <div>
        <h2>{t('灵感火花流')}</h2>
        <p className="panel-sub">
          {t('严格扫描最近真实对白 · 未提出新构想时规则判定无火花，不打扰 · 最新在前')}
        </p>
      </div>
      <div className="toolbar-actions">
        <button type="button" className="devlab-button" onClick={onRefresh} disabled={loading}>
          {loading ? t('读取中…') : `↻ ${t('刷新')}`}
        </button>
        <button
          type="button"
          className="devlab-button primary sparky"
          onClick={() => onSimulate('', 'spark')}
          disabled={busy}
        >
          {busy ? t('扫描中…', {}) : `💡 ${t('从最近真实对白扫描灵感')}`}
        </button>
      </div>
    </div>
    {error && <div className="devlab-alert" role="alert">⚠ {error}</div>}
    {!error && <RuleBanner evaluation={evaluation} />}
    {!loading && !error && items.length === 0 && <EmptyState
      icon="💡"
      title={t('还没有灵感火花')}
      hint={t('点击「从最近真实对白扫描灵感」，让毒舌投资人诊断一次佩戴者亲口说出的点子。')}
    />}
    <div className="spark-list">
      {items.map((item, index) => <SparkCard key={`${item.created_at}:${index}`} item={item} index={index} />)}
    </div>
  </section>
}

function AmbientTab({ recordings, loading, error, onRefresh }) {
  const segments = recordings.flatMap(recording => (recording.segments || []).map(segment => ({
    ...segment,
    file: recording.file,
    source: recording.source,
  })))
  return <section className="tab-panel">
    <div className="panel-toolbar">
      <div>
        <h2>{t('环境音轨探针')}</h2>
        <p className="panel-sub">
          {t('最近 {n} 个转录批次 · 每 10 秒自动刷新', { n: recordings.length })}
        </p>
      </div>
      <div className="toolbar-actions">
        <button type="button" className="devlab-button" onClick={onRefresh} disabled={loading}>
          {loading ? t('扫描中…') : `↻ ${t('重新扫描')}`}
        </button>
      </div>
    </div>
    {error && <div className="devlab-alert" role="alert">⚠ {error}</div>}
    <div className="speaker-legend">
      <span className="legend-chip owner">{t('佩戴者 · speaker_0')}</span>
      <span className="legend-chip external">{t('外部发言人 · speaker_1 / others')}</span>
    </div>
    {!loading && !error && segments.length === 0 && <EmptyState
      icon="🎙️"
      title={t('尚未捕获环境转录')}
      hint={t('开启环境音轨录制后，最近 3 个批次的对白片段会显示在这里。')}
    />}
    <div className="transcript-stream">
      {segments.map((segment, index) => {
        const owner = isOwner(segment.speaker)
        return <div className={`transcript-row ${owner ? 'owner' : 'external'}`} key={`${segment.file}:${index}`}>
          <span className="speaker-tag">{owner ? t('佩戴者') : t('外部')}</span>
          <div className="transcript-content">
            <p>{segment.text}</p>
            <small>
              {formatTime(segment.timestamp)}
              {formatDuration(segment.duration) ? ` · ${formatDuration(segment.duration)}` : ''}
              {segment.source ? ` · ${segment.source}` : ''}
            </small>
          </div>
        </div>
      })}
    </div>
  </section>
}

function EventsTab({ busy, onSimulate, error }) {
  return <section className="tab-panel">
    <div className="panel-toolbar">
      <div>
        <h2>{t('场景事件模拟器')}</h2>
        <p className="panel-sub">{t('使用 Mock 预设对白验证全量触发效果（不影响真实数据模式）。')}</p>
      </div>
    </div>
    {error && <div className="devlab-alert" role="alert">⚠ {error}</div>}
    <div className="scenario-grid">
      {SCENARIOS.map(scenario => <article className="scenario-card" key={scenario.preset}>
        <div className="scenario-icon">{scenario.icon}</div>
        <span className="scenario-tag">{scenario.tag}</span>
        <h3>{scenario.title}</h3>
        <p>{scenario.desc}</p>
        <button
          type="button"
          className={`devlab-button primary block${scenario.kind === 'spark' ? ' sparky' : ''}`}
          onClick={() => onSimulate(scenario.preset, scenario.kind)}
          disabled={busy}
        >
          {busy === scenario.preset || busy === `spark:${scenario.preset}`
            ? t('触发中…')
            : t('模拟触发此场景')}
        </button>
      </article>)}
    </div>
  </section>
}

export default function DevLabCenter() {
  const [activeTab, setActiveTab] = useState('insights')
  const [insights, setInsights] = useState([])
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [insightsError, setInsightsError] = useState('')
  const [sparks, setSparks] = useState([])
  const [sparksLoading, setSparksLoading] = useState(false)
  const [sparksError, setSparksError] = useState('')
  const [recordings, setRecordings] = useState([])
  const [ambientLoading, setAmbientLoading] = useState(false)
  const [ambientError, setAmbientError] = useState('')
  const [crystallized, setCrystallized] = useState(null)
  const [crystallizedLoading, setCrystallizedLoading] = useState(false)
  const [crystallizedError, setCrystallizedError] = useState('')
  const [busy, setBusy] = useState('')
  const [simulateError, setSimulateError] = useState('')
  const [insightEval, setInsightEval] = useState(null)
  const [sparkEval, setSparkEval] = useState(null)
  const [notice, setNotice] = useState('')
  const noticeTimer = useRef(null)

  const flash = useCallback(message => {
    setNotice(message)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(''), 4_000)
  }, [])

  const loadInsights = useCallback(async signal => {
    setInsightsLoading(true)
    setInsightsError('')
    try {
      const payload = await readJson('api/devlab/insights', {}, signal)
      if (signal?.aborted) return
      setInsights(Array.isArray(payload.items) ? payload.items : [])
    } catch (error) {
      if (error?.name !== 'AbortError') setInsightsError(error?.message || t('读取洞察失败'))
    } finally {
      if (!signal?.aborted) setInsightsLoading(false)
    }
  }, [])

  const loadSparks = useCallback(async signal => {
    setSparksLoading(true)
    setSparksError('')
    try {
      const payload = await readJson('api/devlab/sparks', {}, signal)
      if (signal?.aborted) return
      setSparks(Array.isArray(payload.items) ? payload.items : [])
    } catch (error) {
      if (error?.name !== 'AbortError') setSparksError(error?.message || t('读取灵感火花失败'))
    } finally {
      if (!signal?.aborted) setSparksLoading(false)
    }
  }, [])

  const loadAmbient = useCallback(async signal => {
    setAmbientLoading(true)
    setAmbientError('')
    try {
      const payload = await readJson('api/devlab/ambient-recordings', {}, signal)
      if (signal?.aborted) return
      setRecordings(Array.isArray(payload.items) ? payload.items : [])
    } catch (error) {
      if (error?.name !== 'AbortError') setAmbientError(error?.message || t('读取环境音轨失败'))
    } finally {
      if (!signal?.aborted) setAmbientLoading(false)
    }
  }, [])

  const loadCrystallized = useCallback(async signal => {
    setCrystallizedLoading(true)
    setCrystallizedError('')
    try {
      const payload = await readJson('api/devlab/crystallized-context', {}, signal)
      if (signal?.aborted) return
      setCrystallized(payload.crystallized_context || payload)
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setCrystallizedError(error?.message || t('读取认知基底失败'))
      }
    } finally {
      if (!signal?.aborted) setCrystallizedLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadInsights(controller.signal)
    void loadSparks(controller.signal)
    void loadAmbient(controller.signal)
    void loadCrystallized(controller.signal)
    return () => controller.abort()
  }, [loadInsights, loadSparks, loadAmbient, loadCrystallized])

  useEffect(() => {
    if (activeTab !== 'ambient') return undefined
    const timer = setInterval(() => { void loadAmbient() }, AMBIENT_POLL_MS)
    return () => clearInterval(timer)
  }, [activeTab, loadAmbient])

  useEffect(() => () => clearTimeout(noticeTimer.current), [])

  const simulate = useCallback(async (preset, kind) => {
    const isSpark = kind === 'spark'
    const isPreset = Boolean(preset)
    setBusy(`${isSpark ? 'spark:' : ''}${preset || 'default'}`)
    setSimulateError('')
    if (isSpark) setSparkEval(null)
    else setInsightEval(null)
    try {
      if (isSpark) {
        const payload = await readJson('api/devlab/sparks/simulate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(isPreset ? { mode: 'preset', preset } : { mode: 'real' }),
        })
        if (payload.crystallizedContext) setCrystallized(payload.crystallizedContext)
        if (Array.isArray(payload.items)) setSparks(payload.items)
        if (payload.has_spark === false || payload.reason) {
          setSparkEval({
            tone: payload.reason === 'no_voice' ? 'no-voice' : 'no-spark',
            icon: payload.reason === 'no_voice' ? '🎙️' : '🫧',
            title: payload.reason === 'no_voice'
              ? t('规则判定 · 无有效语音')
              : t('规则判定 · 无灵感火花'),
            message: payload.message || t('佩戴者未提出新颖创意或假设，未触发灵感打扰。'),
            stats: payload.stats,
            sourceFiles: payload.sourceFiles,
          })
        } else if (payload.spark?.has_spark) {
          flash(`${t('真实录音已捕获灵感')}：${payload.spark.title}`)
        }
        setActiveTab('sparks')
        return
      }
      const payload = await readJson('api/devlab/insights/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(isPreset ? { mode: 'preset', preset } : { mode: 'real' }),
      })
      if (payload.crystallizedContext) setCrystallized(payload.crystallizedContext)
      if (Array.isArray(payload.items)) setInsights(payload.items)
      if (payload.success === false || payload.reason === 'insufficient_dialogue') {
        setInsightEval({
          tone: 'insufficient',
          icon: '🧊',
          title: t('规则判定 · 未生成洞察'),
          message: payload.message || t('有效对白不足以凝聚场域，未触发洞察打扰。'),
          stats: payload.stats,
          sourceFiles: payload.sourceFiles,
        })
      } else if (payload.insight?.archetype) {
        flash(`${t('真实录音已提炼洞察')}：${payload.insight.archetype}`)
      }
      setActiveTab('insights')
    } catch (error) {
      setSimulateError(error?.message || t('模拟生成失败'))
    } finally {
      setBusy('')
    }
  }, [flash])

  return <div className="devlab-shell">
    <header className="devlab-header">
      <div className="devlab-brand">
        <span className="brand-mark">◈</span>
        <div>
          <h1>DEVLAB <span>//</span> 创意实验室</h1>
          <p>{t('AI 眼镜场域智能 · 低侵入调试面板')}</p>
        </div>
      </div>
      <div className="devlab-status"><i />{t('GATEWAY LOCAL · SIDECAR READY')}</div>
    </header>

    <nav className="devlab-tabs" aria-label={t('调试面板导航')}>
      {TABS.map(tab => <button
        type="button"
        key={tab.id}
        className={activeTab === tab.id ? 'active' : ''}
        onClick={() => setActiveTab(tab.id)}
      >
        <span className="tab-icon">{tab.icon}</span>
        <span className="tab-text"><b>{t(tab.label)}</b><small>{tab.sub}</small></span>
      </button>)}
    </nav>

    <CrystallizedAnchor
      context={crystallized}
      loading={crystallizedLoading}
      error={crystallizedError}
      onRefresh={() => void loadCrystallized()}
    />

    {notice && <div className="devlab-toast" role="status">✦ {notice}</div>}
    {simulateError && activeTab !== 'events' && <div className="devlab-alert" role="alert">⚠ {simulateError}</div>}

    <main className="devlab-main">
      {activeTab === 'insights' && <InsightsTab
        items={insights}
        loading={insightsLoading}
        error={insightsError}
        busy={Boolean(busy)}
        evaluation={insightEval}
        onRefresh={() => void loadInsights()}
        onSimulate={preset => void simulate(preset)}
      />}
      {activeTab === 'sparks' && <SparksTab
        items={sparks}
        loading={sparksLoading}
        error={sparksError}
        busy={Boolean(busy)}
        evaluation={sparkEval}
        onRefresh={() => void loadSparks()}
        onSimulate={(preset, kind) => void simulate(preset, kind)}
      />}
      {activeTab === 'ambient' && <AmbientTab
        recordings={recordings}
        loading={ambientLoading}
        error={ambientError}
        onRefresh={() => void loadAmbient()}
      />}
      {activeTab === 'events' && <EventsTab
        busy={busy}
        error={simulateError}
        onSimulate={(preset, kind) => void simulate(preset, kind)}
      />}
    </main>

    <footer className="devlab-footer">
      <span>QWAUDIO / DEVLAB v0.1</span>
      <span>{t('数据仅来自本地 side-car 产物，不写入记忆库')}</span>
    </footer>
  </div>
}
