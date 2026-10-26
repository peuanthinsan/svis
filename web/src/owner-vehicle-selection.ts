/** Exact plate matching: normalize surrounding whitespace and case, never use fuzzy matches. */
export function normalizeOwnerPlate(value: string): string {
  return value.normalize('NFC').trim().toLocaleUpperCase();
}

export type PlateVehicle = { id: string; plate_number: string };
export type PlateMatchPreview = {
  matches: Array<{ plate: string; vehicleId: string }>;
  unmatched: string[];
  ambiguous: string[];
  duplicates: string[];
  canApply: boolean;
};

export function previewOwnerPlates(plates: string[], vehicles: PlateVehicle[]): PlateMatchPreview {
  const byPlate = new Map<string, Set<string>>();
  for (const vehicle of vehicles) {
    const key = normalizeOwnerPlate(vehicle.plate_number);
    const ids = byPlate.get(key) ?? new Set<string>();
    ids.add(vehicle.id);
    byPlate.set(key, ids);
  }
  const matches: PlateMatchPreview['matches'] = [];
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const rawPlate of plates) {
    const plate = rawPlate.trim();
    const key = normalizeOwnerPlate(plate);
    if (!key) continue;
    if (seen.has(key)) { duplicates.push(plate); continue; }
    seen.add(key);
    const ids = byPlate.get(key);
    if (!ids?.size) unmatched.push(plate);
    else if (ids.size !== 1) ambiguous.push(plate);
    else matches.push({ plate, vehicleId: [...ids][0] });
  }
  return { matches, unmatched, ambiguous, duplicates, canApply: matches.length > 0 && unmatched.length === 0 && ambiguous.length === 0 };
}

export function parsePastedOwnerPlates(input: string): string[] {
  return input.split(/[\r\n\t,;]+/).map((plate) => plate.trim()).filter(Boolean);
}

export type OwnerPlateColumn = { label: string; index: number; plates: string[] };

/** The first non-empty row is the header; each customer column stays separate. */
export function ownerPlateColumns(matrix: unknown[][]): OwnerPlateColumn[] {
  const headerIndex = matrix.findIndex((row) => row.some((cell) => String(cell ?? '').trim()));
  if (headerIndex === -1) return [];
  return matrix[headerIndex].flatMap((header, index) => {
    const label = String(header ?? '').trim();
    if (!label) return [];
    const plates = matrix.slice(headerIndex + 1)
      .map((row) => String(row[index] ?? '').trim()).filter(Boolean);
    return plates.length ? [{ label, index, plates }] : [];
  });
}

/** Fetch all pages, with no silent first-page cap on the administrator's checklist. */
export async function loadCompleteVehicleCatalog<T extends { id: string }>(
  fetchPage: (params: { limit: number; offset: number }) => Promise<T[]>,
): Promise<T[]> {
  const pageSize = 500;
  const vehicles = new Map<string, T>();
  let offset = 0;
  while (true) {
    const page = await fetchPage({ limit: pageSize, offset });
    let added = 0;
    for (const vehicle of page) {
      if (!vehicles.has(vehicle.id)) added++;
      vehicles.set(vehicle.id, vehicle);
    }
    if (page.length < pageSize) return [...vehicles.values()];
    if (added === 0) throw new Error('Vehicle list changed while loading. Please retry.');
    offset += page.length;
  }
}
