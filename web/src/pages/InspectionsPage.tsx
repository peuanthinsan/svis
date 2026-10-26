import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Navigate } from 'react-router-dom';
import {
  ApiError,
  createInspection,
  fetchInspectionCarryover,
  fetchInspectionChecklist,
  fetchInspectionVehicles,
  fetchVehicleInspections,
  updateInspection,
  uploadInspectionPhoto,
  VEHICLE_TYPE_I18N_KEYS,
  type InspectionChecklistItem,
  type InspectionVehicle,
  type VehicleInspectionLog,
} from '../api';
import { useAuth } from '../AuthContext';
import { InspectionResultDialog } from '../components/InspectionResultDialog';
import {
  INSPECTION_ZONES,
  ZONE_SECTIONS,
  activeInspectionQuery,
  getTodayThai,
  itemsForZone,
  validateInspectionDraft,
  type InspectionFrequency,
  type InspectionResult,
  type InspectionZone,
} from '../inspection-workflow';
import { getLang, t } from '../i18n';
import { formatDateThai } from '../lib/format-date';

type PhotoDraft = { id: string; url: string; file?: File };

const FREQUENCIES: InspectionFrequency[] = ['daily', 'weekly', 'post_route'];
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

function frequencyLabel(frequency: InspectionFrequency) {
  if (frequency === 'weekly') return t('weekly');
  if (frequency === 'post_route') return t('postRoute');
  return t('daily');
}

function zoneLabel(zone: InspectionZone | null) {
  if (zone === 'front') return t('zoneFront');
  if (zone === 'cabin') return t('zoneCabin');
  if (zone === 'cargo_supplies') return t('zoneCargo');
  if (zone === 'exterior_tires') return t('zoneExterior');
  return t('all');
}

function draftFromUrl(url: string): PhotoDraft {
  return { id: url, url };
}

function draftsFromFiles(files: File[]): PhotoDraft[] {
  return files.map((file) => ({
    id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
    url: URL.createObjectURL(file),
    file,
  }));
}

function validImageFiles(files: File[]) {
  const valid: File[] = [];
  let error: string | null = null;
  for (const file of files) {
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      error = t('photoFormatError');
      continue;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      error = t('photoSizeError');
      continue;
    }
    valid.push(file);
  }
  return { valid, error };
}

function PhotoDrafts({ photos, onRemove }: { photos: PhotoDraft[]; onRemove: (id: string) => void }) {
  if (photos.length === 0) return null;
  return (
    <div className="inspection-photo-drafts">
      {photos.map((photo) => (
        <div className="inspection-photo-draft" key={photo.id}>
          <img src={photo.url} alt="" />
          <button type="button" onClick={() => onRemove(photo.id)} aria-label={t('removePhoto')}>×</button>
        </div>
      ))}
    </div>
  );
}

function PhotoInput({
  id,
  label,
  multiple = false,
  disabled = false,
  onFiles,
}: {
  id: string;
  label: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  }

  return (
    <label className={`inspection-upload-button${disabled ? ' inspection-upload-button--disabled' : ''}`} htmlFor={id}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l1.4-2h7.2L17 7h3v12H4V7Zm8 3.2a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z" /></svg>
      {label}
      <input
        id={id}
        type="file"
        accept="image/jpeg,image/png"
        multiple={multiple}
        disabled={disabled}
        onChange={handleChange}
      />
    </label>
  );
}

function savedStatus(log: VehicleInspectionLog) {
  return log.overall_status === 'fail' ? t('failLabel') : t('passLabel');
}

