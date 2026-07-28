import React from 'react';
import { Download, Film, Music2 } from 'lucide-react';
import AudioPlayer from './AudioPlayer';

function outputLabel(output) {
    if (output.kind === 'REPAIR_VIDEO') return 'Repaired video';
    if (output.kind === 'REPAIR_AUDIO') return 'Repaired audio';
    if (output.kind === 'CONVERSION') return 'Converted voice';
    return 'Narration';
}

export default function StudioOutputs({
    outputs = [],
}) {
    const ordered = [...outputs].reverse();
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
                                <AudioPlayer src={output.contentUrl} label={outputLabel(output).toLowerCase()} />
                            )}
                            <a
                                className="btn secondary studio-save-output"
                                href={output.downloadUrl || output.contentUrl}
                                download={output.fileName || true}
                                aria-label={`Download ${outputLabel(output).toLowerCase()} to this device`}
                            >
                                <Download size={16} /> Download to this device
                            </a>
                        </article>
                    ))}
                </div>
            )}
        </section>
    );
}
