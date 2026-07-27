import React, { useState } from 'react';
import { AudioLines, FolderOpen, FolderPlus, HardDrive, Repeat2 } from 'lucide-react';

function diskLabel(bytes = 0) {
    if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Where a device lands when it has no session of its own.
 *
 * Opening straight into someone else's half-finished work — or your own, from
 * another device, on a tab you did not pick — is the confusing case this
 * replaces. Projects are all still here; you just choose one deliberately.
 */
export default function StudioStart({ projects = [], onOpen, onCreate, disabled }) {
    const [name, setName] = useState('');
    const recent = [...projects]
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, 6);

    const create = async (event) => {
        event.preventDefault();
        await onCreate(name.trim() || 'Untitled project');
        setName('');
    };

    return (
        <div className="studio-start">
            <div className="studio-start-hero">
                <AudioLines size={34} aria-hidden="true" />
                <h1>What would you like to do?</h1>
                <p>
                    Write narration in a cloned voice, or re-voice a recording you already have.
                    Your projects are shared across devices; where you are in them is not.
                </p>
            </div>

            <form className="studio-start-create" onSubmit={create}>
                <label htmlFor="studio-start-name">Start something new</label>
                <div>
                    <input
                        id="studio-start-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Project name"
                        maxLength={100}
                        disabled={disabled}
                    />
                    <button className="btn primary" type="submit" disabled={disabled}>
                        <FolderPlus size={16} /> Create project
                    </button>
                </div>
            </form>

            {recent.length > 0 && (
                <section className="studio-start-recent" aria-labelledby="studio-start-recent-heading">
                    <h2 id="studio-start-recent-heading">
                        <FolderOpen size={16} aria-hidden="true" /> Or pick up a project
                    </h2>
                    <div className="studio-start-list" role="list">
                        {recent.map((project) => (
                            <button
                                key={project.id}
                                type="button"
                                className="studio-start-project"
                                onClick={() => onOpen(project.id)}
                                disabled={disabled}
                                aria-label={`Open ${project.name}`}
                            >
                                <strong>{project.name}</strong>
                                <span>
                                    <HardDrive size={12} aria-hidden="true" /> {diskLabel(project.diskBytes)}
                                    {(project.outputs || []).length > 0 && (
                                        <> · {project.outputs.length} output{project.outputs.length === 1 ? '' : 's'}</>
                                    )}
                                </span>
                            </button>
                        ))}
                    </div>
                </section>
            )}

            <p className="studio-start-hint">
                <Repeat2 size={14} aria-hidden="true" />
                Every project opens on Create narration. Switch to Convert voice to re-voice an
                existing recording.
            </p>
        </div>
    );
}
