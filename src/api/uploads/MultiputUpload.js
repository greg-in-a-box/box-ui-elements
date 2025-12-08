/**
 * @flow
 * @file Multiput upload
 * @author Box
 */

import noop from 'lodash/noop';
import isNaN from 'lodash/isNaN';
import { getFileLastModifiedAsISONoMSIfPossible, getBoundedExpBackoffRetryDelay } from '../../utils/uploads';
import { retryNumOfTimes } from '../../utils/function';
import { digest } from '../../utils/webcrypto';
import hexToBase64 from '../../utils/base64';
import createWorker from '../../utils/uploadsSHA1Worker';
import Browser from '../../utils/Browser';
import {
    DEFAULT_RETRY_DELAY_MS,
    ERROR_CODE_UPLOAD_STORAGE_LIMIT_EXCEEDED,
    HTTP_STATUS_CODE_FORBIDDEN,
    MS_IN_S,
} from '../../constants';
import {
    persistUploadSession,
    updatePersistedSessionProgress,
    removePersistedSession,
} from '../../utils/uploadSessionPersistence';
import { updateQueryParameters } from '../../utils/url';
import MultiputPart, {
    PART_STATE_UPLOADED,
    PART_STATE_UPLOADING,
    PART_STATE_DIGEST_READY,
    PART_STATE_NOT_STARTED,
} from './MultiputPart';
import BaseMultiput from './BaseMultiput';
import type { MultiputConfig } from '../../common/types/upload';
import type { StringAnyMap } from '../../common/types/core';
import type { APIOptions } from '../../common/types/api';

// Constants used for specifying log event types.

// This type is a catch-all for create session errors that aren't 5xx's (for which we'll do
// retries) and aren't specific 4xx's we know how to specifically handle (e.g. out of storage).
const LOG_EVENT_TYPE_CREATE_SESSION_MISC_ERROR = 'create_session_misc_error';
const LOG_EVENT_TYPE_CREATE_SESSION_RETRIES_EXCEEDED = 'create_session_retries_exceeded';
const LOG_EVENT_TYPE_FILE_CHANGED_DURING_UPLOAD = 'file_changed_during_upload';
const LOG_EVENT_TYPE_PART_UPLOAD_RETRIES_EXCEEDED = 'part_upload_retries_exceeded';
const LOG_EVENT_TYPE_COMMIT_RETRIES_EXCEEDED = 'commit_retries_exceeded';
const LOG_EVENT_TYPE_WEB_WORKER_ERROR = 'web_worker_error';
const LOG_EVENT_TYPE_FILE_READER_RECEIVED_NOT_FOUND_ERROR = 'file_reader_received_not_found_error';
const LOG_EVENT_TYPE_PART_DIGEST_RETRIES_EXCEEDED = 'part_digest_retries_exceeded';

class MultiputUpload extends BaseMultiput {
    clientId: ?string;

    commitRetryCount: number;

    createSessionNumRetriesPerformed: number;

    destinationFileId: ?string;

    folderId: string;

    fileSha1: ?string;

    firstUnuploadedPartIndex: number;

    initialFileLastModified: ?string;

    initialFileSize: number;

    isResumableUploadsEnabled: boolean;

    successCallback: Function;

    progressCallback: Function;

    options: APIOptions;

    partSize: number;

    parts: Array<MultiputPart>;

    numPartsDigestComputing: number;

    numPartsDigestReady: number;

    numPartsNotStarted: number;

    numPartsUploaded: number;

    numPartsUploading: number;

    numResumeRetries: number;

    sessionEndpoints: Object;

    sessionId: string;

    totalUploadedBytes: number;

    sha1Worker: Worker;

    createSessionTimeout: TimeoutID;

    commitSessionTimeout: TimeoutID;

    /**
     * [constructor]
     *
     * @param {Options} options
     * @param {MultiputConfig} [config]
     */
    constructor(options: APIOptions, config?: MultiputConfig) {
        super(
            options,
            {
                createSession: null,
                uploadPart: null,
                listParts: null,
                commit: null,
                abort: null,
                logEvent: null,
            },
            config,
        );
        this.parts = [];
        this.options = options;
        this.fileSha1 = null;
        this.totalUploadedBytes = 0;
        this.numPartsNotStarted = 0; // # of parts yet to be processed
        this.numPartsDigestComputing = 0; // # of parts sent to the digest worker
        this.numPartsDigestReady = 0; // # of parts with digest finished that are waiting to be uploaded.
        this.numPartsUploading = 0; // # of parts with upload requests currently inflight
        this.numPartsUploaded = 0; // # of parts successfully uploaded
        this.firstUnuploadedPartIndex = 0; // Index of first part that hasn't been uploaded yet.
        this.createSessionNumRetriesPerformed = 0;
        this.partSize = 0;
        this.commitRetryCount = 0;
        this.clientId = null;
        this.isResumableUploadsEnabled = false;
        this.numResumeRetries = 0;
    }

    /**
     * Reset values for uploading process.
     */
    reset() {
        this.parts = [];
        this.fileSha1 = null;
        this.totalUploadedBytes = 0;
        this.numPartsNotStarted = 0; // # of parts yet to be processed
        this.numPartsDigestComputing = 0; // # of parts sent to the digest worker
        this.numPartsDigestReady = 0; // # of parts with digest finished that are waiting to be uploaded.
        this.numPartsUploading = 0; // # of parts with upload requests currently inflight
        this.numPartsUploaded = 0; // # of parts successfully uploaded
        this.firstUnuploadedPartIndex = 0; // Index of first part that hasn't been uploaded yet.
        this.createSessionNumRetriesPerformed = 0;
        this.partSize = 0;
        this.commitRetryCount = 0;
        this.numResumeRetries = 0;
    }

    /**
     * Set information about file being uploaded
     *
     *
     * @param {Object} options
     * @param {File} options.file
     * @param {string} options.folderId - Untyped folder id (e.g. no "folder_" prefix)
     * @param {string} [options.fileId] - Untyped file id (e.g. no "file_" prefix)
     * @param {string} options.sessionId
     * @param {Function} [options.errorCallback]
     * @param {Function} [options.progressCallback]
     * @param {Function} [options.successCallback]
     * @return {void}
     */
    setFileInfo({
        file,
        folderId,
        errorCallback,
        progressCallback,
        successCallback,
        // $FlowFixMe
        overwrite = true,
        conflictCallback,
        fileId,
    }: {
        conflictCallback?: Function,
        errorCallback?: Function,
        file: File,
        fileId: ?string,
        folderId: string,
        overwrite?: boolean | 'error',
        progressCallback?: Function,
        successCallback?: Function,
    }): void {
        this.file = file;
        this.fileName = this.file.name;
        this.folderId = folderId;
        this.errorCallback = errorCallback || noop;
        this.progressCallback = progressCallback || noop;
        this.successCallback = successCallback || noop;
        this.overwrite = overwrite;
        this.conflictCallback = conflictCallback;
        this.fileId = fileId;
    }

    /**
     * Upload a given file
     *
     *
     * @param {Object} options
     * @param {File} options.file
     * @param {string} options.folderId - Untyped folder id (e.g. no "folder_" prefix)
     * @param {string} [options.fileId] - Untyped file id (e.g. no "file_" prefix)
     * @param {Function} [options.errorCallback]
     * @param {Function} [options.progressCallback]
     * @param {Function} [options.successCallback]
     * @return {void}
     */
    upload({
        file,
        fileDescription,
        folderId,
        errorCallback,
        progressCallback,
        successCallback,
        // $FlowFixMe
        overwrite = true,
        conflictCallback,
        fileId,
    }: {
        conflictCallback?: Function,
        errorCallback?: Function,
        file: File,
        fileDescription: ?string,
        fileId: ?string,
        folderId: string,
        overwrite?: boolean | 'error',
        progressCallback?: Function,
        successCallback?: Function,
    }): void {
        /* eslint-disable no-console */
        console.log('[MultiputUpload] 📤 Starting upload', {
            fileName: file.name,
            fileSize: file.size,
            fileSizeMB: (file.size / 1024 / 1024).toFixed(2),
            folderId,
            fileId: fileId || 'new file',
            overwrite,
        });
        /* eslint-enable no-console */

        this.file = file;
        this.fileName = this.file.name;
        // These values are used as part of our (best effort) attempt to abort uploads if we detect
        // a file change during the upload.
        this.initialFileSize = this.file.size;
        this.initialFileLastModified = getFileLastModifiedAsISONoMSIfPossible(this.file);
        this.folderId = folderId;
        this.errorCallback = errorCallback || noop;
        this.progressCallback = progressCallback || noop;
        this.successCallback = successCallback || noop;

        /* eslint-disable no-console */
        console.log('[MultiputUpload] 🔧 Creating SHA-1 worker for file digest computation');
        console.log('[MultiputUpload] 🚀 Step 1: Making preflight request to get upload URL');
        /* eslint-enable no-console */
        this.sha1Worker = createWorker();
        this.sha1Worker.addEventListener('message', this.onWorkerMessage);
        /* eslint-disable no-console */
        console.log('[MultiputUpload] ✅ SHA-1 worker created and message listener attached');
        /* eslint-enable no-console */

        this.conflictCallback = conflictCallback;
        this.overwrite = overwrite;
        this.fileId = fileId;
        this.fileDescription = fileDescription;

        this.makePreflightRequest();
    }

