import { getToken } from './auth';
import type { FailedChecklistItem } from './issue-checklist';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function parseJson(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, { ...init, headers });
  const data = await parseJson(res);

  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

export type LoginResponse = {
  token: string;
  user: {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
    role: 'driver' | 'supervisor' | 'admin';
    fleetId: string;
    companyId: string;
    companySlug: string;
    companyName: string;
    primaryColor: string;
    accentColor: string;
  };
};

export type LoginAccount = {
  username: string;
  displayName: string;
  role: 'driver' | 'supervisor' | 'admin';
};

export function fetchLoginUsers(companySlug: string) {
  return apiFetch<{
    drivers: string[];
    staff: string[];
    driverAccounts: LoginAccount[];
    staffAccounts: LoginAccount[];
  }>(`/api/auth/users-list?company=${encodeURIComponent(companySlug)}`);
}

export type Company = {
  slug: string;
  name: string;
  shortName: string;
  primaryColor: string;
  accentColor: string;
};

export function fetchCompanies() {
  return apiFetch<{ defaultCompanySlug: string; companies: Company[] }>('/api/companies');
}

export type FleetStat = {
  fleetId: string;
  total: number;
  checked: number;
  pending: number;
};

export type VehicleTypeKey = 'car' | 'van' | 'e_van' | 'motorcycle' | 'e_bike' | 'light_truck' | 'six_wheel_truck';
export const VEHICLE_TYPES: readonly VehicleTypeKey[] = [
  'car', 'van', 'e_van', 'motorcycle', 'e_bike', 'light_truck', 'six_wheel_truck',
];
export const VEHICLE_TYPE_LABELS: Record<VehicleTypeKey, string> = {
  car: 'Pickup',
  van: 'Van',
  e_van: 'E-Van',
  motorcycle: 'Motorcycle',
  e_bike: 'E-Bike',
  light_truck: 'Light Truck',
  six_wheel_truck: '6-Wheel Truck',
};
export const VEHICLE_TYPE_I18N_KEYS: Record<VehicleTypeKey, string> = {
  car: 'typeCar',
  van: 'typeVan',
  e_van: 'typeEvan',
  motorcycle: 'typeMotorcycle',
  e_bike: 'typeEbike',
  light_truck: 'typeLightTruck',
  six_wheel_truck: 'typeSixWheelTruck',
};
export type TypeBreakdown = Record<VehicleTypeKey, number>;

export type CompletionStat = {
  checked: number;
  total: number;
  pending: number;
  percentage: number;
  byType: TypeBreakdown;
  /** Per-type denominators (Active vehicles when telematics is configured). */
  totalByType: TypeBreakdown;
};

export type DefectVehicle = {
  issueId: string;
  plate: string;
  fleetId: string;
  status: string;
  ageDays: number;
  vendorNotifiedAt: string | null;
  hasVendorEmail: boolean;
};

export type VehicleTaxExpiry = {
  vehicleId: string;
  plate: string;
  fleetId: string;
  expiryDate: string;
};

export type DashboardData = {
  date: string;
  fleetId: string | null;
  totalVehicles: number;
  byType: TypeBreakdown;
  /** True when the GPS sheet is configured, i.e. Active/denominators are telematics-based. */
  telematics: boolean;
  /** GPS counters and rows from the same scoped telematics snapshot as the metrics. */
  unitStatus: UnitStatusData | null;
  active: CompletionStat;
  preDeparture: CompletionStat;
  postRoute: CompletionStat;
  weekly: CompletionStat;
  outOfService: { total: number; today: number };
  withDefect: { total: number; today: number; vehicles: DefectVehicle[] };
  fleets: FleetStat[];
  vehicleTax: VehicleTaxExpiry[];
  // Back-compat alias (= pre-departure / daily completion).
  overall: { total: number; checked: number; pending: number; percentage: number };
};

export type InspectionDetail = {
  id: string;
  vehicle_id?: string;
  inspector_id?: string;
  plate_number: string;
  vehicle_type?: VehicleTypeKey;
  fleet_id?: string;
  overall_status: string;
  inspection_date: string;
  frequency?: 'daily' | 'weekly' | 'post_route';
  inspector_name?: string;
  mileage?: number;
  photo_urls?: string[];
  odometer_photo_url?: string | null;
  vehicle_usable?: boolean | null;
  notes?: string;
  created_at?: string;
  results?: Array<{
    id: string;
    checklist_item_id?: string;
    result: string;
    photo_urls?: string[];
    notes?: string;
    item_name_th: string;
    item_name_en: string;
  }>;
};

export type HistoryData = {
  total: number;
  passed: number;
  failed: number;
  inspections: InspectionDetail[];
};

