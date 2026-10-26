import { useAuth } from './auth-context';
import type { UserRole } from './auth-context';

export function useRole() {
  const { user } = useAuth();
  const role = (user?.role || 'driver') as UserRole;
  const fleetId = user?.fleetId || '';

  return {
    role,
    fleetId,
    isDriver: role === 'driver',
    isSupervisor: role === 'supervisor',
    isAdmin: role === 'admin',
    isVehicleOwner: role === 'vehicle_owner',
  };
}