export function InspectionsPage() {
  const { user, isDashboardUser } = useAuth();
  const locale = getLang();
  const [vehicles, setVehicles] = useState<InspectionVehicle[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(true);
  const [vehiclesError, setVehiclesError] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [frequency, setFrequency] = useState<InspectionFrequency>('daily');
  const [activeZone, setActiveZone] = useState<InspectionZone | null>(null);
  const [checklistItems, setChecklistItems] = useState<InspectionChecklistItem[]>([]);
  const [results, setResults] = useState<Record<string, InspectionResult>>({});
  const [photosByItem, setPhotosByItem] = useState<Record<string, PhotoDraft[]>>({});
  const [notesByItem, setNotesByItem] = useState<Record<string, string>>({});
  const [globalPhotos, setGlobalPhotos] = useState<PhotoDraft[]>([]);
  const [notes, setNotes] = useState('');
  const [mileage, setMileage] = useState('');
  const [odometerPhoto, setOdometerPhoto] = useState<PhotoDraft | null>(null);
  const [vehicleUsable, setVehicleUsable] = useState<boolean | null>(null);
  const [carryoverItems, setCarryoverItems] = useState<Set<string>>(new Set());
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [existingInspectionId, setExistingInspectionId] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [readOnlyInspector, setReadOnlyInspector] = useState('');
  const [savedInspections, setSavedInspections] = useState<VehicleInspectionLog[]>([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [detailInspectionId, setDetailInspectionId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const submitLockRef = useRef(false);

  const selectedVehicle = useMemo(
    () => vehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? null,
    [selectedVehicleId, vehicles],
  );

  const filteredVehicles = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return vehicles;
    return vehicles.filter((vehicle) =>
      vehicle.plate_number.toLocaleLowerCase().includes(query)
      || vehicle.fleet_id.toLocaleLowerCase().includes(query),
    );
  }, [search, vehicles]);

  const visibleItems = useMemo(
    () => itemsForZone(checklistItems, activeZone),
    [activeZone, checklistItems],
  );

  const answeredCount = checklistItems.filter((item) => results[item.id] === 'pass' || results[item.id] === 'fail').length;
  const failCount = checklistItems.filter((item) => results[item.id] === 'fail').length;
  const completionPercent = checklistItems.length > 0 ? Math.round((answeredCount / checklistItems.length) * 100) : 0;
  const validation = validateInspectionDraft({
    items: checklistItems,
    results,
    photoCountByItem: Object.fromEntries(Object.entries(photosByItem).map(([id, photos]) => [id, photos.length])),
    mileage,
    hasOdometerPhoto: odometerPhoto !== null,
    vehicleUsable,
  });

  useEffect(() => {
    const controller = new AbortController();
    async function loadVehicles() {
      setVehiclesLoading(true);
      setVehiclesError(false);
      try {
        const next: InspectionVehicle[] = [];
        const pageSize = 500;
        let offset = 0;
        let total = 1;
        while (offset < total) {
          const page = await fetchInspectionVehicles({ limit: pageSize, offset, signal: controller.signal });
          next.push(...page.vehicles);
          total = page.total;
          if (page.vehicles.length === 0) break;
          offset += page.vehicles.length;
        }
        setVehicles(next);
        setSelectedVehicleId((current) => current && next.some((vehicle) => vehicle.id === current) ? current : next[0]?.id ?? null);
      } catch (error) {
        if (!controller.signal.aborted) setVehiclesError(true);
      } finally {
        if (!controller.signal.aborted) setVehiclesLoading(false);
      }
    }
    void loadVehicles();
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    if (!selectedVehicle || !user) return;
    const activeVehicle = selectedVehicle;
    const activeUser = user;
    const controller = new AbortController();

    function clearForm() {
      setChecklistItems([]);
      setResults({});
      setPhotosByItem({});
      setNotesByItem({});
      setGlobalPhotos([]);
      setNotes('');
      setMileage('');
      setOdometerPhoto(null);
      setVehicleUsable(null);
      setCarryoverItems(new Set());
      setExistingInspectionId(null);
      setReadOnly(false);
      setReadOnlyInspector('');
      setActiveZone(null);
    }

    async function loadForm() {
      clearForm();
      setFormLoading(true);
      setFormError(null);
      try {
        const query = activeInspectionQuery(activeVehicle.id, frequency);
        const [items, activeInspections] = await Promise.all([
          fetchInspectionChecklist(activeVehicle.vehicle_type, frequency, controller.signal),
          fetchVehicleInspections(activeVehicle.id, query, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setChecklistItems(items);

        const existing = activeInspections[0];
        if (existing) {
          // Supervisors can complete or correct inspections for vehicles in their
          // fleet. The API enforces the same fleet boundary; admins remain global.
          const canEdit = activeUser.role === 'admin'
            || activeUser.role === 'supervisor'
            || existing.inspector_id === activeUser.id;
          setExistingInspectionId(existing.id);
          setReadOnly(!canEdit);
          setReadOnlyInspector(existing.inspector_name || '');
          setNotes(existing.notes || '');
          setMileage(typeof existing.mileage === 'number' ? String(existing.mileage) : '');
          setOdometerPhoto(existing.odometer_photo_url ? draftFromUrl(existing.odometer_photo_url) : null);
          setVehicleUsable(typeof existing.vehicle_usable === 'boolean' ? existing.vehicle_usable : null);
          setGlobalPhotos((existing.photo_urls ?? []).filter(Boolean).map(draftFromUrl));

          const itemIds = new Set(items.map((item) => item.id));
          const savedResults: Record<string, InspectionResult> = {};
          const savedPhotos: Record<string, PhotoDraft[]> = {};
          const savedNotes: Record<string, string> = {};
          for (const result of existing.results ?? []) {
            if (!itemIds.has(result.checklist_item_id)) continue;
            savedResults[result.checklist_item_id] = result.result;
            if ((result.photo_urls?.length ?? 0) > 0) {
              savedPhotos[result.checklist_item_id] = result.photo_urls!.filter(Boolean).map(draftFromUrl);
            }
            if (result.notes) savedNotes[result.checklist_item_id] = result.notes;
          }
          setResults(savedResults);
          setPhotosByItem(savedPhotos);
          setNotesByItem(savedNotes);
        } else if (frequency !== 'post_route') {
          const carryover = await fetchInspectionCarryover(activeVehicle.id, controller.signal);
          if (controller.signal.aborted) return;
          const itemIds = new Set(items.map((item) => item.id));
          const carryoverIds = new Set(
            carryover.items.map((item) => item.checklist_item_id).filter((id) => itemIds.has(id)),
          );
          setCarryoverItems(carryoverIds);
          setResults(Object.fromEntries(Array.from(carryoverIds).map((id) => [id, 'fail' as const])));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setFormError(error instanceof Error ? error.message : t('inspectionLoadError'));
      } finally {
        if (!controller.signal.aborted) setFormLoading(false);
      }
    }

    void loadForm();
    return () => controller.abort();
  }, [frequency, reloadKey, selectedVehicle, user]);

  useEffect(() => {
    if (!selectedVehicle) return;
    const controller = new AbortController();
    setSavedLoading(true);
    fetchVehicleInspections(selectedVehicle.id, undefined, controller.signal)
      .then(setSavedInspections)
      .catch(() => {
        if (!controller.signal.aborted) setSavedInspections([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setSavedLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey, selectedVehicle]);

  if (!user) return <Navigate to="/login" replace />;
  if (!isDashboardUser) return <Navigate to="/login" replace />;
  if (user.role === 'vehicle_owner') return <Navigate to="/history" replace />;

  function selectVehicle(vehicleId: string) {
    if (submitting) return;
    setSelectedVehicleId(vehicleId);
    setFrequency('daily');
    setSubmitMessage(null);
  }

  function setItemResult(itemId: string, result: InspectionResult) {
    if (readOnly || submitting) return;
    setResults((current) => ({ ...current, [itemId]: result }));
  }

  function addFilesToItem(itemId: string, files: File[]) {
    const checked = validImageFiles(files);
    if (checked.error) setSubmitMessage({ kind: 'error', text: checked.error });
    if (checked.valid.length === 0) return;
    setPhotosByItem((current) => ({
      ...current,
      [itemId]: [...(current[itemId] ?? []), ...draftsFromFiles(checked.valid)],
    }));
  }

  function addGlobalFiles(files: File[]) {
    const checked = validImageFiles(files);
    if (checked.error) setSubmitMessage({ kind: 'error', text: checked.error });
    if (checked.valid.length > 0) setGlobalPhotos((current) => [...current, ...draftsFromFiles(checked.valid)]);
  }

  function setOdometerFile(files: File[]) {
    const checked = validImageFiles(files.slice(0, 1));
    if (checked.error) setSubmitMessage({ kind: 'error', text: checked.error });
    if (checked.valid[0]) setOdometerPhoto(draftsFromFiles([checked.valid[0]])[0]);
  }

  function removeDraft(photo: PhotoDraft) {
    if (photo.file) URL.revokeObjectURL(photo.url);
  }

  function focusValidationFailure() {
    if (validation.valid) return;
    if (validation.itemId) {
      const item = checklistItems.find((candidate) => candidate.id === validation.itemId);
      const zone = item?.section
        ? INSPECTION_ZONES.find((candidate) => ZONE_SECTIONS[candidate].includes(item.section!)) ?? null
        : null;
      setActiveZone(zone);
    }
    const messages = {
      empty: t('emptyChecklist'),
      unanswered: t('allItemsRequired'),
      'failure-photo': t('failedPhotoRequired'),
      mileage: t('mileageRequired'),
      odometer: t('odometerRequired'),
      usable: t('usableRequired'),
    } as const;
    setSubmitMessage({ kind: 'error', text: messages[validation.reason] });
  }

  async function uploadDraft(photo: PhotoDraft) {
    if (!photo.file) return photo.url;
    const uploaded = await uploadInspectionPhoto(photo.file);
    return uploaded.url;
  }

  async function handleSubmit() {
    if (!selectedVehicle || readOnly || submitLockRef.current) return;
    if (!validation.valid) {
      focusValidationFailure();
      return;
    }

    submitLockRef.current = true;
    setSubmitting(true);
    setSubmitMessage(null);
    try {
      const [photoUrls, odometerPhotoUrl, uploadedItemEntries] = await Promise.all([
        Promise.all(globalPhotos.map(uploadDraft)),
        uploadDraft(odometerPhoto!),
        Promise.all(checklistItems.map(async (item) => [
          item.id,
          await Promise.all((photosByItem[item.id] ?? []).map(uploadDraft)),
        ] as const)),
      ]);
      const uploadedByItem = Object.fromEntries(uploadedItemEntries);
      const formData = {
        results: checklistItems.map((item) => ({
          checklistItemId: item.id,
          result: results[item.id]!,
          photoUrls: uploadedByItem[item.id] ?? [],
          notes: notesByItem[item.id] || '',
        })),
        photoUrls,
        notes,
        mileage: Number.parseInt(mileage.trim(), 10),
        odometerPhotoUrl,
        vehicleUsable: vehicleUsable!,
      };

      if (existingInspectionId) {
        await updateInspection(existingInspectionId, formData);
      } else {
        const created = await createInspection({
          vehicleId: selectedVehicle.id,
          inspectionDate: getTodayThai(),
          frequency,
          ...formData,
        });
        if (created.existingInspectionId) {
          await updateInspection(created.existingInspectionId, formData);
        }
      }
      setSubmitMessage({ kind: 'success', text: existingInspectionId ? t('inspectionUpdated') : t('inspectionSaved') });
      setReloadKey((value) => value + 1);
    } catch (error) {
      const text = error instanceof ApiError && error.status === 409
        ? error.message
        : error instanceof Error ? error.message : t('inspectionSubmitError');
      setSubmitMessage({ kind: 'error', text });
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="inspection-page">
      <div className="page-header inspection-page__header">
        <div>
          <h1>{t('inspections')}</h1>
          <p className="muted">{t('inspectionPageSubtitle')}</p>
        </div>
        <div className="inspection-page__date">
          <span>{t('inspectionDate')}</span>
          <strong>{getTodayThai()}</strong>
        </div>
      </div>

      <div className="inspection-workspace">
        <aside className="panel inspection-vehicle-rail">
          <div className="inspection-panel-heading">
            <div>
              <span className="section-label">{t('vehicle')}</span>
              <h2>{t('selectVehicle')}</h2>
            </div>
            <span className="inspection-count-pill">{filteredVehicles.length}</span>
          </div>
          <label className="inspection-search">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
            <span className="visually-hidden">{t('searchPlate')}</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('searchPlate')} />
          </label>

          <div className="inspection-vehicle-list">
            {vehiclesLoading && <div className="inspection-inline-state">{t('loading')}</div>}
            {vehiclesError && <div className="alert alert--error">{t('vehicleLoadError')}</div>}
            {!vehiclesLoading && !vehiclesError && filteredVehicles.length === 0 && (
              <div className="inspection-inline-state">{t('noResults')}</div>
            )}
            {filteredVehicles.map((vehicle) => {
              const selected = vehicle.id === selectedVehicleId;
              return (
                <button
                  type="button"
                  className={`inspection-vehicle-card${selected ? ' inspection-vehicle-card--selected' : ''}`}
                  key={vehicle.id}
                  onClick={() => selectVehicle(vehicle.id)}
                  aria-pressed={selected}
                >
                  <span className="inspection-vehicle-card__plate">{vehicle.plate_number}</span>
                  <span className="inspection-vehicle-card__meta">
                    {vehicle.fleet_id} · {t(VEHICLE_TYPE_I18N_KEYS[vehicle.vehicle_type] as any)}
                  </span>
                  <span className={`inspection-vehicle-card__status inspection-vehicle-card__status--${vehicle.daily_result === 'fail' ? 'failed' : vehicle.daily_status}`}>
                    {vehicle.daily_result === 'fail' ? t('failedToday') : vehicle.daily_status === 'checked' ? t('checkedToday') : t('pendingToday')}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="panel inspection-editor" aria-label={t('inspectionChecklist')}>
          {!selectedVehicle ? (
            <div className="inspection-empty-editor">
              <span>✓</span>
              <h2>{t('selectVehicle')}</h2>
              <p>{t('selectVehicleHint')}</p>
            </div>
          ) : (
            <>
              <div className="inspection-frequency-tabs" role="tablist" aria-label={t('inspectionType')}>
                {FREQUENCIES.map((value) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={frequency === value}
                    className={frequency === value ? 'inspection-frequency-tab inspection-frequency-tab--active' : 'inspection-frequency-tab'}
                    key={value}
                    onClick={() => {
                      setSubmitMessage(null);
                      setFrequency(value);
                    }}
                    disabled={submitting}
                  >
                    {frequencyLabel(value)}
                  </button>
                ))}
              </div>

              <div className="inspection-editor__identity">
                <div>
                  <span className="section-label">{t('inspectionChecklist')}</span>
                  <h2>{selectedVehicle.plate_number}</h2>
                  <p>{selectedVehicle.fleet_id} · {t(VEHICLE_TYPE_I18N_KEYS[selectedVehicle.vehicle_type] as any)}</p>
                </div>
                <div className="inspection-progress-copy">
                  <strong>{answeredCount}/{checklistItems.length}</strong>
                  <span>{completionPercent}%</span>
                </div>
              </div>
              <div className="inspection-progress-track" aria-label={t('inspectionProgress')}>
                <span style={{ width: `${completionPercent}%` }} />
              </div>

              <div className="inspection-zone-tabs" role="tablist" aria-label={t('inspectionZones')}>
                {[null, ...INSPECTION_ZONES].map((zone) => {
                  const count = itemsForZone(checklistItems, zone).length;
                  return (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeZone === zone}
                      className={activeZone === zone ? 'inspection-zone-tab inspection-zone-tab--active' : 'inspection-zone-tab'}
                      key={zone ?? 'all'}
                      onClick={() => setActiveZone(zone)}
                    >
                      <span>{zoneLabel(zone)}</span>
                      <small>{count}</small>
                    </button>
                  );
                })}
              </div>

              {carryoverItems.size > 0 && (
                <div className="inspection-carryover">{t('carryoverNotice', { count: String(carryoverItems.size) })}</div>
              )}
              {readOnly && (
                <div className="alert alert--warn">{t('inspectionReadOnly', { name: readOnlyInspector || '—' })}</div>
              )}
              {formError && <div className="alert alert--error">{formError}</div>}
              {formLoading ? (
                <div className="inspection-inline-state inspection-inline-state--large">{t('loadingChecklist')}</div>
              ) : (
                <div className="inspection-checklist">
                  <div className="inspection-checklist__heading">
                    <div>
                      <span className="section-label">{t('showingItems')}</span>
                      <h3>{zoneLabel(activeZone)}</h3>
                    </div>
                    <span>{t('itemCount', { count: String(visibleItems.length) })}</span>
                  </div>
                  {visibleItems.length === 0 && (
                    <div className="inspection-inline-state">{t('noZoneItems')}</div>
                  )}
                  {visibleItems.map((item) => {
                    const itemResult = results[item.id];
                    const itemPhotos = photosByItem[item.id] ?? [];
                    const failed = itemResult === 'fail';
                    return (
                      <article
                        className={`inspection-check-row${itemResult ? ` inspection-check-row--${itemResult}` : ''}`}
                        key={item.id}
                      >
                        <div className="inspection-check-row__main">
                          <span className="inspection-check-row__order">{String(item.sort_order).padStart(2, '0')}</span>
                          <div className="inspection-check-row__copy">
                            <strong>{locale === 'th' ? item.item_name_th : item.item_name_en}</strong>
                            <span>{locale === 'th' ? item.item_name_en : item.item_name_th}</span>
                            {carryoverItems.has(item.id) && <small>{t('unresolvedDefect')}</small>}
                          </div>
                          <div className="inspection-result-buttons" role="group" aria-label={locale === 'th' ? item.item_name_th : item.item_name_en}>
                            <button
                              type="button"
                              className={itemResult === 'pass' ? 'inspection-result-button inspection-result-button--pass' : 'inspection-result-button'}
                              onClick={() => setItemResult(item.id, 'pass')}
                              disabled={readOnly || submitting}
                              aria-pressed={itemResult === 'pass'}
                            >
                              ✓ {t('passLabel')}
                            </button>
                            <button
                              type="button"
                              className={itemResult === 'fail' ? 'inspection-result-button inspection-result-button--fail' : 'inspection-result-button'}
                              onClick={() => setItemResult(item.id, 'fail')}
                              disabled={readOnly || submitting}
                              aria-pressed={itemResult === 'fail'}
                            >
                              ! {t('failLabel')}
                            </button>
                          </div>
                        </div>
                        {failed && (
                          <div className="inspection-failure-evidence">
                            <div className="inspection-failure-evidence__heading">
                              <strong>{t('failureEvidence')}</strong>
                              <span>{t('required')}</span>
                            </div>
                            <div className="inspection-failure-evidence__fields">
                              <div>
                                <PhotoInput
                                  id={`failure-photo-${item.id}`}
                                  label={t('addPhoto')}
                                  multiple
                                  disabled={readOnly || submitting}
                                  onFiles={(files) => addFilesToItem(item.id, files)}
                                />
                                <PhotoDrafts
                                  photos={itemPhotos}
                                  onRemove={(photoId) => {
                                    setPhotosByItem((current) => {
                                      const removed = (current[item.id] ?? []).find((photo) => photo.id === photoId);
                                      if (removed) removeDraft(removed);
                                      return { ...current, [item.id]: (current[item.id] ?? []).filter((photo) => photo.id !== photoId) };
                                    });
                                  }}
                                />
                                {itemPhotos.length === 0 && <small className="inspection-required-copy">{t('photoRequired')}</small>}
                              </div>
                              <label>
                                <span>{t('itemNotes')}</span>
                                <textarea
                                  value={notesByItem[item.id] ?? ''}
                                  onChange={(event) => setNotesByItem((current) => ({ ...current, [item.id]: event.target.value }))}
                                  placeholder={t('describeIssue')}
                                  disabled={readOnly || submitting}
                                  rows={3}
                                />
                              </label>
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}

              {!formLoading && checklistItems.length > 0 && (
                <section className="inspection-completion-panel">
                  <div className="inspection-completion-panel__heading">
                    <div>
                      <span className="section-label">{t('finishInspection')}</span>
                      <h3>{validation.valid ? t('readyToSubmit') : t('completeRequiredFields')}</h3>
                    </div>
                    <span className={`inspection-fail-count${failCount > 0 ? ' inspection-fail-count--active' : ''}`}>
                      {t('failCountSummary', { count: String(failCount) })}
                    </span>
                  </div>
                  <div className="inspection-completion-grid">
                    <label className="inspection-field">
                      <span>{t('mileage')} <b>{t('required')}</b></span>
                      <div className="inspection-mileage-input">
                        <input
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={mileage}
                          onChange={(event) => setMileage(event.target.value)}
                          placeholder="0"
                          disabled={readOnly || submitting}
                        />
                        <span>km</span>
                      </div>
                    </label>
                    <div className="inspection-field">
                      <span>{t('odometerPhoto')} <b>{t('required')}</b></span>
                      <PhotoInput
                        id="inspection-odometer-photo"
                        label={odometerPhoto ? t('replacePhoto') : t('choosePhoto')}
                        disabled={readOnly || submitting}
                        onFiles={setOdometerFile}
                      />
                      {odometerPhoto && (
                        <PhotoDrafts
                          photos={[odometerPhoto]}
                          onRemove={() => {
                            removeDraft(odometerPhoto);
                            setOdometerPhoto(null);
                          }}
                        />
                      )}
                    </div>
                    <div className="inspection-field">
                      <span>{t('vehicleUsable')} <b>{t('required')}</b></span>
                      <div className="inspection-usable-buttons">
                        <button
                          type="button"
                          className={vehicleUsable === true ? 'inspection-usable-button inspection-usable-button--yes' : 'inspection-usable-button'}
                          onClick={() => setVehicleUsable(true)}
                          disabled={readOnly || submitting}
                          aria-pressed={vehicleUsable === true}
                        >
                          {t('usable')}
                        </button>
                        <button
                          type="button"
                          className={vehicleUsable === false ? 'inspection-usable-button inspection-usable-button--no' : 'inspection-usable-button'}
                          onClick={() => setVehicleUsable(false)}
                          disabled={readOnly || submitting}
                          aria-pressed={vehicleUsable === false}
                        >
                          {t('notUsable')}
                        </button>
                      </div>
                    </div>
                    <label className="inspection-field inspection-field--notes">
                      <span>{t('notes')} <em>{t('optional')}</em></span>
                      <textarea
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                        placeholder={t('additionalNotes')}
                        disabled={readOnly || submitting}
                        rows={3}
                      />
                    </label>
                    <div className="inspection-field inspection-field--photos">
                      <span>{t('inspectionPhotos')} <em>{t('optional')}</em></span>
                      <PhotoInput
                        id="inspection-global-photos"
                        label={t('addPhotos')}
                        multiple
                        disabled={readOnly || submitting}
                        onFiles={addGlobalFiles}
                      />
                      <PhotoDrafts
                        photos={globalPhotos}
                        onRemove={(photoId) => {
                          setGlobalPhotos((current) => {
                            const removed = current.find((photo) => photo.id === photoId);
                            if (removed) removeDraft(removed);
                            return current.filter((photo) => photo.id !== photoId);
                          });
                        }}
                      />
                    </div>
                  </div>
                  {submitMessage && (
                    <div className={`alert ${submitMessage.kind === 'success' ? 'inspection-alert--success' : 'alert--error'}`}>
                      {submitMessage.text}
                    </div>
                  )}
                  <div className="inspection-completion-panel__submit">
                    <div>
                      <strong>{existingInspectionId ? t('updateCurrentInspection') : t('newInspection')}</strong>
                      <span>{readOnly ? t('readOnlyResult') : validation.valid ? t('allRequiredComplete') : t('requiredFieldsHint')}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn--accent inspection-submit-button"
                      onClick={handleSubmit}
                      disabled={readOnly || submitting || formLoading}
                    >
                      {submitting ? t('submittingInspection') : existingInspectionId ? t('updateInspection') : t('submitInspection')}
                    </button>
                  </div>
                </section>
              )}
            </>
          )}
        </section>

        <aside className="inspection-summary-rail">
          <section className="panel inspection-selected-vehicle">
            <span className="section-label">{t('selectedVehicle')}</span>
            {selectedVehicle ? (
              <>
                <div className="inspection-selected-vehicle__title">
                  <h2>{selectedVehicle.plate_number}</h2>
                  <span>{selectedVehicle.daily_result === 'fail' ? t('failedToday') : selectedVehicle.daily_status === 'checked' ? t('checkedToday') : t('pendingToday')}</span>
                </div>
                <dl>
                  <div><dt>{t('fleet')}</dt><dd>{selectedVehicle.fleet_id}</dd></div>
                  <div><dt>{t('vehicleType')}</dt><dd>{t(VEHICLE_TYPE_I18N_KEYS[selectedVehicle.vehicle_type] as any)}</dd></div>
                  <div><dt>{t('daily')}</dt><dd>{selectedVehicle.daily_status === 'checked' ? t('checked') : t('pending')}</dd></div>
                  <div><dt>{t('weekly')}</dt><dd>{selectedVehicle.weekly_status === 'checked' ? t('checked') : t('pending')}</dd></div>
                </dl>
              </>
            ) : <div className="inspection-inline-state">{t('noVehicleSelected')}</div>}
          </section>

          <section className="panel inspection-saved-panel">
            <div className="inspection-panel-heading">
              <div>
                <span className="section-label">{t('inspectionHistory')}</span>
                <h2>{t('savedInspections')}</h2>
              </div>
              <span className="inspection-count-pill">{savedInspections.length}</span>
            </div>
            <div className="inspection-saved-list">
              {savedLoading && <div className="inspection-inline-state">{t('loading')}</div>}
              {!savedLoading && savedInspections.length === 0 && (
                <div className="inspection-inline-state">{t('noSavedInspections')}</div>
              )}
              {savedInspections.map((log) => (
                <article className="inspection-saved-row" key={log.id}>
                  <div className="inspection-saved-row__top">
                    <div>
                      <strong>{frequencyLabel(log.frequency)}</strong>
                      <span>{formatDateThai(log.inspection_date)}</span>
                    </div>
                    <span className={`inspection-saved-status inspection-saved-status--${log.overall_status}`}>
                      {savedStatus(log)}
                    </span>
                  </div>
                  <div className="inspection-saved-row__meta">
                    <span>{log.inspector_name || '—'}</span>
                    <button type="button" onClick={() => setDetailInspectionId(log.id)}>{t('viewResult')}</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </aside>
      </div>

      {detailInspectionId && (
        <InspectionResultDialog inspectionId={detailInspectionId} onClose={() => setDetailInspectionId(null)} />
      )}
    </div>
  );
}