    /**
     * Update uploadHost with preflight response and return the base uploadUrl
     *
     * @private
     * @param {Object} response
     * @param {Object} [response.data]
     * @return {string}
     */
    getBaseUploadUrlFromPreflightResponse = ({ data }: { data: { upload_url?: string } }) => {
        if (!data || !data.upload_url) {
            return this.getBaseUploadUrl();
        }

        const splitUrl = data.upload_url.split('/');
        // splitUrl[0] is the protocol (e.g., https:), splitUrl[2] is hostname (e.g., www.box.com)
        this.uploadHost = `${splitUrl[0]}//${splitUrl[2]}`;
        return this.getBaseUploadUrl();
    };

    /**
     * Creates upload session. If a file ID is supplied, use the Chunked Upload File Version
     * API to replace the file.
     *
     * @private
     * @return {void}
     */
    preflightSuccessHandler = async (preflightResponse: Object): Promise<any> => {
        if (this.isDestroyed()) {
            return;
        }

        /* eslint-disable no-console */
        console.log('[MultiputUpload] ✅ Preflight request successful');
        /* eslint-enable no-console */
        const uploadUrl = this.getBaseUploadUrlFromPreflightResponse(preflightResponse);
        let createSessionUrl = `${uploadUrl}/files/upload_sessions`;

        // Parallelism is currently detrimental to multiput upload performance in Zones, so set it to 1.
        if (createSessionUrl.includes('fupload-ec2')) {
            this.config.parallelism = 1;
            /* eslint-disable no-console */
            console.log('[MultiputUpload] ⚙️ Detected EC2 zone, setting parallelism to 1');
            /* eslint-enable no-console */
        }

        // Set up post body
        const postData: StringAnyMap = {
            file_size: this.file.size,
            file_name: this.fileName,
        };

        if (this.fileId) {
            createSessionUrl = createSessionUrl.replace('upload_sessions', `${this.fileId}/upload_sessions`);
            /* eslint-disable no-console */
            console.log('[MultiputUpload] 📝 Uploading new version of existing file:', this.fileId);
            /* eslint-enable no-console */
        } else {
            postData.folder_id = this.folderId;
            /* eslint-disable no-console */
            console.log('[MultiputUpload] 📁 Uploading new file to folder:', this.folderId);
            /* eslint-enable no-console */
        }

        /* eslint-disable no-console */
        console.log('[MultiputUpload] 🚀 Step 2: Creating upload session', {
            url: createSessionUrl,
            fileSize: this.file.size,
            fileName: this.fileName,
        });
        /* eslint-enable no-console */

        try {
            const response = await this.xhr.post({
                url: createSessionUrl,
                data: postData,
            });
            this.createSessionSuccessHandler(response.data);
        } catch (error) {
            const errorData = this.getErrorResponse(error);

            if (errorData && errorData.status >= 500 && errorData.status < 600) {
                this.createSessionErrorHandler(error);
                return;
            }

            // Recover from 409 session_conflict.  The server will return the session information
            // in context_info, so treat it as a success.
            if (errorData && errorData.status === 409 && errorData.code === 'session_conflict') {
                this.createSessionSuccessHandler(errorData.context_info.session);
                return;
            }

            if (
                (errorData &&
                    errorData.status === HTTP_STATUS_CODE_FORBIDDEN &&
                    errorData.code === ERROR_CODE_UPLOAD_STORAGE_LIMIT_EXCEEDED) ||
                (errorData.status === HTTP_STATUS_CODE_FORBIDDEN &&
                    errorData.code === 'access_denied_insufficient_permissions')
            ) {
                this.errorCallback(errorData);
                return;
            }

            if (errorData && errorData.status === 409) {
                if (this.overwrite === 'error') {
                    this.errorCallback(errorData);
                    return;
                }
                this.resolveConflict(errorData);
                this.createSessionRetry();
                return;
            }

            // All other cases get treated as an upload failure.
            this.sessionErrorHandler(error, LOG_EVENT_TYPE_CREATE_SESSION_MISC_ERROR, JSON.stringify(error));
        }
    };

    /**
     * Create session error handler.
     * Retries the create session request or fails the upload.
     *
     * @private
     * @param {Error} error
     * @return {void}
     */
    createSessionErrorHandler = (error: Error): void => {
        if (this.isDestroyed()) {
            return;
        }

        if (this.createSessionNumRetriesPerformed < this.config.retries) {
            this.createSessionRetry();
            return;
        }

        this.consoleLog('Too many create session failures, failing upload');
        this.sessionErrorHandler(error, LOG_EVENT_TYPE_CREATE_SESSION_RETRIES_EXCEEDED, JSON.stringify(error));
    };

    /**
     * Schedule a retry for create session request upon failure
     *
     * @private
     * @return {void}
     */
    createSessionRetry(): void {
        const retryDelayMs = getBoundedExpBackoffRetryDelay(
            this.config.initialRetryDelayMs,
            this.config.maxRetryDelayMs,
            this.createSessionNumRetriesPerformed,
        );
        this.createSessionNumRetriesPerformed += 1;
        this.consoleLog(`Retrying create session in ${retryDelayMs} ms`);
        this.createSessionTimeout = setTimeout(this.makePreflightRequest, retryDelayMs);
    }

    /**
     * Handles a upload session success response
     *
     * @private
     * @param {Object} data - Upload session creation success data
     * @return {void}
     */
    createSessionSuccessHandler(data: any): void {
        if (this.isDestroyed()) {
            return;
        }

        const { id, part_size, session_endpoints } = data;

        this.sessionId = id;
        this.partSize = part_size;
        this.sessionEndpoints = {
            ...this.sessionEndpoints,
            uploadPart: session_endpoints.upload_part,
            listParts: session_endpoints.list_parts,
            commit: session_endpoints.commit,
            abort: session_endpoints.abort,
            logEvent: session_endpoints.log_event,
        };

        const numParts = Math.ceil(this.file.size / part_size);
        /* eslint-disable no-console */
        console.log('[MultiputUpload] ✅ Upload session created', {
            sessionId: this.sessionId,
            partSize: part_size,
            partSizeMB: (part_size / 1024 / 1024).toFixed(2),
            totalParts: numParts,
            fileSize: this.file.size,
            fileSizeMB: (this.file.size / 1024 / 1024).toFixed(2),
        });
        /* eslint-enable no-console */

        // Persist session information for resumability after page reload
        if (this.isResumableUploadsEnabled && this.sessionId && this.file) {
            const fileLastModified = this.file.lastModified || (this.initialFileLastModified ? new Date(this.initialFileLastModified).getTime() : undefined);
            persistUploadSession({
                sessionId: this.sessionId,
                fileName: this.fileName,
                fileSize: this.file.size,
                fileLastModified,
                folderId: this.folderId,
                fileId: this.fileId || undefined,
                bytesUploaded: this.totalUploadedBytes,
                uploadHost: this.uploadHost,
                apiHost: this.options.apiHost,
            });
            /* eslint-disable no-console */
            console.log('[MultiputUpload] 💾 Session persisted to localStorage for resume capability');
            /* eslint-enable no-console */
        }

        /* eslint-disable no-console */
        console.log('[MultiputUpload] 🚀 Step 3: Populating parts array');
        /* eslint-enable no-console */
        this.populateParts();
        /* eslint-disable no-console */
        console.log('[MultiputUpload] 🚀 Step 4: Starting to process parts');
        /* eslint-enable no-console */
        this.processNextParts();
    }

