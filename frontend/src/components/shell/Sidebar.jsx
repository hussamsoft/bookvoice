import { Home, Library, ScanLine, AudioWaveform } from 'lucide-react';

const NAV_ITEMS = [
    { view: 'home', label: 'Home', icon: Home, hint: 'Continue reading and quick actions' },
    { view: 'library', label: 'Library', icon: Library, hint: 'Your books' },
    { view: 'scan', label: 'Scan', icon: ScanLine, hint: 'Capture physical book pages with your camera' },
    { view: 'studio', label: 'Studio', icon: AudioWaveform, hint: 'Create voices, narrations, and repairs' },
];

/**
 * The app's left navigation rail (bottom bar on narrow screens via CSS).
 * Reading is not a nav destination: books are opened from Home or Library
 * and the reader always offers a way back.
 */
export default function Sidebar({ view, onNavigate }) {
    return (
        <div className="sidebar">
            <div className="sidebar-brand">
                <img src="/bookvoice.png" alt="" width="28" height="28" />
                <span className="sidebar-brand-name">BookVoice</span>
            </div>
            <nav className="sidebar-nav" aria-label="Main">
                {NAV_ITEMS.map(({ view: itemView, label, icon: Icon, hint }) => {
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
            </nav>
        </div>
    );
}
