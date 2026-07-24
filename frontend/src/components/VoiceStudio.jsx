import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, RotateCw, Scissors, X } from 'lucide-react';
import {
    cancelStudioJob,
    createStudioProject,
    deleteStudioProject,
    duplicateStudioProject,
    getStudioProject,
    getVoices,
    listStudioProjects,
    openStudioProjectFolder,
    updateStudioProject,
    waitForStudioJob,
} from '../utils/api';
import { useToast } from './Toast';
import StudioNarration from './StudioNarration';
import StudioProjectSidebar from './StudioProjectSidebar';
import StudioRepair from './StudioRepair';

export default function VoiceStudio() {
    const toast = useToast();
    const mountedRef = useRef(true);
    const pollControllerRef = useRef(null);
    const [projects, setProjects] = useState([]);
    const [project, setProject] = useState(null);
    const [voices, setVoices] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [activeJob, setActiveJob] = useState(null);

    const openProject = useCallback(async (projectId) => {
        if (!projectId) {
            setProject(null);
            return null;
        }
        const opened = await getStudioProject(projectId);
        if (mountedRef.current) {
            setProject(opened);
            localStorage.setItem('bookvoice.studio.activeProject', opened.id);
        }
        return opened;
    }, []);

    const refresh = useCallback(async (preferredId = null, refreshVoices = false) => {
        const [nextProjects, nextVoices] = await Promise.all([
            listStudioProjects(),
            refreshVoices ? getVoices() : Promise.resolve(null),
        ]);
        if (!mountedRef.current) return null;
        setProjects(nextProjects);
        if (nextVoices) setVoices(nextVoices);
        const savedId = preferredId || project?.id || localStorage.getItem('bookvoice.studio.activeProject');
        const nextId = nextProjects.some((item) => item.id === savedId) ? savedId : nextProjects[0]?.id;
        return openProject(nextId);
    }, [openProject, project?.id]);

    useEffect(() => {
        mountedRef.current = true;
        const load = async () => {
            try {
                const [nextProjects, nextVoices] = await Promise.all([listStudioProjects(), getVoices()]);
                if (!mountedRef.current) return;
                setProjects(nextProjects);
                setVoices(nextVoices);
                const savedId = localStorage.getItem('bookvoice.studio.activeProject');
                const nextId = nextProjects.some((item) => item.id === savedId) ? savedId : nextProjects[0]?.id;
                if (nextId) await openProject(nextId);
            } catch (loadError) {
                if (mountedRef.current) setError(loadError.message || 'Voice Studio could not be opened.');
            } finally {
                if (mountedRef.current) setLoading(false);
            }
        };
        load();
        return () => {
            mountedRef.current = false;
            pollControllerRef.current?.abort();
        };
    }, [openProject]);

    const patchProject = useCallback(async (changes) => {
        if (!project) return null;
        const updated = await updateStudioProject(project.id, changes);
        if (mountedRef.current) {
            setProject(updated);
            setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
        }
        return updated;
    }, [project]);

    const createProject = async (name) => {
        try {
            const created = await createStudioProject(name);
            await refresh(created.id);
            toast.success(`Project “${created.name}” created`);
        } catch (createError) {
            toast.error(createError.message);
        }
    };

    const duplicateProject = async (projectId) => {
        try {
            const copied = await duplicateStudioProject(projectId);
            await refresh(copied.id);
            toast.success(`Project duplicated as “${copied.name}”`);
        } catch (duplicateError) {
            toast.error(duplicateError.message);
        }
    };

    const showProjectFolder = async (target) => {
        try {
            await openStudioProjectFolder(target.id);
            toast.success(`Opened “${target.name}” project folder`);
        } catch (folderError) {
            toast.error(folderError.message || 'Could not open the project folder.');
        }
    };

    const removeProject = async (target) => {
        const confirmed = window.confirm(
            `Delete “${target.name}”? Its copied source media and all output versions will be permanently removed. This cannot be undone.`,
        );
        if (!confirmed) return;
        try {
            await deleteStudioProject(target.id);
            localStorage.removeItem('bookvoice.studio.activeProject');
            setProject(null);
            await refresh(null);
            toast.success('Voice Studio project deleted');
        } catch (deleteError) {
            toast.error(deleteError.message);
        }
    };

    const runJob = useCallback(async (label, submitter, options = {}) => {
        let controller;
        try {
            const queued = await submitter();
            controller = new AbortController();
            pollControllerRef.current = controller;
            if (mountedRef.current) setActiveJob({ ...queued, message: label });
            const completed = await waitForStudioJob(queued.id, {
                signal: controller.signal,
                onProgress: (nextJob) => {
                    if (mountedRef.current) setActiveJob(nextJob);
                },
            });
            if (!mountedRef.current) return;
            await refresh(project?.id, options.refreshVoices === true);
            await options.onComplete?.(completed.result || {});
            const successMessage = options.successMessage?.(completed.result || {});
            toast.success(successMessage || `${label} completed`);
        } catch (jobError) {
            if (jobError.name !== 'AbortError') toast.error(jobError.message || `${label} failed.`);
        } finally {
            if (pollControllerRef.current === controller) pollControllerRef.current = null;
            if (mountedRef.current) setActiveJob(null);
        }
    }, [project?.id, refresh, toast]);

    const cancelJob = async () => {
        if (!activeJob) return;
        try {
            await cancelStudioJob(activeJob.id);
            pollControllerRef.current?.abort();
            setActiveJob(null);
            await refresh(project?.id);
            toast.info('Studio job cancelled. You can run it again when ready.');
        } catch (cancelError) {
            toast.error(cancelError.message);
        }
    };

    const runningProjectJob = project ? [...(project.jobs || [])].reverse().find(
        (job) => ['QUEUED', 'RUNNING'].includes(job.status),
    ) : null;
    const runningProjectJobId = runningProjectJob?.id;

    useEffect(() => {
        if (!runningProjectJobId) return undefined;
        const controller = new AbortController();
        pollControllerRef.current = controller;
        setActiveJob(runningProjectJob);
        waitForStudioJob(runningProjectJobId, {
            signal: controller.signal,
            onProgress: (nextJob) => {
                if (mountedRef.current) setActiveJob(nextJob);
            },
        }).then(async () => {
            const [opened, nextProjects, nextVoices] = await Promise.all([
                getStudioProject(project.id),
                listStudioProjects(),
                getVoices(),
            ]);
            if (!mountedRef.current) return;
            setProject(opened);
            setProjects(nextProjects);
            setVoices(nextVoices);
            toast.success('Reconnected Studio job completed');
        }).catch((jobError) => {
            if (jobError.name !== 'AbortError') toast.error(jobError.message || 'Studio job failed.');
        }).finally(() => {
            if (pollControllerRef.current === controller) pollControllerRef.current = null;
            if (mountedRef.current) setActiveJob(null);
        });
        return () => controller.abort();
    }, [project?.id, runningProjectJob, runningProjectJobId, toast]);

    if (loading) return <div className="studio-loading" role="status"><RotateCw size={20} className="spin" /> Opening Voice Studio…</div>;
    if (error) return <div className="studio-fatal" role="alert"><h2>Voice Studio is unavailable</h2><p>{error}</p><button className="btn secondary" onClick={() => window.location.reload()}>Reload</button></div>;

    const retryableJob = project ? [...(project.jobs || [])].reverse().find(
        (job) => job.canRetry && ['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(job.status),
    ) : null;

    return (
        <div className="voice-studio">
            <StudioProjectSidebar
                projects={projects}
                activeId={project?.id}
                onOpen={openProject}
                onCreate={createProject}
                onDuplicate={duplicateProject}
                onDelete={removeProject}
                onOpenFolder={showProjectFolder}
                disabled={Boolean(activeJob)}
            />

            <section className="studio-main" aria-label="Active Voice Studio project">
                {!project ? (
                    <div className="studio-empty hero">
                        <AudioLines size={38} />
                        <h1>Create your first voice project</h1>
                        <p>Write narration, build a reusable voice profile, or repair a phrase in an audio or video file. Everything stays on this computer.</p>
                    </div>
                ) : <>
                    <header className="studio-project-header">
                        <div>
                            <span className="studio-kicker">Voice Studio project</span>
                            <label className="sr-only" htmlFor="studio-project-title">Project name</label>
                            <input
                                id="studio-project-title"
                                key={`${project.id}-${project.name}`}
                                defaultValue={project.name}
                                maxLength={100}
                                onBlur={(event) => {
                                    const name = event.target.value.trim();
                                    if (name && name !== project.name) patchProject({ name });
                                }}
                                disabled={Boolean(activeJob)}
                            />
                        </div>
                        <span className="studio-local-badge">Local only</span>
                    </header>

                    <div className="studio-workflow-tabs" role="tablist" aria-label="Voice Studio workflow">
                        <button
                            role="tab"
                            aria-selected={(project.activeWorkflow || 'NARRATION') === 'NARRATION'}
                            aria-pressed={(project.activeWorkflow || 'NARRATION') === 'NARRATION'}
                            className={(project.activeWorkflow || 'NARRATION') === 'NARRATION' ? 'is-active' : ''}
                            onClick={() => patchProject({ activeWorkflow: 'NARRATION' })}
                            disabled={Boolean(activeJob)}
                        >
                            <AudioLines size={18} /> <span><strong>Create narration</strong><small>Type and generate speech</small></span>
                        </button>
                        <button
                            role="tab"
                            aria-selected={project.activeWorkflow === 'REPAIR'}
                            aria-pressed={project.activeWorkflow === 'REPAIR'}
                            className={project.activeWorkflow === 'REPAIR' ? 'is-active' : ''}
                            onClick={() => patchProject({ activeWorkflow: 'REPAIR' })}
                            disabled={Boolean(activeJob)}
                        >
                            <Scissors size={18} /> <span><strong>Repair media</strong><small>Replace a selected phrase</small></span>
                        </button>
                    </div>

                    {activeJob && (
                        <div className="studio-job" role="status" aria-live="polite">
                            <div><strong>{activeJob.message || 'Working'}</strong><span>{Math.round((activeJob.progress || 0) * 100)}%</span></div>
                            <progress max="1" value={activeJob.progress || 0} />
                            <button className="icon-btn" onClick={cancelJob} aria-label="Cancel Studio job"><X size={16} /></button>
                        </div>
                    )}

                    {!activeJob && retryableJob && (
                        <div className="studio-recovery" role="status">
                            <div>
                                <strong>{retryableJob.kind.replaceAll('_', ' ')} was interrupted</strong>
                                <span>{retryableJob.error?.message || retryableJob.message || 'No project files were changed.'}</span>
                            </div>
                            <button
                                className="btn secondary"
                                onClick={() => patchProject({
                                    activeWorkflow: retryableJob.kind === 'NARRATION' ? 'NARRATION' : 'REPAIR',
                                })}
                            >
                                Review and retry
                            </button>
                        </div>
                    )}

                    {project.activeWorkflow === 'REPAIR' ? (
                        <StudioRepair project={project} voices={voices} onPatch={patchProject} onRunJob={runJob} disabled={Boolean(activeJob)} />
                    ) : (
                        <StudioNarration project={project} voices={voices} onPatch={patchProject} onRunJob={runJob} disabled={Boolean(activeJob)} />
                    )}
                </>}
            </section>
        </div>
    );
}