    /**
     * Resume uploading the given file
     *
     *
     * @param {Object} options
     * @param {File} options.file
     * @param {string} options.folderId - Untyped folder id (e.g. no "folder_" prefix)
     * @param {string} [options.fileId] - Untyped file id (e.g. no "file_" prefix)
     * @param {string} options.sessionId
     * @param {Function} [options.errorCallback]
     * @param {Function} [options.progressCallback]
     * @param {Function} [options.successCallback]
     * @param {Function} [options.conflictCallback]
     * @return {void}
     */
    resume({
        file,
        folderId,
        errorCallback,
        progressCallback,
        sessionId,
        successCallback,
        // $FlowFixMe
        overwrite = true,
        conflictCallback,
        fileId,
    }: {
        conflictCallback?: Function,
        errorCallback?: Function,
        file: File,
        fileId: ?string,
        folderId: string,
        overwrite?: boolean | 'error',
        progressCallback?: Function,
        sessionId: string,
        successCallback?: Function,
    }): void {
        /* eslint-disable no-console */
        console.log('[MultiputUpload] 🔄 Resuming upload', {
            fileName: file.name,
            fileSize: file.size,
            fileSizeMB: (file.size / 1024 / 1024).toFixed(2),
            sessionId,
            folderId,
            fileId: fileId || 'new file',
        });
        /* eslint-enable no-console */

        this.setFileInfo({
            file,
            folderId,
            errorCallback,
            progressCallback,
            successCallback,
            conflictCallback,
            overwrite,
            fileId,
        });
        this.sessionId = sessionId;

        if (!this.sha1Worker) {
            /* eslint-disable no-console */
            console.log('[MultiputUpload] 🔧 Creating SHA-1 worker for resume');
            /* eslint-enable no-console */
            this.sha1Worker = createWorker();
        }
        this.sha1Worker.addEventListener('message', this.onWorkerMessage);
        /* eslint-disable no-console */
        console.log('[MultiputUpload] ✅ SHA-1 worker ready for resume');
        /* eslint-enable no-console */

        /* eslint-disable no-console */
        console.log('[MultiputUpload] 🔍 Getting session info from server');
        /* eslint-enable no-console */
        this.getSessionInfo();
    }

    /**
     * Get session information from API.
     * Uses session info to commit a complete session or continue an in-progress session.
     *
     * @private
     * @return {void}
     */
    getSessionInfo = async (): Promise<any> => {
        const uploadUrl = this.getBaseUploadUrl();
        const sessionUrl = `${uploadUrl}/files/upload_sessions/${this.sessionId}`;
        /* eslint-disable no-console */
        console.log('[MultiputUpload] 📡 Fetching session info', { sessionUrl });
        /* eslint-enable no-console */
        try {
            const response = await this.xhr.get({ url: sessionUrl });
            /* eslint-disable no-console */
            console.log('[MultiputUpload] ✅ Session info retrieved');
            /* eslint-enable no-console */
            this.getSessionSuccessHandler(response.data);
        } catch (error) {
            /* eslint-disable no-console */
            console.error('[MultiputUpload] ❌ Failed to get session info', error);
            /* eslint-enable no-console */
            this.getSessionErrorHandler(error);
        }
    };

    /**
     * Handles a getSessionInfo success and either commits the session or continues to process
     * the parts that still need to be uploaded.
     *
     * @param response
     * @return {void}
     */
    getSessionSuccessHandler = async (data: any): Promise<void> => {
        const { part_size, session_endpoints } = data;

        // Set session information gotten from API response
        this.partSize = part_size;
        this.sessionEndpoints = {
            ...this.sessionEndpoints,
            uploadPart: session_endpoints.upload_part,
            listParts: session_endpoints.list_parts,
            commit: session_endpoints.commit,
            abort: session_endpoints.abort,
            logEvent: session_endpoints.log_event,
        };

        /* eslint-disable no-console */
        console.log('[MultiputUpload] ✅ Session endpoints configured, checking uploaded parts');
        /* eslint-enable no-console */

        // When resuming, check which parts are already uploaded on the server
        // This handles the case where a part was in the middle of uploading when interrupted
        // IMPORTANT: We must await this to ensure parts are marked before processing
        await this.checkAndMarkUploadedParts();
    };

