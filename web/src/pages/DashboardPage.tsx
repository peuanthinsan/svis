import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  fetchDashboard,
  fetchMaintenance,
  notifyVendor,
  type CompletionStat,
  type DashboardData,
  type DefectVehicle,
  type MaintenanceCategory,
  type MaintenanceData,
  type TypeBreakdown,
  type UnitStatusData,
  type UnitStatusVehicle,
  type VehicleTypeKey,
  type VehicleTaxExpiry,
  VEHICLE_TYPE_I18N_KEYS,
} from '../api';
import { useAuth } from '../AuthContext';
import { DonutChart, type DonutSegment } from '../components/DonutChart';
import { t } from '../i18n';
import { formatDateThai } from '../lib/format-date';

const GPS_COLOR: Record<string, string> = {
  running: '#22c55e',
  stopped: '#f59e0b',
  offline: '#94a3b8',
};

function gpsLabel(status: string) {
  if (status === 'running') return t('unitStatusRunning');
  if (status === 'stopped') return t('unitStatusStopped');
  return t('unitStatusOffline');
}

function UnitStatusBadge({ status }: { status: string }) {
  return (
    <span className="status-badge" style={{ backgroundColor: GPS_COLOR[status] ?? '#94a3b8' }}>
      {gpsLabel(status)}
    </span>
  );
}

function InspectionCell({ done }: { done: boolean }) {
  return done
    ? <span className="inspection-state inspection-state--done">✓ {t('unitStatusChecked')}</span>
    : <span className="inspection-state inspection-state--pending">! {t('unitStatusPending')}</span>;
}

