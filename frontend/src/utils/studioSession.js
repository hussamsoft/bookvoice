/**
 * Per-device Voice Studio session.
 *
 * Projects, voices, sources and outputs live on the server and are shared —
 * they are the work. What you happen to be *doing* is not: landing on a phone
 * halfway through something started at the desk, on a tab you did not choose,
 * is disorienting rather than helpful. So the open project, the selected
 * workflow and the draft script are kept here, in this browser, on this device.
 *
 * Everything degrades to defaults if storage is unavailable (private windows,
 * blocked storage), because none of it is worth failing a page load over.
 */
const STORAGE_KEY = 'bookvoice.studio.session';
const LEGACY_PROJECT_KEY = 'bookvoice.studio.activeProject';
const WORKFLOWS = ['NARRATION', 'CONVERSION', 'REPAIR'];

function read() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed === 'object') {
            return {
                activeProjectId: parsed.activeProjectId || '',
                workflows: parsed.workflows && typeof parsed.workflows === 'object' ? parsed.workflows : {},
                scripts: parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {},
            };
        }
    } catch {
        /* unreadable storage is the same as no session */
    }
    return { activeProjectId: '', workflows: {}, scripts: {} };
}

function write(session) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
        /* a session that cannot be saved still works for this visit */
    }
}

/** Adopt the pre-session active project so an upgrade does not lose your place. */
export function migrateLegacySession() {
    const session = read();
    if (session.activeProjectId) return session;
    try {
        const legacy = localStorage.getItem(LEGACY_PROJECT_KEY);
        if (legacy) {
            session.activeProjectId = legacy;
            write(session);
            localStorage.removeItem(LEGACY_PROJECT_KEY);
        }
    } catch {
        /* nothing to migrate */
    }
    return session;
}

export function getActiveProjectId() {
    return read().activeProjectId;
}

export function setActiveProjectId(projectId) {
    const session = read();
    session.activeProjectId = projectId || '';
    write(session);
}

export function getWorkflow(projectId) {
    const stored = read().workflows[projectId];
    return WORKFLOWS.includes(stored) ? stored : 'NARRATION';
}

export function setWorkflow(projectId, workflow) {
    if (!projectId || !WORKFLOWS.includes(workflow)) return;
    const session = read();
    session.workflows[projectId] = workflow;
    write(session);
}

/**
 * The device's draft script. `undefined` means this device has never typed
 * here, so the caller should fall back to whatever the project last generated.
 */
export function getScript(projectId) {
    const stored = read().scripts[projectId];
    return typeof stored === 'string' ? stored : undefined;
}

export function setScript(projectId, script) {
    if (!projectId) return;
    const session = read();
    session.scripts[projectId] = String(script ?? '');
    write(session);
}

/** Drop everything remembered about a project, e.g. once it is deleted. */
export function forgetProject(projectId) {
    const session = read();
    delete session.workflows[projectId];
    delete session.scripts[projectId];
    if (session.activeProjectId === projectId) session.activeProjectId = '';
    write(session);
}

export function clearSession() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        /* nothing to clear */
    }
}
