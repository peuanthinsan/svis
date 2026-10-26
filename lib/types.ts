import type { TranslationKey } from './i18n';

export type VehicleType = 'car' | 'van' | 'e_van' | 'motorcycle' | 'e_bike' | 'light_truck' | 'six_wheel_truck';

export const VEHICLE_TYPES: readonly VehicleType[] = [
  'car', 'van', 'e_van', 'motorcycle', 'e_bike', 'light_truck', 'six_wheel_truck',
];

export type Company = {
  slug: string;
  name: string;
  shortName: string;
  primaryColor: string;
  accentColor: string;
};

export type LoginAccount = {
  username: string;
  displayName: string;
  role: 'driver' | 'supervisor' | 'admin' | 'vehicle_owner';
};

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  car: 'Pickup',
  van: 'Van',
  e_van: 'E-Van',
  motorcycle: 'Motorcycle',
  e_bike: 'E-Bike',
  light_truck: 'Light Truck',
  six_wheel_truck: '6-Wheel Truck',
};

export const VEHICLE_TYPE_I18N_KEYS: Record<VehicleType, TranslationKey> = {
  car: 'inspection.vehicleTypeCar',
  van: 'inspection.vehicleTypeVan',
  e_van: 'inspection.vehicleTypeEvan',
  motorcycle: 'inspection.vehicleTypeMotorcycle',
  e_bike: 'inspection.vehicleTypeEbike',
  light_truck: 'inspection.vehicleTypeLightTruck',
  six_wheel_truck: 'inspection.vehicleTypeSixWheelTruck',
};

export function vehicleTypeLabel(vehicleType: string): string {
  return VEHICLE_TYPE_LABELS[vehicleType as VehicleType] ?? vehicleType;
}
export type InspectionFrequency = 'daily' | 'weekly' | 'post_route';
export type InspectionStatus = 'pass' | 'fail';
export type IssueStatus = 'open' | 'in_progress' | 'completed';
export type Vehicle = {
  id: string;
  plate_number: string;
  vehicle_type: VehicleType;
  fleet_id: string;
  fleet_manager_email: string | null;
  is_active?: boolean;
};

export type ChecklistSection =
  | 'front'
  | 'rear'
  | 'sides'
  | 'top'
  | 'underbody'
  | 'cabin'
  | 'cargo'
  | 'documents'
  | 'supplies';

export type InspectionZone = 'front' | 'cabin' | 'cargo_supplies' | 'exterior_tires';

export const ZONE_SECTIONS: Record<InspectionZone, ChecklistSection[]> = {
  front: ['front'],
  cabin: ['cabin', 'rear'],
  cargo_supplies: ['cargo', 'documents', 'supplies'],
  exterior_tires: ['sides', 'top', 'underbody'],
};

export type ChecklistItem = {
  id: string;
  vehicle_type: VehicleType;
  frequency: InspectionFrequency;
  item_name_th: string;
  item_name_en: string;
  sort_order: number;
  section: ChecklistSection;
};

export type InspectionLog = {
  id: string;
  vehicle_id: string;
  inspector_id: string;
  inspector_name: string;
  fleet_id: string;
  inspection_date: string;
  overall_status: InspectionStatus;
  photo_urls: string[];
  notes: string;
  mileage: number | null;
  odometer_photo_url: string | null;
  created_at: string;
};

export type IssueReport = {
  id: string;
  inspection_id: string;
  vehicle_id: string;
  fleet_id: string;
  status: IssueStatus;
  defect_photo_urls: string[];
  completion_photo_urls: string[];
  created_at: string;
  updated_at: string;
};

export type User = {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  role: 'driver' | 'supervisor' | 'admin' | 'vehicle_owner';
  fleet_id: string;
  company_id: string;
  created_at: string;
};
