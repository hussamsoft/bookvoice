import { useCallback, useEffect, useRef, useState } from 'react';
import {
    bookAudiobookContentUrl,
    cancelBookAudiobook,
    cancelBookPreparation,
    createBookArchive,
    createBookAudiobook,
    createBookPreparation,
    getBookAudiobook,
    getBookPreparation,
} from '../utils/api';

/**
 * Whole-book actions for the Library view: prepare, save a .bookvoice
 * archive, and export an audiobook. Jobs are tracked per book id so rows can
 * show live progress; finished downloads trigger directly from here.
 *
 * Voice/language fall back to the user's saved defaults (null voice = the
 * server default voice, which is a supported configuration).
 */
export function useBookActions({ toast, getVoiceId, getLanguageId }) {
    const [jobs, setJobs] = useState({});
    const pollRefs = useRef({});
    const mountedRef = useRef(true);

    const setJob = useCallback((bookId, job) => {
        if (!mountedRef.current) return;
        setJobs((current) => {
            const next = { ...current };
            if (job) next[bookId] = job;
            else delete next[bookId];
            return next;
        });
    }, []);

    const stopPolling = useCallback((bookId) => {
        if (pollRefs.current[bookId]) {
            clearInterval(pollRefs.current[bookId]);
            delete pollRefs.current[bookId];
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        const polls = pollRefs.current;
        return () => {
            mountedRef.current = false;
            Object.values(polls).forEach((timer) => clearInterval(timer));
        };
    }, []);

    const prepareBook = useCallback(async (book) => {
        const bookId = book.id;
        try {
            const job = await createBookPreparation(bookId, getVoiceId() ?? null, getLanguageId() || 'en');
            setJob(bookId, {
                kind: 'prepare',
                label: 'Preparing',
                jobId: job.id,
                status: job.status,
                pagesDone: job.completedPages?.length ?? 0,
                pageCount: job.totalPages ?? book.pageCount ?? null,
            });
            toast.success(`Preparing “${book.title || 'book'}”. You can keep working meanwhile.`);
            stopPolling(bookId);
            pollRefs.current[bookId] = setInterval(async () => {
                try {
                    const next = await getBookPreparation(job.id);
                    if (!mountedRef.current) return;
                    if (next.status === 'COMPLETED' || next.status === 'FAILED' || next.status === 'CANCELLED') {
                        stopPolling(bookId);
                        setJob(bookId, null);
                        if (next.status === 'COMPLETED') {
                            toast.success(`“${book.title || 'Book'}” is prepared — export it any time.`);
                        } else if (next.status === 'FAILED') {
                            toast.error(next.error || 'Whole-book preparation failed.');
                        }
                        return;
                    }
                    setJob(bookId, {
                        kind: 'prepare',
                        label: 'Preparing',
                        jobId: job.id,
                        status: next.status,
                        pagesDone: next.completedPages?.length ?? 0,
                        pageCount: next.totalPages ?? book.pageCount ?? null,
                    });
                } catch {
                    // Transient poll failures are tolerable; the job keeps
                    // running server-side.
                }
            }, 1500);
        } catch (error) {
            toast.error(error.message || 'Could not start whole-book preparation.');
        }
    }, [toast, getVoiceId, getLanguageId, setJob, stopPolling]);

    const exportArchive = useCallback(async (book, profileId) => {
        try {
            const archive = await createBookArchive(book.id, profileId);
            const link = document.createElement('a');
            link.href = archive.downloadUrl;
            link.download = `${(book.title || 'book').replace(/\.(pdf|epub|txt|md)$/i, '')}.bookvoice`;
            document.body.appendChild(link);
            link.click();
            link.remove();
        } catch (error) {
            toast.error(error.message || 'Could not create the prepared-book file.');
        }
    }, [toast]);

    const exportAudiobook = useCallback(async (book, profileId) => {
        const bookId = book.id;
        try {
            const job = await createBookAudiobook(bookId, profileId);
            setJob(bookId, {
                kind: 'audiobook',
                label: 'Exporting audiobook',
                jobId: job.jobId,
                pagesDone: 0,
                pageCount: job.pageCount ?? book.pageCount ?? null,
            });
            const title = (book.title || 'book').replace(/\.(pdf|epub|txt|md)$/i, '');
            stopPolling(bookId);
            pollRefs.current[bookId] = setInterval(async () => {
                try {
                    const status = await getBookAudiobook(bookId, job.jobId);
                    if (!mountedRef.current) return;
                    if (status.status === 'COMPLETED') {
                        stopPolling(bookId);
                        setJob(bookId, null);
                        const link = document.createElement('a');
                        link.href = bookAudiobookContentUrl(bookId, job.jobId);
                        link.download = `${title}.m4b`;
                        document.body.appendChild(link);
                        link.click();
                        link.remove();
                        return;
                    }
                    if (status.status === 'FAILED' || status.status === 'CANCELLED') {
                        stopPolling(bookId);
                        setJob(bookId, null);
                        toast.error(status.error || 'The audiobook export failed.');
                        return;
                    }
                    setJob(bookId, {
                        kind: 'audiobook',
                        label: 'Exporting audiobook',
                        jobId: job.jobId,
                        pagesDone: status.pagesDone,
                        pageCount: status.pageCount,
                    });
                } catch (error) {
                    stopPolling(bookId);
                    if (mountedRef.current) {
                        setJob(bookId, null);
                        toast.error(error.message || 'The audiobook export failed.');
                    }
                }
            }, 1500);
        } catch (error) {
            toast.error(error.message || 'Could not start the audiobook export.');
        }
    }, [toast, setJob, stopPolling]);

    const cancelJob = useCallback(async (book) => {
        const job = jobs[book.id];
        if (!job) return;
        stopPolling(book.id);
        try {
            if (job.kind === 'audiobook') await cancelBookAudiobook(book.id, job.jobId);
            else await cancelBookPreparation(job.jobId);
        } catch {
            // A finished one-shot job may already be gone.
        }
        setJob(book.id, null);
    }, [jobs, stopPolling, setJob]);

    return { jobs, prepareBook, exportArchive, exportAudiobook, cancelJob };
}
