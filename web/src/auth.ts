export type Role = 'driver' | 'supervisor' | 'admin' | 'vehicle_owner';

export type User = {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  role: Role;
  fleetId: string;
  companyId: string;
  companySlug: string;
  companyName: string;
  primaryColor: string;
  accentColor: string;
};

const TOKEN_KEY = 'svis_dashboard_token';
const USER_KEY = 'svis_dashboard_user';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function saveSession(token: string, user: User) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function canAccessDashboard(role: Role) {
  return role === 'supervisor' || role === 'admin' || role === 'vehicle_owner';
}