export type IssueRow = {
  id: string;
  status: string;
  plate_number: string;
  vehicle_fleet?: string;
  fleet_id?: string;
  inspector_name?: string;
  inspection_date?: string;
  created_at: string;
  defect_photo_urls?: string[];
  completion_photo_urls?: string[];
  failed_checklist_items?: FailedChecklistItem[];
};

export function login(username: string, password: string, companySlug = 'dhl') {
  return apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, companySlug }),
  });
}

export function fetchDashboard(fleetId?: string, signal?: AbortSignal) {
  const qs = fleetId ? `?fleetId=${encodeURIComponent(fleetId)}` : '';
  return apiFetch<DashboardData>(`/api/dashboard${qs}`, { signal });
}

export function fetchHistory(startDate: string, endDate: string, fleetId?: string, options?: { search?: string; limit?: number; offset?: number; outOfService?: boolean }) {
  const params = new URLSearchParams();
  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);
  if (options?.outOfService) params.set('outOfService', 'true');
  if (fleetId) params.set('fleetId', fleetId);
  if (options?.search) params.set('search', options.search);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.offset !== undefined) params.set('offset', String(options.offset));
  return apiFetch<HistoryData>(`/api/history?${params}`);
}

export type IssuesResponse = {
  issues: IssueRow[];
  limit: number;
  offset: number;
};

export function fetchIssues(status?: string, fleetId?: string) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (fleetId) params.set('fleetId', fleetId);
  const qs = params.toString();
  return apiFetch<IssuesResponse>(`/api/issues${qs ? `?${qs}` : ''}`).then((r) => r.issues);
}

export function fetchInspectionDetail(id: string) {
  return apiFetch<InspectionDetail>(`/api/inspections/${encodeURIComponent(id)}`);
}

export type InspectionVehicle = {
  id: string;
  plate_number: string;
  vehicle_type: VehicleTypeKey;
  fleet_id: string;
  daily_status: 'checked' | 'pending';
  daily_result?: 'pass' | 'fail' | null;
  daily_checked_by?: string | null;
  weekly_status: 'checked' | 'pending';
  today_status: 'checked' | 'pending';
  overall_status?: 'pass' | 'fail' | null;
  checked_by?: string | null;
};

export type InspectionChecklistItem = ChecklistItem & {
  section?: 'front' | 'rear' | 'sides' | 'top' | 'underbody' | 'cabin' | 'cargo' | 'documents' | 'supplies' | null;
};

export type VehicleInspectionLog = InspectionDetail & {
  vehicle_id: string;
  inspector_id: string;
  frequency: 'daily' | 'weekly' | 'post_route';
  results: Array<{
    id?: string;
    checklist_item_id: string;
    result: 'pass' | 'fail';
    photo_urls?: string[];
    notes?: string;
    item_name_th?: string;
    item_name_en?: string;
  }>;
};

export function fetchInspectionVehicles(params?: { limit?: number; offset?: number; search?: string; signal?: AbortSignal }) {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.search) qs.set('search', params.search);
  const query = qs.toString();
  return apiFetch<{ vehicles: InspectionVehicle[]; total: number; limit: number; offset: number }>(
    `/api/vehicles${query ? `?${query}` : ''}`,
    { signal: params?.signal },
  );
}

export function fetchInspectionChecklist(vehicleType: VehicleTypeKey, frequency: 'daily' | 'weekly' | 'post_route', signal?: AbortSignal) {
  const qs = new URLSearchParams({ vehicleType, frequency });
  return apiFetch<InspectionChecklistItem[]>(`/api/checklist?${qs}`, { signal });
}

export function fetchVehicleInspections(vehicleId: string, params?: URLSearchParams, signal?: AbortSignal) {
  const qs = params ? new URLSearchParams(params) : new URLSearchParams();
  qs.set('vehicleId', vehicleId);
  return apiFetch<VehicleInspectionLog[]>(`/api/inspections?${qs}`, { signal });
}

export function fetchInspectionCarryover(vehicleId: string, signal?: AbortSignal) {
  const qs = new URLSearchParams({ vehicleId, carryover: '1' });
  return apiFetch<{ items: Array<{ checklist_item_id: string; item_name_th: string; item_name_en: string }> }>(
    `/api/inspections?${qs}`,
    { signal },
  );
}

export type InspectionResultInput = {
  checklistItemId: string;
  result: 'pass' | 'fail';
  photoUrls: string[];
  notes: string;
};