    /**
     * Check which parts are already uploaded on the server and mark them accordingly.
     * This is important when resuming an upload that was interrupted mid-part.
     *
     * @private
     * @return {void}
     */
    checkAndMarkUploadedParts = async (): Promise<any> => {
        if (this.isDestroyed()) {
            return;
        }

        // Clear any existing parts before populating
        this.parts = [];
        this.numPartsNotStarted = 0;
        this.numPartsDigestComputing = 0;
        this.numPartsDigestReady = 0;
        this.numPartsUploading = 0;
        this.numPartsUploaded = 0;
        this.firstUnuploadedPartIndex = 0;
        this.totalUploadedBytes = 0;

        // First populate all parts
        this.populateParts();

        // If this is a resume (we have a sessionId), check which parts are already uploaded
        if (this.sessionId && this.sessionEndpoints.listParts) {
            try {
                /* eslint-disable no-console */
                console.log('[MultiputUpload] 🔍 Checking which parts are already uploaded on server');
                /* eslint-enable no-console */

                // Fetch all uploaded parts with pagination
                // Box API listParts supports limit/offset pagination
                const allUploadedParts = [];
                const limit = 1000; // Fetch up to 1000 parts at a time
                
                // Fetch first page to get structure
                const firstPageParams = { limit, offset: 0 };
                const firstPageUrl = updateQueryParameters(this.sessionEndpoints.listParts, firstPageParams);
                const firstResponse = await this.xhr.get({ url: firstPageUrl });

                /* eslint-disable no-console */
                console.log('[MultiputUpload] 📡 listParts API response structure:', {
                    hasData: !!firstResponse.data,
                    dataKeys: firstResponse.data ? Object.keys(firstResponse.data) : [],
                    fullResponse: JSON.stringify(firstResponse.data, null, 2),
                });
                /* eslint-enable no-console */

                const firstPageEntries = firstResponse.data?.entries || [];
                const totalCount = firstResponse.data?.total_count || 0;
                allUploadedParts.push(...firstPageEntries);

                /* eslint-disable no-console */
                console.log('[MultiputUpload] 📋 Fetched first page', {
                    entriesInPage: firstPageEntries.length,
                    totalFetched: allUploadedParts.length,
                    totalCount,
                });
                /* eslint-enable no-console */

                // Fetch remaining pages if needed
                if (firstPageEntries.length === limit && allUploadedParts.length < totalCount) {
                    const remainingPages = Math.ceil((totalCount - allUploadedParts.length) / limit);
                    const pagePromises = [];
                    
                    for (let page = 1; page < remainingPages; page += 1) {
                        const pageOffset = page * limit;
                        const pageParams = { limit, offset: pageOffset };
                        const pageUrl = updateQueryParameters(this.sessionEndpoints.listParts, pageParams);
                        pagePromises.push(
                            this.xhr.get({ url: pageUrl }).then(response => {
                                const entries = response.data?.entries || [];
                                allUploadedParts.push(...entries);
                                /* eslint-disable no-console */
                                console.log('[MultiputUpload] 📋 Fetched parts page', {
                                    offset: pageOffset,
                                    entriesInPage: entries.length,
                                    totalFetched: allUploadedParts.length,
                                });
                                /* eslint-enable no-console */
                                return entries;
                            }),
                        );
                    }
                    
                    await Promise.all(pagePromises);
                }

                /* eslint-disable no-console */
                console.log('[MultiputUpload] ✅ Fetched all uploaded parts from server', {
                    totalUploadedParts: allUploadedParts.length,
                    totalPartsExpected: this.parts.length,
                });

                // Log sample of uploaded parts to see structure
                if (allUploadedParts.length > 0) {
                    console.log('[MultiputUpload] 📋 Sample uploaded part from server:', {
                        firstPart: allUploadedParts[0],
                        allPartKeys: Object.keys(allUploadedParts[0] || {}),
                    });
                }

                // Log sample of local parts to see structure
                if (this.parts.length > 0) {
                    console.log('[MultiputUpload] 📋 Sample local part:', {
                        firstPart: {
                            index: this.parts[0].index,
                            offset: this.parts[0].offset,
                            partSize: this.parts[0].partSize,
                            rangeEnd: this.parts[0].rangeEnd,
                        },
                    });
                }
                /* eslint-enable no-console */
                
                // Create a map of uploaded parts by offset for quick lookup
                // Only include parts that have both offset and part_id (indicating successful upload)
                const uploadedPartsMap = new Map();
                allUploadedParts.forEach((part: any) => {
                    // Parts are identified by their offset
                    // Only consider parts with part_id as successfully uploaded
                    if (part.offset === undefined) {
                        /* eslint-disable no-console */
                        console.warn('[MultiputUpload] ⚠️ Uploaded part missing offset field:', part);
                        /* eslint-enable no-console */
                    } else if (!part.part_id) {
                        /* eslint-disable no-console */
                        console.warn('[MultiputUpload] ⚠️ Uploaded part missing part_id (not fully uploaded):', {
                            offset: part.offset,
                            part,
                        });
                        /* eslint-enable no-console */
                    } else {
                        // Only add parts that have both offset and part_id (successfully uploaded)
                        uploadedPartsMap.set(part.offset, part);
                    }
                });

                /* eslint-disable no-console */
                console.log('[MultiputUpload] 🔍 Matching parts by offset', {
                    uploadedPartsOffsets: Array.from(uploadedPartsMap.keys()).slice(0, 10),
                    localPartsOffsets: this.parts.slice(0, 10).map(p => p.offset),
                });
                /* eslint-enable no-console */

                let partsMarkedAsUploaded = 0;
                const unmatchedParts = [];
                const matchedParts = [];
                
                /* eslint-disable no-console */
                console.log('[MultiputUpload] 🔍 Starting part matching process', {
                    totalLocalParts: this.parts.length,
                    totalUploadedPartsFromServer: allUploadedParts.length,
                    uploadedOffsets: Array.from(uploadedPartsMap.keys()).sort((a, b) => a - b),
                });
                /* eslint-enable no-console */

                // Mark parts that are already uploaded on the server
                this.parts.forEach(part => {
                    const uploadedPart = uploadedPartsMap.get(part.offset);
                    if (uploadedPart && uploadedPart.part_id) {
                        // This part is already uploaded on the server (has part_id = successfully uploaded)
                        part.state = PART_STATE_UPLOADED;
                        // Ensure the part data includes offset and part_id for commit
                        // The server's uploadedPart should have part_id, and we use the local part's offset
                        part.data = {
                            part: {
                                ...uploadedPart,
                                offset: part.offset, // Ensure offset is set from local part
                            },
                        };
                        part.uploadedBytes = part.partSize;
                        // Store part_id for commit
                        if (uploadedPart.part_id) {
                            part.id = uploadedPart.part_id;
                        }
                        
                        // Update counters
                        this.numPartsNotStarted -= 1;
                        this.numPartsUploaded += 1;
                        this.totalUploadedBytes += part.partSize;
                        partsMarkedAsUploaded += 1;
                        
                        matchedParts.push({
                            index: part.index,
                            offset: part.offset,
                            partSize: part.partSize,
                            partId: uploadedPart.part_id,
                        });
                    } else {
                        // Part not found in uploaded list or missing part_id - needs to be uploaded
                        unmatchedParts.push({
                            index: part.index,
                            offset: part.offset,
                            partSize: part.partSize,
                            reason: uploadedPart ? 'missing part_id' : 'not in uploaded list',
                        });
                    }
                });

                /* eslint-disable no-console */
                console.log('[MultiputUpload] ✅ Part matching complete', {
                    partsMarkedAsUploaded,
                    partsToUpload: unmatchedParts.length,
                    matchedPartsSample: matchedParts.slice(0, 5),
                    unmatchedPartsSample: unmatchedParts.slice(0, 5),
                });
                
                if (unmatchedParts.length > 0) {
                    console.log('[MultiputUpload] ⚠️ Parts not found in uploaded list (will be uploaded):', {
                        count: unmatchedParts.length,
                        firstFew: unmatchedParts.slice(0, 10),
                        lastFew: unmatchedParts.slice(-10),
                    });
                }
                /* eslint-enable no-console */

                /* eslint-disable no-console */
                console.log('[MultiputUpload] ✅ Marked parts as already uploaded', {
                    partsMarkedAsUploaded,
                    partsToUpload: this.parts.length - partsMarkedAsUploaded,
                    totalUploadedBytes: this.totalUploadedBytes,
                    totalUploadedBytesMB: (this.totalUploadedBytes / 1024 / 1024).toFixed(2),
                });
                /* eslint-enable no-console */

                // Update first unuploaded part index
                this.updateFirstUnuploadedPartIndex();

                // Update progress callback with current progress
                if (this.totalUploadedBytes > 0) {
                    this.progressCallback({
                        loaded: this.totalUploadedBytes,
                        total: this.file.size,
                    });
                }
            } catch (error) {
                // If we can't list parts, continue anyway - parts will be re-uploaded if needed
                // According to Box API docs, parts are immutable once uploaded, so re-uploading
                // a complete part will result in an error, but incomplete/interrupted parts can be uploaded
                /* eslint-disable no-console */
                console.error('[MultiputUpload] ❌ Could not list uploaded parts', error);
                console.log('[MultiputUpload] ⚠️ Continuing with upload - will re-upload parts if needed');
                /* eslint-enable no-console */
                this.consoleLog('Could not list uploaded parts, continuing with upload');
            }
        }

        // Now process the remaining parts
        this.processNextParts();
    };

    /**
     * Handle error from getting upload session.
     * Restart uploads without valid sessions from the beginning of the upload process.
     *
     * @param error
     * @return {void}
     */
    getSessionErrorHandler(error: Error): void {
        if (this.isDestroyed()) {
            return;
        }

        const errorData = this.getErrorResponse(error);
        if (this.numResumeRetries > this.config.retries) {
            this.errorCallback(errorData);
            return;
        }

        if (errorData && errorData.status === 429) {
            let retryAfterMs = DEFAULT_RETRY_DELAY_MS;
            if (errorData.headers) {
                const retryAfterSec = parseInt(
                    errorData.headers['retry-after'] || errorData.headers.get('Retry-After'),
                    10,
                );
                if (!isNaN(retryAfterSec)) {
                    retryAfterMs = retryAfterSec * MS_IN_S;
                }
            }
            this.retryTimeout = setTimeout(this.getSessionInfo, retryAfterMs);
            this.numResumeRetries += 1;
        } else if (errorData && errorData.status >= 400 && errorData.status < 500) {
            // Restart upload process for errors resulting from invalid/expired session or no permission
            this.parts.forEach(part => {
                part.cancel();
            });
            this.reset();

            // Abort session
            clearTimeout(this.createSessionTimeout);
            clearTimeout(this.commitSessionTimeout);
            this.abortSession();
            // Restart the uploading process from the beginning
            const uploadOptions: Object = {
                file: this.file,
                folderId: this.folderId,
                errorCallback: this.errorCallback,
                progressCallback: this.progressCallback,
                successCallback: this.successCallback,
                overwrite: this.overwrite,
                fileId: this.fileId,
            };
            this.upload(uploadOptions);
        } else {
            // Handle internet disconnects (error.request && !error.response) and (!error.request)
            // Also handle any 500 error messages
            this.retryTimeout = setTimeout(this.getSessionInfo, 2 ** this.numResumeRetries * MS_IN_S);
            this.numResumeRetries += 1;
        }
    }

