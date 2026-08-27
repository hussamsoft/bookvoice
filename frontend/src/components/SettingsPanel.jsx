import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Settings } from 'lucide-react';
import { useToast } from './Toast';
import Button from './ui/Button';
import { useUserConfig } from '../hooks/useUserConfig';
import VoiceSettings from './VoiceSettings';

export default function SettingsPanel() {
    const toast = useToast();
    const { config, updateConfig } = useUserConfig();
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const panelRef = useRef(null);
    const triggerRef = useRef(null);

    const closeSettings = useCallback(() => {
        setOpen(false);
        triggerRef.current?.focus();
    }, []);

    useEffect(() => {
        if (!open) return undefined;
        const closeOnOutside = (event) => {
            if (!panelRef.current?.contains(event.target)) closeSettings();
        };
        const closeOnEscape = (event) => {
            if (event.key === 'Escape') closeSettings();
        };
        const trapFocus = (event) => {
            if (event.key !== 'Tab' || !panelRef.current) return;
            const focusable = panelRef.current.querySelectorAll(
                'button:not(:disabled), select:not(:disabled), input:not([type="disabled"]), a[href]'
            );
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('click', closeOnOutside);
        document.addEventListener('keydown', closeOnEscape);
        document.addEventListener('keydown', trapFocus);
        return () => {
            document.removeEventListener('click', closeOnOutside);
            document.removeEventListener('keydown', closeOnEscape);
            document.removeEventListener('keydown', trapFocus);
        };
    }, [open, closeSettings]);


    if (!config) {
        return (
            <button
                ref={triggerRef}
                className="icon-btn"
                aria-label="Open settings"
                aria-disabled="true"
            >
                <Settings size={16} />
            </button>
        );
    }

    const handleChange = async (key, value) => {
        setSaving(true);
        try {
            await updateConfig({ [key]: value });
        } catch (e) {
            toast.error(e?.message || 'Could not save settings');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="settings-panel-wrap" ref={panelRef}>
            <Button
                ref={triggerRef}
                variant="secondary"
                size="sm"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-label={open ? 'Close settings' : 'Open settings'}
                title="Settings"
            >
                <Settings size={16} />
            </Button>
            {open && (
                <div className="settings-dropdown">
                    <h4>Settings</h4>
                    <label className="settings-row">
                        <span>TTS device</span>
                        <select
                            value={config.tts_device || 'auto'}
                            disabled={saving}
                            onChange={(e) => handleChange('tts_device', e.target.value)}
                        >
                            <option value="auto">Auto</option>
                            <option value="cuda">CUDA (GPU)</option>
                            <option value="cpu">CPU</option>
                        </select>
                    </label>
                    <label className="settings-row">
                        <span>OCR GPU</span>
                        <input
                            type="checkbox"
                            checked={!!config.ocr_use_gpu}
                            disabled={saving}
                            onChange={(e) => handleChange('ocr_use_gpu', e.target.checked)}
                        />
                    </label>
                    <p className="settings-hint">
                        GPU settings take effect after restart. CPU mode works offline but is much
                        slower for long narration.
                    </p>
                    <VoiceSettings
                        backendReady
                        activeVoiceId={config.voice_id || null}
                        onVoiceChange={(voiceId) => handleChange('voice_id', voiceId)}
                    />
                </div>
            )}
        </div>
    );
}
