import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, MonitorSmartphone } from 'lucide-react';
import Button from '../ui/Button';
import { useToast } from '../Toast';
import { useUserConfig } from '../../hooks/useUserConfig';
import { useTheme, PALETTES, getSwatchColor } from '../../hooks/useTheme';
import { getServerAddresses } from '../../utils/api';
import VoiceSettings from '../VoiceSettings';

/**
 * Every setting in one place, with its scope labeled. Server/device config
 * (TTS, OCR, updates, addresses) comes from useUserConfig; appearance lives
 * in this browser via useTheme.
 */
export default function SettingsView() {
    const toast = useToast();
    const { config, updateConfig } = useUserConfig();
    const theme = useTheme();
    const [saving, setSaving] = useState(false);
    const [access, setAccess] = useState(null);

    useEffect(() => {
        let cancelled = false;
        getServerAddresses()
            .then((value) => {
                if (!cancelled) setAccess(value);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, []);

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

    const copyAddress = useCallback(async (url) => {
        try {
            await navigator.clipboard.writeText(url);
            toast.success(`Copied ${url}`);
        } catch {
            toast.error('Could not copy the address');
        }
    }, [toast]);

    return (
        <div className="settings-page">
            <header className="settings-page-header">
                <h1>Settings</h1>
                <p className="hint">Appearance follows this browser; everything else follows this computer.</p>
            </header>

            <section className="settings-card" aria-labelledby="settings-appearance">
                <h2 className="settings-section-title" id="settings-appearance">Appearance</h2>
                <div className="appearance-grid" role="group" aria-label="Color palette">
                    {PALETTES.map((palette) => (
                        <div key={palette.id} className="appearance-palette">
                            <span className="appearance-palette-name">{palette.name}</span>
                            <div className="appearance-palette-modes">
                                {['light', 'dark'].map((mode) => {
                                    const active = theme.palette === palette.id && theme.mode === mode;
                                    return (
                                        <button
                                            key={mode}
                                            type="button"
                                            className={`appearance-option ${active ? 'is-active' : ''}`}
                                            onClick={() => {
                                                theme.setPalette(palette.id);
                                                theme.setMode(mode);
                                            }}
                                            aria-pressed={active}
                                            title={`${palette.name} (${mode})`}
                                        >
                                            <span
                                                className="theme-selector-swatch"
                                                style={{ background: getSwatchColor(palette.id, mode) }}
                                                aria-hidden="true"
                                            />
                                            {active ? <Check size={13} aria-hidden="true" /> : null}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            <section className="settings-card" aria-labelledby="settings-narration">
                <h2 className="settings-section-title" id="settings-narration">Narration</h2>
                {config ? (
                    <>
                        <label className="settings-row">
                            <span>Voice engine device</span>
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
                        <p className="settings-hint">
                            GPU settings take effect after restart. CPU mode works offline but is
                            much slower for long narration.
                        </p>
                        <VoiceSettings
                            backendReady
                            activeVoiceId={config.voice_id || null}
                            onVoiceChange={(voiceId) => handleChange('voice_id', voiceId)}
                        />
                        <p className="settings-hint">
                            This default voice applies to new books; a book keeps the voice it was
                            prepared with.
                        </p>
                    </>
                ) : (
                    <p className="settings-hint" role="status">Loading settings…</p>
                )}
            </section>

            <section className="settings-card" aria-labelledby="settings-capture">
                <h2 className="settings-section-title" id="settings-capture">Capture &amp; OCR</h2>
                {config ? (
                    <label className="settings-row">
                        <span>Use the GPU for page OCR</span>
                        <input
                            type="checkbox"
                            checked={!!config.ocr_use_gpu}
                            disabled={saving}
                            onChange={(e) => handleChange('ocr_use_gpu', e.target.checked)}
                        />
                    </label>
                ) : (
                    <p className="settings-hint" role="status">Loading settings…</p>
                )}
            </section>

            <section className="settings-card" aria-labelledby="settings-connections">
                <h2 className="settings-section-title" id="settings-connections">Device &amp; connections</h2>
                {config ? (
                    <label className="settings-row">
                        <span>Check for updates</span>
                        <input
                            type="checkbox"
                            checked={config.check_for_updates !== false}
                            disabled={saving}
                            onChange={(e) => handleChange('check_for_updates', e.target.checked)}
                        />
                    </label>
                ) : null}
                {config && (
                    <p className="settings-hint">
                        Update checks ask GitHub once a day whether a newer release exists. Turn
                        this off to stop BookVoice contacting the network on its own.
                    </p>
                )}
                {access?.available && ((access.addresses?.length ?? 0) > 0 || access.tunnelUrl) && (
                    <div className="settings-devices">
                        <div className="settings-row settings-devices-heading">
                            <span><MonitorSmartphone size={15} aria-hidden="true" /> Open on another device</span>
                        </div>
                        {(access.addresses ?? []).map((address) => (
                            <DeviceAddressRow
                                key={address}
                                url={`http://${address}:${access.port}`}
                                onCopy={copyAddress}
                            />
                        ))}
                        {access.tunnelUrl && (
                            <DeviceAddressRow url={access.tunnelUrl} onCopy={copyAddress} />
                        )}
                        <p className="settings-hint">
                            Anyone with this address can use BookVoice as you while the server
                            runs. The address survives restarts while the port stays free.
                        </p>
                    </div>
                )}
            </section>
        </div>
    );
}

function DeviceAddressRow({ url, onCopy }) {
    return (
        <div className="settings-row">
            <a href={url} target="_blank" rel="noreferrer">{url}</a>
            <Button variant="secondary" size="sm" onClick={() => onCopy(url)}>
                <Copy size={14} aria-hidden="true" /> Copy
            </Button>
        </div>
    );
}
