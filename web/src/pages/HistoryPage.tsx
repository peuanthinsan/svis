import { useEffect, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { fetchHistory, fetchInspectionDetail, type HistoryData, type InspectionDetail } from '../api';
import { useAuth } from '../AuthContext';
import { t } from '../i18n';
import { PhotoGrid } from '../components/PhotoGrid';
import { formatDateThai } from '../lib/format-date';
import { useDebounce } from '../useDebounce';
import { DateRangePicker } from '../components/DateRangePicker';

type Range = 'all' | 'today' | 'week' | 'month' | 'custom';

function getDateRange(range: Range, customStart = '', customEnd = '') {
  if (range === 'all') return { startDate: '', endDate: '' };
  const now = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
  const endDate = now.toISOString().split('T')[0];
  if (range === 'today') return { startDate: endDate, endDate };
  if (range === 'custom') return { startDate: customStart, endDate: customEnd };
  if (range === 'week') {
    const weekAgo = new Date(now);
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);
    return { startDate: weekAgo.toISOString().split('T')[0], endDate };
  }
  const monthAgo = new Date(now);
  monthAgo.setUTCMonth(monthAgo.getUTCMonth() - 1);
  return { startDate: monthAgo.toISOString().split('T')[0], endDate };
}

function InspectionModal({ inspection, onClose }: { inspection: InspectionDetail; onClose: () => void }) {
  const [detail, setDetail] = useState<InspectionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  async function loadFullDetail() {
    setLoadingDetail(true);
    try {
      const d = await fetchInspectionDetail(inspection.id);
      setDetail(d);
    } catch {
      /* ignore */
    } finally {
      setLoadingDetail(false);
    }
  }

  const globalPhotos = inspection.photo_urls ?? [];
  const odometerPhoto = inspection.odometer_photo_url;
  const itemResults = detail?.results ?? [];
  const failedItems = itemResults.filter((r) => r.result === 'fail');

  return (
    <div
      onClick={onClose}
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:100, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background:'var(--surface)', borderRadius:16, padding:24, maxWidth:720, width:'100%', maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }}
      >
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:20 }}>
          <div>
            <h2 style={{ margin:0, fontSize:20 }}>{inspection.plate_number}</h2>
            <div style={{ color:'var(--text-secondary)', fontSize:14, marginTop:4 }}>
              {formatDateThai(inspection.inspection_date)}
              {inspection.inspector_name ? ` • ${inspection.inspector_name}` : ''}
              {inspection.mileage ? ` • ${inspection.mileage.toLocaleString()} km` : ''}
            </div>
            <div style={{ color:'var(--text-secondary)', fontSize:13, marginTop:4 }}>
              {t('fleet')}: {inspection.fleet_id || '-'}
              {' • '}{t('vehicleType')}: {inspection.vehicle_type || '-'}
              {' • '}{t('frequency')}: {inspection.frequency || '-'}
              {inspection.vehicle_usable === false && <> • {t('outOfService')}</>}
            </div>
          </div>
          <span className={inspection.overall_status === 'fail' ? 'badge badge--open' : 'badge badge--pass'}>
            {t(inspection.overall_status === 'fail' ? 'failed' : 'passed')}
          </span>
        </div>

        {globalPhotos.length > 0 && (
          <div style={{ marginBottom:20 }}>
            <PhotoGrid urls={globalPhotos} label={t('photos') || 'Inspection Photos'} maxThumb={140} />
          </div>
        )}

        {odometerPhoto && (
          <div style={{ marginBottom:20 }}>
            <PhotoGrid urls={[odometerPhoto]} label={t('odometerPhoto') || 'Odometer'} maxThumb={200} />
          </div>
        )}

        {!detail ? (
          <div style={{ marginTop:8 }}>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={loadFullDetail}
              disabled={loadingDetail}
              style={{ fontSize:13 }}
            >
              {loadingDetail ? t('signingIn') : (t('viewDetails') || 'Load per-item details')}
            </button>
          </div>
        ) : (
          <div style={{ marginTop:8 }}>
            {failedItems.length > 0 ? (
              <div>
                <div style={{ fontSize:12, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.05em', color:'var(--text-secondary)', marginBottom:12 }}>
                  {t('failedItems') || 'Failed Items'}
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
                  {failedItems.map((item) => (
                    <div key={item.id} style={{ borderLeft:'3px solid var(--color-fail, #ef4444)', paddingLeft:12 }}>
                      <div style={{ fontWeight:600, marginBottom:4 }}>{item.item_name_th} / {item.item_name_en}</div>
                      {item.notes && <div style={{ color:'var(--text-secondary)', fontSize:13, marginBottom:8 }}>{item.notes}</div>}
                      {(item.photo_urls?.length ?? 0) > 0 && (
                        <PhotoGrid urls={item.photo_urls!} maxThumb={100} />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ color:'var(--text-secondary)', fontSize:13 }}>{t('noData')}</div>
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

export function HistoryPage() {
  const { user, isDashboardUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const outOfService = searchParams.get('filter') === 'out_of_service';
  const requestedRange = searchParams.get('range');
  const range: Range = requestedRange === 'all' && outOfService ? 'all'
    : requestedRange === 'week' || requestedRange === 'month' || requestedRange === 'custom' ? requestedRange
    : 'today';
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<InspectionDetail | null>(null);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const queryGeneration = useRef(0);
  const HISTORY_PAGE_SIZE = 50;

  const fleetScope = user?.role === 'admin' ? searchParams.get('fleetId') || undefined : user?.fleetId;

  useEffect(() => {
    let cancelled = false;
    queryGeneration.current++;
    setHistory(null);
    setSelected(null);
    setHasMore(false);
    setLoadingMore(false);
    (async () => {
      if (range === 'custom' && (!customStart || !customEnd || customStart > customEnd)) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const { startDate, endDate } = getDateRange(range, customStart, customEnd);
        const data = await fetchHistory(startDate, endDate, fleetScope, {
          outOfService,
          search: debouncedSearch.trim(),
          limit: HISTORY_PAGE_SIZE,
          offset: 0,
        });
        if (!cancelled) {
          setHistory(data);
          setHasMore(data.inspections.length >= HISTORY_PAGE_SIZE);
        }
      } catch {
        if (!cancelled) setHistory(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [range, customStart, customEnd, fleetScope, debouncedSearch, outOfService]);

  async function loadMore() {
    if (!history || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const generation = queryGeneration.current;
    try {
      const { startDate, endDate } = getDateRange(range, customStart, customEnd);
      const data = await fetchHistory(startDate, endDate, fleetScope, {
        outOfService,
        search: debouncedSearch.trim(),
        limit: HISTORY_PAGE_SIZE,
        offset: history.inspections.length,
      });
      if (generation !== queryGeneration.current) return;
      setHistory((current) => current ? {
        ...current,
        inspections: [...current.inspections, ...data.inspections],
      } : data);
      setHasMore(data.inspections.length >= HISTORY_PAGE_SIZE);
    } catch {
      // Keep the records already loaded; the next click can retry.
    } finally {
      if (generation === queryGeneration.current) setLoadingMore(false);
    }
  }

  function selectRange(nextRange: Range) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('range', nextRange);
      return next;
    });
  }

  if (!user) return <Navigate to="/login" replace />;
  if (!isDashboardUser) return <Navigate to="/login" replace />;

  // The API returns both passed and failed inspections. The log should show
  // both; the summary cards already provide the status breakdown.
  const inspections = history?.inspections || [];
  const emptyMessage = debouncedSearch.trim() ? 'noResults'
    : outOfService ? (range === 'all' ? 'noOutOfServiceVehicles' : 'noOutOfServiceInPeriod')
    : 'noInspections';

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <h1>{t(outOfService ? 'outOfService' : 'history')}</h1>
          {outOfService && <p className="muted">{t('outOfServiceHistoryDescription')}</p>}
        </div>
      </div>

      <div className="chip-row">
        {outOfService && (
          <button type="button" className={`chip${range === 'all' ? ' chip--active' : ''}`} onClick={() => selectRange('all')}>
            {t('allTime')}
          </button>
        )}
        {(['today', 'week', 'month'] as Range[]).map((key) => (
          <button
            key={key}
            type="button"
            className={`chip${range === key ? ' chip--active' : ''}`}
            onClick={() => selectRange(key)}
          >
            {key === 'today' ? t('today') : key === 'week' ? t('thisWeek') : t('thisMonth')}
          </button>
        ))}
        <button type="button" className={`chip${range === 'custom' ? ' chip--active' : ''}`} onClick={() => selectRange('custom')}>
          {t('customRange')}
        </button>
      </div>

      {range === 'custom' && (
        <DateRangePicker
          start={customStart}
          end={customEnd}
          onChange={({ start, end }) => { setCustomStart(start); setCustomEnd(end); }}
          startLabel={t('startDate')}
          endLabel={t('endDate')}
          placeholder={t('customRange')}
        />
      )}

      <div style={{ display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`${t('search')} ${t('plateNumber')}`}
          aria-label={t('plateNumber')}
          style={{ border:'1px solid var(--border)', borderRadius:8, padding:'9px 12px', minWidth:260, flex:1 }}
        />
      </div>

      {loading ? (
        <div className="panel centered">{t('signingIn')}</div>
      ) : history ? (
        <>
          <div className="stats panel">
            <div><span>{t('totalInspections')}</span><strong>{history.total}</strong></div>
            <div><span>{t('passed')}</span><strong className="text-pass">{history.passed}</strong></div>
            <div><span>{t('failed')}</span><strong className="text-fail">{history.failed}</strong></div>
          </div>

          <section>
            <h2>{t('history')}</h2>
            <div className="panel panel--flush">
              {inspections.length === 0 ? (
                <div className="table-empty">{t(emptyMessage)}</div>
              ) : (
                inspections.map((ins) => {
                  const photoCount = (ins.photo_urls?.length ?? 0) + (ins.odometer_photo_url ? 1 : 0);
                  return (
                    <div
                      key={ins.id}
                      className="fail-row"
                      onClick={() => setSelected(ins)}
                      style={{ cursor:'pointer' }}
                    >
                      <div>
                        <strong>{ins.plate_number}</strong>
                        <div className="muted">
                          {t('fleet')}: {ins.fleet_id || '-'}
                          {' • '}{t('vehicleType')}: {ins.vehicle_type || '-'}
                          {' • '}{t('frequency')}: {ins.frequency || '-'}
                          {ins.vehicle_usable === false && <> • {t('outOfService')}</>}
                        </div>
                        <div className="muted">
                          {t('date')}: {formatDateThai(ins.inspection_date)}
                          {' • '}{t('inspector')}: {ins.inspector_name || '-'}
                          {' • '}{t('mileage')}: {ins.mileage != null ? `${ins.mileage.toLocaleString()} km` : '-'}
                          {photoCount > 0 && (
                            <span style={{ marginLeft:8, color:'var(--brand-primary)' }}>
                              {'📷'} {photoCount}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className={ins.overall_status === 'fail' ? 'badge badge--open' : 'badge badge--pass'}>
                        {ins.overall_status === 'fail' ? t('failed') : t('passed')}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
            {hasMore && (
              <div style={{ padding:16, textAlign:'center' }}>
                <button type="button" className="btn btn--secondary" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? t('loading') : t('loadMore')}
                </button>
              </div>
            )}
          </section>
        </>
      ) : (
        <div className="panel centered">{t('noData')}</div>
      )}

      {selected && <InspectionModal inspection={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
