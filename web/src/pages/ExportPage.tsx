import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ApiError, downloadDashboardExport, fetchDashboard } from '../api';
import { useAuth } from '../AuthContext';
import { t } from '../i18n';

type Period = 'all' | 'today' | 'week' | 'month' | 'custom';

function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getRange(period: Period, start: string, end: string) {
  const today = new Date();
  if (period === 'all') return {};
  if (period === 'today') { const date = localDate(today); return { start: date, end: date }; }
  if (period === 'week') {
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
    return { start: localDate(monday), end: localDate(today) };
  }
  if (period === 'month') return { start: localDate(new Date(today.getFullYear(), today.getMonth(), 1)), end: localDate(today) };
  if (!start || !end) return { error: t('selectDateRange') };
  return start <= end ? { start, end } : { error: t('exportInvalidDateRange') };
}

export function ExportPage() {
  const { user, isDashboardUser } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [period, setPeriod] = useState<Period>('all');
  const [fleet, setFleet] = useState('');
  const [fleets, setFleets] = useState<string[]>([]);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [downloadRequested, setDownloadRequested] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    fetchDashboard().then((data) => setFleets(data.fleets.map((item) => item.fleetId))).catch(() => setFleets([]));
  }, [isAdmin]);

  const periodOptions = useMemo(() => [
    ['all', t('allTime')], ['today', t('today')], ['week', t('thisWeek')], ['month', t('thisMonth')], ['custom', t('customRange')],
  ] as const, []);

  if (!user) return <Navigate to="/login" replace />;
  if (!isDashboardUser) return <Navigate to="/login" replace />;
  const currentUser = user;

  async function exportReport() {
    setDownloadRequested(false);
    const range = getRange(period, start, end);
    if ('error' in range) { setError(range.error ?? t('selectDateRange')); return; }
    setError('');
    setBusy(true);
    try {
      const params = new URLSearchParams();
      const scope = isAdmin ? fleet : (currentUser.fleetId ?? '');
      if (scope) params.set('fleetId', scope);
      if (range.start) params.set('dateStart', range.start);
      if (range.end) params.set('dateEnd', range.end);
      await downloadDashboardExport(params);
      setDownloadRequested(true);
    } catch (err: unknown) {
      if (err instanceof TypeError) setError(t('exportNetworkError'));
      else if (err instanceof ApiError && err.status === 401) setError(t('exportSessionExpired'));
      else setError(t('exportFailed'));
    }
    finally { setBusy(false); }
  }

  return <div className="stack export-page">
    <div className="page-header"><div><h1>{t('export')}</h1><p className="muted">{t('exportDescription')}</p></div></div>
    <section className="panel export-panel">
      <div className="export-field"><label htmlFor="export-fleet">{t('fleet')}</label><select id="export-fleet" value={fleet} onChange={(event) => setFleet(event.target.value)} disabled={!isAdmin}><option value="">{isAdmin ? t('allFleets') : user.fleetId}</option>{fleets.map((item) => <option key={item} value={item}>{item}</option>)}</select></div>
      <div className="export-field"><span className="export-label">{t('timePeriod')}</span><div className="export-options">{periodOptions.map(([value, label]) => <button type="button" key={value} className={`export-option${period === value ? ' export-option--active' : ''}`} onClick={() => setPeriod(value)}>{label}</button>)}</div></div>
      {period === 'custom' && <div className="export-dates"><label><span>{t('from')}</span><input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label><label><span>{t('to')}</span><input type="date" min={start || undefined} value={end} onChange={(event) => setEnd(event.target.value)} /></label></div>}
      {error && <div className="alert alert--error" role="alert">{error}</div>}
      {downloadRequested && <p className="muted" role="status">{t('exportDownloadRequested')}</p>}
      <button type="button" className="btn btn--accent export-submit" onClick={() => void exportReport()} disabled={busy}>{busy ? t('exportPreparing') : t('export')}</button>
    </section>
  </div>;
}
