import React, { useCallback, useRef } from 'react';

/**
 * Tab list with roving tabindex and arrow-key navigation per WAI-ARIA.
 * `tabs` is [{ id, label, hint?, icon? }]; panels are rendered by the caller
 * with role="tabpanel" and id={`${idBase}-${tab.id}-panel`}.
 */
export default function Tabs({ tabs, active, onChange, idBase, ariaLabel, className = '' }) {
    const listRef = useRef(null);

    const move = useCallback(
        (from, delta) => {
            const index = tabs.findIndex((tab) => tab.id === from);
            if (index === -1) return;
            const next = (index + delta + tabs.length) % tabs.length;
            onChange(tabs[next].id);
            const buttons = listRef.current?.querySelectorAll('[role="tab"]');
            buttons?.[next]?.focus();
        },
        [tabs, onChange]
    );

    const handleKeyDown = (event, currentId) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            move(currentId, 1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            move(currentId, -1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            onChange(tabs[0].id);
            listRef.current?.querySelector('[role="tab"]')?.focus();
        } else if (event.key === 'End') {
            event.preventDefault();
            const last = tabs[tabs.length - 1];
            onChange(last.id);
            const buttons = listRef.current?.querySelectorAll('[role="tab"]');
            buttons?.[buttons.length - 1]?.focus();
        }
    };

    return (
        <div ref={listRef} role="tablist" aria-label={ariaLabel} className={className}>
            {tabs.map(({ id, label, hint, icon: Icon }) => (
                <button
                    key={id}
                    type="button"
                    role="tab"
                    id={`${idBase}-${id}-tab`}
                    aria-selected={active === id}
                    aria-controls={`${idBase}-${id}-panel`}
                    tabIndex={active === id ? 0 : -1}
                    onClick={() => onChange(id)}
                    onKeyDown={(event) => handleKeyDown(event, id)}
                >
                    {Icon ? <Icon size={17} aria-hidden="true" /> : null}
                    <span>
                        {label}
                        {hint ? <small>{hint}</small> : null}
                    </span>
                </button>
            ))}
        </div>
    );
}
