import React from 'react';
import Modal from '../ui/Modal';

/**
 * Ask whether to continue the narrated page or read the visible one.
 * Rendered through the shared Modal so focus, Escape, and screen-reader
 * semantics are handled once for every dialog in the app.
 */
export default function ResumeDialog({ open, audioPage, pageNumber, onResume, onStartFresh, onDismiss }) {
    return (
        <Modal
            open={open}
            onClose={onDismiss}
            title="Resume or start new?"
            actions={[
                {
                    label: `Read Page ${pageNumber}`,
                    onClick: onStartFresh,
                    variant: 'primary',
                    key: 'fresh',
                },
                {
                    label: `Resume Page ${audioPage}`,
                    onClick: onResume,
                    key: 'resume',
                },
            ]}
        >
            <p className="hint">
                You have narration audio for <strong>Page {audioPage}</strong>.
            </p>
        </Modal>
    );
}
