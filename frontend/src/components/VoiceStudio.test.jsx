import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from './Toast';
import VoiceStudio from './VoiceStudio';
import * as api from '../utils/api';

vi.mock('../utils/api', () => ({
    cancelStudioJob: vi.fn(),
    createStudioConversion: vi.fn(),
    createStudioProfile: vi.fn(),
    createStudioProject: vi.fn(),
    deleteStudioProject: vi.fn(),
    duplicateStudioProject: vi.fn(),
    getStudioProject: vi.fn(),
    getVoices: vi.fn(),
    listStudioProjects: vi.fn(),
    openStudioProjectFolder: vi.fn(),
    saveStudioOutput: vi.fn(),
    updateStudioProject: vi.fn(),
    uploadStudioSource: vi.fn(),
    waitForStudioJob: vi.fn(),
}));

const project = {
    id: 'a'.repeat(32),
    name: 'Demo voice project',
    activeWorkflow: 'NARRATION',
    script: 'The corrected sentence.',
    languageId: 'en',
    voiceId: null,
    generationSettings: { pace: 1, expression: 0.5, temperature: 0.8, guidance: null, seed: null },
    sources: [],
    repairs: [],
    outputs: [],
    jobs: [],
    diskBytes: 1024,
};

function renderStudio() {
    return render(<ToastProvider><VoiceStudio /></ToastProvider>);
}