    /**
     * Session error handler.
     * Retries the create session request or fails the upload.
     *
     * @private
     * @param {?Error} error
     * @param {string} logEventType
     * @param {string} [logMessage]
     * @return {Promise}
     */
    async sessionErrorHandler(error: ?Error, logEventType: string, logMessage?: string): Promise<any> {
        if (!this.isResumableUploadsEnabled) {
            this.destroy();
            // Remove persisted session on non-resumable error
            if (this.sessionId) {
                removePersistedSession(this.sessionId);
            }
        }
        const errorData = this.getErrorResponse(error);
        this.errorCallback(errorData);

        try {
            if (!this.sessionEndpoints.logEvent) {
                throw new Error('logEvent endpoint not found');
            }

            await retryNumOfTimes(
                (resolve: Function, reject: Function): void => {
                    this.logEvent(logEventType, logMessage).then(resolve).catch(reject);
                },
                this.config.retries,
                this.config.initialRetryDelayMs,
            );
            if (!this.isResumableUploadsEnabled) {
                this.abortSession();
            }
        } catch (err) {
            if (!this.isResumableUploadsEnabled) {
                this.abortSession();
            }
        }
    }

    /**
     * Aborts the upload session
     *
     * @private
     * @return {void}
     */
    abortSession(): void {
        if (this.sha1Worker) {
            /* eslint-disable no-console */
            console.log('[MultiputUpload] 🔚 Terminating SHA-1 worker (session aborted)');
            /* eslint-enable no-console */
            this.sha1Worker.terminate();
        }

        if (this.sessionEndpoints.abort && this.sessionId) {
            this.xhr
                .delete({
                    url: this.sessionEndpoints.abort,
                })
                .then(() => {
                    this.sessionId = '';
                });
        }
    }

    /**
     * Part upload success handler
     *
     * @private
     * @param {MultiputPart} part
     * @return {void}
     */
    partUploadSuccessHandler = (part: MultiputPart): void => {
        this.numPartsUploading -= 1;
        this.numPartsUploaded += 1;
        this.updateProgress(part.uploadedBytes, this.partSize);
        this.processNextParts();
    };

    /**
     * Part upload error handler
     *
     * @private
     * @param {Error} error
     * @param {string} eventInfo
     * @return {void}
     */
    partUploadErrorHandler = (error: Error, eventInfo: string): void => {
        this.sessionErrorHandler(error, LOG_EVENT_TYPE_PART_UPLOAD_RETRIES_EXCEEDED, eventInfo);
        // Pause the rest of the parts.
        // can't cancel parts because cancel destroys the part and parts are only created in createSession call
        if (this.isResumableUploadsEnabled) {
            // Reset uploading process for parts that were in progress when the upload failed
            let nextUploadIndex = this.firstUnuploadedPartIndex;
            while (this.numPartsUploading > 0) {
                const part = this.parts[nextUploadIndex];
                if (part && part.state === PART_STATE_UPLOADING) {
                    part.reset();
                    part.pause();

                    this.numPartsUploading -= 1;
                    this.numPartsDigestReady += 1;
                }
                nextUploadIndex += 1;
            }
        }
    };

    /**
     * Update upload progress
     *
     * @private
     * @param {number} prevUploadedBytes
     * @param {number} newUploadedBytes
     * @return {void}
     */
    updateProgress = (prevUploadedBytes: number, newUploadedBytes: number): void => {
        if (this.isDestroyed()) {
            return;
        }

        this.totalUploadedBytes += newUploadedBytes - prevUploadedBytes;
        const progressPercent = ((this.totalUploadedBytes / this.file.size) * 100).toFixed(2);
        
        /* eslint-disable no-console */
        console.log('[MultiputUpload] 📊 Progress update', {
            uploaded: this.totalUploadedBytes,
            uploadedMB: (this.totalUploadedBytes / 1024 / 1024).toFixed(2),
            total: this.file.size,
            totalMB: (this.file.size / 1024 / 1024).toFixed(2),
            percent: `${progressPercent}%`,
            partsUploaded: this.numPartsUploaded,
            totalParts: this.parts.length,
        });
        /* eslint-enable no-console */

        this.progressCallback({
            loaded: this.totalUploadedBytes,
            total: this.file.size,
        });

        // Update persisted session progress
        if (this.isResumableUploadsEnabled && this.sessionId) {
            updatePersistedSessionProgress(this.sessionId, this.totalUploadedBytes);
        }
    };

    /**
     * Attempts to process more parts, except in the case where everything is done or we detect
     * a file change (in which case we want to abort and not process more parts).
     *
     * @private
     * @return {void}
     */
    processNextParts = (): void => {
        if (this.failSessionIfFileChangeDetected()) {
            return;
        }

        // Check if all parts are uploaded and file SHA-1 is ready for commit
        if (this.numPartsUploaded === this.parts.length && this.fileSha1) {
            /* eslint-disable no-console */
            console.log('[MultiputUpload] ✅ All parts uploaded and file SHA-1 ready, committing session');
            /* eslint-enable no-console */
            this.commitSession();
            return;
        }

        // If all parts are uploaded but file SHA-1 is not ready, we still need to compute digests
        // for the SHA-1 worker (even though parts are already uploaded)
        if (this.numPartsUploaded === this.parts.length && !this.fileSha1) {
            /* eslint-disable no-console */
            console.log('[MultiputUpload] ⚠️ All parts uploaded but file SHA-1 not ready, computing digests for file hash', {
                numPartsUploaded: this.numPartsUploaded,
                totalParts: this.parts.length,
                partsNeedingDigest: this.parts.filter(p => !p.sha1).length,
                shouldCompute: this.shouldComputeDigestForNextPart(),
            });
            /* eslint-enable no-console */
        }

        this.updateFirstUnuploadedPartIndex();

        while (this.canStartMorePartUploads()) {
            this.uploadNextPart();
        }

        // Always check if we need to compute digests (especially for already-uploaded parts when fileSha1 is missing)
        if (this.shouldComputeDigestForNextPart()) {
            this.computeDigestForNextPart();
        } else if (this.numPartsUploaded === this.parts.length && !this.fileSha1) {
            /* eslint-disable no-console */
            console.warn('[MultiputUpload] ⚠️ All parts uploaded but file SHA-1 not ready and shouldComputeDigestForNextPart returned false', {
                numPartsDigestComputing: this.numPartsDigestComputing,
                numPartsDigestReady: this.numPartsDigestReady,
                digestReadahead: this.config.digestReadahead,
                partsWithoutSha1: this.parts.filter(p => !p.sha1).map(p => ({ index: p.index, offset: p.offset, state: p.state })),
            });
            /* eslint-enable no-console */
        }
    };

    /**
     * We compute digest for parts one at a time.  This is done for simplicity and also to guarantee that
     * we send parts in order to the web sha1Worker (which is computing the digest for the entire file).
     *
     * @private
     * @return {boolean} true if there is work to do, false otherwise.
     */
    shouldComputeDigestForNextPart(): boolean {
        // If file SHA-1 is not ready, we need to compute digests even for already-uploaded parts
        const needsFileSha1 = !this.fileSha1;
        const hasPartsNeedingDigest = this.parts.some(part => {
            const alreadySentToWorker = part.timing?.fileDigestTime !== undefined;
            const alreadyComputedAndSent = part.sha1 !== undefined && part.state === PART_STATE_UPLOADED;
            const needsDigestForUpload = !part.sha1 && part.state === PART_STATE_NOT_STARTED;
            const needsDigestForFileHash = needsFileSha1 && part.state === PART_STATE_UPLOADED && !alreadySentToWorker && !alreadyComputedAndSent;
            return needsDigestForUpload || needsDigestForFileHash;
        });
        
        return (
            !this.isDestroyed() &&
            this.numPartsDigestComputing === 0 &&
            hasPartsNeedingDigest &&
            this.numPartsDigestReady < this.config.digestReadahead
        );
    }