export type InspectionSubmission = {
  vehicleId: string;
  inspectionDate: string;
  frequency: 'daily' | 'weekly' | 'post_route';
  results: InspectionResultInput[];
  photoUrls: string[];
  notes: string;
  mileage: number;
  odometerPhotoUrl: string;
  vehicleUsable: boolean;
};

export function createInspection(data: InspectionSubmission) {
  return apiFetch<{
    inspectionId?: string;
    existingInspectionId?: string;
    overallStatus?: 'pass' | 'fail';
    issueId?: string | null;
  }>('/api/inspections', { method: 'POST', body: JSON.stringify(data) });
}

export function updateInspection(inspectionId: string, data: Omit<InspectionSubmission, 'vehicleId' | 'inspectionDate' | 'frequency'>) {
  return apiFetch<{ inspectionId: string; overallStatus: 'pass' | 'fail' }>('/api/inspections', {
    method: 'PUT',
    body: JSON.stringify({ inspectionId, ...data }),
  });
}

export function uploadInspectionPhoto(file: File) {
  const extension = file.type === 'image/png' ? 'png' : 'jpg';
  const safeBase = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || 'photo';
  const suffix = Math.random().toString(36).slice(2, 9);
  const filename = `inspection-${Date.now()}-${suffix}-${safeBase}.${extension}`;
  const body = new FormData();
  body.append('file', file, filename);
  return apiFetch<{ url: string }>(`/api/upload?filename=${encodeURIComponent(filename)}`, {
    method: 'POST',
    body,
  });
}

export type GpsStatus = 'running' | 'stopped' | 'offline';

export type InspectionFlags = {
  preRoute: boolean;
  postRoute: boolean;
  weekly: boolean;
};

export type UnitStatusVehicle = {
  plateNumber: string;
  fleet: string;
  driverName: string;
  gpsStatus: GpsStatus;
  ignition: boolean;
  speed: number;
  lastFixTime: string;
  updatedAt: string;
  inspections: InspectionFlags;
  needsAttention: boolean;
};

export type UnitStatusData = {
  configured: boolean;
  date?: string;
  vehicles: UnitStatusVehicle[];
  summary?: {
    total: number;
    running: number;
    stopped: number;
    offline: number;
    needsAttention: number;
  };
};

export function fetchUnitStatus(fleetId?: string) {
  const qs = fleetId ? `?fleetId=${encodeURIComponent(fleetId)}` : '';
  return apiFetch<UnitStatusData>(`/api/unit-status${qs}`);
}

// ─── Preventive Maintenance ──────────────────────────────────────────────────

export type MaintenanceCategoryStatus = 'ok' | 'due' | 'overdue' | 'noData';

export type MaintenanceCategory = {
  status: MaintenanceCategoryStatus;
  dueAtKm?: number;
  kmRemaining?: number;
  dueDate?: string;
};

export type MaintenanceVehicle = {
  vehicleId: string;
  plate: string;
  fleetId: string;
  vehicleType: VehicleTypeKey;
  region: 'metro' | 'provincial';
  latestMileage: number | null;
  kmPerDay: number | null;
  lastServiceDate: string | null;
  lastServiceMileage: number | null;
  lastTireChangeDate: string | null;
  lastTireChangeMileage: number | null;
  lastBatteryChangeDate: string | null;
  taxExpiryDate: string | null;
  checkup: MaintenanceCategory;
  tires: MaintenanceCategory;
  battery: MaintenanceCategory;
};

export type MaintenanceSummaryEntry = { due: number; overdue: number; noData: number };

export type MaintenanceData = {
  date: string;
  horizonDays: number;
  vehicles: MaintenanceVehicle[];
  summary: {
    checkup: MaintenanceSummaryEntry;
    tires: MaintenanceSummaryEntry;
    battery: MaintenanceSummaryEntry;
  };
};

export function fetchMaintenance(fleetId?: string, signal?: AbortSignal) {
  const qs = fleetId ? `?fleetId=${encodeURIComponent(fleetId)}` : '';
  return apiFetch<MaintenanceData>(`/api/maintenance${qs}`, { signal });
}

