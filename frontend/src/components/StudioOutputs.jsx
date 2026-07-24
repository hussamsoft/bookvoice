import React from 'react';
import { Download, Film, Music2 } from 'lucide-react';
import { saveStudioOutput } from '../utils/api';

function outputLabel(output) {
    if (output.kind === 'REPAIR_VIDEO') return 'Repaired video';
    if (output.kind === 'REPAIR_AUDIO') return 'Repaired audio';
    return 'Narration';
}

export default function StudioOutputs({
    projectId,
    outputs = [],
    onRunJob,
    disabled = false,
}) {
    const ordered = [...outputs].reverse();
    const saveOutput = (output) => onRunJob(
        'Saving output to Downloads',
        () => saveStudioOutput(projectId, output.id),
        {
            successMessage: (result) => `${result.fileName || output.fileName} saved to Downloads`,
        },
    );
    return (
        <section className="studio-output-history" aria-labelledby="studio-output-heading">
            <div className="studio-section-heading">
                <div>
                    <span className="studio-kicker">Immutable versions</span>
                    <h3 id="studio-output-heading">Output history</h3>
                </div>
                <span>{outputs.length}</span>
            </div>
            {ordered.length === 0 ? (
                <div className="studio-empty compact" role="status">
                    <p>No outputs yet.</p>
                    <small>Generated narration and accepted repairs appear here.</small>
                </div>
            ) : (
                <div className="studio-output-list">
                    {ordered.map((output) => (
                        <article key={output.id} className="studio-output-row">
                            <div className="studio-output-title">
                                {output.kind === 'REPAIR_VIDEO' ? <Film size={17} /> : <Music2 size={17} />}
                                <div>
                                    <strong>{outputLabel(output)}</strong>
                                    <small>{Number(output.durationSec || 0).toFixed(1)}s · {output.format || 'WAV'}</small>
                                </div>
                            </div>
                            {output.format === 'MP4' ? (
                                <video controls preload="metadata" src={output.contentUrl} />
                            ) : (
                                <audio controls preload="metadata" src={output.contentUrl} />
                            )}
                            <button
                                className="btn secondary studio-save-output"
                                type="button"
                                onClick={() => saveOutput(output)}
                                disabled={disabled}
                                aria-label={`Save ${outputLabel(output).toLowerCase()} to Downloads`}
                            >
                                <Download size={16} /> Save to Downloads
                            </button>
                        </article>
                    ))}
                </div>
            )}
        </section>
    );
}
