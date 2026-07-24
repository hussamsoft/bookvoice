import React, { useState } from 'react';
import { Copy, FolderOpen, FolderPlus, HardDrive, Trash2 } from 'lucide-react';

function diskLabel(bytes = 0) {
    if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export default function StudioProjectSidebar({
    projects,
    activeId,
    onOpen,
    onCreate,
    onDuplicate,
    onDelete,
    onOpenFolder,
    disabled,
}) {
    const [name, setName] = useState('');

    const create = async (event) => {
        event.preventDefault();
        await onCreate(name.trim() || 'Untitled project');
        setName('');
    };

    return (
        <aside className="studio-sidebar" aria-label="Voice Studio projects">
            <div className="studio-sidebar-heading">
                <div>
                    <span className="studio-kicker">Local workspace</span>
                    <h2>Projects</h2>
                </div>
                <span className="studio-project-count">{projects.length}</span>
            </div>

            <form className="studio-new-project" onSubmit={create}>
                <label className="sr-only" htmlFor="studio-project-name">New project name</label>
                <input
                    id="studio-project-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Project name"
                    maxLength={100}
                    disabled={disabled}
                />
                <button className="btn primary" type="submit" disabled={disabled}>
                    <FolderPlus size={16} /> Create
                </button>
            </form>

            <div className="studio-project-list" role="list">
                {projects.length === 0 ? (
                    <div className="studio-empty compact" role="status">
                        <p>No Studio projects yet.</p>
                        <small>Create one to save scripts, media, and outputs locally.</small>
                    </div>
                ) : projects.map((project) => (
                    <article
                        className={`studio-project-row ${project.id === activeId ? 'is-active' : ''}`}
                        key={project.id}
                    >
                        <button className="studio-project-open" onClick={() => onOpen(project.id)}>
                            <strong>{project.name}</strong>
                            <span><HardDrive size={12} /> {diskLabel(project.diskBytes)}</span>
                        </button>
                        <div className="studio-project-actions">
                            <button
                                className="icon-btn"
                                onClick={() => onOpenFolder(project)}
                                aria-label={`Open ${project.name} folder`}
                                title="Open complete project folder"
                            >
                                <FolderOpen size={14} />
                            </button>
                            <button
                                className="icon-btn"
                                onClick={() => onDuplicate(project.id)}
                                aria-label={`Duplicate ${project.name}`}
                                title="Duplicate project"
                                disabled={disabled}
                            >
                                <Copy size={14} />
                            </button>
                            <button
                                className="icon-btn danger"
                                onClick={() => onDelete(project)}
                                aria-label={`Delete ${project.name}`}
                                title="Delete project and its local media"
                                disabled={disabled}
                            >
                                <Trash2 size={14} />
                            </button>
                        </div>
                    </article>
                ))}
            </div>
        </aside>
    );
}
