import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { fetchIssues, type IssueRow, updateIssueStatus, uploadInspectionPhoto } from '../api';
import { useAuth } from '../AuthContext';
import { getLang, t } from '../i18n';
import {
  localizedFailedChecklistItemLabel,
  localizedFailedChecklistItemLabels,
  partitionFailedChecklistPhotos,
} from '../issue-checklist';
import { PhotoGrid } from '../components/PhotoGrid';
import { formatDateThai, formatDateTimeThai } from '../lib/format-date';

const statuses = ['', 'open', 'in_progress', 'completed'] as const;

function statusLabel(status: string) {
  if (status === 'open') return t('open');
  if (status === 'in_progress') return t('inProgress');
  if (status === 'completed') return t('completed');
  return status;
}

function IssueModal({ issue, onClose, onStartRepair, onCompleteRepair, updating, readOnly }: {
  issue: IssueRow;
  onClose: () => void;
  onStartRepair: () => void;
  onCompleteRepair: (file: File) => void;
  updating: boolean;
  readOnly: boolean;
}) {
  const lang = getLang();
  const { mappedItems: mappedDefectItems, unassociatedUrls: unassociatedDefectUrls } = partitionFailedChecklistPhotos(
    issue.failed_checklist_items,
    issue.defect_photo_urls,
  );
  const hasPhotos = (issue.defect_photo_urls?.length ?? 0) + (issue.completion_photo_urls?.length ?? 0) > 0;
  return (
    <div
      onClick={onClose}
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background:'var(--surface)', borderRadius:16, padding:24, maxWidth:680, width:'100%', maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}
      >
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20 }}>
          <div>
            <h2 style={{ margin:0, fontSize:20 }}>{issue.plate_number}</h2>
            <div style={{ color:'var(--text-secondary)', fontSize:14, marginTop:4 }}>
              {issue.vehicle_fleet || issue.fleet_id || '—'} &bull; {issue.inspection_date ? formatDateThai(issue.inspection_date) : formatDateTimeThai(issue.created_at)}
              {issue.inspector_name ? ` • ${issue.inspector_name}` : ''}
            </div>
          </div>
          <span className={`badge badge--${issue.status}`} style={{ marginLeft:12 }}>{statusLabel(issue.status)}</span>
        </div>

        {!hasPhotos && (
          <div style={{ color:'var(--text-secondary)', textAlign:'center', padding:'32px 0', fontSize:14 }}>{t('noData')}</div>
        )}

        {mappedDefectItems.map((item) => (
          <div key={item.checklist_item_id} style={{ marginBottom:20 }}>
            <PhotoGrid
              urls={item.photo_urls!}
              label={`${t('defectPhotos')} — ${localizedFailedChecklistItemLabel(item, lang) || t('checklistItem')}`}
              maxThumb={160}
            />
          </div>
        ))}

        {unassociatedDefectUrls.length > 0 && (
          <div style={{ marginBottom:20 }}>
            <PhotoGrid urls={unassociatedDefectUrls} label={t('defectPhotos')} maxThumb={160} />
          </div>
        )}

        {(issue.completion_photo_urls?.length ?? 0) > 0 && (
          <div>
            <PhotoGrid urls={issue.completion_photo_urls!} label={t('completionPhotos') || 'Completion Photos'} maxThumb={160} />
          </div>
        )}

        {!readOnly && issue.status !== 'completed' && (
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            {issue.status === 'open' && (
              <button type="button" className="btn btn--secondary" onClick={onStartRepair} disabled={updating}>
                {updating ? '…' : `→ ${t('inProgress')}`}
              </button>
            )}
            {issue.status === 'in_progress' && (
              <>
                <input ref={(node) => { if (node) (node as HTMLInputElement).dataset.ready = 'true'; }} type="file" accept="image/jpeg,image/png" hidden onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) onCompleteRepair(file);
                }} />
                <button type="button" className="btn btn--primary" onClick={(event) => {
                  const input = (event.currentTarget.previousElementSibling as HTMLInputElement | null);
                  input?.click();
                }} disabled={updating}>
                  {updating ? '…' : `✓ ${t('completed')} — ${t('completionPhotos')}`}
                </button>
                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>{t('completionPhotoRequired')}</div>
              </>
            )}
          </div>
        )}

        <div style={{ marginTop:24, display:'flex', justifyContent:'flex-end' }}>
          <button type="button" className="btn btn--ghost" onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  );
}

