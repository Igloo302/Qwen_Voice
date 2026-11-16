import { t } from '../i18n.js'
import { eventChanges, formatTime, isClaim, isThread, isPattern, operationLabel, recordFields, titleFor, valueText } from './presentation.js'

function Pager({ data, onChange, busy, label }) {
  if (!data || data.total <= data.pageSize) return null
  const last = Math.ceil(data.total / data.pageSize)
  return <nav className="memory-pager" aria-label={label}>
    <button type="button" disabled={busy || data.page <= 1} onClick={() => onChange?.(data.page - 1)}>{t('上一页')}</button>
    <span>{data.page} / {last}</span>
    <button type="button" disabled={busy || data.page >= last} onClick={() => onChange?.(data.page + 1)}>{t('下一页')}</button>
  </nav>
}

export function EvidenceList({ items = [] }) {
  return items.map(evidence => <article className="memory-evidence" key={`${evidence.evidence_type}:${evidence.evidence_id}:${evidence.role}`}>
    <div className="memory-record-meta">{evidence.evidence_type} · #{evidence.evidence_id}{evidence.status ? ` · ${evidence.status}` : ''}</div>
    <p>{evidence.resolved ? evidence.text || t('来源未保存正文') : t('来源记录已不可用')}</p>
    {evidence.occurred_at && <small>{formatTime(evidence.occurred_at)}</small>}
    {evidence.source && <div className="memory-linked-source"><small>{evidence.source.evidence_type} · #{evidence.source.evidence_id}</small>
      <p>{evidence.source.resolved ? evidence.source.text : t('来源记录已不可用')}</p></div>}
    {!!evidence.source_segments?.length && <details><summary>{t('原始片段摘录（最多 6 段）')}</summary>
      {evidence.source_segments.map(segment => <blockquote key={segment.id}><p>{segment.text}</p><small>{formatTime(segment.started_at)}</small></blockquote>)}
    </details>}
  </article>)
}

export default function MemoryObjectDetail({ data, setEvidencePage, setHistoryPage, setDerivationPage, setPremisePagination, busy }) {
  const item = data.item
  const claim = isClaim(item)
  const thread = isThread(item)
  return <>
    <div className="memory-record-meta">{claim ? 'user_claims' : thread ? 'user_thread' : 'user_observed_pattern'} · #{item.id}{item.primary_domain ? ` · ${item.primary_domain}` : ''}</div>
    <h2>{titleFor(item)}</h2>
    <dl className="memory-fields">
      {recordFields(item).map(field => <div key={field.key}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
      <div><dt>created_at</dt><dd>{formatTime(item.created_at)}</dd></div>
      <div><dt>updated_at</dt><dd>{formatTime(item.updated_at)}</dd></div>
      {Number.isFinite(item.confidence) && <div><dt>confidence</dt><dd>{item.confidence.toFixed(2)}</dd></div>}
    </dl>
    <section className="memory-detail-section"><h3>{thread ? 'linked records' : isPattern(item) ? 'supporting signals' : 'evidence'} ({data.evidence?.total || 0})</h3>
      {!data.evidence?.items?.length && <p className="memory-muted">{t('未保存关联依据')}</p>}
      <EvidenceList items={data.evidence?.items} />
      <Pager data={data.evidence} onChange={setEvidencePage} busy={busy} label="evidence pages" />
    </section>
    {claim && <section className="memory-detail-section"><h3>derivations ({data.derivations?.total || 0})</h3>
      {!data.derivations?.items?.length && <p className="memory-muted">{item.claim_origin === 'explicit' ? 'explicit claim' : 'No saved derivation'}</p>}
      {data.derivations?.items?.map(derivation => <article className="memory-evidence" key={derivation.id}>
        <div>{derivation.rule_id} · {derivation.status}</div>
        {derivation.derived_at && <small>derived_at: {formatTime(derivation.derived_at)}</small>}
        {derivation.invalidated_at && <small>invalidated_at: {formatTime(derivation.invalidated_at)}</small>}
        <h4>premises ({derivation.premises?.total || 0})</h4>
        <EvidenceList items={derivation.premises?.items} />
        <Pager data={derivation.premises} onChange={page => setPremisePagination?.({ id: derivation.id, page })} busy={busy} label={`premise pages ${derivation.id}`} />
      </article>)}
      <Pager data={data.derivations} onChange={setDerivationPage} busy={busy} label="derivation pages" />
    </section>}
    <section className="memory-detail-section"><h3>{thread ? 'event timeline' : 'history'} ({data.history?.total || 0})</h3>
      {!data.history?.items?.length && <p className="memory-muted">{t('未保存变更记录')}</p>}
      {data.history?.items?.map(event => <article className="memory-event" key={event.id}>
        <header><b>{operationLabel(event)}</b><time>{formatTime(event.effective_at || event.occurred_at || event.created_at)}</time></header>
        {thread && <small>occurred_at: {formatTime(event.occurred_at)} · known_at: {formatTime(event.known_at)}</small>}
        {event.summary && <p>{event.summary}</p>}
        {event.reason && <p>{event.reason}</p>}
        {eventChanges(event).map(change => <div className="memory-change" key={change.key}><span>{change.label}</span><p>{change.before} → {change.after}</p></div>)}
        {event.candidate_snapshot && Object.entries(event.candidate_snapshot).map(([key, value]) => <div className="memory-change" key={key}><span>{key}</span><p>{valueText(value)}</p></div>)}
        <EvidenceList items={event.evidence} />
      </article>)}
      <Pager data={data.history} onChange={setHistoryPage} busy={busy} label="history pages" />
    </section>
  </>
}
