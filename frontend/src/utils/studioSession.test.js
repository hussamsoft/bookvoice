import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as session from './studioSession';

const PROJECT = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

describe('studioSession', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it('starts with no project, so a new device chooses rather than resumes', () => {
        expect(session.getActiveProjectId()).toBe('');
        expect(session.getScript(PROJECT)).toBeUndefined();
    });

    it('defaults every project to the narration tab', () => {
        expect(session.getWorkflow(PROJECT)).toBe('NARRATION');
        session.setWorkflow(PROJECT, 'CONVERSION');
        expect(session.getWorkflow(PROJECT)).toBe('CONVERSION');
        // Unrelated projects are unaffected.
        expect(session.getWorkflow(OTHER)).toBe('NARRATION');
    });

    it('ignores a workflow it does not recognise', () => {
        session.setWorkflow(PROJECT, 'TELEPORT');
        expect(session.getWorkflow(PROJECT)).toBe('NARRATION');
    });

    it('keeps a separate draft script per project', () => {
        session.setScript(PROJECT, 'First draft');
        session.setScript(OTHER, 'Something else');

        expect(session.getScript(PROJECT)).toBe('First draft');
        expect(session.getScript(OTHER)).toBe('Something else');
    });

    it('distinguishes an empty draft from never having typed', () => {
        // undefined means "fall back to the project"; '' means "I cleared it".
        expect(session.getScript(PROJECT)).toBeUndefined();
        session.setScript(PROJECT, '');
        expect(session.getScript(PROJECT)).toBe('');
    });

    it('forgets everything about a deleted project', () => {
        session.setActiveProjectId(PROJECT);
        session.setWorkflow(PROJECT, 'REPAIR');
        session.setScript(PROJECT, 'Draft');

        session.forgetProject(PROJECT);

        expect(session.getActiveProjectId()).toBe('');
        expect(session.getWorkflow(PROJECT)).toBe('NARRATION');
        expect(session.getScript(PROJECT)).toBeUndefined();
    });

    it('adopts the pre-session active project once, then clears the old key', () => {
        localStorage.setItem('bookvoice.studio.activeProject', PROJECT);

        expect(session.migrateLegacySession().activeProjectId).toBe(PROJECT);
        expect(localStorage.getItem('bookvoice.studio.activeProject')).toBeNull();
        expect(session.getActiveProjectId()).toBe(PROJECT);
    });

    it('does not let a legacy value override a real session', () => {
        session.setActiveProjectId(OTHER);
        localStorage.setItem('bookvoice.studio.activeProject', PROJECT);

        expect(session.migrateLegacySession().activeProjectId).toBe(OTHER);
    });

    it('survives unreadable or unwritable storage', () => {
        localStorage.setItem('bookvoice.studio.session', '{not json');
        expect(session.getActiveProjectId()).toBe('');
        expect(session.getWorkflow(PROJECT)).toBe('NARRATION');

        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('storage disabled');
        });
        // A session that cannot be saved must not break the page.
        expect(() => session.setActiveProjectId(PROJECT)).not.toThrow();
    });
});
