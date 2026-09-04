import Modal from './ui/Modal';

const SECTIONS = [
    {
        title: 'Reading',
        items: [
            { keys: ['Space'], label: 'Play / pause narration' },
            { keys: ['\u2190', '\u2192'], label: 'Seek \u00b110 seconds' },
            { keys: ['PageUp', 'PageDown'], label: 'Previous / next page' },
            { keys: ['Home', 'End'], label: 'First / last page' },
            { keys: ['\u2318/Ctrl', '['], label: 'Previous page (macOS)' },
            { keys: ['\u2318/Ctrl', ']'], label: 'Next page (macOS)' },
        ],
    },
    {
        title: 'Actions',
        items: [
            { keys: ['F'], label: 'Find in book' },
            { keys: ['B'], label: 'Toggle bookmark' },
            { keys: ['M'], label: 'Mute / unmute' },
        ],
    },
    {
        title: 'Help',
        items: [
            { keys: ['?'], label: 'Show this sheet' },
        ],
    },
];

function ShortcutKeys({ keys }) {
    return (
        <span className="shortcut-keys" aria-hidden="true">
            {keys.map((key, i) => (
                <span className="shortcut-keys-wrap" key={`${key}-${i}`}>
                    <kbd className="shortcut-key">{key}</kbd>
                    {i < keys.length - 1 ? <span className="shortcut-keys-plus">+</span> : null}
                </span>
            ))}
        </span>
    );
}

export default function Shortcuts({ open, onClose }) {
    return (
        <Modal
            open={open}
            onClose={onClose}
            title="Keyboard shortcuts"
            actions={[
                { label: 'Close', onClick: onClose, key: 'close' },
            ]}
        >
            <div className="shortcuts-list">
                {SECTIONS.map((section) => (
                    <section key={section.title} className="shortcuts-section">
                        <h3 className="shortcuts-section-title">{section.title}</h3>
                        <dl className="shortcuts-grid">
                            {section.items.map((item, i) => (
                                <div key={`${section.title}-${i}`} className="shortcut-row">
                                    <dt className="shortcut-label">{item.label}</dt>
                                    <dd className="shortcut-keys-cell">
                                        <ShortcutKeys keys={item.keys} />
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </section>
                ))}
            </div>
        </Modal>
    );
}
