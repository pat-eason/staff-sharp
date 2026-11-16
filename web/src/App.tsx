import clsx from 'clsx';
import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useMeta } from './hooks';
import { useAppearance } from './theme';
import Briefing from './views/Briefing';
import Builder from './views/Builder';
import Insights from './views/Insights';
import Library from './views/Library';
import ProfilePage from './views/Profile';
import Welcome from './views/Welcome';
import RegimentPage from './views/Regiment';
import Regiments from './views/Regiments';
import SettingsPage from './views/Settings';

// The session runner carries the diagram editor and code views: load it on demand.
const SessionPage = lazy(() => import('./views/Session'));

const NAV = [
  { to: '/', label: 'Briefing', icon: 'M3 12l9-8 9 8M5 10v10h14V10' },
  { to: '/regiments', label: 'Regiments', icon: 'M4 6h16M4 12h16M4 18h10' },
  { to: '/regiments/new', label: 'Build', icon: 'M12 5v14M5 12h14' },
  { to: '/library', label: 'Library', icon: 'M5 4h4v16H5zM10 4h4v16h-4zM15.5 4.5l3.8 1 -3.9 15 -3.8-1z' },
  { to: '/insights', label: 'Insights', icon: 'M4 19V10M10 19V5M16 19v-7M22 19H2' },
  { to: '/profile', label: 'Profile', icon: 'M12 3l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 16.8 6.4 20.2l1.5-6.3L3 9.7l6.4-.5z' },
  { to: '/settings', label: 'Settings', icon: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1' },
];

function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const { resolved, setTheme } = useAppearance();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="btn sm ghost theme-toggle" data-mode={resolved} onClick={(e) => setTheme(next, e.currentTarget)}
      aria-label={`Switch to ${next} mode`} data-tip={collapsed ? `${next === 'light' ? 'Light' : 'Dark'} mode` : undefined} data-tip-side="right">
      {/* both glyphs stay mounted so they can rotate and fade between each other */}
      <span className="theme-icon" aria-hidden>
        <svg className="icon-sun" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 7a5 5 0 100 10 5 5 0 000-10z" />
        </svg>
        <svg className="icon-moon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" />
        </svg>
      </span>
      <span key={next} className="nav-label theme-label">{next === 'light' ? 'Light mode' : 'Dark mode'}</span>
    </button>
  );
}

const COLLAPSE_KEY = 'staff-sharp.sidebar-collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false; // storage blocked: start expanded
  }
}

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const meta = useMeta().data;
  return (
    <aside className="sidebar">
      <button type="button" className="collapse-btn" onClick={onToggle} aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} data-tip={collapsed ? 'Expand navigation' : 'Collapse navigation'} data-tip-side="right">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d={collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} />
        </svg>
      </button>
      <Link to="/" className="brand">
        <span className="brand-mark" aria-hidden>
          <svg width="22" height="22" viewBox="0 0 24 24"><path d="M12 5v7l4 3" fill="none" stroke="#fefffa" strokeWidth="2.2" strokeLinecap="round" /><circle cx="12" cy="12" r="1.8" fill="#d23a00" /></svg>
        </span>
        <span className="brand-name">Staff Sharp<small>Stay sharp at staff+</small></span>
      </Link>
      <nav className="nav" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/' || n.to === '/regiments'} data-tip={collapsed ? n.label : undefined} data-tip-side="right" aria-label={collapsed ? n.label : undefined}>
            <span className="nav-dot" />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" aria-hidden><path d={n.icon} /></svg>
            <span className="nav-label">{n.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-foot">
        <ThemeToggle collapsed={collapsed} />
        <div className="small faint nav-label">{meta ? `${meta.bank.total} questions · ${meta.taxonomy.domains.length} domains` : ''}</div>
        <div className="small faint nav-label">
          Model: {meta ? { off: 'none (offline)', api_key: 'API key', claude_code: 'Claude subscription' }[meta.llm.provider] : '…'}
          {meta && meta.llm.provider !== 'off' && !meta.llm.active && ' (not configured)'}
        </div>
      </div>
    </aside>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="glass empty stack" style={{ alignItems: 'center' }}>
        <h2>Something broke on this page</h2>
        <p className="muted">{this.state.error.message}</p>
        <div className="row">
          <button type="button" className="btn primary" onClick={() => this.setState({ error: null })}>Try again</button>
          <Link to="/" className="btn light">Back to the briefing</Link>
        </div>
      </div>
    );
  }
}

function Routed() {
  const loc = useLocation();
  return (
    <main className="main">
      <ErrorBoundary resetKey={loc.pathname}>
        <Suspense fallback={<div className="empty"><span className="spinner" role="status" aria-label="Loading" /></div>}>
        <Routes>
          <Route path="/" element={<Briefing />} />
          <Route path="/welcome" element={<Welcome />} />
          <Route path="/regiments" element={<Regiments />} />
          <Route path="/regiments/new" element={<Builder />} />
          <Route path="/regiments/:id" element={<RegimentPage />} />
          <Route path="/sessions/:id" element={<SessionPage />} />
          <Route path="/library" element={<Library />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<div className="glass empty">Not found. <Link to="/">Back to the briefing</Link></div>} />
        </Routes>
        </Suspense>
      </ErrorBoundary>
    </main>
  );
}

export default function App() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* storage blocked: the choice lasts for this visit only */
      }
      return !c;
    });
  return (
    <BrowserRouter>
      <div className={clsx('shell', collapsed && 'collapsed')}>
        <Sidebar collapsed={collapsed} onToggle={toggle} />
        <Routed />
      </div>
    </BrowserRouter>
  );
}
