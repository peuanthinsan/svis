import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { brand } from '../branding';
import { useAuth } from '../AuthContext';
import { getLang, setLang, t } from '../i18n';

type NavIconName = 'dashboard' | 'export' | 'inspections' | 'issues' | 'history' | 'checklist' | 'admin';

function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<NavIconName, ReactNode> = {
    dashboard: <path d="M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z" />,
    export: <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14" />,
    inspections: <path d="M9 5h6m-7 3h8M7 3h10a2 2 0 0 1 2 2v16H5V5a2 2 0 0 1 2-2Zm1 10 2 2 4-4m-6 8h8" />,
    issues: <path d="M12 3 2.7 19h18.6L12 3Zm0 5.5v4.8m0 3.2v.1" />,
    history: <path d="M12 4a8 8 0 1 1-7.1 4.3M4 4v4.3h4.3M12 8v4.6l3 1.8" />,
    checklist: <path d="M9 4h6m-7 3h8m-8 4h8m-8 4h5M6 2h12a2 2 0 0 1 2 2v16H4V4a2 2 0 0 1 2-2Z" />,
    admin: <path d="M9.4 4.1 10 2h4l.6 2.1 1.5.9 2.1-.5 2 3.5-1.5 1.6v1.8l1.5 1.6-2 3.5-2.1-.5-1.5.9L14 20h-4l-.6-2.1-1.5-.9-2.1.5-2-3.5 1.5-1.6v-1.8L3.8 9l2-3.5 2.1.5 1.5-.9ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />,
  };

  return (
    <svg className="tabs__icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function Layout() {
  const { user, signOut } = useAuth();
  const lang = getLang();

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar__inner">
          <div className="topbar__brand">
            <img className="topbar__logo" src={`${import.meta.env.BASE_URL}logo.svg`} alt="Songdee VIS" />
            <div className="topbar__brand-copy">
              <div className="topbar__title">{brand.appName}</div>
              <div className="topbar__subtitle">{brand.productName}</div>
            </div>
          </div>
          <div className="topbar__actions">
            {user && <span className="company-pill">{user.companyName}</span>}
            <button
              type="button"
              className="lang-btn"
              aria-label={t('language')}
              onClick={() => {
                setLang(lang === 'th' ? 'en' : 'th');
                window.location.reload();
              }}
            >
              {lang === 'th' ? 'EN' : 'TH'}
            </button>
            {user && (
              <div className="topbar__user">
                <span className="user-avatar" aria-hidden="true">{user.firstName.slice(0, 1).toUpperCase()}</span>
                <span className="user-summary">
                  <strong>{user.firstName}</strong>
                  <small>{t(user.role)}</small>
                </span>
                <button type="button" className="link-btn" onClick={signOut}>
                  {t('logout')}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="tabs" aria-label={t('dashboard')}>
        <div className="tabs__inner">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'tabs__link tabs__link--active' : 'tabs__link')}>
            <NavIcon name="dashboard" />
            {t('dashboard')}
          </NavLink>
          <NavLink to="/export" className={({ isActive }) => (isActive ? 'tabs__link tabs__link--active' : 'tabs__link')}>
            <NavIcon name="export" />
            {t('export')}
          </NavLink>
          <NavLink to="/inspections" className={({ isActive }) => (isActive ? 'tabs__link tabs__link--active' : 'tabs__link')}>
            <NavIcon name="inspections" />
            {t('inspections')}
          </NavLink>
          <NavLink to="/issues" className={({ isActive }) => (isActive ? 'tabs__link tabs__link--active' : 'tabs__link')}>
            <NavIcon name="issues" />
            {t('issues')}
          </NavLink>
          <NavLink to="/history" className={({ isActive }) => (isActive ? 'tabs__link tabs__link--active' : 'tabs__link')}>
            <NavIcon name="history" />
            {t('history')}
          </NavLink>
          {user?.role === 'admin' && (
            <NavLink to="/checklist" className={({ isActive }) => (isActive ? 'tabs__link tabs__link--active' : 'tabs__link')}>
              <NavIcon name="checklist" />
              {t('adminChecklist')}
            </NavLink>
          )}
          {(user?.role === 'admin' || user?.role === 'supervisor') && (
            <NavLink to="/admin" className={({ isActive }) => (isActive ? 'tabs__link tabs__link--active' : 'tabs__link')}>
              <NavIcon name="admin" />
              {t('admin')}
            </NavLink>
          )}
        </div>
      </nav>

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