export function saveMaintenance(data: {
  vehicleId: string;
  region?: 'metro' | 'provincial';
  lastServiceDate?: string | null;
  lastServiceMileage?: number | null;
  lastTireChangeDate?: string | null;
  lastTireChangeMileage?: number | null;
  lastBatteryChangeDate?: string | null;
  taxExpiryDate?: string | null;
}) {
  return apiFetch<{ ok: boolean }>('/api/maintenance', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function importMaintenance(rows: Array<{
  vehicleId?: string;
  plateNumber?: string;
  region?: string | null;
  lastServiceDate?: string | null;
  lastServiceMileage?: number | string | null;
  lastTireChangeDate?: string | null;
  lastTireChangeMileage?: number | string | null;
  lastBatteryChangeDate?: string | null;
  taxExpiryDate?: string | null;
}>) {
  return apiFetch<{ imported: number }>('/api/admin/maintenance/import', {
    method: 'POST',
    body: JSON.stringify({ rows }),
  });
}

export function exportDashboardUrl(params: URLSearchParams) {
  const token = getToken();
  const qs = params.toString();
  const url = `/api/dashboard/export${qs ? `?${qs}` : ''}`;
  if (!token) return url;
  return `${url}${qs ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export async function downloadExport(path: string, filename: string) {
  const token = getToken();
  const res = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError('Export failed', res.status);
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(href);
}


// ─── Admin Types ─────────────────────────────────────────────────────────────

export type AdminUser = {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  role: 'driver' | 'supervisor' | 'admin';
  fleet_id?: string;
  created_at: string;
};

export type AdminVehicle = {
  id: string;
  plate_number: string;
  vehicle_type: VehicleTypeKey;
  fleet_id: string;
  fleet_manager_email?: string;
  vendor_email?: string;
  tax_expiry_date?: string | null;
  created_at: string;
};

export type AdminFleet = {
  fleet_id: string;
  vehicle_count: number;
  fleet_manager_email?: string;
};

export type AdminSettings = {
  unit_status_sheet_url?: string;
};

export type ChecklistItem = {
  id: string;
  item_name_th: string;
  item_name_en: string;
  vehicle_type: VehicleTypeKey;
  frequency: 'daily' | 'weekly' | 'post_route';
  sort_order: number;
};

export type AnalyticsData = {
  topFailingVehicles: Array<{ plate_number: string; fleet_id: string; inspection_count: number; fail_count: number; fail_rate: number; last_inspection_date: string | null; last_failed_date: string | null }>;
  topFailingItems: Array<{ item_name_th: string; item_name_en: string; fail_count: number }>;
  fleetStats: Array<{ fleet_id: string; total: number; passed: number; failed: number; active_vehicles: number }>;
  dailyTrend: Array<{ date: string; passed: number; failed: number }>;
  completionTrend: Array<{ date: string; inspected: number; total: number; rate: number }>;
  resolutionTrend: Array<{ period: string; avg_hours: number; count: number }>;
  summary: { totalInspections: number; passed: number; failed: number; passRate: number; openIssues: number; activeVehicles: number };
  period: { days: number | null; since: string | null; until: string | null };
};

// ─── Admin API Functions ──────────────────────────────────────────────────────

export function fetchAdminSettings() {
  return apiFetch<AdminSettings>('/api/admin/settings');
}

export function saveAdminSetting(key: string, value: string) {
  return apiFetch<{ ok: boolean }>('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify({ key, value }),
  });
}

export function fetchAdminUsers(params?: { limit?: number; offset?: number; search?: string; role?: string }) {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.search) qs.set('search', params.search);
  if (params?.role) qs.set('role', params.role);
  const q = qs.toString();
  return apiFetch<AdminUser[]>(`/api/admin/users${q ? `?${q}` : ''}`);
}

export function createAdminUser(data: {
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  role: string;
  fleetId?: string;
}) {
  return apiFetch<AdminUser>('/api/admin/users', { method: 'POST', body: JSON.stringify(data) });
}

export function updateAdminUser(id: string, data: { password?: string; firstName?: string; lastName?: string; role?: string; fleetId?: string }) {
  return apiFetch<AdminUser>(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteAdminUser(id: string) {
  return apiFetch<{ deleted: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' });
}

export type UserImportMode = 'add' | 'modify' | 'replace';
export type UserImportSummary = {
  mode: UserImportMode;
  sourceRows: number;
  skippedStruck: number;
  add: number;
  modify: number;
  deactivate: number;
  errors: string[];
};

export function importAdminUsers(file: File, mode: UserImportMode, apply = false) {
  const body = new FormData();
  body.append('file', file);
  return apiFetch<{ summary: UserImportSummary; imported?: boolean }>(`/api/admin/users/import?mode=${mode}`, {
    method: apply ? 'PUT' : 'POST',
    body,
  });
}

export function fetchAdminVehicles(params?: { limit?: number; offset?: number; search?: string; fleetId?: string }) {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.search) qs.set('search', params.search);
  if (params?.fleetId) qs.set('fleetId', params.fleetId);
  const q = qs.toString();
  return apiFetch<AdminVehicle[]>(`/api/admin/vehicles${q ? `?${q}` : ''}`);
}

export function createAdminVehicle(data: { plateNumber: string; vehicleType: string; fleetId: string; fleetManagerEmail?: string; vendorEmail?: string; taxExpiryDate?: string }) {
  return apiFetch<AdminVehicle>('/api/admin/vehicles', { method: 'POST', body: JSON.stringify(data) });
}

export function importAdminVehicles(rows: Array<{ plateNumber: string; vehicleType: string; fleetId: string; fleetManagerEmail?: string; vendorEmail?: string; taxExpiryDate?: string }>) {
  return apiFetch<{ imported: number }>('/api/admin/vehicles', { method: 'POST', body: JSON.stringify({ rows }) });
}

export function updateAdminVehicle(id: string, data: { plateNumber?: string; vehicleType?: string; fleetId?: string; fleetManagerEmail?: string; vendorEmail?: string; taxExpiryDate?: string | null }) {
  return apiFetch<AdminVehicle>(`/api/admin/vehicles/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export function notifyVendor(issueId: string) {
  return apiFetch<{ notifiedAt: string; vendorEmail: string }>(`/api/issues/${encodeURIComponent(issueId)}/notify-vendor`, { method: 'POST' });
}

export function deleteAdminVehicle(id: string) {
  return apiFetch<{ deleted: boolean }>(`/api/admin/vehicles/${id}`, { method: 'DELETE' });
}

export function fetchAdminFleets() {
  return apiFetch<AdminFleet[]>('/api/admin/fleets');
}

export function updateAdminFleet(fleetId: string, fleetManagerEmail: string) {
  return apiFetch<{ updated: boolean }>('/api/admin/fleets', {
    method: 'PUT',
    body: JSON.stringify({ fleetId, fleetManagerEmail }),
  });
}

export function importAdminFleets(rows: Array<{ fleetId: string; fleetManagerEmail?: string }>) {
  return apiFetch<{ imported: number }>('/api/admin/fleets', { method: 'PUT', body: JSON.stringify({ rows }) });
}

export function importIssues(rows: Array<{ issueId: string; status: string }>) {
  return apiFetch<{ imported: number }>('/api/issues/import', { method: 'POST', body: JSON.stringify({ rows }) });
}

export function fetchAdminChecklist(params?: { vehicleType?: string; frequency?: string }) {
  const qs = new URLSearchParams({ all: '1' });
  if (params?.vehicleType) qs.set('vehicleType', params.vehicleType);
  if (params?.frequency) qs.set('frequency', params.frequency);
  return apiFetch<ChecklistItem[]>(`/api/admin/checklist?${qs}`);
}

export function createChecklistItem(data: { itemNameTh: string; itemNameEn: string; vehicleType: string; frequency: string; sortOrder?: number }) {
  return apiFetch<ChecklistItem>('/api/admin/checklist', { method: 'POST', body: JSON.stringify(data) });
}

export function importChecklistItems(items: Array<{
  itemNameTh: string;
  itemNameEn: string;
  vehicleType: string;
  frequency: string;
  sortOrder: number;
}>) {
  return apiFetch<{ imported: number; items: ChecklistItem[] }>('/api/admin/checklist', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

export function reorderChecklistItems(items: Array<{ id: string; sortOrder: number }>) {
  return apiFetch<{ updated: number; items: Array<{ id: string; sort_order: number }> }>('/api/admin/checklist', {
    method: 'PATCH',
    body: JSON.stringify({ items }),
  });
}

export function updateChecklistItem(data: { id: string; itemNameTh?: string; itemNameEn?: string; vehicleType?: string; frequency?: string; sortOrder?: number }) {
  return apiFetch<ChecklistItem>('/api/admin/checklist', { method: 'PUT', body: JSON.stringify(data) });
}

export function deleteChecklistItem(id: string) {
  return apiFetch<{ deleted: boolean; retired?: boolean }>(`/api/admin/checklist?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function fetchAdminAnalytics(options: { days?: 7 | 30 | 90; dateStart?: string; dateEnd?: string; allTime?: boolean } = {}) {
  const params = new URLSearchParams();
  if (options.days) params.set('days', String(options.days));
  if (options.dateStart) params.set('dateStart', options.dateStart);
  if (options.dateEnd) params.set('dateEnd', options.dateEnd);
  if (options.allTime) params.set('allTime', '1');
  const query = params.toString();
  return apiFetch<AnalyticsData>(`/api/admin/analytics${query ? `?${query}` : ''}`);
}

export function updateIssueStatus(id: string, status: string, completionPhotoUrls?: string[]) {
  return apiFetch<{ ok: boolean }>(`/api/issues/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, ...(completionPhotoUrls ? { completionPhotoUrls } : {}) }),
  });
}
