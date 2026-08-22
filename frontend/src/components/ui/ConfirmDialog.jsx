import React from 'react';
import Modal from './Modal';

/**
 * Confirmation dialog replacing scattered window.confirm() calls. Destructive
 * intents pass confirmVariant="danger" so the action reads as destructive.
 */
export default function ConfirmDialog({
    open,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    confirmVariant = 'primary',
    onConfirm,
    onCancel,
}) {
    return (
        <Modal
            open={open}
            onClose={onCancel}
            title={title}
            actions={[
                { label: cancelLabel, onClick: onCancel, key: 'cancel' },
                { label: confirmLabel, onClick: onConfirm, variant: confirmVariant, key: 'confirm' },
            ]}
        >
            {message ? <p className="hint">{message}</p> : null}
        </Modal>
    );
}
