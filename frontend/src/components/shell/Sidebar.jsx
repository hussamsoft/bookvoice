import { Home, Library, ScanLine, AudioWaveform, Settings } from 'lucide-react';

const NAV_GROUPS = [
    {
        label: 'Listen',
        items: [
            { view: 'home', label: 'Home', icon: Home, hint: 'Continue reading and quick actions' },
            { view: 'library', label: 'Library', icon: Library, hint: 'Your books' },
        ],
    },
    {
        label: 'Create',
        items: [
            { view: 'scan', label: 'Scan', icon: ScanLine, hint: 'Capture physical book pages with your camera' },
            { view: 'studio', label: 'Studio', icon: AudioWaveform, hint: 'Create voices, narrations, and repairs' },
        ],
    },
];

/**
 * The app's left navigation rail (bottom bar on narrow screens via CSS).
 */
export default function Sidebar({ view, onNavigate }) {
    return (
        <div className="sidebar">
            <div className="sidebar-brand">
                <img src="/bookvoice.png" alt="" width="28" height="28" />
                <span className="sidebar-brand-name">BookVoice</span>
            </div>
            <nav className="sidebar-nav" aria-label="Main">
                {NAV_GROUPS.map((group) => (
                    <div className="sidebar-nav-group" key={group.label}>
                        <span className="sidebar-nav-group-label">{group.label}</span>
                        {group.items.map(({ view: itemView, label, icon: Icon, hint }) => {
                            const active = view === itemView;
                            return (
                                <button
                                    key={itemView}
                                    type="button"
                                    className={`sidebar-item ${active ? 'is-active' : ''}`}
                                    aria-current={active ? 'page' : undefined}
                                    title={hint}
                                    onClick={() => onNavigate(itemView)}
                                >
                                    <Icon size={20} aria-hidden="true" />
                                    <span className="sidebar-item-label">{label}</span>
                                </button>
                            );
                        })}
                    </div>
                ))}
            </nav>
            {/* F-42: a nav control outside every navigation landmark was
                invisible to landmark-based navigation — own labelled nav. */}
            <nav className="sidebar-footer" aria-label="Secondary">
                <button
                    type="button"
                    className={`sidebar-item ${view === 'settings' ? 'is-active' : ''}`}
                    aria-current={view === 'settings' ? 'page' : undefined}
                    title="Appearance, narration, and connections"
                    onClick={() => onNavigate('settings')}
                >
                    <Settings size={20} aria-hidden="true" />
                    <span className="sidebar-item-label">Settings</span>
                </button>
            </nav>
        </div>
    );
}
