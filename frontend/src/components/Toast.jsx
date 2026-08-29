/* eslint-disable react/only-export-components */
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

// Dedupe key is `${type}:${message}` — an identical toast fired within this
// window updates the existing entry instead of stacking a duplicate.
const COALESCE_MS = 2000;
// Exit animation length; must match the .toast-leaving transition in shell.css.
const EXIT_MS = 160;

let toastId = 0;

export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);
    // Synchronous mirror of state so add/dismiss decisions never read stale
    // closures and the setState updater stays pure.
    const toastsRef = useRef(toasts);
    const timersRef = useRef(new Map());

    const commit = useCallback((next) => {
        toastsRef.current = next;
        setToasts(next);
    }, []);


    // First phase of dismissal: flag the exit transition, drop after it plays.
    const remove = useCallback(
        (id) => {
            clearTimeout(timersRef.current.get(id));
            timersRef.current.delete(id);
            commit(toastsRef.current.filter((t) => t.id !== id));
        },
        [commit]
    );


    // Flag the exit animation; the node drops once the transition plays.
    const beginExit = useCallback(
        (id) => {
            const current = toastsRef.current.find((t) => t.id === id);
            if (!current || current.leaving) return;
            commit(toastsRef.current.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
            timersRef.current.set(id, setTimeout(() => remove(id), EXIT_MS));
        },
        [commit, remove]
    );
    const dismiss = useCallback((id) => beginExit(id), [beginExit]);

    const scheduleAutoDismiss = useCallback(
        (id, duration) => {
            clearTimeout(timersRef.current.get(id));
            timersRef.current.set(id, setTimeout(() => beginExit(id), duration));
        },
        [beginExit]
    );

    const push = useCallback(
        (message, type = 'info', duration = 4000) => {
            const next = { id: toastId++, message, type, leaving: false };
            const dupKey = `${type}:${message}`;
            const now = Date.now();
            const existing = toastsRef.current.find(
                (t) => `${t.type}:${t.message}` === dupKey && now - (t.bornAt || now) < COALESCE_MS
            );
            if (existing) {
                const freshToasts = toastsRef.current.map((t) =>
                    t.id === existing.id ? { ...t, bornAt: now, leaving: false } : t
                );
                commit(freshToasts);
                clearTimeout(timersRef.current.get(existing.id));
                scheduleAutoDismiss(existing.id, duration);
                return existing.id;
            }
            next.bornAt = now;
            commit([...toastsRef.current, next]);
            scheduleAutoDismiss(next.id, duration);
            return next.id;
        },
        [commit, scheduleAutoDismiss]
    );

    const toast = useMemo(
        () => ({
            notify: push,
            info: (message, duration) => push(message, 'info', duration),
            success: (message, duration) => push(message, 'success', duration),
            error: (message, duration) => push(message, 'error', duration),
            dismiss,
        }),
        [push, dismiss]
    );

    const icons = {
        info: Info,
        success: CheckCircle,
        error: AlertCircle,
    };

    const renderToast = ({ id, message, type, leaving }) => {
        const Icon = icons[type];
        const isUrgent = type === 'error';
        return (
            <div
                key={id}
                className={`toast toast-${type}${leaving ? ' toast-leaving' : ''}`}
                role={isUrgent ? 'alert' : 'status'}
                aria-live={isUrgent ? 'assertive' : 'polite'}
            >
                <Icon size={18} className="toast-icon" aria-hidden="true" />
                <span className="toast-message">{message}</span>
                <button
                    className="toast-dismiss"
                    onClick={() => dismiss(id)}
                    aria-label="Dismiss"
                >
                    <X size={16} aria-hidden="true" />
                </button>
            </div>
        );
    };

    return (
        <ToastContext.Provider value={toast}>
            {children}
            <div className="toast-region" aria-label="Notifications">
                {toasts.map(renderToast)}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast() {
    const ctx = useContext(ToastContext);
    return ctx || { notify: () => {}, info: () => {}, success: () => {}, error: () => {}, dismiss: () => {} };
}

export { COALESCE_MS, EXIT_MS };
