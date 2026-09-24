import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, LogOut, MonitorSmartphone } from 'lucide-react';
import Button from '../ui/Button';
import { useToast } from '../Toast';
import { useUserConfig } from '../../hooks/useUserConfig';
import { useTheme, THEME_MODE_OPTIONS, getSwatchColor } from '../../hooks/useTheme';
import { useCapabilities } from '../../hooks/useCapabilities';
import { getServerAddresses, signOut } from '../../utils/api';
import VoiceSettings from '../VoiceSettings';

/**
 * Every setting in one place, with its scope labeled. Server/device config
 * (TTS, OCR, updates, addresses) comes from useUserConfig; appearance lives
 * in this browser via useTheme.
 */
export default function SettingsView() {
    const toast = useToast();
    const { config, updateConfig, saveError, loadError } = useUserConfig();
    const theme = useTheme();
    const { serverMode } = useCapabilities();
    const [signingOut, setSigningOut] = useState(false);

    const handleSignOut = async () => {
        setSigningOut(true);
        try {
            await signOut();
            toast.success('Signed out of this hosted session.');
            window.location.reload();
        } catch (error) {
            toast.error(error?.message || 'Could not sign out.');
            setSigningOut(false);
        }
    };
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

    // F-29: palette+mode is a single choice across ten options, so it is a
    const modeOptions = THEME_MODE_OPTIONS;
    const modeGroupRef = useRef(null);
    const pendingFocusRef = useRef(null);

    useEffect(() => {
        if (pendingFocusRef.current == null) return;
        const radios = modeGroupRef.current?.querySelectorAll('[role="radio"]');
        radios?.[pendingFocusRef.current]?.focus();
        pendingFocusRef.current = null;
    });

    const onModeKeyDown = (event) => {
        const current = modeOptions.findIndex((option) => option.id === theme.mode);
        if (current === -1) return;
        let next;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % modeOptions.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + modeOptions.length) % modeOptions.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = modeOptions.length - 1;
        else return;
        event.preventDefault();
        theme.setMode(modeOptions[next].id);
        pendingFocusRef.current = next;
    };

    const selectMode = (mode) => {
        theme.setMode(mode);
        theme.setPalette('paper');
    };

    return (
        <div className="settings-page">
            {/* F-23: plain block — App's <header> is the page's one banner. */}
            <div className="settings-page-header">
                <h1>Settings</h1>
                <p className="hint">Appearance follows this browser; everything else follows this computer.</p>
            </div>

            {saveError && (
                <div className="status-banner error" role="alert">
                    <span>Could not save settings: {saveError}</span>
                </div>
            )}
            {/* F-33: a failed load used to be silent — defaults were served
                with no hint that nothing would persist from this session. */}
            {loadError && (
                <div className="status-banner warning" role="status">
                    <span>Could not load your saved settings ({loadError}). Changes on this page may not stick.</span>
                </div>
            )}
            {serverMode && (
                <div className="status-banner loading" role="status">
                    <span>Hosted server mode: local file actions and LAN tunnel options are disabled.</span>
                </div>
            )}
            {serverMode ? (
                <div className="settings-row settings-hosted-row">
                    <span>Hosted session</span>
                    <Button variant="secondary" size="sm" disabled={signingOut} onClick={handleSignOut}>
                        <LogOut size={14} aria-hidden="true" /> {signingOut ? 'Signing out…' : 'Sign out'}
                    </Button>
                </div>
            ) : null}
            {/* F-41: ONE loading announcement for the whole page. The
                per-section "Loading settings…" paragraphs each carried
                role="status" and were announced three times. */}
            {!config && !serverMode && (
                <p className="settings-hint" role="status">Loading settings…</p>
            )}

            <section className="settings-card settings-appearance" aria-labelledby="settings-appearance">
                <div className="settings-appearance-heading">
                    <div>
                        <h2 className="settings-section-title" id="settings-appearance">Mode</h2>
                        <p className="settings-hint">Paper and Night are tuned for long reading. System follows this device.</p>
                    </div>
                    <div className="appearance-role-legend" aria-label="Color roles">
                        <span><i className="appearance-role-swatch action" aria-hidden="true" />Action</span>
                        <span><i className="appearance-role-swatch signal" aria-hidden="true" />Signal</span>
                    </div>
                </div>
                <div
                    className="appearance-mode-grid"
                    role="radiogroup"
                    aria-label="Reading mode"
                    ref={modeGroupRef}
                    onKeyDown={onModeKeyDown}
                >
                    {modeOptions.map((option) => {
                        const active = theme.mode === option.id;
                        return (
                            <button
                                key={option.id}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                tabIndex={active ? 0 : -1}
                                className={`appearance-mode ${active ? 'is-active' : ''}`}
                                onClick={() => selectMode(option.id)}
                                aria-label={option.name}
                            >
                                <span className="appearance-mode-swatch" style={{ background: getSwatchColor('paper', option.id) }} aria-hidden="true" />
                                <span className="appearance-mode-copy">
                                    <strong>{option.name}</strong>
                                    <small>{option.description}</small>
                                </span>
                                {active ? <Check size={15} aria-hidden="true" /> : null}
                            </button>
                        );
                    })}
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
                ) : null}
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
                ) : null}
            </section>

            <section className="settings-card" aria-labelledby="settings-connections">
                <h2 className="settings-section-title" id="settings-connections">Device &amp; connections</h2>
                {config && !serverMode ? (
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
                {config && !serverMode && (
                    <p className="settings-hint">
                        Update checks ask GitHub once a day whether a newer release exists. Turn
                        this off to stop BookVoice contacting the network on its own.
                    </p>
                )}
                {serverMode && (
                    <p className="settings-hint">
                        Update checks run only on the desktop app — the person looking at this
                        hosted UI is not on the machine that would need to restart.
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
