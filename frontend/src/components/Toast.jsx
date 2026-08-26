/* eslint-disable react/only-export-components */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
            if (duration > 0) {
                timersRef.current.set(id, setTimeout(() => beginExit(id), duration));
            }
        },
        [beginExit]
    );

    const addToast = useCallback(
        (message, type = 'info', duration = 5000) => {
            const now = Date.now();
            const existing = toastsRef.current.find(
                (t) =>
                    !t.leaving &&
                    t.type === type &&
                    t.message === message &&
                    now - t.timestamp < COALESCE_MS
            );
            if (existing) {
                // Bump the timestamp: restarts both the dedupe window and the
                // auto-dismiss clock instead of stacking a second entry.
                commit(
                    toastsRef.current.map((t) => (t.id === existing.id ? { ...t, timestamp: now } : t))
                );
                scheduleAutoDismiss(existing.id, duration);
                return existing.id;
            }
            const id = ++toastId;
            commit([...toastsRef.current, { id, message, type, timestamp: now }]);
            scheduleAutoDismiss(id, duration);
            return id;
        },
        [commit, scheduleAutoDismiss]
    );

    useEffect(
        () => () => {
            for (const timer of timersRef.current.values()) clearTimeout(timer);
            timersRef.current.clear();
        },
        []
    );

    // Stable identity: consumers key effects on this object, so a new toast
    // must never re-create it (a fresh value re-ran library fetches and
    // polling loops on every notification).
    const toast = useMemo(
        () => ({
            info: (msg) => addToast(msg, 'info'),
            success: (msg) => addToast(msg, 'success'),
            error: (msg) => addToast(msg, 'error', 7000),
        }),
        [addToast]
    );

    const icons = {
        info: Info,
        success: CheckCircle,
        error: AlertCircle,
    };

    return (
        <ToastContext.Provider value={toast}>
            {children}
            <div className="toast-container" aria-live="polite">
                {toasts.map(({ id, message, type, leaving }) => {
                    const Icon = icons[type];
                    return (
                        <div
                            key={id}
                            className={`toast toast-${type}${leaving ? ' toast-leaving' : ''}`}
                            role="alert"
                        >
                            <Icon size={18} className="toast-icon" />
                            <span className="toast-message">{message}</span>
                            <button
                                className="toast-dismiss"
                                onClick={() => dismiss(id)}
                                aria-label="Dismiss"
                            >
                                <X size={16} />
                            </button>
                        </div>
                    );
                })}
            </div>
        </ToastContext.Provider>
    );
}

export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error('useToast must be used within ToastProvider');
    return ctx;
}
