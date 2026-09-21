/* eslint-disable react/only-export-components */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

// Dedupe key is `${type}:${message}` — an identical toast fired within this
// window updates the existing entry instead of stacking a duplicate.
const COALESCE_MS = 2000;
// Exit animation length; must match the .toast-leaving transition in shell.css.
const EXIT_MS = 160;

let toastId = 0;
const TOAST_ID_EPOCH = Date.now();
const nextToastId = () => TOAST_ID_EPOCH + (++toastId);

export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);
    // Synchronous mirror of state so add/dismiss decisions never read stale
    // closures and the setState updater stays pure.
    const toastsRef = useRef(toasts);
    const timersRef = useRef(new Map());
    // F-26: pause-on-hover/focus bookkeeping. `expiresAt` per toast lets a
    // resumed timer fire at the right wall-clock time (WCAG 2.2.1).
    const expiresRef = useRef(new Map());
    const pausedRef = useRef(false);
    const politeRegionRef = useRef(null);
    const errorRegionRef = useRef(null);

    const commit = useCallback((next) => {
        toastsRef.current = next;
        setToasts(next);
    }, []);

    // Unmount cleanup: cancel any pending auto-dismiss / exit timers so they
    // don't fire after the provider is gone.
    useEffect(() => () => {
        timersRef.current.forEach((timer) => clearTimeout(timer));
        timersRef.current.clear();
    }, []);

    // First phase of dismissal: flag the exit transition, drop after it plays.
    const remove = useCallback(
        (id) => {
            clearTimeout(timersRef.current.get(id));
            timersRef.current.delete(id);
            expiresRef.current.delete(id);
            // F-26: if focus is inside the toast being dropped it would fall
            // to <body> — park it on the region that hosted it instead.
            const host = document.querySelector(`[data-toast-id="${id}"]`);
            const hadFocus = Boolean(host && host.contains(document.activeElement));
            const isError = toastsRef.current.find((t) => t.id === id)?.type === 'error';
            commit(toastsRef.current.filter((t) => t.id !== id));
            if (hadFocus) {
                const region = isError ? errorRegionRef.current : politeRegionRef.current;
                region?.focus();
            }
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
        (id, duration, type = 'info') => {
            clearTimeout(timersRef.current.get(id));
            timersRef.current.delete(id);
            // F-26: errors are important — never auto-dismiss them.
            if (type === 'error' || duration == null) {
                expiresRef.current.delete(id);
                return;
            }
            expiresRef.current.set(id, Date.now() + duration);
            if (pausedRef.current) return; // resumed by resumeAll()
            timersRef.current.set(id, setTimeout(() => beginExit(id), duration));
        },
        [beginExit]
    );

    // F-26: hovering or focusing a region pauses every pending auto-dismiss;
    // leaving resumes with the remaining time.
    const pauseAll = useCallback(() => {
        pausedRef.current = true;
        timersRef.current.forEach((timer) => clearTimeout(timer));
        timersRef.current.clear();
    }, []);
    const resumeAll = useCallback(() => {
        pausedRef.current = false;
        const now = Date.now();
        expiresRef.current.forEach((expiresAt, id) => {
            if (timersRef.current.has(id)) return;
            const remaining = Math.max(expiresAt - now, 500);
            timersRef.current.set(id, setTimeout(() => beginExit(id), remaining));
        });
    }, [beginExit]);

    const push = useCallback(
        (message, type = 'info', duration = 4000) => {
            const next = { id: nextToastId(), message, type, leaving: false };
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
                timersRef.current.delete(existing.id);
                scheduleAutoDismiss(existing.id, duration, type);
                return existing.id;
            }
            next.bornAt = now;
            commit([...toastsRef.current, next]);
            scheduleAutoDismiss(next.id, duration, type);
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
        success: CheckCircle2,
        error: AlertCircle,
    };

    // F-26: individual toasts are plain nodes. Live semantics belong to the
    // PERSISTENT regions below — screen readers announce mutations inside an
    // existing live region reliably; nodes inserted already carrying their
    // content and role (the old per-toast role="alert"/"status") are not
    // announced consistently by NVDA/JAWS.
    const renderToast = ({ id, message, type, leaving }) => {
        const Icon = icons[type];
        return (
            <div
                key={id}
                data-toast-id={id}
                className={`toast toast-${type}${leaving ? ' toast-leaving' : ''}`}
            >
                <Icon size={18} className="toast-icon" aria-hidden="true" />
                <span className="toast-message">{message}</span>
                <button
                    type="button"
                    className="toast-dismiss"
                    onClick={() => dismiss(id)}
                    aria-label="Dismiss notification"
                >
                    <X size={16} aria-hidden="true" />
                </button>
            </div>
        );
    };

    const regionHandlers = {
        onMouseEnter: pauseAll,
        onMouseLeave: resumeAll,
        onFocus: pauseAll,
        onBlur: resumeAll,
    };

    return (
        <ToastContext.Provider value={toast}>
            {children}
            {/* F-26: one presentational stack so the two persistent live
                regions can never overlap each other on screen. */}
            <div className="toast-stack">
                <div
                    className="toast-region"
                    role="region"
                    aria-label="Notifications"
                    aria-live="polite"
                    ref={politeRegionRef}
                    tabIndex={-1}
                    {...regionHandlers}
                >
                    {toasts.filter((t) => t.type !== 'error').map(renderToast)}
                </div>
                <div
                    className="toast-region toast-region-error"
                    role="region"
                    aria-label="Errors"
                    aria-live="assertive"
                    ref={errorRegionRef}
                    tabIndex={-1}
                    {...regionHandlers}
                >
                    {toasts.filter((t) => t.type === 'error').map(renderToast)}
                </div>
            </div>
        </ToastContext.Provider>
    );
}

let warnedMissingProvider = false;
export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) {
        // F-26: a missing provider used to be a silent swallow.
        if (!warnedMissingProvider && import.meta.env?.DEV) {
            warnedMissingProvider = true;
            // eslint-disable-next-line no-console
            console.warn('useToast(): no <ToastProvider> ancestor — toasts will be dropped.');
        }
        return { notify: () => {}, info: () => {}, success: () => {}, error: () => {}, dismiss: () => {} };
    }
    return ctx;
}

export { COALESCE_MS, EXIT_MS };
