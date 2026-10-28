import { Fragment, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { fetchInspectionVehicles, fetchVehicleInspections, VEHICLE_TYPE_I18N_KEYS, type InspectionVehicle, type VehicleInspectionLog } from '../api';
import { useAuth } from '../AuthContext';
import { InspectionResultDialog } from '../components/InspectionResultDialog';
import { t, type MessageKey } from '../i18n';
import { formatDateThai } from '../lib/format-date';
import { loadCompleteVehicleCatalog } from '../owner-vehicle-selection';

/** A read-only inventory remains available even when GPS has not been configured. */
export function OwnerVehiclesPage() {
  const { user } = useAuth();
  const [vehicles, setVehicles] = useState<InspectionVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(100);
  const [selected, setSelected] = useState<InspectionVehicle | null>(null);
  const [logs, setLogs] = useState<VehicleInspectionLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    if (user?.role !== 'vehicle_owner') return;
    const controller = new AbortController();
    setLoading(true); setError(false); setVehicles([]); setSelected(null);
    loadCompleteVehicleCatalog(async ({ limit, offset }) => {
      const response = await fetchInspectionVehicles({ limit, offset, signal: controller.signal });
      return response.vehicles;
    }).then((rows) => {
      if (!controller.signal.aborted) setVehicles(rows);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [user?.id, user?.role, retry]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setLogs([]); setLogsLoading(true); setLogsError(false);
    fetchVehicleInspections(selected.id, undefined, controller.signal).then((rows) => {
      if (!controller.signal.aborted) setLogs(rows);
    }).catch(() => {
      if (!controller.signal.aborted) setLogsError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLogsLoading(false);
    });
    return () => controller.abort();
  }, [selected]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return vehicles.filter((vehicle) => !query || vehicle.plate_number.toLocaleLowerCase().includes(query)
      || vehicle.fleet_id.toLocaleLowerCase().includes(query));
  }, [vehicles, search]);

  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'vehicle_owner') return <Navigate to="/" replace />;

  return <div className="stack">
    <div className="page-header"><div><h1>{t('ownerVehicleList')}</h1><p className="muted">{t('ownerViewHelp')}</p></div></div>
    <section className="panel panel--flush">
      <div className="owner-inventory__toolbar">
        <strong>{t('ownerVisibleCount', { count: String(filtered.length) })}</strong>
        <input aria-label={t('searchPlate')} placeholder={t('searchPlate')} value={search} onChange={(event) => { setSearch(event.target.value); setVisibleCount(100); }} />
        <button className="btn btn--secondary" type="button" disabled={loading} onClick={() => setRetry((value) => value + 1)}>{t('ownerRefresh')}</button>
      </div>
      {loading ? <p className="table-empty" role="status">{t('loading')}</p>
        : error ? <div className="alert alert--error" role="alert">{t('error')}</div>
        : filtered.length === 0 ? <p className="table-empty">{search.trim() ? t('noResults') : t('ownerNoVehicles')}</p>
        : <div className="table-scroll"><table className="data-table">
          <thead><tr><th>{t('plate')}</th><th>{t('fleet')}</th><th>{t('vehicleType')}</th><th>{t('status')}</th><th>{t('daily')}</th><th>{t('weekly')}</th><th>{t('history')}</th></tr></thead>
          <tbody>{filtered.slice(0, visibleCount).map((vehicle) => <Fragment key={vehicle.id}>
            <tr>
            <td><strong>{vehicle.plate_number}</strong></td><td>{vehicle.fleet_id}</td>
            <td>{t(VEHICLE_TYPE_I18N_KEYS[vehicle.vehicle_type] as MessageKey)}</td>
            <td><span className={`badge${vehicle.is_active === false ? ' badge--inactive' : ' badge--completed'}`}>{t(vehicle.is_active === false ? 'ownerVehicleInactive' : 'ownerVehicleActive')}</span></td>
            <td>{t(vehicle.daily_status === 'checked' ? 'checked' : 'pending')}</td>
            <td>{t(vehicle.weekly_status === 'checked' ? 'checked' : 'pending')}</td>
            <td><button type="button" className="link-btn" aria-expanded={selected?.id === vehicle.id} aria-controls={`vehicle-history-${vehicle.id}`} onClick={() => setSelected((current) => current?.id === vehicle.id ? null : vehicle)}>{t('savedInspections')}</button></td>
            </tr>
            {selected?.id === vehicle.id && <tr>
              <td colSpan={7}>
                <section className="panel" id={`vehicle-history-${vehicle.id}`} aria-labelledby={`vehicle-history-title-${vehicle.id}`}>
                  <div className="page-header"><h2 id={`vehicle-history-title-${vehicle.id}`}>{vehicle.plate_number} · {t('savedInspections')}</h2><button type="button" className="link-btn" onClick={() => setSelected(null)}>{t('close')}</button></div>
                  {logsLoading ? <p className="muted" role="status">{t('loading')}</p>
                    : logsError ? <p className="alert alert--error" role="alert">{t('error')}</p>
                    : logs.length === 0 ? <p className="muted">{t('noSavedInspections')}</p>
                    : <div className="table-scroll"><table className="data-table"><thead><tr><th>{t('date')}</th><th>{t('frequency')}</th><th>{t('status')}</th><th>{t('history')}</th></tr></thead>
                      <tbody>{logs.map((log) => <tr key={log.id}>
                        <td>{formatDateThai(log.inspection_date)}</td><td>{t(log.frequency === 'weekly' ? 'weekly' : log.frequency === 'post_route' ? 'postRoute' : 'daily')}</td>
                        <td>{t(log.overall_status === 'pass' ? 'passLabel' : 'failLabel')}</td>
                        <td><button type="button" className="link-btn" onClick={() => setDetailId(log.id)}>{t('viewDetails')}</button></td>
                      </tr>)}</tbody>
                    </table></div>}
                </section>
              </td>
            </tr>}
          </Fragment>)}</tbody>
        </table></div>}
      {!loading && !error && filtered.length > visibleCount && <div className="owner-inventory__toolbar"><button type="button" className="btn btn--secondary" onClick={() => setVisibleCount((count) => count + 100)}>{t('loadMore')}</button></div>}
    </section>
    {detailId && <InspectionResultDialog inspectionId={detailId} onClose={() => setDetailId(null)} />}
  </div>;
}
