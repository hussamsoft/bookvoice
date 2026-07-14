import React, { useEffect, useRef, useState } from 'react';
import { Settings } from 'lucide-react';
import { useToast } from './Toast';
import { useUserConfig } from '../hooks/useUserConfig';
import VoiceSettings from './VoiceSettings';

export default function SettingsPanel() {
    const toast = useToast();
    const { config, updateConfig } = useUserConfig();
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const panelRef = useRef(null);

    useEffect(() => {
        if (!open) return undefined;
        const closeOnOutside = (event) => {
            if (!panelRef.current?.contains(event.target)) setOpen(false);
        };
        const closeOnEscape = (event) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', closeOnOutside);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('pointerdown', closeOnOutside);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [open]);

    if (!config) return null;

    const handleChange = async (key, value) => {
        setSaving(true);
        try {
            await updateConfig({ [key]: value });
            toast.success('Settings saved');
        } catch (e) {
            toast.error(e?.message || 'Could not save settings');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="settings-panel-wrap" ref={panelRef}>
            <button
                className="btn secondary btn-compact"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-label="Open settings"
                title="Settings"
            >
                <Settings size={16} />
            </button>
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