    /**
     * Find first part in parts array that doesn't have a digest, and compute its digest.

     * @private
     * @return {void}
     */
    computeDigestForNextPart(): void {
        // If file SHA-1 is not ready, we need to compute digests for all parts (including already-uploaded ones)
        const needsFileSha1 = !this.fileSha1;
        
        // Find the first part that needs digest computation
        // For already-uploaded parts, check if they've been sent to the worker (fileDigestTime exists)
        // Start from firstUnuploadedPartIndex for parts that need uploading, or from 0 if we need file SHA-1
        const startIndex = needsFileSha1 ? 0 : this.firstUnuploadedPartIndex;
        
        for (let i = startIndex; i < this.parts.length; i += 1) {
            const part = this.parts[i];
            
            // Check if part has already been sent to SHA-1 worker (for file hash computation)
            // We check both fileDigestTime (worker responded) and sha1 (we computed and sent it)
            const alreadySentToWorker = part.timing?.fileDigestTime !== undefined;
            const alreadyComputedAndSent = part.sha1 !== undefined && part.state === PART_STATE_UPLOADED;
            
            // Compute digest if:
            // 1. Part is not started and doesn't have SHA-1 yet (normal case - needs to be uploaded)
            // 2. Part is uploaded but file SHA-1 is not ready AND hasn't been sent to worker yet
            //    (resume case where all parts are uploaded but file hash not computed)
            //    Note: If part has sha1 and is UPLOADED, we've already computed and sent it
            const needsDigestForUpload = !part.sha1 && part.state === PART_STATE_NOT_STARTED;
            const needsDigestForFileHash = needsFileSha1 && part.state === PART_STATE_UPLOADED && !alreadySentToWorker && !alreadyComputedAndSent;
            
            if (needsDigestForUpload || needsDigestForFileHash) {
                /* eslint-disable no-console */
                console.log('[MultiputUpload] 🔐 Computing digest for part', {
                    partIndex: part.index,
                    partOffset: part.offset,
                    reason: needsDigestForUpload ? 'needs upload' : 'needs file hash',
                    alreadySentToWorker,
                    alreadyComputedAndSent,
                    hasSha1: !!part.sha1,
                    state: part.state,
                });
                /* eslint-enable no-console */
                
                // Update the counters here instead of computeDigestForPart because computeDigestForPart
                // can get called on retries
                if (part.state === PART_STATE_NOT_STARTED) {
                    this.numPartsNotStarted -= 1;
                }
                this.numPartsDigestComputing += 1;
                this.computeDigestForPart(part);
                return;
            }
        }
    }

    /**
     * Compute digest for this part
     *
     * @private
     * @param {MultiputPart} part
     * @return {Promise}
     */
    async computeDigestForPart(part: MultiputPart): Promise<any> {
        /* eslint-disable no-console */
        console.log('[MultiputUpload] 🔐 Computing SHA-1 digest for part', part.index, {
            offset: part.offset,
            size: part.partSize,
            sizeMB: (part.partSize / 1024 / 1024).toFixed(2),
        });

        const blob = this.file.slice(part.offset, part.offset + this.partSize);
        const reader = new window.FileReader();
        const startTimestamp = Date.now();

        try {
            const {
                buffer,
                readCompleteTimestamp,
            }: {
                buffer: ArrayBuffer,
                readCompleteTimestamp: number,
            } = await this.readFile(reader, blob);
            const sha1ArrayBuffer = await digest('SHA-1', buffer);
            const sha1 = btoa(
                [].reduce.call(new Uint8Array(sha1ArrayBuffer), (data, byte) => data + String.fromCharCode(byte), ''),
            );
            this.sendPartToWorker(part, buffer);

            part.sha1 = sha1;
            
            // Check if this part was already uploaded (for file SHA-1 computation only)
            const wasAlreadyUploaded = part.state === PART_STATE_UPLOADED;
            const digestCompleteTimestamp = Date.now();
            
            if (!wasAlreadyUploaded) {
                // Part needs to be uploaded - set state to DIGEST_READY
                part.state = PART_STATE_DIGEST_READY;
                part.blob = blob;
                this.numPartsDigestReady += 1;
                
                /* eslint-disable no-console */
                console.log(`[MultiputUpload] ✅ Part ${part.index} digest ready`, {
                    readTime: readCompleteTimestamp - startTimestamp,
                    digestTime: digestCompleteTimestamp - readCompleteTimestamp,
                    totalTime: digestCompleteTimestamp - startTimestamp,
                });
                /* eslint-enable no-console */
            } else {
                // Part is already uploaded - keep it as UPLOADED and don't set blob
                // We only computed the SHA-1 for the file hash computation
                // Don't increment numPartsDigestReady to prevent re-upload
                /* eslint-disable no-console */
                console.log(`[MultiputUpload] ✅ Part ${part.index} digest computed (already uploaded, not re-uploading)`, {
                    readTime: readCompleteTimestamp - startTimestamp,
                    digestTime: digestCompleteTimestamp - readCompleteTimestamp,
                    totalTime: digestCompleteTimestamp - startTimestamp,
                });
                /* eslint-enable no-console */
            }
            
            // This will trigger the next digest computation
            this.numPartsDigestComputing -= 1;

            part.timing = {
                partDigestTime: digestCompleteTimestamp - startTimestamp,
                readTime: readCompleteTimestamp - startTimestamp,
                subtleCryptoTime: digestCompleteTimestamp - readCompleteTimestamp,
            };

            this.processNextParts();
        } catch (error) {
            this.onPartDigestError(error, part);
        }
    }

    /**
     * Deal with a message from the worker (either a part sha-1 ready, file sha-1 ready, or error).
     *
     * @private
     * @param {object} event
     * @return {void}
     */
    onWorkerMessage = (event: Object) => {
        if (this.isDestroyed()) {
            return;
        }

        const { data } = event;
        
        /* eslint-disable no-console */
        console.log('[MultiputUpload] 📨 SHA-1 worker message received', {
            type: data.type,
            partIndex: data.part?.index,
            partOffset: data.part?.offset,
            duration: data.duration,
        });
        /* eslint-enable no-console */
        
        if (data.type === 'partDone') {
            const { part } = data;
            this.parts[part.index].timing.fileDigestTime = data.duration;
            
            /* eslint-disable no-console */
            console.log('[MultiputUpload] ✅ SHA-1 worker processed part', {
                partIndex: part.index,
                partOffset: part.offset,
                partSize: part.size,
                duration: data.duration,
                partsProcessed: this.parts.filter(p => p.timing?.fileDigestTime).length,
                totalParts: this.parts.length,
            });
            /* eslint-enable no-console */
            
            this.processNextParts();
        } else if (data.type === 'done') {
            this.fileSha1 = hexToBase64(data.sha1);
            
            /* eslint-disable no-console */
            console.log('[MultiputUpload] 🎉 SHA-1 worker completed file hash computation', {
                fileSha1: `${this.fileSha1.substring(0, 20)}...`,
                fileSha1Length: this.fileSha1.length,
                totalPartsProcessed: this.parts.length,
                fileSize: this.file.size,
                fileSizeMB: (this.file.size / 1024 / 1024).toFixed(2),
            });
            console.log('[MultiputUpload] 🔚 Terminating SHA-1 worker');
            /* eslint-enable no-console */
            
            this.sha1Worker.terminate();
            this.processNextParts();
        } else if (data.type === 'error') {
            /* eslint-disable no-console */
            console.error('[MultiputUpload] ❌ SHA-1 worker error', {
                errorName: data.name,
                errorMessage: data.message,
                part: data.part,
            });
            /* eslint-enable no-console */
            this.sessionErrorHandler(null, LOG_EVENT_TYPE_WEB_WORKER_ERROR, JSON.stringify(data));
        }
    };

    /**
     * Sends a part to the sha1Worker
     *
     * @private
     * @param {MultiputPart} part
     * @param {ArrayBuffer} buffer
     * @return {void}
     */
    sendPartToWorker = (part: MultiputPart, buffer: ArrayBuffer): void => {
        if (this.isDestroyed()) {
            return;
        }

        // Don't send entire part since XHR can't be cloned
        const partInformation = {
            index: part.index,
            offset: part.offset,
            size: part.partSize,
        };
        
        /* eslint-disable no-console */
        console.log('[MultiputUpload] 📤 Sending part to SHA-1 worker', {
            partIndex: part.index,
            partOffset: part.offset,
            partSize: part.partSize,
            partSizeMB: (part.partSize / 1024 / 1024).toFixed(2),
            bufferSize: buffer.byteLength,
            fileSize: this.file.size,
            expectedOffset: part.offset, // Worker expects parts in order
        });
        /* eslint-enable no-console */
        
        this.sha1Worker.postMessage(
            {
                part: partInformation,
                fileSize: this.file.size,
                partContents: buffer,
            },
            [buffer], // This transfers the ArrayBuffer to the worker context without copying contents.
        );
        
        /* eslint-disable no-console */
        console.log('[MultiputUpload] ✅ Part sent to SHA-1 worker', {
            partIndex: part.index,
            partOffset: part.offset,
        });
        /* eslint-enable no-console */
    };