function UnitStatusSection({ unitData }: { unitData: UnitStatusData }) {
  const [filter, setFilter] = useState<'all' | 'attention'>('attention');

  const displayed = useMemo<UnitStatusVehicle[]>(() => {
    if (!unitData.configured) return [];
    return filter === 'attention'
      ? unitData.vehicles.filter(v => v.needsAttention)
      : unitData.vehicles;
  }, [unitData, filter]);

  if (!unitData.configured) {
    return (
      <section className="dashboard-section">
        <h2>{t('unitStatus')}</h2>
        <div className="panel table-empty">
          {t('unitStatusNotConfigured')}
        </div>
      </section>
    );
  }

  const { summary } = unitData;

  return (
    <section className="dashboard-section">
      <div className="section-title-row">
        <h2>{t('unitStatus')}</h2>
      </div>

      {summary && (
        <div className="status-summary">
          {([
            { label: t('unitStatusRunning'), value: summary.running, color: '#22c55e' },
            { label: t('unitStatusStopped'), value: summary.stopped, color: '#f59e0b' },
            { label: t('unitStatusOffline'), value: summary.offline, color: '#94a3b8' },
          ] as const).map(s => (
            <div key={s.label} className="status-summary__item">
              <span><i className="status-summary__dot" style={{ backgroundColor: s.color }} aria-hidden="true" /> {s.label}</span>
              <strong style={{ color: s.color }}>{s.value}</strong>
            </div>
          ))}
        </div>
      )}

      <div className="segmented-control">
        <button
          type="button"
          className={`btn btn--sm ${filter === 'attention' ? 'btn--accent' : 'btn--secondary'}`}
          onClick={() => setFilter('attention')}
        >
          {t('unitStatusNeedsAttention')} ({summary?.needsAttention ?? 0})
        </button>
        <button
          type="button"
          className={`btn btn--sm ${filter === 'all' ? 'btn--accent' : 'btn--secondary'}`}
          onClick={() => setFilter('all')}
        >
          {t('unitStatusAllVehicles')} ({summary?.total ?? 0})
        </button>
      </div>

      {displayed.length === 0 ? (
        <div className="panel table-empty">
          {filter === 'attention' ? t('unitStatusNoPending') : t('unitStatusNoVehicles')}
        </div>
      ) : (
        <div className="panel panel--flush">
          <div className="table-scroll">
            <table className="unit-table">
              <thead>
                <tr>
                  {([
                    t('unitStatusColNo'),
                    t('unitStatusColPlate'),
                    t('unitStatusColFleet'),
                    t('unitStatusColGps'),
                    t('statusPreDeparture'),
                    t('statusPostRoute'),
                    t('statusWeekly'),
                  ] as const).map(h => <th key={h}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {displayed.map((v, i) => (
                  <tr key={v.plateNumber} className={v.needsAttention ? 'unit-table__attention' : undefined}>
                    <td className="muted">{i + 1}</td>
                    <td><strong>{v.plateNumber}</strong></td>
                    <td className="muted">{v.fleet}</td>
                    <td><UnitStatusBadge status={v.gpsStatus} /></td>
                    <td><InspectionCell done={v.inspections.preRoute} /></td>
                    <td><InspectionCell done={v.inspections.postRoute} /></td>
                    <td><InspectionCell done={v.inspections.weekly} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

const MAINT_CATEGORIES = [
  { key: 'checkup', labelKey: 'maintenanceCheckup', ruleKey: 'maintenanceCheckupRule' },
  { key: 'tires', labelKey: 'maintenanceTires', ruleKey: 'maintenanceTiresRule' },
  { key: 'battery', labelKey: 'maintenanceBattery', ruleKey: 'maintenanceBatteryRule' },
] as const;

function maintDetail(info: MaintenanceCategory): string {
  const parts: string[] = [];
  if (info.kmRemaining !== undefined && info.kmRemaining !== null) {
    parts.push(t('maintenanceKmLeft', { km: info.kmRemaining.toLocaleString() }));
  }
  if (info.dueDate) {
    parts.push(t('maintenanceDueOn', { date: formatDateThai(info.dueDate) }));
  }
  return parts.join(' · ');
}

function MaintenanceSection({ maintData, vehicleTax, today }: { maintData: MaintenanceData; vehicleTax: VehicleTaxExpiry[]; today: string }) {
  const days = String(maintData.horizonDays);
  type Focus = 'checkup' | 'tires' | 'battery' | 'tax';
  const [focus, setFocus] = useState<Focus | null>(null);

  // One row per vehicle-category that is due or overdue, overdue first.
  const dueList = maintData.vehicles
    .flatMap((v) =>
      MAINT_CATEGORIES
        .map((c) => ({ vehicle: v, category: c, info: v[c.key] }))
        .filter((e) => e.info.status === 'due' || e.info.status === 'overdue'),
    )
    .sort((a, b) =>
      (a.info.status === 'overdue' ? 0 : 1) - (b.info.status === 'overdue' ? 0 : 1),
    );

  const missingBaselines = maintData.vehicles.filter((v) =>
    v.checkup.status === 'noData' && v.tires.status === 'noData' && v.battery.status === 'noData',
  ).length;
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const taxRows = vehicleTax.map((vehicle) => ({
    vehicle,
    days: Math.round((Date.parse(`${vehicle.expiryDate}T00:00:00Z`) - todayMs) / 86_400_000),
  })).sort((a, b) => a.days - b.days);

  return (
    <section className="dashboard-section">
      <div className="section-title-row">
        <h2>{t('maintenance')}</h2>
      </div>
      <div className="maintenance-grid">
        {MAINT_CATEGORIES.map((c) => {
          const s = maintData.summary[c.key];
          const dueCount = s.due + s.overdue;
          const active = focus === c.key;
          return (
            <button
              key={c.key}
              type="button"
              className="panel maintenance-card"
              onClick={() => setFocus(active ? null : c.key)}
              aria-expanded={active}
              style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
            >
              <div className="maintenance-card__heading">
                <div>
                  <strong>{t(c.labelKey)}</strong>
                  <div className="maintenance-card__rule">{t(c.ruleKey)}</div>
                </div>
                <div className="maintenance-card__count" style={{ color: dueCount > 0 ? 'var(--status-fail)' : 'var(--status-pass)' }}>
                  {dueCount}
                </div>
              </div>
              <div className="maintenance-card__meta">
                {t('maintenanceDueSoon', { days })}
                {s.overdue > 0 && (
                  <span className="maintenance-card__overdue"> · {t('maintenanceOverdue')} {s.overdue}</span>
                )}
              </div>
            </button>
          );
        })}
        <VehicleTaxSection
          vehicles={vehicleTax}
          today={today}
          active={focus === 'tax'}
          onClick={() => setFocus(focus === 'tax' ? null : 'tax')}
        />
      </div>

      {focus && (
        <MaintenanceFocusList
          focus={focus}
          vehicles={maintData.vehicles}
          taxRows={taxRows}
          days={days}
        />
      )}

      {!focus && (dueList.length > 0 || taxRows.length > 0) && (
        <div className="panel">
          <div className="defect-list" style={{ marginTop: 0 }}>
            {dueList.slice(0, 10).map((e) => (
              <div className="defect-row" key={`${e.vehicle.vehicleId}-${e.category.key}`}>
                <span>{e.vehicle.plate} · {e.vehicle.fleetId}</span>
                <span className="muted">
                  {t(e.category.labelKey)}
                  {e.info.status === 'overdue' && (
                    <strong className="text-fail"> · {t('maintenanceOverdue')}</strong>
                  )}
                  {maintDetail(e.info) && ` · ${maintDetail(e.info)}`}
                </span>
              </div>
            ))}
            {taxRows.slice(0, Math.max(0, 10 - dueList.length)).map(({ vehicle, days: daysRemaining }) => {
              return (
                <div className="defect-row" key={`${vehicle.vehicleId}-tax-expiry`}>
                  <span>{vehicle.plate} · {vehicle.fleetId}</span>
                  <span className={daysRemaining < 0 ? 'text-fail' : 'muted'}>
                    {t('vehicleTaxExpiry')} · {formatDateThai(vehicle.expiryDate)} · {daysRemaining < 0 ? t('vehicleTaxExpired') : t('vehicleTaxDueSoon')}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {missingBaselines > 0 && (
        <p className="muted maintenance-card__meta">
          {t('maintenanceMissingBaselines', { count: String(missingBaselines) })}
        </p>
      )}
    </section>
  );
}

function VehicleTaxSection({
  vehicles,
  today,
  active,
  onClick,
}: {
  vehicles: VehicleTaxExpiry[];
  today: string;
  active: boolean;
  onClick: () => void;
}) {
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const dueSoon = vehicles.filter((vehicle) => {
    const days = Math.round((Date.parse(`${vehicle.expiryDate}T00:00:00Z`) - todayMs) / 86_400_000);
    return days <= 30;
  });

  return (
    <button
      type="button"
      className="panel maintenance-card"
      onClick={onClick}
      aria-expanded={active}
      style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
    >
      <div className="maintenance-card__heading">
        <div>
          <strong>{t('vehicleTaxExpiry')}</strong>
          <div className="maintenance-card__rule">{t('vehicleTaxDueSoon')}</div>
        </div>
        <div className="maintenance-card__count" style={{ color: dueSoon.length > 0 ? 'var(--status-fail)' : 'var(--status-pass)' }}>
          {vehicles.length}
        </div>
      </div>
      <div className="maintenance-card__meta">
          {vehicles.length === 0 ? t('vehicleTaxNoData') : t('vehicleTaxRecorded', { count: String(vehicles.length) })}
      </div>
    </button>
  );
}

function MaintenanceFocusList({
  focus,
  vehicles,
  taxRows,
  days,
}: {
  focus: 'checkup' | 'tires' | 'battery' | 'tax';
  vehicles: MaintenanceData['vehicles'];
  taxRows: Array<{ vehicle: VehicleTaxExpiry; days: number }>;
  days: string;
}) {
  const rows = focus === 'tax'
    ? taxRows.map(({ vehicle, days: daysRemaining }) => ({
      key: `${vehicle.vehicleId}-tax`, plate: vehicle.plate, fleet: vehicle.fleetId,
      detail: `${formatDateThai(vehicle.expiryDate)} · ${daysRemaining < 0 ? t('vehicleTaxExpired') : daysRemaining <= 30 ? t('vehicleTaxDueSoon') : ''}`,
      urgent: daysRemaining <= 30,
    }))
    : vehicles
      .filter((vehicle) => vehicle[focus].status === 'due' || vehicle[focus].status === 'overdue')
      .map((vehicle) => ({
        key: vehicle.vehicleId,
        plate: vehicle.plate,
        fleet: vehicle.fleetId,
        detail: maintDetail(vehicle[focus]),
        urgent: vehicle[focus].status === 'overdue',
      }));

  const label = focus === 'tax' ? t('vehicleTaxExpiry') : t(MAINT_CATEGORIES.find((category) => category.key === focus)!.labelKey);

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', fontWeight: 700 }}>
        {label} · {rows.length}
      </div>
      {rows.length === 0 ? (
        <div className="table-empty">{focus === 'tax' ? t('vehicleTaxNoData') : t('maintenanceNoneDue', { days })}</div>
      ) : (
        <div className="defect-list" style={{ marginTop: 0 }}>
          {rows.map((row) => (
            <div className="defect-row" key={row.key}>
              <span><strong>{row.plate}</strong> · {row.fleet}</span>
              <span className={row.urgent ? 'text-fail' : 'muted'}>{row.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const TYPE_ORDER: VehicleTypeKey[] = ['car', 'van', 'e_van', 'motorcycle', 'e_bike', 'light_truck', 'six_wheel_truck'];

const TYPE_COLOR: Record<VehicleTypeKey, string> = {
  car: '#2563eb',
  van: '#ea580c',
  e_van: '#16a34a',
  motorcycle: '#7c3aed',
  e_bike: '#0891b2',
  light_truck: '#b45309',
  six_wheel_truck: '#be123c',
};

function typeLabel(k: VehicleTypeKey): string {
  return t(VEHICLE_TYPE_I18N_KEYS[k] as any);
}

/**
 * Inspection-status donut with vehicle-type colour slices.
 * Completion donuts (showChecked=true): coloured slices = checked per type, gray = pending.
 * Active donut (showChecked=false): coloured slices = fleet composition, center shows active %.
 */
function StatusDonutCard({
  label,
  stat,
  composition,
  showChecked,
}: {
  label: string;
  stat: CompletionStat;
  composition: TypeBreakdown;
  showChecked: boolean;
}) {
  const segments: DonutSegment[] = TYPE_ORDER.map((k) => ({
    value: showChecked ? stat.byType[k] : composition[k],
    color: TYPE_COLOR[k],
  }));

  return (
    <div className="donut-card">
      <div className="donut-card__title">{label}</div>
      <DonutChart
        segments={segments}
        pending={showChecked ? stat.pending : 0}
        total={stat.total}
        centerChecked={showChecked ? undefined : stat.checked}
        size={106}
      />
      <div className="donut-card__types">
        {TYPE_ORDER.filter((k) => composition[k] > 0).map((k, i) => (
          <span key={k} style={{ whiteSpace: 'nowrap' }}>
            {i > 0 ? ' · ' : ''}
            <span style={{
              display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
              background: TYPE_COLOR[k], verticalAlign: 'middle', marginRight: 2,
            }} />
            {typeLabel(k)}{showChecked ? ` ${stat.byType[k]}/${(stat.totalByType ?? composition)[k]}` : ` ${composition[k]}`}
          </span>
        ))}
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { user, isDashboardUser } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [data, setData] = useState<DashboardData | null>(null);
  const [maintData, setMaintData] = useState<MaintenanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFleet, setSelectedFleet] = useState<string | undefined>(undefined);
  const [allFleets, setAllFleets] = useState<string[]>([]);
  const [notifyingId, setNotifyingId] = useState<string | null>(null);
  const [notifiedIds, setNotifiedIds] = useState<Record<string, string>>({});

  const fleetScope = isAdmin ? selectedFleet : user?.fleetId;

  // Monotonic guard so only the latest load() applies its results: drops out-of-order
  // 60s-poll/fleet-switch responses and post-unmount state writes (last-resolved-wins bug).
  const loadGenRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const myGen = ++loadGenRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setError(null);
    const maintenanceRequest = fetchMaintenance(fleetScope, controller.signal).catch(() => null);
    try {
      const result = await fetchDashboard(fleetScope, controller.signal);
      if (loadGenRef.current !== myGen) return;
      setData(result);
      // Capture the full fleet list from an unscoped admin load to populate the filter dropdown.
      if (isAdmin && !fleetScope) {
        setAllFleets(result.fleets.map((f) => f.fleetId));
      }
      // The core metrics and GPS table are coherent in `result`; do not make the
      // user wait for the optional maintenance calculation before showing them.
      setLoading(false);

      const maint = await maintenanceRequest;
      if (loadGenRef.current !== myGen) return;
      setMaintData(maint);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      if (loadGenRef.current !== myGen) return;
      setError(t('error'));
    } finally {
      if (loadGenRef.current === myGen) setLoading(false);
    }
  }, [fleetScope, isAdmin]);

  useEffect(() => {
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      window.clearInterval(id);
      loadAbortRef.current?.abort();
      loadGenRef.current++; // invalidate any in-flight load on unmount / dependency change
    };
  }, [load]);

  if (!user) return <Navigate to="/login" replace />;
  if (!isDashboardUser) return <Navigate to="/login" replace />;

  async function onNotifyVendor(v: DefectVehicle) {
    setNotifyingId(v.issueId);
    try {
      const res = await notifyVendor(v.issueId);
      setNotifiedIds((prev) => ({ ...prev, [v.issueId]: res.notifiedAt }));
    } catch {
      alert(t('error'));
    } finally {
      setNotifyingId(null);
    }
  }

  if (loading) return <div className="panel centered">{t('loading')}</div>;
  if (error) {
    return (
      <div className="panel centered">
        <p>{error}</p>
        <button type="button" className="btn btn--secondary" onClick={() => { setLoading(true); load(); }}>
          {t('retry')}
        </button>
      </div>
    );
  }
  if (!data) return <div className="panel centered">{t('noData')}</div>;

  const defects = data.withDefect.vehicles;
  const outOfServiceHistory = (range: 'all' | 'today') => {
    const params = new URLSearchParams({ filter: 'out_of_service', range });
    if (data.fleetId) params.set('fleetId', data.fleetId);
    return `/history?${params}`;
  };

  return (
    <div className="stack">
      <div className="page-header dashboard-header">
        <div>
          <h1>{t('greeting', { name: user.firstName })}</h1>
          <p className="muted">{t('today')} {formatDateThai(data.date)}</p>
        </div>
        <div className="header-actions">
          {isAdmin && (
            <select
              className="fleet-select"
              value={selectedFleet ?? ''}
              onChange={(e) => {
                setLoading(true);
                setMaintData(null);
                setSelectedFleet(e.target.value || undefined);
              }}
              aria-label={t('fleet')}
            >
              <option value="">{t('allFleets')}</option>
              {allFleets.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      <section className="dashboard-section">
        <div className="section-title-row">
          <div className="section-label">{t('inspectionStatusToday')}</div>
        </div>
        <div className="donut-grid">
          {/* With telematics the Active ring shows online-per-type vs fleet size;
              without it we fall back to the legacy composition ring. */}
          <StatusDonutCard label={t('statusActive')} stat={data.active} composition={data.byType} showChecked={data.telematics} />
          <StatusDonutCard label={t('statusPreDeparture')} stat={data.preDeparture} composition={data.byType} showChecked />
          <StatusDonutCard label={t('statusPostRoute')} stat={data.postRoute} composition={data.byType} showChecked />
          <StatusDonutCard label={t('statusWeekly')} stat={data.weekly} composition={data.byType} showChecked />
        </div>
      </section>

      <div className="attention-grid">
        <section className="panel attention-card">
          <div className="section-head">
            <h2>{t('outOfService')}</h2>
            <Link className="section-link" to={outOfServiceHistory('today')}>
              {t('viewTodayHistory')} <span aria-hidden="true">→</span>
            </Link>
          </div>
          <div className="metric-grid">
            <Link className="metric metric--link" to={outOfServiceHistory('all')}>
              <strong>{data.outOfService.total}</strong><span>{t('metricTotal')}</span>
            </Link>
            <Link className="metric metric--link" to={outOfServiceHistory('today')}>
              <strong>{data.outOfService.today}</strong><span>{t('today')}</span>
            </Link>
          </div>
        </section>

        <section className={`panel attention-card${data.withDefect.total > 0 ? ' attention-card--critical' : ''}`}>
          <div className="section-head">
            <h2>{t('withDefect')}</h2>
            <Link className="section-link" to="/issues?status=open">
              {t('viewOpenDefects')} <span aria-hidden="true">→</span>
            </Link>
          </div>
          <div className="metric-grid">
            <Link className="metric metric--link" to="/issues?status=open">
              <strong className="text-fail">{data.withDefect.total}</strong><span>{t('metricTotal')}</span>
            </Link>
            <Link className="metric metric--link" to="/issues?status=open">
              <strong>{data.withDefect.today}</strong><span>{t('today')}</span>
            </Link>
          </div>
          {defects.length > 0 ? (
            <div className="defect-list">
              {defects.slice(0, 5).map((v) => {
                const alreadyNotified = v.vendorNotifiedAt || notifiedIds[v.issueId];
                const isNotifying = notifyingId === v.issueId;
                return (
                  <div className="defect-row" key={v.issueId}>
                    <span>{v.plate} · {v.fleetId}</span>
                    <div className="defect-row__actions">
                      <span className="muted">{t(v.status === 'in_progress' ? 'inProgress' : 'open')} · {v.ageDays}d</span>
                      {alreadyNotified ? (
                        <span className="tag tag--success">{t('notifyVendorSent')}</span>
                      ) : v.hasVendorEmail ? (
                        <button type="button" className="btn btn--sm btn--secondary" disabled={isNotifying} onClick={() => onNotifyVendor(v)}>
                          {isNotifying ? '…' : t('notifyVendor')}
                        </button>
                      ) : (
                        <span className="tag">{t('notifyVendorNoEmail')}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13, marginTop: 12, marginBottom: 0 }}>{t('noDefects')}</p>
          )}
        </section>
      </div>

      {data.unitStatus && <UnitStatusSection unitData={data.unitStatus} />}

      {maintData && <MaintenanceSection maintData={maintData} vehicleTax={data.vehicleTax} today={data.date} />}
    </div>
  );
}
