import { useEffect, useRef, useState } from 'react';
import { AdminUser, fetchAdminUsers, createAdminUser, updateAdminUser, deleteAdminUser, importAdminUsers, UserImportMode, UserImportSummary, downloadExport, fetchAdminUserVehicles, fetchAdminVehicles, type OwnerVehicleOption } from '../../api';
import { t } from '../../i18n';
import { useDebounce } from '../../useDebounce';
import { loadCompleteVehicleCatalog } from '../../owner-vehicle-selection';
import { OwnerVehicleSelector } from './OwnerVehicleSelector';

type Form = { username: string; password: string; firstName: string; lastName: string; role: string; fleetId: string };
const BLANK: Form = { username: '', password: '', firstName: '', lastName: '', role: 'driver', fleetId: '' };

const PAGE_LIMIT = 100;
const ROLES = ['all', 'driver', 'supervisor', 'admin', 'vehicle_owner'];

export function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [modal, setModal] = useState<'create' | AdminUser | null>(null);
  const [form, setForm] = useState<Form>(BLANK);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [importMode, setImportMode] = useState<UserImportMode>('add');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importSummary, setImportSummary] = useState<UserImportSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [ownerVehicles, setOwnerVehicles] = useState<OwnerVehicleOption[]>([]);
  const [selectedVehicleIds, setSelectedVehicleIds] = useState<string[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);
  const [vehiclesLoaded, setVehiclesLoaded] = useState(false);
  const [vehiclesError, setVehiclesError] = useState('');
  const [vehicleRetry, setVehicleRetry] = useState(0);
  const offsetRef = useRef(0);
  const seqRef = useRef(0);
  const vehicleLoadSeqRef = useRef(0);
  const debouncedSearch = useDebounce(search, 300);

  function load(reset: boolean) {
    // seq guards against a stale in-flight request landing after a newer one
    // (filter/search change or Load more race) — dropped responses never touch state.
    const seq = ++seqRef.current;
    if (reset) {
      setLoading(true);
      // A reset supersedes any in-flight Load more; that response will be dropped
      // by the seq check below and would otherwise never clear loadingMore itself.
      setLoadingMore(false);
    } else {
      setLoadingMore(true);
    }
    setListError('');
    const offset = reset ? 0 : offsetRef.current;
    fetchAdminUsers({
      limit: PAGE_LIMIT,
      offset,
      search: debouncedSearch.trim() || undefined,
      role: roleFilter === 'all' ? undefined : roleFilter,
    })
      .then((data) => {
        if (seq !== seqRef.current) return;
        if (reset) {
          setUsers(data);
          offsetRef.current = data.length;
        } else {
          setUsers((prev) => {
            const existingIds = new Set(prev.map((u) => u.id));
            return [...prev, ...data.filter((u) => !existingIds.has(u.id))];
          });
          offsetRef.current = offset + data.length;
        }
        setHasMore(data.length >= PAGE_LIMIT);
        setLoading(false);
        setLoadingMore(false);
      })
      .catch(() => {
        if (seq !== seqRef.current) return;
        setListError(t('error'));
        // A failed reset must not leave the previous filter's rows on screen —
        // a later Load more would append the new filter onto stale data.
        if (reset) setUsers([]);
        setLoading(false);
        setLoadingMore(false);
      });
  }
  useEffect(() => {
    offsetRef.current = 0;
    setHasMore(true);
    load(true);
  }, [debouncedSearch, roleFilter]);

  function loadMore() {
    if (!hasMore || loading || loadingMore) return;
    load(false);
  }

  useEffect(() => {
    if (!modal || form.role !== 'vehicle_owner' || vehiclesLoaded) return;
    let cancelled = false;
    const sequence = ++vehicleLoadSeqRef.current;
    setVehiclesLoading(true); setVehiclesError('');
    const request = modal !== 'create' && modal.role === 'vehicle_owner'
      ? fetchAdminUserVehicles(modal.id)
      : loadCompleteVehicleCatalog(fetchAdminVehicles).then((vehicles) => ({ vehicles, selectedVehicleIds: [] as string[] }));
    request.then((result) => {
      if (cancelled || sequence !== vehicleLoadSeqRef.current) return;
      setOwnerVehicles(result.vehicles);
      setSelectedVehicleIds(result.selectedVehicleIds);
      setVehiclesLoading(false);
      setVehiclesLoaded(true);
    }).catch((failure) => {
      if (!cancelled && sequence === vehicleLoadSeqRef.current) {
        setVehiclesError(failure instanceof Error ? failure.message : t('error'));
        setVehiclesLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [modal, form.role, vehiclesLoaded, vehicleRetry]);

  function resetVehicleEditor() {
    vehicleLoadSeqRef.current++;
    setOwnerVehicles([]); setSelectedVehicleIds([]); setVehiclesLoaded(false);
    setVehiclesLoading(false); setVehiclesError('');
  }

  function closeEditor() {
    if (saving) return;
    vehicleLoadSeqRef.current++;
    setModal(null);
  }

  function openCreate() { resetVehicleEditor(); setForm(BLANK); setModal('create'); setError(''); }
  function openEdit(u: AdminUser) {
    resetVehicleEditor();
    setForm({ username: u.username, password: '', firstName: u.first_name, lastName: u.last_name, role: u.role, fleetId: u.fleet_id || '' });
    setModal(u); setError('');
  }

  async function handleSave() {
    if (saving || (form.role === 'vehicle_owner' && (!vehiclesLoaded || vehiclesLoading || vehiclesError))) return;
    setSaving(true); setError('');
    try {
      const vehicleIds = form.role === 'vehicle_owner' ? selectedVehicleIds : undefined;
      const fleetId = form.role === 'vehicle_owner' ? '' : form.fleetId || undefined;
      if (modal === 'create') {
        await createAdminUser({ ...form, fleetId, vehicleIds });
      } else if (modal) {
        const payload: Parameters<typeof updateAdminUser>[1] = {
          firstName: form.firstName, lastName: form.lastName, role: form.role, fleetId, vehicleIds,
        };
        if (form.password) payload.password = form.password;
        await updateAdminUser(modal.id, payload);
      }
      setModal(null);
      offsetRef.current = 0;
      setHasMore(true);
      load(true);
    } catch (e: any) {
      setError(e.message || t('error'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(u: AdminUser) {
    if (!window.confirm(`${t('confirmDelete')} ${u.username}?`)) return;
    try {
      await deleteAdminUser(u.id);
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
      // A deleted row shifts every later server row down by one offset position;
      // without this, the next Load more re-fetches from the old offset and skips one user.
      offsetRef.current = Math.max(0, offsetRef.current - 1);
    } catch (e: any) {
      alert(e.message || t('error'));
    }
  }

  async function previewImport() {
    if (!importFile) return;
    setImporting(true); setImportError(''); setImportSummary(null);
    try {
      const result = await importAdminUsers(importFile, importMode);
      setImportSummary(result.summary);
    } catch (e: any) { setImportError(e.message || t('error')); }
    finally { setImporting(false); }
  }

  async function applyImport() {
    if (!importFile || !importSummary || importSummary.errors.length) return;
    if (importMode === 'replace' && !window.confirm('Replace will deactivate active users missing from the file. Continue?')) return;
    setImporting(true); setImportError('');
    try {
      await importAdminUsers(importFile, importMode, true);
      setImportFile(null); setImportSummary(null);
      const input = document.getElementById('user-import-file') as HTMLInputElement | null;
      if (input) input.value = '';
      offsetRef.current = 0; setHasMore(true); load(true);
    } catch (e: any) { setImportError(e.message || t('error')); }
    finally { setImporting(false); }
  }

  async function exportUsers() {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (roleFilter !== 'all') params.set('role', roleFilter);
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
      await downloadExport(`/api/admin/users/export?${params.toString()}`, 'users.xlsx');
    } catch (e: any) {
      alert(e.message || t('exportFailed'));
    } finally {
      setExporting(false);
    }
  }

  const roleLabel: Record<string, string> = { all: t('all'), driver: t('driver'), supervisor: t('supervisor'), admin: t('admin'), vehicle_owner: t('vehicle_owner') };

  return (
    <div className="panel panel--flush">
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, flex: 1 }}>{t('adminUsers')}</h2>
        <div className="chip-row">
          {ROLES.map((r) => (
            <button key={r} type="button" className={`chip${roleFilter === r ? ' chip--active' : ''}`} onClick={() => setRoleFilter(r)}>
              {roleLabel[r]}
            </button>
          ))}
        </div>
        <input
          placeholder={t('search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '7px 12px', fontSize: 14 }}
        />
        <button type="button" className="btn btn--accent" style={{ padding: '8px 16px' }} onClick={openCreate}>
          + {t('add')}
        </button>
        <button type="button" className="btn btn--secondary" style={{ padding: '8px 16px' }} onClick={exportUsers} disabled={exporting}>
          {exporting ? '…' : t('export')}
        </button>
      </div>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', background: '#fafafa', display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14 }}>{t('importUsers')}</strong>
          <select value={importMode} onChange={(e) => { setImportMode(e.target.value as UserImportMode); setImportSummary(null); }} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px', fontSize: 13 }}>
            <option value="add">Add only</option>
            <option value="modify">Modify only</option>
            <option value="replace">Replace active list</option>
          </select>
          <input id="user-import-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => { setImportFile(e.target.files?.[0] || null); setImportSummary(null); setImportError(''); }} />
          <button type="button" className="btn btn--secondary" onClick={previewImport} disabled={!importFile || importing}>{importing ? 'Checking…' : 'Preview'}</button>
        </div>
        <details style={{ fontSize: 12 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{t('supportedImportColumns')} / {t('supportedExportColumns')}</summary>
          <div className="muted" style={{ paddingTop: 6, lineHeight: 1.6 }}>
            Required: <strong>Username</strong> (or <strong>Name</strong>/<strong>Name - Surname</strong> or <strong>Email</strong>), <strong>Role</strong>.<br />
            Optional: <strong>First Name</strong>, <strong>Last Name</strong>, <strong>Fleet ID</strong> (also Fleet or Service Center), <strong>Password</strong>.<br />
            Export columns: Username, First Name, Last Name, Role, Fleet ID, Created At. DHL workbook names are supported: <strong>Name - Surname</strong>, <strong>e-mail</strong>, <strong>Service Center</strong>. Employee ID is ignored. New users need Password. Crossed-out Excel rows are skipped.
          </div>
        </details>
        {importSummary && <div style={{ display: 'grid', gap: 7, fontSize: 13 }}>
          <span>Preview: {importSummary.sourceRows} rows · {importSummary.add} to add · {importSummary.modify} to modify · {importSummary.deactivate} to deactivate · {importSummary.skippedStruck} crossed-out skipped</span>
          {importSummary.errors.length > 0 && <div className="alert alert--error">{importSummary.errors.slice(0, 3).join(' · ')}{importSummary.errors.length > 3 ? ` · +${importSummary.errors.length - 3} more` : ''}</div>}
          {importSummary.errors.length === 0 && <button type="button" className="btn btn--accent" style={{ width: 'fit-content', padding: '7px 14px' }} onClick={applyImport} disabled={importing}>{importing ? 'Importing…' : `Apply ${importMode} import`}</button>}
        </div>}
        {importError && <div className="alert alert--error">{importError}</div>}
      </div>
      {listError && <div className="alert alert--error" style={{ margin: 12 }}>{listError}</div>}
      {loading ? (
        <p className="muted" style={{ padding: 20 }}>{t('loading')}</p>
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr><th>{t('username')}</th><th>{t('firstName')}</th><th>{t('lastName')}</th><th>{t('role')}</th><th>{t('fleetId')}</th><th></th></tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr><td colSpan={6} className="table-empty">{t('noResults')}</td></tr>
              )}
              {users.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.username}</strong></td>
                  <td>{u.first_name}</td>
                  <td>{u.last_name}</td>
                  <td><span className="badge badge--open">{roleLabel[u.role] || u.role}</span></td>
                  <td className="muted">{u.fleet_id || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn btn--secondary" style={{ padding: '5px 10px', marginRight: 6 }} onClick={() => openEdit(u)}>{t('editAction')}</button>
                    <button type="button" className="btn" style={{ padding: '5px 10px', background: '#fde', color: '#c00' }} onClick={() => handleDelete(u)}>{t('deleteAction')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hasMore && (
            <div style={{ padding: 16, textAlign: 'center' }}>
              <button type="button" className="btn btn--secondary" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? t('loading') : t('loadMore')}
              </button>
            </div>
          )}
        </>
      )}

      {modal !== null && (
        <div className="user-editor-overlay" onKeyDown={(event) => { if (event.key === 'Escape') closeEditor(); }}>
          <div className={`user-editor${form.role === 'vehicle_owner' ? ' user-editor--owner' : ''}`} role="dialog" aria-modal="true" aria-labelledby="user-editor-title">
            <h3 id="user-editor-title" style={{ margin: 0 }}>{modal === 'create' ? `+ ${t('adminUsers')}` : `${t('editAction')} ${(modal as AdminUser).username}`}</h3>
            {error && <div className="alert alert--error">{error}</div>}
            {(form.role === 'vehicle_owner' ? ['firstName', 'lastName'] : ['firstName', 'lastName', 'fleetId']).map((field) => (
              <label key={field} style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 600 }}>
                {form.role === 'vehicle_owner' && field === 'firstName' ? t('ownerCustomerName')
                  : form.role === 'vehicle_owner' && field === 'lastName' ? t('ownerOptionalLastName')
                  : t(field as 'firstName')}
                <input
                  disabled={saving}
                  value={(form as any)[field]}
                  onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                  style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 14 }}
                />
              </label>
            ))}
            {modal === 'create' && (
              <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 600 }}>
                {t('username')}
                <input disabled={saving} value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                  style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 14 }} />
              </label>
            )}
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 600 }}>
              {modal === 'create' ? t('password') : t('newPassword')}
              <input disabled={saving} type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 14 }} />
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 13, fontWeight: 600 }}>
              {t('role')}
              <select aria-label={t('role')} disabled={saving} value={form.role} onChange={(e) => { vehicleLoadSeqRef.current++; setForm((f) => ({ ...f, role: e.target.value })); }}
                style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 14 }}>
                <option value="driver">{t('driver')}</option>
                <option value="supervisor">{t('supervisor')}</option>
                <option value="admin">{t('admin')}</option>
                <option value="vehicle_owner">{t('vehicle_owner')}</option>
              </select>
            </label>
            {form.role === 'vehicle_owner' && <>
              {vehiclesLoading && <p className="muted" role="status">{t('ownerLoadingVehicles')}</p>}
              {vehiclesError && <div className="alert alert--error" role="alert">{vehiclesError}<button type="button" className="link-btn" onClick={() => setVehicleRetry((value) => value + 1)}>{t('retry')}</button></div>}
              {vehiclesLoaded && <OwnerVehicleSelector vehicles={ownerVehicles} selectedIds={selectedVehicleIds} onChange={setSelectedVehicleIds} disabled={saving} />}
            </>}
            <div className="user-editor__footer">
              <button type="button" className="btn btn--secondary" disabled={saving} onClick={closeEditor}>{t('cancel')}</button>
              <button type="button" className="btn btn--accent" onClick={handleSave} disabled={saving || (form.role === 'vehicle_owner' && (!vehiclesLoaded || vehiclesLoading || !!vehiclesError))}>{saving ? t('saving') : t('save')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