    /**
     * Error handler for part digest computation
     *
     * @private
     * @param {Error} error
     * @param {MultiputPart} part
     * @return {void}
     */
    onPartDigestError = (error: Error, part: MultiputPart): void => {
        this.consoleLog(`Error computing digest for part ${JSON.stringify(part)}: ${JSON.stringify(error)}`);

        // When a FileReader is processing a file that changes on disk, Chrome reports a 'NotFoundError'
        // and Safari reports a 'NOT_FOUND_ERR'. (Other browsers seem to allow the reader to keep
        // going, either with the old version of the new file or the new one.) Since the error name
        // implies that retrying will not help, we fail the session.
        if (error.name === 'NotFoundError' || error.name === 'NOT_FOUND_ERR') {
            this.sessionErrorHandler(null, LOG_EVENT_TYPE_FILE_READER_RECEIVED_NOT_FOUND_ERROR, JSON.stringify(error));
            return;
        }

        if (this.failSessionIfFileChangeDetected()) {
            return;
        }

        if (part.numDigestRetriesPerformed >= this.config.retries) {
            this.sessionErrorHandler(null, LOG_EVENT_TYPE_PART_DIGEST_RETRIES_EXCEEDED, JSON.stringify(error));
            return;
        }

        const retryDelayMs = getBoundedExpBackoffRetryDelay(
            this.config.initialRetryDelayMs,
            this.config.maxRetryDelayMs,
            part.numDigestRetriesPerformed,
        );
        part.numDigestRetriesPerformed += 1;
        this.consoleLog(`Retrying digest work for part ${JSON.stringify(part)} in ${retryDelayMs} ms`);

        setTimeout(() => {
            this.computeDigestForPart(part);
        }, retryDelayMs);
    };

    /**
     * Send a request to commit the upload.
     *
     * @private
     * @return {void}
     */
    commitSession = (): void => {
        if (this.isDestroyed()) {
            return;
        }

        if (!this.fileSha1) {
            /* eslint-disable no-console */
            console.error('[MultiputUpload] ❌ Cannot commit: file SHA-1 is not ready', {
                fileSha1: this.fileSha1,
                numPartsUploaded: this.numPartsUploaded,
                totalParts: this.parts.length,
                partsWithoutSha1: this.parts.filter(p => !p.sha1).length,
            });
            /* eslint-enable no-console */
            // Don't commit without file SHA-1 - it's required for the Digest header
            // The digest computation should be triggered by processNextParts
            return;
        }

        /* eslint-disable no-console */
        console.log('[MultiputUpload] 🚀 Step 5: All parts uploaded, committing session', {
            fileSha1: `${this.fileSha1.substring(0, 20)}...`,
            totalParts: this.parts.length,
        });
        /* eslint-enable no-console */

        const stats = {
            totalPartReadTime: 0,
            totalPartDigestTime: 0,
            totalFileDigestTime: 0,
            totalPartUploadTime: 0,
        };

        const partsData = this.parts.map(part => {
            stats.totalPartReadTime += part.timing.readTime;
            stats.totalPartDigestTime += part.timing.subtleCryptoTime;
            stats.totalFileDigestTime += part.timing.fileDigestTime;
            stats.totalPartUploadTime += part.timing.uploadTime;
            return part.getPart();
        });

        /* eslint-disable no-console */
        console.log('[MultiputUpload] 📦 Parts data for commit', {
            totalParts: partsData.length,
            samplePart: partsData[0],
            partsWithOffset: partsData.filter(p => p.offset !== undefined).length,
            partsWithPartId: partsData.filter(p => p.part_id !== undefined).length,
            fileSha1: this.fileSha1 ? `${this.fileSha1.substring(0, 20)}...` : 'NULL',
        });
        /* eslint-enable no-console */

        const data = {
            parts: partsData.sort((part1, part2) => part1.offset - part2.offset),
            attributes: {},
        };

        /* eslint-disable no-console */
        console.log('[MultiputUpload] 📊 Upload statistics', {
            totalParts: this.parts.length,
            avgReadTime: Math.round(stats.totalPartReadTime / this.parts.length),
            avgDigestTime: Math.round(stats.totalPartDigestTime / this.parts.length),
            avgUploadTime: Math.round(stats.totalPartUploadTime / this.parts.length),
        });
        /* eslint-enable no-console */

        const fileLastModified = getFileLastModifiedAsISONoMSIfPossible(this.file);
        if (fileLastModified) {
            data.attributes.content_modified_at = fileLastModified;
        }
        if (this.fileDescription) {
            data.attributes.description = this.fileDescription;
        }

        const clientEventInfo = {
            avg_part_read_time: Math.round(stats.totalPartReadTime / this.parts.length),
            avg_part_digest_time: Math.round(stats.totalPartDigestTime / this.parts.length),
            avg_file_digest_time: Math.round(stats.totalFileDigestTime / this.parts.length),
            avg_part_upload_time: Math.round(stats.totalPartUploadTime / this.parts.length),
        };

        // To make flow stop complaining about this.fileSha1 could potentially be undefined/null
        const fileSha1: string = (this.fileSha1: any);
        const headers = {
            Digest: `sha=${fileSha1}`,
            'X-Box-Client-Event-Info': JSON.stringify(clientEventInfo),
        };

        this.xhr
            .post({ url: this.sessionEndpoints.commit, data, headers })
            .then(this.commitSessionSuccessHandler)
            .catch(this.commitSessionErrorHandler);
    };

    /**
     * Commit response handler.  Succeeds the upload, retries the commit on 202
     *
     * @private
     * @param {Object} response
     * @return {void}
     */
    commitSessionSuccessHandler = (response: Object): void => {
        if (this.isDestroyed()) {
            return;
        }

        const { status, data } = response;

        if (status === 202) {
            /* eslint-disable no-console */
            console.log('[MultiputUpload] ⏳ Commit session returned 202 (processing), will retry');
            /* eslint-enable no-console */
            this.commitSessionRetry(response);
            return;
        }

        let { entries } = data;
        // v2.1 API response format is different from v2.0. v2.1 returns individual upload entry directly inside data,
        // while v2.0 returns a collection of entries under data.entries
        if (!entries && data.id) {
            entries = [data];
        }

        /* eslint-disable no-console */
        console.log('[MultiputUpload] ✅ Upload complete! Session committed successfully', {
            fileId: entries?.[0]?.id,
            fileName: entries?.[0]?.name,
            totalParts: this.parts.length,
        });
        /* eslint-enable no-console */

        // Remove persisted session on successful completion
        if (this.sessionId) {
            removePersistedSession(this.sessionId);
            /* eslint-disable no-console */
            console.log('[MultiputUpload] 🗑️ Removed persisted session from localStorage');
            /* eslint-enable no-console */
        }

        this.destroy();

        if (this.successCallback && entries) {
            this.successCallback(entries);
        }
    };

    /**
     * Commit error handler.
     * Retries the commit or fails the multiput session.
     *
     * @private
     * @param {Object} error
     * @return {void}
     */
    commitSessionErrorHandler = (error: Object): void => {
        if (this.isDestroyed()) {
            return;
        }

        const { response } = error;

        /* eslint-disable no-console */
        console.error('[MultiputUpload] ❌ Commit session error', {
            status: response?.status,
            statusText: response?.statusText,
            error,
            sessionId: this.sessionId,
            commitUrl: this.sessionEndpoints?.commit,
            fileSha1: this.fileSha1 ? `${this.fileSha1.substring(0, 20)}...` : 'NULL',
            totalParts: this.parts.length,
            partsData: this.parts.map(p => ({
                index: p.index,
                offset: p.offset,
                hasPartData: !!p.data?.part,
                partId: p.id,
                getPartResult: p.getPart(),
            })),
        });
        /* eslint-enable no-console */

        if (!response) {
            // Some random error happened
            this.consoleError(error);
            return;
        }

        if (this.commitRetryCount >= this.config.retries) {
            this.consoleLog('Too many commit failures, failing upload');
            this.sessionErrorHandler(error, LOG_EVENT_TYPE_COMMIT_RETRIES_EXCEEDED, JSON.stringify(error));
            return;
        }

        this.commitSessionRetry(response);
    };

