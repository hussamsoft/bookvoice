import React, { createContext, useCallback, useContext, useState } from 'react';
import { AlertCircle, CheckCircle, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

let toastId = 0;

export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);

    const dismiss = useCallback((id) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const addToast = useCallback((message, type = 'info', duration = 5000) => {
        const id = ++toastId;
        setToasts((prev) => [...prev, { id, message, type }]);

        if (duration > 0) {
            setTimeout(() => dismiss(id), duration);
        }

        return id;
    }, [dismiss]);

    const toast = {
        info: (msg) => addToast(msg, 'info'),
        success: (msg) => addToast(msg, 'success'),
        error: (msg) => addToast(msg, 'error', 7000),
    };

    const icons = {
        info: Info,
        success: CheckCircle,
        error: AlertCircle,
    };

    return (
        <ToastContext.Provider value={toast}>
            {children}
            <div className="toast-container" aria-live="polite">
                {toasts.map(({ id, message, type }) => {
                    const Icon = icons[type];
                    return (
                        <div key={id} className={`toast toast-${type}`} role="alert">
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
