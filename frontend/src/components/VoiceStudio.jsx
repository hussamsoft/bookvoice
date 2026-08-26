import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, LayoutGrid, Repeat2, RotateCw, Scissors } from 'lucide-react';
import {
    cancelStudioJob,
    claimLegacyStudioProjects,
    createStudioProject,
    deleteStudioProject,
    duplicateStudioProject,
    getStudioProject,
    getStudioWorkspace,
    getVoices,
    listStudioProjects,
    openStudioProjectFolder,
    updateStudioProject,
    waitForStudioJob,
} from '../utils/api';
import { useToast } from './Toast';
import ConfirmDialog from './ui/ConfirmDialog';
import StudioConversion from './StudioConversion';
import StudioNarration from './StudioNarration';
import StudioProjectSidebar from './StudioProjectSidebar';
import StudioStart from './StudioStart';
import StudioRepair from './StudioRepair';
import * as studioSession from '../utils/studioSession';

const WORKFLOW_ORDER = ['NARRATION', 'CONVERSION', 'REPAIR'];

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
    const [workflow, setWorkflowState] = useState('NARRATION');
    const [legacyProjectsAvailable, setLegacyProjectsAvailable] = useState(false);
    const [projectPendingDelete, setProjectPendingDelete] = useState(null);

    const openProject = useCallback(async (projectId) => {
        if (!projectId) {
            setProject(null);
            return null;
        }
        const opened = await getStudioProject(projectId);
        if (mountedRef.current) {
            setProject(opened);
            setWorkflowState(studioSession.getWorkflow(opened.id));
            studioSession.setActiveProjectId(opened.id);
        }
        return opened;
    }, []);

    const refresh = useCallback(async (preferredId = null, refreshVoices = false) => {
        const [workspace, nextVoices] = await Promise.all([
            getStudioWorkspace(),
            refreshVoices ? getVoices() : Promise.resolve(null),
        ]);
        if (!mountedRef.current) return null;
        const nextProjects = workspace.projects;
        setProjects(nextProjects);
        setLegacyProjectsAvailable(workspace.legacyProjectsAvailable);
        if (nextVoices) setVoices(nextVoices);
        const savedId = preferredId || project?.id || studioSession.getActiveProjectId();
        // Falling back to 'some other project' is how a device ends up somewhere
        // it never chose to be; without a match, return to the start screen.
        const nextId = nextProjects.some((item) => item.id === savedId) ? savedId : '';
        return openProject(nextId);
    }, [openProject, project?.id]);

    useEffect(() => {
        mountedRef.current = true;
        const load = async () => {
            try {
                const [workspace, nextVoices] = await Promise.all([getStudioWorkspace(), getVoices()]);
                if (!mountedRef.current) return;
                const nextProjects = workspace.projects;
                setProjects(nextProjects);
                setLegacyProjectsAvailable(workspace.legacyProjectsAvailable);
                setVoices(nextVoices);
                // Only reopen what *this device* had open. A project another
                // device left mid-flow is not this device's business.
                const savedId = studioSession.migrateLegacySession().activeProjectId;
                if (savedId && nextProjects.some((item) => item.id === savedId)) {
                    await openProject(savedId);
                } else {
                    // No session on this device: land on the start screen.
                    studioSession.setActiveProjectId('');
                }
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

    // The workflow tab is device state: it never reaches the server, so a tab
    // chosen at the desk does not decide what a phone opens on.
    const setWorkflow = useCallback((next) => {
        setWorkflowState(next);
        if (project?.id) studioSession.setWorkflow(project.id, next);
    }, [project?.id]);

    // ARIA tabs pattern: arrow keys / Home / End move the selected workflow
    // tab with roving tabindex; mouse and touch keep their click behavior.
    const onWorkflowTabsKeyDown = (event) => {
        const key = event.key;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
        const tabs = Array.from(event.currentTarget.querySelectorAll('[role="tab"]'));
        const index = tabs.indexOf(document.activeElement);
        if (index === -1) return;
        event.preventDefault();
        const nextIndex = key === 'Home' ? 0
            : key === 'End' ? tabs.length - 1
            : key === 'ArrowRight' ? Math.min(tabs.length - 1, index + 1)
            : Math.max(0, index - 1);
        setWorkflow(WORKFLOW_ORDER[nextIndex]);
        tabs[nextIndex].focus();
    };

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

    const claimEarlierProjects = async () => {
        try {
            const workspace = await claimLegacyStudioProjects();
            if (!mountedRef.current) return;
            setProjects(workspace.projects);
            setLegacyProjectsAvailable(workspace.legacyProjectsAvailable);
            if (workspace.claimed === 0) {
                toast.info('Those earlier projects were already claimed on another device');
            } else {
                toast.success(
                    workspace.claimed === 1
                        ? 'Moved 1 earlier project to this device'
                        : `Moved ${workspace.claimed} earlier projects to this device`,
                );
            }
        } catch (claimError) {
            toast.error(claimError.message);
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
        try {
            await deleteStudioProject(target.id);
            studioSession.forgetProject(target.id);
            setProject(null);
            await refresh(null);
            toast.success('Voice Studio project deleted');
        } catch (deleteError) {
            toast.error(deleteError.message);
        }
    };

    const runJob = useCallback(async (label, submitter, options = {}) => {
        let controller;
        let success = false;
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
            if (!mountedRef.current) return false;
            await refresh(project?.id, options.refreshVoices === true);
            await options.onComplete?.(completed.result || {});
            const successMessage = options.successMessage?.(completed.result || {});
            toast.success(successMessage || `${label} completed`);
            success = true;
        } catch (jobError) {
            if (jobError.name !== 'AbortError') toast.error(jobError.message || `${label} failed.`);
            success = false;
        } finally {
            if (pollControllerRef.current === controller) pollControllerRef.current = null;
            if (mountedRef.current) setActiveJob(null);
        }
        return success;
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

    // A recovered failure is historical once a newer job completes. Looking
    // for any old failed job made the same error banner persist forever.
    const latestJob = project?.jobs?.at(-1) || null;
    const retryableJob = latestJob?.canRetry
        && ['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(latestJob.status)
        ? latestJob
        : null;

    const jobProgressPct = Math.min(100, Math.max(0, Math.round((activeJob?.progress || 0) * 100)));
    return (
        <div className="voice-studio">
            <StudioProjectSidebar
                projects={projects}
                activeId={project?.id}
                onOpen={openProject}
                onCreate={createProject}
                onDuplicate={duplicateProject}
                onDelete={setProjectPendingDelete}
                onOpenFolder={showProjectFolder}
                disabled={Boolean(activeJob)}
            />

            <section className="studio-main" aria-label="Active Voice Studio project">
                {!project ? (
                    <StudioStart
                        projects={projects}
                        onOpen={openProject}
                        onCreate={createProject}
                        legacyProjectsAvailable={legacyProjectsAvailable}
                        onClaimLegacy={claimEarlierProjects}
                        disabled={Boolean(activeJob)}
                    />
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
                        <div className="studio-project-header-actions">
                            <button
                                className="btn text"
                                type="button"
                                onClick={() => {
                                    studioSession.setActiveProjectId('');
                                    setProject(null);
                                }}
                                disabled={Boolean(activeJob)}
                            >
                                <LayoutGrid size={15} /> All projects
                            </button>
                            <span className="studio-local-badge">This device only</span>
                        </div>
                    </header>

                    <div
                        className="studio-workflow-tabs"
                        role="tablist"
                        aria-label="Voice Studio workflow"
                        onKeyDown={onWorkflowTabsKeyDown}
                    >
                        <button
                            role="tab"
                            aria-selected={workflow === 'NARRATION'}
                            className={workflow === 'NARRATION' ? 'is-active' : ''}
                            onClick={() => setWorkflow('NARRATION')}
                            tabIndex={workflow === 'NARRATION' ? 0 : -1}
                            disabled={Boolean(activeJob)}
                        >
                            <AudioLines size={18} /> <span><strong>Create narration</strong><small>Type and generate speech</small></span>
                        </button>
                        <button
                            role="tab"
                            aria-selected={workflow === 'CONVERSION'}
                            className={workflow === 'CONVERSION' ? 'is-active' : ''}
                            onClick={() => setWorkflow('CONVERSION')}
                            tabIndex={workflow === 'CONVERSION' ? 0 : -1}
                            disabled={Boolean(activeJob)}
                        >
                            <Repeat2 size={18} /> <span><strong>Convert voice</strong><small>Re-voice an existing recording</small></span>
                        </button>
                        <button
                            role="tab"
                            aria-selected={workflow === 'REPAIR'}
                            className={workflow === 'REPAIR' ? 'is-active' : ''}
                            onClick={() => setWorkflow('REPAIR')}
                            tabIndex={workflow === 'REPAIR' ? 0 : -1}
                            disabled={Boolean(activeJob)}
                        >
                            <Scissors size={18} /> <span><strong>Repair media</strong><small>Replace a selected phrase</small></span>
                        </button>
                    </div>

                    {activeJob && (
                        <div className="studio-job" role="status" aria-live="polite">
                            <strong>{activeJob.message || 'Working'}</strong>
                            <span className="studio-job-pct">{jobProgressPct}%</span>
                            <div
                                className="studio-job-meter"
                                role="progressbar"
                                aria-label={activeJob.message || 'Working'}
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={jobProgressPct}
                            >
                                <div className="studio-job-meter-fill" style={{ width: `${jobProgressPct}%` }} />
                            </div>
                            <button className="btn text" onClick={cancelJob} aria-label="Cancel Studio job">Cancel</button>
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
                                onClick={() => setWorkflow({
                                    NARRATION: 'NARRATION',
                                    VOICE_CONVERSION: 'CONVERSION',
                                }[retryableJob.kind] || 'REPAIR')}
                            >
                                Review and retry
                            </button>
                        </div>
                    )}

                    {workflow === 'REPAIR' && (
                        <StudioRepair project={project} voices={voices} onPatch={patchProject} onRunJob={runJob} disabled={Boolean(activeJob)} />
                    )}
                    {workflow === 'CONVERSION' && (
                        <StudioConversion project={project} voices={voices} onPatch={patchProject} onRunJob={runJob} disabled={Boolean(activeJob)} />
                    )}
                    {!['REPAIR', 'CONVERSION'].includes(workflow) && (
                        <StudioNarration project={project} voices={voices} onPatch={patchProject} onRunJob={runJob} disabled={Boolean(activeJob)} />
                    )}
                </>}
            </section>

            <ConfirmDialog
                open={Boolean(projectPendingDelete)}
                title={`Delete “${projectPendingDelete?.name ?? ''}”?`}
                message="Its copied source media and all output versions will be permanently removed. This cannot be undone."
                confirmLabel="Delete project"
                confirmVariant="danger"
                onConfirm={() => {
                    const target = projectPendingDelete;
                    setProjectPendingDelete(null);
                    if (target) removeProject(target);
                }}
                onCancel={() => setProjectPendingDelete(null)}
            />
        </div>
    );
}