    /**
     * Retry commit.
     * Retries the commit or fails the multiput session.
     *
     * @private
     * @param {Object} response
     * @return {void}
     */
    commitSessionRetry(response: Object): void {
        const { status, headers } = response;
        let retryAfterMs = DEFAULT_RETRY_DELAY_MS;

        if (headers) {
            const retryAfterSec = parseInt(headers['retry-after'], 10);

            if (!Number.isNaN(retryAfterSec)) {
                retryAfterMs = retryAfterSec * 1000;
            }
        }

        const defaultRetryDelayMs = getBoundedExpBackoffRetryDelay(
            this.config.initialRetryDelayMs,
            this.config.maxRetryDelayMs,
            this.commitRetryCount,
        );
        // If status is 202 then don't increment the retry count.
        // In this case, frontend will keep retrying until it gets another status code.
        // Retry interval = value specified for the Retry-After header in 202 response.
        if (status !== 202) {
            this.commitRetryCount += 1;
        }

        const retryDelayMs = retryAfterMs || defaultRetryDelayMs;
        this.consoleLog(`Retrying commit in ${retryDelayMs} ms`);
        this.commitSessionTimeout = setTimeout(this.commitSession, retryDelayMs);
    }

    /**
     * Find first part in parts array that we can upload, and upload it.
     *
     * @private
     * @return {void}
     */
    uploadNextPart(): void {
        for (let i = this.firstUnuploadedPartIndex; i < this.parts.length; i += 1) {
            const part = this.parts[i];

            if (part.state === PART_STATE_DIGEST_READY) {
                // Update the counters here instead of uploadPart because uploadPart
                // can get called on retries
                this.numPartsDigestReady -= 1;
                this.numPartsUploading += 1;
                if (part.isPaused) {
                    part.unpause();
                } else {
                    part.upload();
                }
                break;
            }
        }
    }

    /**
     * Checks if upload pipeline is full
     *
     * @private
     * @return {boolean}
     */
    canStartMorePartUploads(): boolean {
        return !this.isDestroyed() && this.numPartsUploading < this.config.parallelism && this.numPartsDigestReady > 0;
    }

    /**
     * Functions that walk the parts array get called a lot, so we cache which part we should
     * start work at to avoid always iterating through entire parts list.
     *
     * @private
     * @return {void}
     */
    updateFirstUnuploadedPartIndex(): void {
        let part = this.parts[this.firstUnuploadedPartIndex];
        while (part && part.state === PART_STATE_UPLOADED) {
            this.firstUnuploadedPartIndex += 1;
            part = this.parts[this.firstUnuploadedPartIndex];
        }
    }

    /**
     * Get number of parts being uploaded
     *
     * @return {number}
     */
    getNumPartsUploading = (): number => this.numPartsUploading;

    /**
     * After session is created and we know the part size, populate the parts
     * array.
     *
     * @private
     * @return {void}
     */
    populateParts(): void {
        this.numPartsNotStarted = Math.ceil(this.file.size / this.partSize);

        /* eslint-disable no-console */
        console.log('[MultiputUpload] 📦 Creating', this.numPartsNotStarted, 'part metadata objects');
        /* eslint-enable no-console */

        for (let i = 0; i < this.numPartsNotStarted; i += 1) {
            const offset = i * this.partSize;
            const currentPartSize = Math.min(offset + this.partSize, this.file.size) - offset;
            const part = new MultiputPart(
                this.options,
                i,
                offset,
                currentPartSize,
                this.file.size,
                this.sessionId,
                this.sessionEndpoints,
                this.config,
                this.getNumPartsUploading,
                this.partUploadSuccessHandler,
                this.updateProgress,
                this.partUploadErrorHandler,
            );
            this.parts.push(part);
        }

        /* eslint-disable no-console */
        console.log('[MultiputUpload] ✅ Parts array populated:', {
            totalParts: this.parts.length,
            partsNotStarted: this.numPartsNotStarted,
        });
        /* eslint-enable no-console */
    }

    /**
     * Fails the session if the file's size or last modified has changed since the upload process
     * began.
     *
     * This ensures that we don't upload a file that has parts from one file version and parts from
     * another file version.
     *
     * This logic + the "not found" error logic in onWorkerError() is best effort and will not
     * detect all possible file changes. This is because of browser differences. For example,
     * -- In Safari, size and last modified will update when a file changes, and workers will
     * get "not found" errors.
     * -- In Chrome, size and last modified will update, but not in legacy drag and drop (that
     * code path constructs a different file object). Workers will still get "not found" errors,
     * though, so we can still detect changes even in legacy drag and drop.
     * -- In IE 11/Edge, size will update but last modified will not. Workers will not get
     * "not found" errors, but they may get a generic error saying that some bytes failed to be
     * read.
     * -- In Firefox, neither last modified nor size will update. Workers don't seem to get errors.
     * (Not a whole lot we can do here...)
     *
     * Unfortunately, alternative solutions to catch more cases don't have a clear ROI (for
     * example, doing a SHA-1 of the file before and after the upload is very expensive), so
     * this is the best solution we have. We can revisit this if data shows that we need a better
     * solution.
     *
     * @private
     * @return {boolean} True if the session was failed, false if no action was taken
     */
    failSessionIfFileChangeDetected(): boolean {
        const currentFileSize = this.file.size;
        const currentFileLastModified = getFileLastModifiedAsISONoMSIfPossible(this.file);

        if (currentFileSize !== this.initialFileSize || currentFileLastModified !== this.initialFileLastModified) {
            const changeJSON = JSON.stringify({
                oldSize: this.initialFileSize,
                newSize: currentFileSize,
                oldLastModified: this.initialFileLastModified,
                newLastModified: currentFileLastModified,
            });
            // Leave IE with old behavior and kill upload
            if (Browser.isIE()) {
                this.sessionErrorHandler(null, LOG_EVENT_TYPE_FILE_CHANGED_DURING_UPLOAD, changeJSON);
                return true;
            }
            // for evergreen browsers where the file change check does not work, log and continue with upload
            // https://w3c.github.io/FileAPI/#file-section
            this.consoleLog(`file properties changed during upload: ${changeJSON}`);
            return false;
        }

        return false;
    }

    /**
     * Cancels an upload in progress by cancelling all upload parts.
     * This cannot be undone or resumed.
     *
     * @private
     * @return {void}
     */
    cancel(): void {
        if (this.isDestroyed()) {
            return;
        }

        // Cancel individual upload parts
        this.parts.forEach(part => {
            part.cancel();
        });

        this.parts = [];
        clearTimeout(this.createSessionTimeout);
        clearTimeout(this.commitSessionTimeout);
        
        // Remove persisted session on cancel
        if (this.sessionId) {
            removePersistedSession(this.sessionId);
        }
        
        this.abortSession();
        this.destroy();
    }

    /**
     * Resolves upload conflict by overwriting or renaming
     *
     * @param {Object} response data
     * @return {Promise}
     */
    async resolveConflict(data: Object): Promise<any> {
        if (this.overwrite && data.context_info) {
            this.fileId = data.context_info.conflicts.id;
            return;
        }
        if (this.conflictCallback) {
            this.fileName = this.conflictCallback(this.fileName);
            return;
        }

        const extension = this.fileName.substr(this.fileName.lastIndexOf('.')) || '';
        // foo.txt => foo-1513385827917.txt
        this.fileName = `${this.fileName.substr(0, this.fileName.lastIndexOf('.'))}-${Date.now()}${extension}`;
    }

    /**
     * Returns detailed error response
     *
     * @param {Object} error
     * @return {Object}
     */
    getErrorResponse(error: ?Object): Object {
        if (!error) {
            return {};
        }

        const { response } = error;
        if (!response) {
            return {};
        }

        if (response.status === 401) {
            return response;
        }

        return response.data;
    }
}

export default MultiputUpload;
