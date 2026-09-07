import { Moon, Sun } from 'lucide-react';

/**
 * Slim top bar over the workspace: where you are, one honest engine status,
 * and the quick theme toggle. Everything else lives in the Settings view.
 */
export default function TopBar({ title, engineStatus, theme, onThemeToggle }) {
    const dark = theme.mode === 'dark';
    return (
        <header className="topbar">
            <h2 className="topbar-title">{title}</h2>
            <div className="topbar-tools">
                <span
                    className={`engine-chip ${engineStatus.tone}`}
                    role="status"
                    title={engineStatus.detail}
                >
                    <span className="engine-chip-dot" aria-hidden="true" />
                    {engineStatus.label}
                </span>
                <button
                    type="button"
                    className="icon-btn theme-toggle"
                    onClick={onThemeToggle}
                    aria-label={dark ? 'Use light mode' : 'Use dark mode'}
                    title={dark ? 'Use light mode' : 'Use dark mode'}
                >
                    {dark ? <Sun size={16} /> : <Moon size={16} />}
                </button>
            </div>
        </header>
    );
}
