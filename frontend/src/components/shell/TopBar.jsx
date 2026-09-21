import { Moon, Sun } from 'lucide-react';

/**
 * Slim top bar over the workspace: where you are, one honest engine status,
 * and the quick theme toggle. Everything else lives in the Settings view.
 */
export default function TopBar({ title, engineStatus, theme, onThemeToggle }) {
    // F-35: the icon/label track the mode actually showing (effective),
    // not the stored choice — which may be 'system'.
    const dark = theme.effectiveMode === 'dark';
    // F-23/F-24: not a <header> (App already wraps this in the page banner —
    // nested headers both map to role=banner), and the title is a label, not
    // a document heading — each view renders its own h1.
    return (
        <div className="topbar">
            <div className="topbar-title">{title}</div>
            <div className="topbar-tools">
                <span
                    className={`engine-chip ${engineStatus.tone}`}
                    role="status"
                    title={engineStatus.detail}
                >
                    <span className="engine-chip-dot" aria-hidden="true" />
                    {engineStatus.label}
                    {/* F-28: detail was tooltip-only — hover is unreachable
                        for keyboard and touch users. */}
                    {engineStatus.detail ? (
                        <span className="engine-chip-detail">{engineStatus.detail}</span>
                    ) : null}
                </span>
                <button
                    type="button"
                    className="icon-btn theme-toggle"
                    onClick={onThemeToggle}
                    aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                    title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                >
                    {dark ? <Sun size={16} /> : <Moon size={16} />}
                </button>
            </div>
        </div>
    );
}
