import { useMemo, useRef, useState } from 'react';
import type { OwnerVehicleOption } from '../../api';
import { t } from '../../i18n';
import { parseCsvMatrix } from '../../checklist-import';
import {
  ownerPlateColumns, parsePastedOwnerPlates, previewOwnerPlates,
  type OwnerPlateColumn, type PlateMatchPreview,
} from '../../owner-vehicle-selection';

type Props = {
  vehicles: OwnerVehicleOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
};

export function OwnerVehicleSelector({ vehicles, selectedIds, onChange, disabled = false }: Props) {
  const [search, setSearch] = useState('');
  const [fleet, setFleet] = useState('');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [plateText, setPlateText] = useState('');
  const [columns, setColumns] = useState<OwnerPlateColumn[]>([]);
  const [columnIndex, setColumnIndex] = useState('');
  const [preview, setPreview] = useState<PlateMatchPreview | null>(null);
  const [fileError, setFileError] = useState('');
  const [readingFile, setReadingFile] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileSequence = useRef(0);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const fleets = useMemo(() => [...new Set(vehicles.map((vehicle) => vehicle.fleet_id))].sort(), [vehicles]);
  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return vehicles.filter((vehicle) => (!fleet || vehicle.fleet_id === fleet)
      && (!selectedOnly || selected.has(vehicle.id))
      && (!query || vehicle.plate_number.toLocaleLowerCase().includes(query)
        || vehicle.fleet_id.toLocaleLowerCase().includes(query)));
  }, [fleet, search, selectedOnly, selected, vehicles]);

  function toggle(id: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(id); else next.delete(id);
    onChange([...next]);
  }

  function selectVisible(checked: boolean) {
    const next = new Set(selected);
    for (const vehicle of visible) {
      if (checked) next.add(vehicle.id); else next.delete(vehicle.id);
    }
    onChange([...next]);
  }

  function previewText() {
    setPreview(previewOwnerPlates(parsePastedOwnerPlates(plateText), vehicles));
  }

  async function readFile(file: File | undefined) {
    const sequence = ++fileSequence.current;
    setFileError(''); setColumns([]); setColumnIndex(''); setPlateText(''); setPreview(null);
    if (!file) { setReadingFile(false); return; }
    if (file.size > 5 * 1024 * 1024) { setReadingFile(false); setFileError(t('ownerFileTooLarge')); return; }
    setReadingFile(true);
    try {
      let matrix: unknown[][];
      if (file.name.toLowerCase().endsWith('.csv')) matrix = parseCsvMatrix(await file.text());
      else if (file.name.toLowerCase().endsWith('.xlsx')) {
        const { readSheet } = await import('read-excel-file/browser');
        matrix = await readSheet(file);
      } else throw new Error(t('ownerFileFormat'));
      if (sequence !== fileSequence.current) return;
      if (matrix.length > 10001) throw new Error(t('ownerFileTooManyRows'));
      const nextColumns = ownerPlateColumns(matrix);
      if (!nextColumns.length) throw new Error(t('ownerFileEmpty'));
      setColumns(nextColumns);
    } catch (error) {
      if (sequence === fileSequence.current) setFileError(error instanceof Error ? error.message : t('error'));
    } finally {
      if (sequence === fileSequence.current) setReadingFile(false);
    }
  }

  function chooseColumn(value: string) {
    setColumnIndex(value); setPreview(null);
    const column = columns.find((candidate) => String(candidate.index) === value);
    if (column) {
      setPlateText(column.plates.join('\n'));
      setPreview(previewOwnerPlates(column.plates, vehicles));
    } else setPlateText('');
  }

  function applyPreview(replace: boolean) {
    if (!preview?.canApply) return;
    const ids = preview.matches.map((match) => match.vehicleId);
    onChange(replace ? ids : [...new Set([...selectedIds, ...ids])]);
  }

  return <fieldset className="owner-vehicle-selector" disabled={disabled}>
    <legend>{t('ownerVehicles')}</legend>
    <p className="muted owner-vehicle-selector__help">{t('ownerAssignmentHelp')}</p>
    <div className="owner-vehicle-selector__summary" role="status">
      <strong>{t('ownerSelectedCount', { count: String(selectedIds.length) })}</strong>
      <span className="muted">{t('ownerAvailableCount', { count: String(vehicles.length) })}</span>
      <button type="button" className="link-btn" disabled={!selectedIds.length} onClick={() => onChange([])}>{t('ownerClearSelection')}</button>
    </div>
    {!selectedIds.length && <p className="owner-vehicle-selector__empty">{t('ownerEmptySelection')}</p>}
    <details className="owner-vehicle-selector__bulk">
      <summary>{t('ownerUsePlateList')}</summary>
      <p className="muted">{t('ownerPlateListHelp')}</p>
      <label className="owner-vehicle-selector__label">
        {t('ownerPlateList')}
        <textarea aria-label={t('ownerPlateList')} rows={4} value={plateText} onChange={(event) => { setPlateText(event.target.value); setPreview(null); setColumnIndex(''); }} placeholder={t('ownerPlatePlaceholder')} />
      </label>
      <div className="owner-vehicle-selector__actions">
        <button type="button" className="btn btn--secondary" disabled={!plateText.trim() || readingFile} onClick={previewText}>{t('ownerPreviewList')}</button>
        <input ref={fileInput} type="file" accept=".csv,.xlsx" hidden onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ''; }} />
        <button type="button" className="btn btn--secondary" disabled={readingFile} onClick={() => fileInput.current?.click()}>{readingFile ? t('loading') : t('ownerChooseFile')}</button>
      </div>
      {columns.length > 0 && <label className="owner-vehicle-selector__label">
        {t('ownerChooseColumn')}
        <select aria-label={t('ownerChooseColumn')} value={columnIndex} onChange={(event) => chooseColumn(event.target.value)}>
          <option value="">{t('ownerChooseColumnPlaceholder')}</option>
          {columns.map((column) => <option key={column.index} value={column.index}>{column.label} ({column.plates.length})</option>)}
        </select>
      </label>}
      {fileError && <div className="alert alert--error" role="alert">{fileError}</div>}
      {preview && <div className="owner-vehicle-selector__preview" aria-live="polite">
        <strong>{t('ownerMatchedCount', { count: String(preview.matches.length) })}</strong>
        {preview.duplicates.length > 0 && <span className="muted">{t('ownerDuplicateCount', { count: String(preview.duplicates.length) })}</span>}
        {preview.unmatched.length > 0 && <div className="alert alert--error"><strong>{t('ownerUnmatched')}</strong><p>{preview.unmatched.join(', ')}</p></div>}
        {preview.ambiguous.length > 0 && <div className="alert alert--error"><strong>{t('ownerAmbiguous')}</strong><p>{preview.ambiguous.join(', ')}</p></div>}
        {!preview.canApply && <p className="muted">{t('ownerResolveList')}</p>}
        <div className="owner-vehicle-selector__actions">
          <button type="button" className="btn btn--secondary" disabled={!preview.canApply} onClick={() => applyPreview(false)}>{t('ownerAddMatched')}</button>
          <button type="button" className="btn btn--secondary" disabled={!preview.canApply} onClick={() => applyPreview(true)}>{t('ownerReplaceSelection')}</button>
        </div>
      </div>}
    </details>
    <div className="owner-vehicle-selector__filters">
      <input aria-label={t('searchPlate')} placeholder={t('searchPlate')} value={search} onChange={(event) => setSearch(event.target.value)} />
      <select aria-label={t('fleet')} value={fleet} onChange={(event) => setFleet(event.target.value)}>
        <option value="">{t('allFleets')}</option>
        {fleets.map((fleetId) => <option key={fleetId} value={fleetId}>{fleetId || '—'}</option>)}
      </select>
      <label><input type="checkbox" checked={selectedOnly} onChange={(event) => setSelectedOnly(event.target.checked)} />{t('ownerSelectedOnly')}</label>
    </div>
    <div className="owner-vehicle-selector__actions">
      <span className="muted">{t('ownerVisibleCount', { count: String(visible.length) })}</span>
      <button type="button" className="link-btn" onClick={() => selectVisible(true)} disabled={!visible.length}>{t('ownerSelectVisible')}</button>
      <button type="button" className="link-btn" onClick={() => selectVisible(false)} disabled={!visible.length}>{t('ownerClearVisible')}</button>
    </div>
    <div className="owner-vehicle-selector__list">
      {visible.length === 0 && <p className="table-empty">{t('noResults')}</p>}
      {visible.map((vehicle) => <label key={vehicle.id} className="owner-vehicle-selector__vehicle">
        <input type="checkbox" checked={selected.has(vehicle.id)} onChange={(event) => toggle(vehicle.id, event.target.checked)} />
        <strong>{vehicle.plate_number}</strong>
        <span className="muted">{vehicle.fleet_id || '—'}</span>
        <span className="muted">{vehicle.vehicle_type}</span>
      </label>)}
    </div>
  </fieldset>;
}