describe('VoiceStudio', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.listStudioProjects.mockResolvedValue([project]);
        api.getStudioProject.mockResolvedValue(project);
        api.getVoices.mockResolvedValue([]);
        api.updateStudioProject.mockImplementation(async (_id, changes) => ({ ...project, ...changes }));
    });

    it('restores a project and exposes direct narration editing', async () => {
        renderStudio();

        expect(await screen.findByDisplayValue('The corrected sentence.')).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: /Create narration/i })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('tab', { name: /Repair media/i })).toBeInTheDocument();
    }, 15_000);

    it('offers media-derived voice cloning inside Create Narration', async () => {
        renderStudio();

        expect(await screen.findByRole('heading', { name: /Clone a voice from media/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Import voice audio or video/i })).toBeInTheDocument();
        expect(screen.getByText(/narrate anything you write in that imported voice/i)).toBeInTheDocument();
    }, 15_000);

    it('creates a profile from imported media and selects it for typed narration', async () => {
        const sourceProject = {
            ...project,
            sources: [{
                id: 'c'.repeat(32),
                fileName: 'interview.mp4',
                mediaType: 'VIDEO',
                durationSec: 12,
                waveformPeaks: [0.1, 0.4, 0.8, 0.3],
                originalUrl: '/api/studio/assets/video',
                previewUrl: '/api/studio/assets/video-preview',
                audioUrl: '/api/studio/assets/audio',
            }],
        };
        const completedJob = {
            id: 'd'.repeat(32),
            projectId: project.id,
            kind: 'VOICE_PROFILE',
            status: 'COMPLETED',
            progress: 1,
            result: { voiceId: 'interview_voice' },
        };
        api.listStudioProjects.mockResolvedValue([sourceProject]);
        api.getStudioProject.mockResolvedValue(sourceProject);
        api.getVoices.mockResolvedValue([{
            id: 'interview_voice',
            name: 'Interview Voice',
            sourceType: 'VIDEO',
            isLegacy: false,
        }]);
        api.createStudioProfile.mockResolvedValue({ ...completedJob, status: 'QUEUED', progress: 0 });
        api.waitForStudioJob.mockResolvedValue(completedJob);
        api.updateStudioProject.mockImplementation(async (_id, changes) => ({ ...sourceProject, ...changes }));

        renderStudio();
        expect(await screen.findByLabelText('Voice source video preview')).toHaveAttribute(
            'src',
            sourceProject.sources[0].previewUrl,
        );
        fireEvent.change(await screen.findByLabelText('Profile name'), { target: { value: 'Interview Voice' } });
        fireEvent.click(screen.getByLabelText(/I own or have permission/i));
        fireEvent.click(screen.getByRole('button', { name: /Create and use this voice/i }));

        await waitFor(() => expect(api.createStudioProfile).toHaveBeenCalledWith(project.id, expect.objectContaining({
            sourceId: sourceProject.sources[0].id,
            name: 'Interview Voice',
            consentConfirmed: true,
        })));
        await waitFor(() => expect(api.updateStudioProject).toHaveBeenCalledWith(project.id, { voiceId: 'interview_voice' }));
    }, 15_000);

    it('applies the settings derived from the imported recording', async () => {
        const suggestedSettings = { pace: 1.08, expression: 0.62, temperature: 0.8, guidance: null, seed: null };
        const sourceProject = {
            ...project,
            sources: [{
                id: 'c'.repeat(32),
                fileName: 'interview.wav',
                mediaType: 'AUDIO',
                durationSec: 12,
                waveformPeaks: [0.1, 0.4, 0.8, 0.3],
                originalUrl: '/api/studio/assets/audio',
                audioUrl: '/api/studio/assets/audio',
            }],
        };
        api.listStudioProjects.mockResolvedValue([sourceProject]);
        api.getStudioProject.mockResolvedValue(sourceProject);
        api.getVoices.mockResolvedValue([{ id: 'interview_voice', name: 'Interview Voice', isLegacy: false }]);
        api.createStudioProfile.mockResolvedValue({ id: 'd'.repeat(32), status: 'QUEUED', progress: 0 });
        api.waitForStudioJob.mockResolvedValue({
            id: 'd'.repeat(32),
            status: 'COMPLETED',
            progress: 1,
            result: { voiceId: 'interview_voice', suggestedSettings },
        });
        api.updateStudioProject.mockImplementation(async (_id, changes) => ({ ...sourceProject, ...changes }));

        renderStudio();
        fireEvent.change(await screen.findByLabelText('Profile name'), { target: { value: 'Interview Voice' } });
        fireEvent.click(screen.getByLabelText(/I own or have permission/i));
        fireEvent.click(screen.getByRole('button', { name: /Create and use this voice/i }));

        await waitFor(() => expect(api.updateStudioProject).toHaveBeenCalledWith(project.id, {
            voiceId: 'interview_voice',
            generationSettings: suggestedSettings,
        }));
    }, 15_000);

    it('switches the saved project workflow to Convert Voice', async () => {
        renderStudio();
        await screen.findByDisplayValue('The corrected sentence.');

        fireEvent.click(screen.getByRole('tab', { name: /Convert voice/i }));

        await waitFor(() => expect(api.updateStudioProject).toHaveBeenCalledWith(project.id, { activeWorkflow: 'CONVERSION' }));
        expect(await screen.findByRole('heading', { name: /Convert a recording into another voice/i })).toBeInTheDocument();
    }, 15_000);

    it('converts a selected recording into a saved voice without generation controls', async () => {
        const sourceId = 'c'.repeat(32);
        const conversionProject = {
            ...project,
            activeWorkflow: 'CONVERSION',
            voiceId: 'interview_voice',
            sources: [{
                id: sourceId,
                fileName: 'interview.wav',
                mediaType: 'AUDIO',
                durationSec: 12,
                waveformPeaks: [0.1, 0.4, 0.8, 0.3],
                originalUrl: '/api/studio/assets/audio',
                audioUrl: '/api/studio/assets/audio',
            }],
        };
        api.listStudioProjects.mockResolvedValue([conversionProject]);
        api.getStudioProject.mockResolvedValue(conversionProject);
        api.getVoices.mockResolvedValue([{ id: 'interview_voice', name: 'Interview Voice', isLegacy: false }]);
        api.createStudioConversion.mockResolvedValue({ id: 'e'.repeat(32), status: 'QUEUED', progress: 0 });
        api.waitForStudioJob.mockResolvedValue({
            id: 'e'.repeat(32),
            status: 'COMPLETED',
            progress: 1,
            result: { outputId: 'f'.repeat(32) },
        });

        renderStudio();
        await screen.findByRole('heading', { name: /Convert a recording into another voice/i });
        expect(screen.queryByLabelText(/Expression/i)).not.toBeInTheDocument();

        fireEvent.click(screen.getByLabelText(/I own or have permission/i));
        fireEvent.click(screen.getByRole('button', { name: /Convert to Interview Voice/i }));

        await waitFor(() => expect(api.createStudioConversion).toHaveBeenCalledWith(project.id, expect.objectContaining({
            sourceId,
            startSec: 0,
            endSec: 12,
            targetVoiceId: 'interview_voice',
            targetSourceId: null,
            consentConfirmed: true,
        })));
    }, 15_000);

    it('can take the target voice from a second recording instead of the library', async () => {
        const sourceId = 'c'.repeat(32);
        const targetId = 'd'.repeat(32);
        const media = (id, fileName) => ({
            id,
            fileName,
            mediaType: 'AUDIO',
            durationSec: 20,
            waveformPeaks: [0.2, 0.5, 0.9],
            originalUrl: `/api/studio/assets/${id}`,
            audioUrl: `/api/studio/assets/${id}`,
        });
        const conversionProject = {
            ...project,
            activeWorkflow: 'CONVERSION',
            sources: [media(sourceId, 'interview.wav'), media(targetId, 'target-speaker.wav')],
        };
        api.listStudioProjects.mockResolvedValue([conversionProject]);
        api.getStudioProject.mockResolvedValue(conversionProject);
        api.getVoices.mockResolvedValue([]);
        api.createStudioConversion.mockResolvedValue({ id: 'e'.repeat(32), status: 'QUEUED', progress: 0 });
        api.waitForStudioJob.mockResolvedValue({ id: 'e'.repeat(32), status: 'COMPLETED', progress: 1, result: {} });

        renderStudio();
        await screen.findByRole('heading', { name: /Convert a recording into another voice/i });

        fireEvent.change(screen.getByLabelText('Recording to convert'), { target: { value: sourceId } });
        fireEvent.click(screen.getByRole('radio', { name: /Another recording/i }));
        fireEvent.change(screen.getByLabelText('Voice reference recording'), { target: { value: targetId } });
        fireEvent.click(screen.getByLabelText(/I own or have permission/i));
        fireEvent.click(screen.getByRole('button', { name: /Convert this recording/i }));

        await waitFor(() => expect(api.createStudioConversion).toHaveBeenCalledWith(project.id, expect.objectContaining({
            sourceId,
            targetVoiceId: null,
            targetSourceId: targetId,
            targetStartSec: 0,
            targetEndSec: 20,
            consentConfirmed: true,
        })));
    }, 15_000);

    it('blocks conversion until consent and a target voice are provided', async () => {
        const conversionProject = {
            ...project,
            activeWorkflow: 'CONVERSION',
            voiceId: null,
            sources: [{
                id: 'c'.repeat(32),
                fileName: 'interview.wav',
                mediaType: 'AUDIO',
                durationSec: 12,
                waveformPeaks: [0.1, 0.4],
                originalUrl: '/api/studio/assets/audio',
                audioUrl: '/api/studio/assets/audio',
            }],
        };
        api.listStudioProjects.mockResolvedValue([conversionProject]);
        api.getStudioProject.mockResolvedValue(conversionProject);
        api.getVoices.mockResolvedValue([]);

        renderStudio();
        await screen.findByRole('heading', { name: /Convert a recording into another voice/i });

        const convert = screen.getByRole('button', { name: /Convert this recording/i });
        expect(convert).toBeDisabled();

        fireEvent.click(screen.getByLabelText(/I own or have permission/i));
        expect(convert).toBeDisabled();
        expect(api.createStudioConversion).not.toHaveBeenCalled();
    }, 15_000);

    it('switches the saved project workflow to Repair Media', async () => {
        renderStudio();
        await screen.findByDisplayValue('The corrected sentence.');

        fireEvent.click(screen.getByRole('tab', { name: /Repair media/i }));

        await waitFor(() => expect(api.updateStudioProject).toHaveBeenCalledWith(project.id, { activeWorkflow: 'REPAIR' }));
        expect(await screen.findByRole('heading', { name: 'Media source' })).toBeInTheDocument();
    }, 15_000);

    it('flushes an edited script when focus leaves the editor', async () => {
        renderStudio();
        const editor = await screen.findByDisplayValue('The corrected sentence.');

        fireEvent.change(editor, { target: { value: 'Saved before switching.' } });
        fireEvent.blur(editor);

        await waitFor(() => expect(api.updateStudioProject).toHaveBeenCalledWith(project.id, { script: 'Saved before switching.' }));
    }, 15_000);

    it('reconnects to a persistent running job after reopening', async () => {
        const runningJob = {
            id: 'b'.repeat(32),
            projectId: project.id,
            kind: 'NARRATION',
            status: 'RUNNING',
            progress: 0.4,
            message: 'Generating narration',
        };
        const runningProject = { ...project, jobs: [runningJob] };
        api.listStudioProjects.mockResolvedValue([runningProject]);
        api.getStudioProject
            .mockResolvedValueOnce(runningProject)
            .mockResolvedValueOnce({ ...runningProject, jobs: [{ ...runningJob, status: 'COMPLETED', progress: 1 }] });
        api.waitForStudioJob.mockResolvedValue({ ...runningJob, status: 'COMPLETED', progress: 1, result: {} });

        renderStudio();

        await waitFor(() => expect(api.waitForStudioJob).toHaveBeenCalledWith(
            runningJob.id,
            expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) }),
        ));
    }, 15_000);

    it('explains what increasing and decreasing every delivery control does', async () => {
        renderStudio();

        expect(await screen.findByText(/Slower keeps the original pitch/i)).toBeInTheDocument();
        expect(screen.getByText(/Calmer delivery/i)).toBeInTheDocument();
        expect(screen.getByText(/More animated delivery/i)).toBeInTheDocument();
        expect(screen.getByText(/More consistent/i)).toBeInTheDocument();
        expect(screen.getByText(/More varied/i)).toBeInTheDocument();
        expect(screen.getByText(/Lower guidance gives the voice more freedom/i)).toBeInTheDocument();
    }, 15_000);

    it('saves generated output automatically and opens the managed project folder', async () => {
        const outputProject = {
            ...project,
            outputs: [{
                id: 'f'.repeat(32),
                kind: 'NARRATION',
                fileName: 'Demo voice project.wav',
                format: 'WAV',
                durationSec: 2,
                contentUrl: '/api/studio/output.wav',
            }],
        };
        api.listStudioProjects.mockResolvedValue([outputProject]);
        api.getStudioProject.mockResolvedValue(outputProject);
        api.saveStudioOutput.mockResolvedValue({
            id: 'e'.repeat(32),
            projectId: project.id,
            kind: 'SAVE_OUTPUT',
            status: 'QUEUED',
            progress: 0,
        });
        api.waitForStudioJob.mockResolvedValue({
            id: 'e'.repeat(32),
            status: 'COMPLETED',
            progress: 1,
            result: { fileName: 'Demo voice project.wav', destination: 'Downloads' },
        });
        api.openStudioProjectFolder.mockResolvedValue({ opened: true });

        renderStudio();
        fireEvent.click(await screen.findByRole('button', { name: /Save narration to Downloads/i }));
        await waitFor(() => expect(api.saveStudioOutput).toHaveBeenCalledWith(
            project.id,
            outputProject.outputs[0].id,
        ));

        fireEvent.click(screen.getByRole('button', { name: /Open Demo voice project folder/i }));
        await waitFor(() => expect(api.openStudioProjectFolder).toHaveBeenCalledWith(project.id));
    }, 15_000);
});
