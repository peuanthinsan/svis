import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadExport, fetchMaintenance, importMaintenance, saveMaintenance, MaintenanceCategory, MaintenanceVehicle } from '../../api';
import { t } from '../../i18n';
import { formatDateThai } from '../../lib/format-date';
import { parseMaintenanceImportFile } from '../../maintenance-import';
import { useAuth } from '../../AuthContext';

type FormState = {
  region: 'metro' | 'provincial';
  lastServiceDate: string;
  lastServiceMileage: string;
  lastTireChangeDate: string;
  lastTireChangeMileage: string;
  lastBatteryChangeDate: string;
  taxExpiryDate: string;
};

type EditTab = 'overview' | 'checkup' | 'tires' | 'dates';
type SortKey = 'plate' | 'fleet' | 'latestMileage' | 'checkup' | 'tires' | 'battery' | 'tax';
type StatusFilter = 'all' | 'overdue' | 'due' | 'noData' | 'ok';
type TaxFilter = 'all' | 'recorded' | 'missing' | 'dueSoon' | 'expired';

const inputStyle = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 13,
  width: '100%',
} as const;

function categoryStatus(v: MaintenanceVehicle, key: 'checkup' | 'tires' | 'battery') {
  return v[key].status;
}

function taxDays(v: MaintenanceVehicle): number | null {
  if (!v.taxExpiryDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(`${v.taxExpiryDate}T00:00:00`);
  return Math.round((expiry.getTime() - today.getTime()) / 86_400_000);
}

function inputDate(value: string | null | undefined) {
  return value ? value.slice(0, 10) : '';
}

function taxStatus(v: MaintenanceVehicle): TaxFilter {
  const days = taxDays(v);
  if (days === null) return 'missing';
  if (days < 0) return 'expired';
  if (days <= 30) return 'dueSoon';
  return 'recorded';
}

function statusLabel(status: string) {
  if (status === 'overdue') return t('maintenanceOverdue');
  if (status === 'due') return t('maintenanceDueSoon', { days: '30' });
  if (status === 'noData') return t('maintenanceNoBaseline');
  return t('maintenanceOkay');
}

function statusClass(status: string) {
  return status === 'overdue' ? 'maintenance-status maintenance-status--danger'
    : status === 'due' ? 'maintenance-status maintenance-status--warning'
      : status === 'noData' ? 'maintenance-status maintenance-status--muted'
        : 'maintenance-status maintenance-status--ok';
}

function ContractSummary({ rule, category }: { rule: string; category: MaintenanceCategory }) {
  return (
    <div className="maintenance-contract">
      <strong>{t('maintenanceContract')}: {rule}</strong>
      <span className={statusClass(category.status)}>{statusLabel(category.status)}</span>
      <div className="maintenance-contract__facts">
        {category.dueAtKm !== undefined && <span>{t('maintenanceNextAt', { km: category.dueAtKm.toLocaleString() })}</span>}
        {category.kmRemaining !== undefined && <span>{t('maintenanceKmLeft', { km: category.kmRemaining.toLocaleString() })}</span>}
        {category.dueDate && <span>{t('maintenanceDueOn', { date: formatDateThai(category.dueDate) })}</span>}
        {category.dueAtKm === undefined && !category.dueDate && <span>{t('maintenanceBaselineNeeded')}</span>}
      </div>
    </div>
  );
}

function TaxContractSummary({ vehicle }: { vehicle: MaintenanceVehicle }) {
  const days = taxDays(vehicle);
  const status = days === null ? 'noData' : days < 0 ? 'overdue' : days <= 30 ? 'due' : 'ok';
  return (
    <div className="maintenance-contract">
      <strong>{t('maintenanceContract')}: {t('vehicleTaxExpiry')}</strong>
      <span className={statusClass(status)}>{days === null ? t('maintenanceBaselineNeeded') : days < 0 ? t('vehicleTaxExpired') : days <= 30 ? t('vehicleTaxDueSoon') : t('maintenanceOkay')}</span>
      <div className="maintenance-contract__facts">
        {vehicle.taxExpiryDate && <span>{t('maintenanceTaxDate')}: {formatDateThai(vehicle.taxExpiryDate)}</span>}
        {days !== null && days >= 0 && <span>{t('maintenanceDueOn', { date: formatDateThai(vehicle.taxExpiryDate) })}</span>}
      </div>
    </div>
  );
}

function allSearchableValues(v: MaintenanceVehicle) {
  return [
    v.plate, v.fleetId, v.vehicleType, v.region,
    v.latestMileage, v.kmPerDay,
    v.lastServiceDate, v.lastServiceMileage,
    v.lastTireChangeDate, v.lastTireChangeMileage,
    v.lastBatteryChangeDate, v.taxExpiryDate,
    categoryStatus(v, 'checkup'), categoryStatus(v, 'tires'), categoryStatus(v, 'battery'), taxStatus(v),
    formatDateThai(v.lastServiceDate), formatDateThai(v.lastTireChangeDate),
    formatDateThai(v.lastBatteryChangeDate), formatDateThai(v.taxExpiryDate),
  ].filter((value) => value !== null && value !== undefined).join(' ').toLowerCase();
}

export function MaintenanceTab() {
  const { user } = useAuth();
  const canTransfer = user?.role === 'admin';
  const [vehicles, setVehicles] = useState<MaintenanceVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editTab, setEditTab] = useState<EditTab>('overview');
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [regionFilter, setRegionFilter] = useState('all');
  const [vehicleTypeFilter, setVehicleTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [taxFilter, setTaxFilter] = useState<TaxFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('plate');
  const [sortDescending, setSortDescending] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  function load() {
    setLoading(true);
    fetchMaintenance()
      .then((data) => { setVehicles(data.vehicles); setLoading(false); })
      .catch(() => { setError(t('error')); setLoading(false); });
  }
  useEffect(load, []);

  function startEdit(v: MaintenanceVehicle) {
    setEditing(v.vehicleId);
    setEditTab('overview');
    setError('');
    setForm({
      region: v.region,
      lastServiceDate: inputDate(v.lastServiceDate),
      lastServiceMileage: v.lastServiceMileage === null ? '' : String(v.lastServiceMileage),
      lastTireChangeDate: inputDate(v.lastTireChangeDate),
      lastTireChangeMileage: v.lastTireChangeMileage === null ? '' : String(v.lastTireChangeMileage),
      lastBatteryChangeDate: inputDate(v.lastBatteryChangeDate),
      taxExpiryDate: inputDate(v.taxExpiryDate),
    });
  }

  async function save(vehicleId: string) {
    if (!form) return;
    const parseMileage = (value: string) => value === '' ? null : Number(value);
    const serviceMileage = parseMileage(form.lastServiceMileage);
    const tireMileage = parseMileage(form.lastTireChangeMileage);
    if ([serviceMileage, tireMileage].some((value) => value !== null && (!Number.isInteger(value) || value < 0))) {
      setError(t('maintenanceMileageInvalid'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await saveMaintenance({
        vehicleId,
        region: form.region,
        lastServiceDate: form.lastServiceDate || null,
        lastServiceMileage: serviceMileage,
        lastTireChangeDate: form.lastTireChangeDate || null,
        lastTireChangeMileage: tireMileage,
        lastBatteryChangeDate: form.lastBatteryChangeDate || null,
        taxExpiryDate: form.taxExpiryDate || null,
      });
      setEditing(null);
      setForm(null);
      load();
    } catch (e: any) {
      setError(e.message || t('error'));
    } finally {
      setSaving(false);
    }
  }

  const setField = (key: keyof FormState) => (value: string) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  const numericField = (key: 'lastServiceMileage' | 'lastTireChangeMileage') => (value: string) =>
    setField(key)(value.replace(/[^0-9]/g, ''));
  const closeEditor = () => {
    if (saving) return;
    setEditing(null);
    setForm(null);
    setError('');
  };

  async function exportMaintenance() {
    setTransferBusy(true);
    try { await downloadExport('/api/admin/maintenance/export', 'maintenance.xlsx'); }
    catch (e: any) { setError(e.message || t('exportFailed')); }
    finally { setTransferBusy(false); }
  }

  async function handleMaintenanceImport(file?: File) {
    if (!file) return;
    setTransferBusy(true); setError('');
    try {
      const rows = await parseMaintenanceImportFile(file);
      const result = await importMaintenance(rows);
      alert(t('importSuccess', { count: String(result.imported) }));
      load();
    } catch (e: any) { setError(e.message || t('importFailed')); }
    finally { setTransferBusy(false); if (importInputRef.current) importInputRef.current.value = ''; }
  }

  const displayed = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = vehicles.filter((v) => {
      const matchesSearch = !query || allSearchableValues(v).includes(query);
      const matchesRegion = regionFilter === 'all' || v.region === regionFilter;
      const matchesType = vehicleTypeFilter === 'all' || v.vehicleType === vehicleTypeFilter;
      const matchesStatus = statusFilter === 'all' || ['checkup', 'tires', 'battery'].some((key) => categoryStatus(v, key as 'checkup' | 'tires' | 'battery') === statusFilter);
      const matchesTax = taxFilter === 'all' || taxStatus(v) === taxFilter;
      return matchesSearch && matchesRegion && matchesType && matchesStatus && matchesTax;
    });
    return filtered.sort((a, b) => {
      const valueFor = (vehicle: MaintenanceVehicle): string | number | null => {
        if (sortKey === 'plate') return vehicle.plate;
        if (sortKey === 'fleet') return vehicle.fleetId;
        if (sortKey === 'latestMileage') return vehicle.latestMileage;
        if (sortKey === 'tax') return vehicle.taxExpiryDate;
        return categoryStatus(vehicle, sortKey);
      };
      const left = valueFor(a);
      const right = valueFor(b);
      if (left === right) return 0;
      if (left === null || left === '') return 1;
      if (right === null || right === '') return -1;
      const result = typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
      return sortDescending ? -result : result;
    });
  }, [vehicles, search, regionFilter, vehicleTypeFilter, statusFilter, taxFilter, sortKey, sortDescending]);

  const editingVehicle = vehicles.find((v) => v.vehicleId === editing);
  const vehicleTypes = [...new Set(vehicles.map((v) => v.vehicleType))].sort();
  const columnSort = (key: SortKey) => {
    if (sortKey === key) setSortDescending((value) => !value);
    else { setSortKey(key); setSortDescending(false); }
  };
  const sortMark = (key: SortKey) => sortKey === key ? (sortDescending ? ' ↓' : ' ↑') : '';

  return (
    <div className="panel panel--flush">
      <div className="maintenance-toolbar">
        <div>
          <h2 style={{ margin: 0 }}>{t('adminMaintenance')}</h2>
          <p className="muted" style={{ margin: '5px 0 0', fontSize: 12 }}>{t('maintenanceEditorHint')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <input type="search" placeholder={`${t('search')} ${t('allParameters')}`} value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...inputStyle, width: 250 }} />
          {canTransfer && <>
            <input ref={importInputRef} type="file" accept=".csv,.xlsx" hidden onChange={(e) => void handleMaintenanceImport(e.target.files?.[0])} />
            <button type="button" className="btn btn--secondary" onClick={() => importInputRef.current?.click()} disabled={transferBusy}>{transferBusy ? '…' : t('importFile')}</button>
            <button type="button" className="btn btn--secondary" onClick={() => void exportMaintenance()} disabled={transferBusy}>{transferBusy ? '…' : t('export')}</button>
          </>}
        </div>
      </div>
      {canTransfer && <details style={{ padding: '0 20px 12px', fontSize: 12 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('supportedImportColumns')} / {t('supportedExportColumns')}</summary>
        <span className="muted">{t('required')}: <strong>Plate Number</strong> or <strong>Vehicle ID</strong>. {t('optional')}: <strong>Region</strong>, <strong>Last Service Date</strong>, <strong>Last Service Mileage</strong>, <strong>Last Tire Change Date</strong>, <strong>Last Tire Change Mileage</strong>, <strong>Last Battery Change Date</strong>, <strong>Tax Expiry Date</strong>. {t('exportColumns')}: <strong>Vehicle ID</strong>, <strong>Plate Number</strong>, <strong>Fleet</strong>, <strong>Vehicle Type</strong>, <strong>Region</strong>, <strong>Last Service Date</strong>, <strong>Last Service Mileage</strong>, <strong>Last Tire Change Date</strong>, <strong>Last Tire Change Mileage</strong>, <strong>Last Battery Change Date</strong>, <strong>Tax Expiry Date</strong>.</span>
      </details>}
      <div className="maintenance-filter-bar">
        <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)} style={inputStyle} aria-label={t('region')}>
          <option value="all">{t('all')} {t('region')}</option><option value="metro">{t('regionMetro')}</option><option value="provincial">{t('regionProvincial')}</option>
        </select>
        <select value={vehicleTypeFilter} onChange={(e) => setVehicleTypeFilter(e.target.value)} style={inputStyle} aria-label={t('vehicleType')}>
          <option value="all">{t('all')} {t('vehicleType')}</option>{vehicleTypes.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} style={inputStyle} aria-label={t('status')}>
          <option value="all">{t('all')} {t('status')}</option><option value="overdue">{t('maintenanceOverdue')}</option><option value="due">{t('maintenanceDueSoon', { days: '30' })}</option><option value="noData">{t('maintenanceNoBaseline')}</option><option value="ok">{t('maintenanceOkay')}</option>
        </select>
        <select value={taxFilter} onChange={(e) => setTaxFilter(e.target.value as TaxFilter)} style={inputStyle} aria-label={t('vehicleTaxExpiry')}>
          <option value="all">{t('all')} {t('vehicleTaxExpiry')}</option><option value="recorded">{t('vehicleTaxRecorded', { count: '' })}</option><option value="missing">{t('vehicleTaxNoData')}</option><option value="dueSoon">{t('vehicleTaxDueSoon')}</option><option value="expired">{t('vehicleTaxExpired')}</option>
        </select>
        <span className="maintenance-result-count">{displayed.length} / {vehicles.length}</span>
      </div>
      {error && <div className="alert alert--error" style={{ margin: 12 }}>{error}</div>}
      {loading ? <p className="muted" style={{ padding: 20 }}>{t('loading')}</p> : displayed.length === 0 ? <div className="table-empty">{t('noResults')}</div> : (
        <div className="maintenance-table-scroll">
          <table className="data-table maintenance-table">
            <thead><tr>
              <th><button type="button" onClick={() => columnSort('plate')}>{t('plate')}{sortMark('plate')}</button></th>
              <th><button type="button" onClick={() => columnSort('fleet')}>{t('fleet')}{sortMark('fleet')}</button></th>
              <th>{t('vehicleType')}</th><th>{t('region')}</th>
              <th><button type="button" onClick={() => columnSort('latestMileage')}>{t('latestMileage')}{sortMark('latestMileage')}</button></th>
              <th><button type="button" onClick={() => columnSort('checkup')}>{t('maintenanceCheckup')}{sortMark('checkup')}</button></th>
              <th><button type="button" onClick={() => columnSort('tires')}>{t('maintenanceTires')}{sortMark('tires')}</button></th>
              <th><button type="button" onClick={() => columnSort('battery')}>{t('maintenanceBattery')}{sortMark('battery')}</button></th>
              <th><button type="button" onClick={() => columnSort('tax')}>{t('vehicleTaxExpiry')}{sortMark('tax')}</button></th>
              <th></th>
            </tr></thead>
            <tbody>{displayed.map((v) => <tr key={v.vehicleId}>
              <td><strong>{v.plate}</strong></td><td className="muted">{v.fleetId}</td><td>{v.vehicleType}</td>
              <td>{v.region === 'metro' ? t('regionMetro') : t('regionProvincial')}</td>
              <td>{v.latestMileage === null ? '—' : `${v.latestMileage.toLocaleString()} km`}</td>
              <td><span className={statusClass(v.checkup.status)}>{statusLabel(v.checkup.status)}</span></td>
              <td><span className={statusClass(v.tires.status)}>{statusLabel(v.tires.status)}</span></td>
              <td><span className={statusClass(v.battery.status)}>{statusLabel(v.battery.status)}</span></td>
              <td>{formatDateThai(v.taxExpiryDate)}</td>
              <td><button type="button" className="btn btn--accent" style={{ padding: '6px 12px' }} onClick={() => startEdit(v)}>{t('editAction')}</button></td>
            </tr>)}</tbody>
          </table>
        </div>
      )}

      {editing && form && editingVehicle && <div className="maintenance-editor-overlay" role="dialog" aria-modal="true" aria-label={t('adminMaintenance')}>
        <div className="maintenance-editor-modal">
          <div className="maintenance-editor-modal__header"><div><h3 style={{ margin: 0 }}>{t('editAction')} {editingVehicle.plate}</h3><p className="muted" style={{ margin: '5px 0 0', fontSize: 12 }}>{editingVehicle.fleetId} · {editingVehicle.vehicleType}</p></div><button type="button" className="btn btn--secondary" onClick={closeEditor} disabled={saving}>×</button></div>
          <div className="maintenance-editor-tabs">{([['overview', t('overview')], ['checkup', t('maintenanceCheckup')], ['tires', t('maintenanceTires')], ['dates', t('dates')]] as [EditTab, string][]).map(([key, label]) => <button key={key} type="button" className={editTab === key ? 'maintenance-editor-tab maintenance-editor-tab--active' : 'maintenance-editor-tab'} onClick={() => setEditTab(key)}>{label}</button>)}</div>
          <div className="maintenance-editor-modal__body">
            {editTab === 'overview' && <><div className="maintenance-editor-callout"><strong>{t('latestMileage')}: {editingVehicle.latestMileage === null ? '—' : `${editingVehicle.latestMileage.toLocaleString()} km`}</strong><span className="muted">{t('maintenanceEditorOverviewHint')}</span></div><label className="maintenance-editor-field">{t('region')}<select value={form.region} onChange={(e) => setField('region')(e.target.value)} style={inputStyle}><option value="metro">{t('regionMetro')}</option><option value="provincial">{t('regionProvincial')}</option></select></label></>}
            {editTab === 'checkup' && <><ContractSummary rule={t('maintenanceCheckupRule')} category={editingVehicle.checkup} /><div className="maintenance-editor-fields"><label className="maintenance-editor-field">{t('lastServiceDate')}<input type="date" value={form.lastServiceDate} onChange={(e) => setField('lastServiceDate')(e.target.value)} style={inputStyle} /></label><label className="maintenance-editor-field">{t('lastServiceMileage')}<input type="text" inputMode="numeric" pattern="[0-9]*" placeholder="0" value={form.lastServiceMileage} onChange={(e) => numericField('lastServiceMileage')(e.target.value)} style={inputStyle} /></label></div></>}
            {editTab === 'tires' && <><ContractSummary rule={t('maintenanceTiresRule')} category={editingVehicle.tires} /><div className="maintenance-editor-fields"><label className="maintenance-editor-field">{t('lastTireDate')}<input type="date" value={form.lastTireChangeDate} onChange={(e) => setField('lastTireChangeDate')(e.target.value)} style={inputStyle} /></label><label className="maintenance-editor-field">{t('lastTireMileage')}<input type="text" inputMode="numeric" pattern="[0-9]*" placeholder="0" value={form.lastTireChangeMileage} onChange={(e) => numericField('lastTireChangeMileage')(e.target.value)} style={inputStyle} /></label></div></>}
            {editTab === 'dates' && <><ContractSummary rule={t('maintenanceBatteryRule')} category={editingVehicle.battery} /><TaxContractSummary vehicle={editingVehicle} /><div className="maintenance-editor-fields"><label className="maintenance-editor-field">{t('lastBatteryDate')}<input type="date" value={form.lastBatteryChangeDate} onChange={(e) => setField('lastBatteryChangeDate')(e.target.value)} style={inputStyle} /></label><label className="maintenance-editor-field">{t('vehicleTaxExpiry')}<input type="date" value={form.taxExpiryDate} onChange={(e) => setField('taxExpiryDate')(e.target.value)} style={inputStyle} /><span className="maintenance-editor-help">{form.taxExpiryDate ? `${t('maintenanceTaxDate')}: ${formatDateThai(form.taxExpiryDate)}` : t('maintenanceBaselineNeeded')}</span></label></div></>}
          </div>
          {error && <div className="alert alert--error" style={{ margin: '0 22px 12px' }}>{error}</div>}
          <div className="maintenance-editor-modal__footer"><button type="button" className="btn btn--secondary" onClick={closeEditor} disabled={saving}>{t('cancel')}</button><button type="button" className="btn btn--accent" onClick={() => save(editing)} disabled={saving}>{saving ? t('saving') : t('save')}</button></div>
        </div>
      </div>}
    </div>
  );
}