export function IssuesPage() {
  const { user, isDashboardUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedStatus = searchParams.get('status');
  const initialStatus = statuses.includes(requestedStatus as (typeof statuses)[number])
    ? requestedStatus as (typeof statuses)[number]
    : 'open';
  const [status, setStatus] = useState<(typeof statuses)[number]>(initialStatus);
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<IssueRow | null>(null);
  const [updating, setUpdating] = useState(false);

  const readOnly = user?.role === 'vehicle_owner';
  const fleetScope = user?.role === 'admin' || readOnly ? undefined : user?.fleetId;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const rows = await fetchIssues(status || undefined, fleetScope);
        if (!cancelled) setIssues(rows);
      } catch {
        if (!cancelled) setIssues([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [status, fleetScope]);

  function selectStatus(nextStatus: (typeof statuses)[number]) {
    setStatus(nextStatus);
    setSearchParams(nextStatus ? { status: nextStatus } : {});
  }

  async function startRepair() {
    if (!selected || readOnly) return;
    setUpdating(true);
    try {
      await updateIssueStatus(selected.id, 'in_progress');
      const next = { ...selected, status: 'in_progress' };
      setSelected(next);
      setIssues((prev) => prev.map((issue) => issue.id === next.id ? next : issue));
    } catch (e: any) {
      alert(e.message || t('error'));
    } finally { setUpdating(false); }
  }

  async function completeRepair(file: File) {
    if (!selected || readOnly) return;
    setUpdating(true);
    try {
      const { url } = await uploadInspectionPhoto(file);
      await updateIssueStatus(selected.id, 'completed', [url]);
      const next = { ...selected, status: 'completed', completion_photo_urls: [url] };
      setSelected(next);
      setIssues((prev) => prev.map((issue) => issue.id === next.id ? next : issue));
    } catch (e: any) {
      alert(e.message || t('error'));
    } finally { setUpdating(false); }
  }

  if (!user) return <Navigate to="/login" replace />;
  if (!isDashboardUser) return <Navigate to="/login" replace />;

  return (
    <div className="stack">
      <div className="page-header">
        <h1>{t('issues')}</h1>
      </div>

      <div className="chip-row">
        {statuses.map((s) => (
          <button
            key={s || 'all'}
            type="button"
            className={`chip${status === s ? ' chip--active' : ''}`}
            onClick={() => selectStatus(s)}
          >
            {s ? statusLabel(s) : t('all')}
          </button>
        ))}
      </div>

      <div className="panel panel--flush">
        {loading ? (
          <div className="table-empty">{t('signingIn')}</div>
        ) : issues.length === 0 ? (
          <div className="table-empty">{t('noData')}</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('plate')}</th>
                  <th>{t('fleet')}</th>
                  <th>{t('failedChecklistItems')}</th>
                  <th>{t('status')}</th>
                  <th>{t('date')}</th>
                  <th style={{ textAlign:'center' }}>{t('photos') || '📷'}</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((issue) => {
                  const photoCount = (issue.defect_photo_urls?.length ?? 0) + (issue.completion_photo_urls?.length ?? 0);
                  const checklistLabels = localizedFailedChecklistItemLabels(issue.failed_checklist_items, getLang());
                  const checklistSummary = checklistLabels.join(' • ');
                  return (
                    <tr
                      key={issue.id}
                      onClick={() => setSelected(issue)}
                      style={{ cursor:'pointer' }}
                    >
                      <td><strong>{issue.plate_number}</strong></td>
                      <td>{issue.vehicle_fleet || issue.fleet_id || '—'}</td>
                      <td className="issue-checklist-cell">
                        {checklistSummary || '—'}
                      </td>
                      <td><span className={`badge badge--${issue.status}`}>{statusLabel(issue.status)}</span></td>
                      <td>{issue.inspection_date ? formatDateThai(issue.inspection_date) : formatDateTimeThai(issue.created_at)}</td>
                      <td style={{ textAlign:'center', color: photoCount > 0 ? 'var(--brand-primary)' : 'var(--text-secondary)' }}>
                        {photoCount > 0 ? `📷 ${photoCount}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected && <IssueModal issue={selected} onClose={() => setSelected(null)} onStartRepair={() => void startRepair()} onCompleteRepair={(file) => void completeRepair(file)} updating={updating} readOnly={readOnly} />}
    </div>
  );
}
