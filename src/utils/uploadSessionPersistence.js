/**
 * @flow
 * @file Utility for persisting and restoring upload sessions
 * @author Box
 */

import LocalStore from './LocalStore';

const STORAGE_KEY_PREFIX = 'box_upload_session';
const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type PersistedUploadSession = {
    sessionId: string,
    fileName: string,
    fileSize: number,
    fileLastModified: ?number,
    folderId: string,
    fileId: ?string,
    bytesUploaded: number,
    timestamp: number,
    uploadHost: ?string,
    apiHost: ?string,
};

const localStore = new LocalStore();

/**
 * Generate a unique key for an upload session
 *
 * @param {string} sessionId - The upload session ID
 * @return {string}
 */
function getSessionKey(sessionId: string): string {
    return `${STORAGE_KEY_PREFIX}_${sessionId}`;
}

/**
 * Get all persisted upload session keys
 *
 * @return {Array<string>}
 */
function getAllSessionKeys(): Array<string> {
    const keys: Array<string> = [];
    if (!localStore.isLocalStorageAvailable) {
        return keys;
    }

    try {
        const localStorage = window.localStorage;
        const prefix = localStore.buildKey(STORAGE_KEY_PREFIX);
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (key && key.startsWith(prefix)) {
                // Extract the session ID from the key
                const sessionId = key.replace(prefix + '_', '');
                keys.push(sessionId);
            }
        }
    } catch (e) {
        // no-op
    }

    return keys;
}

/**
 * Persist an upload session to localStorage
 *
 * @param {Object} sessionData - Session data to persist
 * @param {string} sessionData.sessionId - Upload session ID
 * @param {string} sessionData.fileName - File name
 * @param {number} sessionData.fileSize - File size in bytes
 * @param {number} [sessionData.fileLastModified] - File last modified timestamp
 * @param {string} sessionData.folderId - Folder ID where file is being uploaded
 * @param {string} [sessionData.fileId] - File ID if updating existing file
 * @param {number} [sessionData.bytesUploaded] - Bytes already uploaded
 * @param {string} [sessionData.uploadHost] - Upload host URL
 * @param {string} [sessionData.apiHost] - API host URL
 * @return {void}
 */
export function persistUploadSession({
    sessionId,
    fileName,
    fileSize,
    fileLastModified,
    folderId,
    fileId,
    bytesUploaded = 0,
    uploadHost,
    apiHost,
}: {
    sessionId: string,
    fileName: string,
    fileSize: number,
    fileLastModified?: number,
    folderId: string,
    fileId?: string,
    bytesUploaded?: number,
    uploadHost?: string,
    apiHost?: string,
}): void {
    if (!sessionId) {
        return;
    }

    const sessionData: PersistedUploadSession = {
        sessionId,
        fileName,
        fileSize,
        fileLastModified: fileLastModified || null,
        folderId,
        fileId: fileId || null,
        bytesUploaded,
        timestamp: Date.now(),
        uploadHost: uploadHost || null,
        apiHost: apiHost || null,
    };

    localStore.setItem(getSessionKey(sessionId), sessionData);
}

/**
 * Update the bytes uploaded for a persisted session
 *
 * @param {string} sessionId - Upload session ID
 * @param {number} bytesUploaded - Bytes uploaded so far
 * @return {void}
 */
export function updatePersistedSessionProgress(sessionId: string, bytesUploaded: number): void {
    if (!sessionId) {
        return;
    }

    const sessionData = getPersistedSession(sessionId);
    if (sessionData) {
        persistUploadSession({
            ...sessionData,
            bytesUploaded,
        });
    }
}

/**
 * Get a persisted upload session
 *
 * @param {string} sessionId - Upload session ID
 * @return {?PersistedUploadSession}
 */
export function getPersistedSession(sessionId: string): ?PersistedUploadSession {
    if (!sessionId) {
        return null;
    }

    const sessionData = localStore.getItem(getSessionKey(sessionId));
    if (!sessionData) {
        return null;
    }

    // Check if session has expired
    const now = Date.now();
    if (sessionData.timestamp && now - sessionData.timestamp > SESSION_EXPIRY_MS) {
        removePersistedSession(sessionId);
        return null;
    }

    return sessionData;
}

/**
 * Get all persisted upload sessions
 *
 * @return {Array<PersistedUploadSession>}
 */
export function getAllPersistedSessions(): Array<PersistedUploadSession> {
    const sessionIds = getAllSessionKeys();
    const sessions: Array<PersistedUploadSession> = [];

    sessionIds.forEach(sessionId => {
        const session = getPersistedSession(sessionId);
        if (session) {
            sessions.push(session);
        }
    });

    return sessions;
}

/**
 * Find a persisted session matching file metadata
 *
 * @param {Object} fileMetadata - File metadata to match
 * @param {string} fileMetadata.name - File name
 * @param {number} fileMetadata.size - File size
 * @param {number} [fileMetadata.lastModified] - File last modified timestamp
 * @param {string} [fileMetadata.folderId] - Folder ID
 * @return {?PersistedUploadSession}
 */
export function findMatchingPersistedSession({
    name,
    size,
    lastModified,
    folderId,
}: {
    name: string,
    size: number,
    lastModified?: number,
    folderId?: string,
}): ?PersistedUploadSession {
    const sessions = getAllPersistedSessions();

    // Find sessions matching file name and size
    const matchingSessions = sessions.filter(session => {
        const nameMatch = session.fileName === name;
        const sizeMatch = session.fileSize === size;
        const folderMatch = !folderId || session.folderId === folderId;

        // If lastModified is provided, try to match it (with some tolerance for browser differences)
        let lastModifiedMatch = true;
        if (lastModified && session.fileLastModified) {
            // Allow 1 second difference due to browser precision differences
            const diff = Math.abs(lastModified - session.fileLastModified);
            lastModifiedMatch = diff < 1000;
        }

        return nameMatch && sizeMatch && folderMatch && lastModifiedMatch;
    });

    // Return the most recent matching session
    if (matchingSessions.length > 0) {
        return matchingSessions.sort((a, b) => b.timestamp - a.timestamp)[0];
    }

    return null;
}

/**
 * Remove a persisted upload session
 *
 * @param {string} sessionId - Upload session ID
 * @return {void}
 */
export function removePersistedSession(sessionId: string): void {
    if (!sessionId) {
        return;
    }

    localStore.removeItem(getSessionKey(sessionId));
}

/**
 * Remove all persisted upload sessions
 *
 * @return {void}
 */
export function clearAllPersistedSessions(): void {
    const sessionIds = getAllSessionKeys();
    sessionIds.forEach(sessionId => {
        removePersistedSession(sessionId);
    });
}

/**
 * Clean up expired sessions
 *
 * @return {void}
 */
export function cleanupExpiredSessions(): void {
    const sessionIds = getAllSessionKeys();
    const now = Date.now();

    sessionIds.forEach(sessionId => {
        const session = localStore.getItem(getSessionKey(sessionId));
        if (session && session.timestamp && now - session.timestamp > SESSION_EXPIRY_MS) {
            removePersistedSession(sessionId);
        }
    });
}

