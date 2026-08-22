import React, { useState } from 'react';
import { ChevronDown, Copy, FolderOpen, FolderPlus, HardDrive, Trash2 } from 'lucide-react';
import { useCapabilities } from '../hooks/useCapabilities';

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
    const [expanded, setExpanded] = useState(false);
    const { localFileActions } = useCapabilities();

    const create = async (event) => {
        event.preventDefault();
        await onCreate(name.trim() || 'Untitled project');
        setName('');
    };

    const activeName = projects.find((item) => item.id === activeId)?.name || 'No project';

    return (
        <aside className={`studio-sidebar ${expanded ? 'is-expanded' : ''}`} aria-label="Voice Studio projects">
            <div className="studio-sidebar-heading">
                <div>
                    <span className="studio-kicker">Local workspace</span>
                    <h2>Projects</h2>
                </div>
                <span className="studio-project-count">{projects.length}</span>
            </div>

            {/* On a phone the project list would otherwise occupy the top of
                every screen before the actual work is reachable. */}
            <button
                className="studio-sidebar-toggle"
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((open) => !open)}
            >
                <span>
                    <small>Project</small>
                    <strong>{activeName}</strong>
                </span>
                <ChevronDown size={18} aria-hidden="true" />
            </button>

            <div className="studio-sidebar-body">
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
                        <button
                            className="studio-project-open"
                            onClick={() => {
                                // Collapse after choosing, so the work is on screen.
                                setExpanded(false);
                                onOpen(project.id);
                            }}
                        >
                            <strong>{project.name}</strong>
                            <span><HardDrive size={12} /> {diskLabel(project.diskBytes)}</span>
                        </button>
                        <div className="studio-project-actions">
                            {localFileActions && (
                                <button
                                    className="icon-btn"
                                    onClick={() => onOpenFolder(project)}
                                    aria-label={`Open ${project.name} folder`}
                                    title="Open complete project folder"
                                >
                                    <FolderOpen size={14} />
                                </button>
                            )}
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
            </div>
        </aside>
    );
}
