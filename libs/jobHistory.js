/**
 *  ClusterODM - A reverse proxy, load balancer and task tracker for NodeODM
 *  Copyright (C) 2018-present MasseranoLabs LLC
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as
 *  published by the Free Software Foundation, either version 3 of the
 *  License, or (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
"use strict";

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const statusCodes = require('./statusCodes');
const {sanitizeProjectName} = require('./gcsProjectName');

// Durable job ledger for the gateway. Unlike routetable (routing only, expires)
// and tasktable (memory only), this survives gateway restarts and worker
// teardown. Any authenticated teammate can list all rows; actor email/sub on
// each event shows who worked on a job.

const DEFAULT_HISTORY_FILE = path.join('data', 'jobs.json');
const SCHEMA_VERSION = 3;
const MAX_EVENTS_PER_JOB = 200;
const MAX_EVENTS_PER_PROJECT = 50;

const STATUS = {
    QUEUED: 'queued',
    RUNNING: 'running',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    CANCELED: 'canceled',
    DELETED: 'deleted'
};

// Where a commit is in the hand-off to a worker. Persisted because the gateway
// can restart mid-dispatch, and an in-memory-only guard would then let a client
// retry start a second worker VM for the same upload.
const DISPATCH_PHASE = {
    ACCEPTED: 'accepted',
    QUEUED: 'queued',
    DISPATCHING: 'dispatching',
    ROUTED: 'routed'
};

// A phase in this set means "a dispatch owns this upload right now", which both
// blocks a duplicate commit and protects tmp/<uuid> from cleanup.
const ACTIVE_DISPATCH_PHASES = [
    DISPATCH_PHASE.ACCEPTED,
    DISPATCH_PHASE.QUEUED,
    DISPATCH_PHASE.DISPATCHING
];

// Ordering used by applyStatus to decide which transitions are allowed.
const STATUS_RANK = {
    [STATUS.QUEUED]: 1,
    [STATUS.RUNNING]: 2,
    [STATUS.SUCCEEDED]: 3,
    [STATUS.FAILED]: 3,
    [STATUS.CANCELED]: 3,
    [STATUS.DELETED]: 4
};

const TERMINAL = [STATUS.SUCCEEDED, STATUS.FAILED, STATUS.CANCELED, STATUS.DELETED];

let jobs = null;
let projects = null;
let historyFile = DEFAULT_HISTORY_FILE;
let writeChain = Promise.resolve();

function statusFromCode(code){
    switch (code){
        case statusCodes.QUEUED: return STATUS.QUEUED;
        case statusCodes.RUNNING: return STATUS.RUNNING;
        case statusCodes.FAILED: return STATUS.FAILED;
        case statusCodes.COMPLETED: return STATUS.SUCCEEDED;
        case statusCodes.CANCELED: return STATUS.CANCELED;
        default: return null;
    }
}

// A deleted job keeps its last NodeODM code, since deletion is our own state.
function codeFromStatus(status){
    switch (status){
        case STATUS.QUEUED: return statusCodes.QUEUED;
        case STATUS.RUNNING: return statusCodes.RUNNING;
        case STATUS.FAILED: return statusCodes.FAILED;
        case STATUS.SUCCEEDED: return statusCodes.COMPLETED;
        case STATUS.CANCELED: return statusCodes.CANCELED;
        default: return null;
    }
}

// Owner keys are already one-way hashes; sub/email are kept for display so a
// shared account can tell who acted, and nothing else from the JWT is stored.
function sanitizeActor(actor){
    if (!actor) return null;
    const result = {};
    if (actor.source) result.source = String(actor.source);
    if (actor.sub) result.sub = String(actor.sub);
    if (actor.email) result.email = String(actor.email);
    return Object.keys(result).length ? result : null;
}

function newRecord(uuid, ownerKey, now){
    return {
        uuid,
        ownerKey: ownerKey || null,
        name: null,
        status: STATUS.QUEUED,
        statusCode: statusCodes.QUEUED,
        imagesCount: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        deletedAt: null,
        createdBy: null,
        lastUpdatedBy: null,
        dispatchPhase: null,
        dispatchAcceptedAt: null,
        events: []
    };
}

function newProjectRecord(name, now){
    return {
        name,
        archived: false,
        archivedAt: null,
        archivedBy: null,
        updatedAt: now,
        lastUpdatedBy: null,
        events: []
    };
}

function writeNow(){
    const payload = JSON.stringify({version: SCHEMA_VERSION, jobs, projects});
    const target = historyFile;
    const tmpFile = `${target}.${process.pid}.tmp`;

    return fs.promises.mkdir(path.dirname(target), {recursive: true})
        .then(() => fs.promises.writeFile(tmpFile, payload))
        .then(() => fs.promises.rename(tmpFile, target))
        .catch(err => {
            logger.warn(`Cannot save job history to disk: ${err.message}`);
        });
}

// Writes are chained so concurrent lifecycle events never interleave a partial
// file, and the rename keeps readers from ever seeing a truncated ledger.
function scheduleSave(){
    writeChain = writeChain.then(writeNow);
    return writeChain;
}

function applyStatus(record, status, options = {}){
    if (!status || record.status === status) return false;
    if (record.status === STATUS.DELETED) return false;

    if (status !== STATUS.DELETED){
        // A finished job only moves again when the worker reports an
        // authoritative result (force) or the user restarts it (allowRevive).
        const settled = TERMINAL.indexOf(record.status) !== -1;
        if (settled && !options.force && !options.allowRevive) return false;

        // Only an explicit restart may move a job backwards; an authoritative
        // worker result can still correct one settled state into another.
        const current = STATUS_RANK[record.status] || 0;
        const next = STATUS_RANK[status] || 0;
        if (next < current && !options.allowRevive) return false;
    }

    record.status = status;

    const now = options.at || new Date().getTime();
    if (status === STATUS.RUNNING && !record.startedAt) record.startedAt = now;

    if (status === STATUS.DELETED){
        // Keep the real completion time; deletion is tracked separately.
        record.deletedAt = now;
        if (!record.finishedAt) record.finishedAt = now;
    }else if (TERMINAL.indexOf(status) !== -1){
        record.finishedAt = now;
    }else{
        record.finishedAt = null;
    }

    return true;
}

function isActivePhase(phase){
    return ACTIVE_DISPATCH_PHASES.indexOf(phase) !== -1;
}

function isTerminal(status){
    return TERMINAL.indexOf(status) !== -1;
}

function toPublic(record){
    return {
        uuid: record.uuid,
        name: record.name,
        status: record.status,
        statusCode: record.statusCode,
        imagesCount: record.imagesCount,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        deletedAt: record.deletedAt,
        createdBy: record.createdBy,
        lastUpdatedBy: record.lastUpdatedBy,
        events: (record.events || []).map(e => ({
            at: e.at,
            action: e.action,
            actor: e.actor || null,
            detail: e.detail || null
        }))
    };
}

function projectToPublic(record){
    return {
        name: record.name,
        archived: !!record.archived,
        archivedAt: record.archivedAt || null,
        archivedBy: record.archivedBy || null,
        updatedAt: record.updatedAt || null,
        lastUpdatedBy: record.lastUpdatedBy || null,
        events: (record.events || []).map(e => ({
            at: e.at,
            action: e.action,
            actor: e.actor || null
        }))
    };
}

module.exports = {
    STATUS,
    DISPATCH_PHASE,

    /**
     * Claims the right to dispatch `uuid`, so a retried commit is a no-op that
     * returns the original task instead of launching a second worker.
     *
     * The read-modify-write below runs without an await, which is what makes it
     * atomic against concurrent requests on Node's single thread; the disk write
     * it schedules is serialized by writeChain as usual.
     *
     * @return {object} {accepted, reason, revived, job}
     */
    tryAcceptCommit: function(uuid, options = {}){
        if (!uuid || !jobs) return {accepted: true, reason: null, revived: false, job: null};

        const now = options.at || new Date().getTime();
        const job = jobs[uuid];

        if (job){
            if (isActivePhase(job.dispatchPhase)){
                return {accepted: false, reason: 'in-progress', revived: false, job};
            }
            if (job.dispatchPhase === DISPATCH_PHASE.ROUTED){
                return {accepted: false, reason: 'routed', revived: false, job};
            }
            if (job.status === STATUS.DELETED || job.status === STATUS.CANCELED){
                return {accepted: false, reason: job.status, revived: false, job};
            }
            if (job.status === STATUS.SUCCEEDED){
                return {accepted: false, reason: 'succeeded', revived: false, job};
            }
        }

        // A job the orphan sweeper already failed is still resumable as long as
        // its uploaded files survived, so accept and let the caller revive it.
        const revived = !!job && job.status === STATUS.FAILED;

        const target = job || newRecord(uuid, options.ownerKey, now);
        if (!job) jobs[uuid] = target;

        target.dispatchPhase = DISPATCH_PHASE.ACCEPTED;
        target.dispatchAcceptedAt = now;
        target.updatedAt = now;

        scheduleSave();

        return {accepted: true, reason: null, revived, job: target};
    },

    setDispatchPhase: async function(uuid, phase){
        if (!uuid || !jobs) return null;
        const job = jobs[uuid];
        if (!job) return null;

        job.dispatchPhase = phase || null;
        if (!phase) job.dispatchAcceptedAt = null;
        job.updatedAt = new Date().getTime();
        scheduleSave();
        return job;
    },

    clearDispatchPhase: async function(uuid){
        return this.setDispatchPhase(uuid, null);
    },

    /**
     * Drops dispatch claims left behind by a gateway that died mid-hand-off.
     * Without this, a persisted `accepted` phase would reject every retry and
     * every resume attempt forever, turning the idempotency guard into a trap.
     *
     * @param isLive {function} async (uuid) => bool, true while a dispatch is
     *                          genuinely still running for that task.
     */
    clearStaleDispatchPhases: async function(isLive){
        if (!jobs) return [];

        const cleared = [];
        for (const uuid of Object.keys(jobs)){
            const job = jobs[uuid];
            if (!isActivePhase(job.dispatchPhase)) continue;
            if (await isLive(uuid)) continue;

            job.dispatchPhase = null;
            job.dispatchAcceptedAt = null;
            cleared.push(uuid);
        }

        if (cleared.length) scheduleSave();
        return cleared;
    },

    /**
     * True while tmp/<uuid> must survive cleanup because a dispatch is actively
     * reading those files. Kept here so cleanup does not have to know the
     * dispatch-phase vocabulary.
     */
    hasActiveDispatch: async function(uuid){
        const job = await this.lookup(uuid);
        return !!job && isActivePhase(job.dispatchPhase);
    },

    isTerminal: function(status){
        return isTerminal(status);
    },

    /**
     * Raw records that have not reached an outcome yet. Used by the orphan
     * sweeper, which needs dispatchPhase and events that toPublic() hides.
     */
    listNonTerminal: async function(){
        if (!jobs) return [];
        return Object.keys(jobs)
            .map(uuid => jobs[uuid])
            .filter(job => !isTerminal(job.status));
    },

    /**
     * Last known worker for a job, as "hostname:port", recovered from the
     * `routed` event. Lets the sweeper probe a worker whose route was dropped.
     */
    lastNodeHint: function(job){
        if (!job || !Array.isArray(job.events)) return null;
        for (let i = job.events.length - 1; i >= 0; i--){
            const event = job.events[i];
            if (event.action !== 'routed' || !event.detail) continue;
            const match = String(event.detail).match(/^([^\s:]+):(\d+)$/);
            if (match) return {hostname: match[1], port: parseInt(match[2], 10)};
        }
        return null;
    },

    /**
     * Last known state in the shape NodeODM clients expect, so a task whose
     * worker is gone still reports an outcome instead of a routing error.
     */
    toTaskInfo: function(record){
        const settled = TERMINAL.indexOf(record.status) !== -1;
        const status = {code: record.statusCode || statusCodes.FAILED};

        // Clients render errorMessage; without it a failure reads as a bare
        // "Failed" with no reason once the worker is gone.
        if (status.code === statusCodes.FAILED && record.status === STATUS.FAILED){
            const last = record.events && record.events[record.events.length - 1];
            if (last && last.detail) status.errorMessage = last.detail;
        }

        return {
            uuid: record.uuid,
            name: record.name || record.uuid,
            dateCreated: record.createdAt,
            processingTime: (record.startedAt && record.finishedAt) ?
                                record.finishedAt - record.startedAt : -1,
            status,
            options: [],
            imagesCount: record.imagesCount || 0,
            progress: settled ? 100 : 0
        };
    },

    initialize: async function(filePath){
        historyFile = filePath || DEFAULT_HISTORY_FILE;
        const state = await this.loadFromDisk();
        jobs = state.jobs;
        projects = state.projects;
        logger.info(`Loaded ${Object.keys(jobs).length} job history records`);
        logger.info(`Loaded ${Object.keys(projects).filter(name => projects[name].archived).length} archived projects`);
        if (state.migrated) await scheduleSave();
    },

    statusFromCode,

    /**
     * Upsert a job and append an audit event. Safe to call more than once for
     * the same event: status transitions are rank-guarded and never regress.
     */
    record: async function(uuid, action, options = {}){
        if (!uuid || !jobs) return null;

        const now = options.at || new Date().getTime();
        const actor = sanitizeActor(options.actor);

        let job = jobs[uuid];
        if (!job){
            job = newRecord(uuid, options.ownerKey, now);
            jobs[uuid] = job;
        }

        if (options.ownerKey && !job.ownerKey) job.ownerKey = options.ownerKey;
        if (options.name) job.name = options.name;
        if (options.imagesCount !== undefined && options.imagesCount !== null){
            job.imagesCount = options.imagesCount;
        }
        if (!job.createdBy && actor) job.createdBy = actor;

        const status = options.status ||
                       (options.statusCode !== undefined ? statusFromCode(options.statusCode) : null);
        const changed = applyStatus(job, status, {
            at: now,
            allowRevive: options.allowRevive,
            force: options.force
        });
        if (changed){
            if (options.statusCode !== undefined) job.statusCode = options.statusCode;
            else{
                const derived = codeFromStatus(job.status);
                if (derived !== null) job.statusCode = derived;
            }

            // Reaching an outcome ends the hand-off, so no claim is left to
            // block a future commit for this uuid.
            if (isTerminal(job.status)){
                job.dispatchPhase = null;
                job.dispatchAcceptedAt = null;
            }
        }

        job.events.push({
            at: now,
            action,
            actor,
            detail: options.detail || null
        });
        if (job.events.length > MAX_EVENTS_PER_JOB){
            job.events = job.events.slice(job.events.length - MAX_EVENTS_PER_JOB);
        }

        job.updatedAt = now;
        if (actor) job.lastUpdatedBy = Object.assign({}, actor, {action});

        scheduleSave();

        return job;
    },

    /**
     * Records an outcome the worker reported, whether it arrived by webhook or
     * by the reconciler probing for it. The action mirrors the outcome so the
     * activity feed does not label a crash as "finished", and the worker's own
     * error message becomes the detail the UI shows.
     */
    recordWorkerOutcome: async function(uuid, taskInfo, options = {}){
        const status = (taskInfo && taskInfo.status) || {};
        const action = status.code === statusCodes.FAILED ? 'failed' :
                       status.code === statusCodes.CANCELED ? 'canceled' : 'finished';

        return this.record(uuid, action, Object.assign({
            statusCode: status.code,
            name: taskInfo && taskInfo.name,
            imagesCount: taskInfo && taskInfo.imagesCount,
            detail: status.errorMessage || null,
            // The worker is authoritative, so this overrides an optimistic
            // cancel recorded while it was still running.
            force: true
        }, options));
    },

    lookup: async function(uuid){
        if (!uuid || !jobs) return null;
        return jobs[uuid] || null;
    },

    /**
     * Ownership check used before acting on a task the routing tables no longer
     * know about. `found` false means the ledger predates the job, which is not
     * an authorization failure: there is nothing to disclose.
     */
    ownership: async function(uuid, ownerKey){
        const job = await this.lookup(uuid);
        if (!job) return {found: false, owned: false};
        return {found: true, owned: !!ownerKey && job.ownerKey === ownerKey};
    },

    findByOwner: async function(ownerKey, options = {}){
        if (!jobs || !ownerKey) return [];
        return this.list(Object.assign({}, options, {ownerKey}));
    },

    /**
     * Org-wide history for the authenticated gateway. Owner is still stored for
     * attribution; listing is not filtered by it unless ownerKey is passed.
     */
    list: async function(options = {}){
        if (!jobs) return [];
        const includeDeleted = options.includeDeleted !== false;
        const ownerKey = options.ownerKey || null;

        const result = Object.keys(jobs)
            .map(uuid => jobs[uuid])
            .filter(job => !ownerKey || job.ownerKey === ownerKey)
            .filter(job => includeDeleted || job.status !== STATUS.DELETED)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        const limit = parseInt(options.limit, 10);
        const limited = limit > 0 ? result.slice(0, limit) : result;

        return limited.map(toPublic);
    },

    setProjectArchived: async function(name, archived, actor, options = {}){
        if (!projects) return null;
        const projectName = sanitizeProjectName(name, "");
        if (!projectName || projectName !== String(name || "").trim()) return null;

        const now = options.at || new Date().getTime();
        const cleanActor = sanitizeActor(actor);
        let project = projects[projectName];
        if (!project){
            project = newProjectRecord(projectName, now);
            projects[projectName] = project;
        }

        project.archived = !!archived;
        project.archivedAt = project.archived ? now : null;
        project.archivedBy = project.archived ? cleanActor : null;
        project.updatedAt = now;
        project.lastUpdatedBy = cleanActor;
        project.events.push({
            at: now,
            action: project.archived ? 'archived' : 'restored',
            actor: cleanActor
        });
        if (project.events.length > MAX_EVENTS_PER_PROJECT){
            project.events = project.events.slice(project.events.length - MAX_EVENTS_PER_PROJECT);
        }

        await scheduleSave();
        return projectToPublic(project);
    },

    listArchivedProjects: async function(){
        if (!projects) return [];
        return Object.keys(projects)
            .map(name => projects[name])
            .filter(project => project.archived)
            .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0))
            .map(projectToPublic);
    },

    saveToDisk: async function(){
        if (!jobs || !projects) return;
        return scheduleSave();
    },

    loadFromDisk: async function(){
        try{
            const raw = await fs.promises.readFile(historyFile, 'utf8');
            const content = JSON.parse(raw);
            if (content && content.jobs && typeof content.jobs === 'object'){
                Object.keys(content.jobs).forEach(uuid => {
                    const job = content.jobs[uuid];
                    if (!Array.isArray(job.events)) job.events = [];
                    if (job.dispatchPhase === undefined) job.dispatchPhase = null;
                    if (job.dispatchAcceptedAt === undefined) job.dispatchAcceptedAt = null;
                });
                const hasProjects = content.projects && typeof content.projects === 'object';
                const loadedProjects = hasProjects ? content.projects : {};
                Object.keys(loadedProjects).forEach(name => {
                    if (!Array.isArray(loadedProjects[name].events)) loadedProjects[name].events = [];
                });

                if (!hasProjects){
                    const newestByProject = {};
                    Object.keys(content.jobs).forEach(uuid => {
                        const job = content.jobs[uuid];
                        const name = sanitizeProjectName(job.name, "");
                        if (!name) return;
                        const current = newestByProject[name];
                        if (!current || (job.createdAt || 0) > (current.createdAt || 0)){
                            newestByProject[name] = job;
                        }
                    });
                    Object.keys(newestByProject).forEach(name => {
                        const job = newestByProject[name];
                        if (job.status !== STATUS.DELETED) return;
                        const at = job.deletedAt || job.updatedAt || new Date().getTime();
                        const project = newProjectRecord(name, at);
                        const actor = sanitizeActor(job.lastUpdatedBy);
                        project.archived = true;
                        project.archivedAt = at;
                        project.archivedBy = actor;
                        project.lastUpdatedBy = actor;
                        project.events.push({
                            at,
                            action: 'archived',
                            actor
                        });
                        loadedProjects[name] = project;
                    });
                }

                return {
                    jobs: content.jobs,
                    projects: loadedProjects,
                    migrated: !hasProjects
                };
            }
            return {jobs: {}, projects: {}, migrated: false};
        }catch(err){
            if (err.code !== 'ENOENT'){
                logger.warn(`Cannot read job history from disk: ${err.message}`);
            }
            return {jobs: {}, projects: {}, migrated: false};
        }
    },

    cleanup: async function(){
        if (!jobs || !projects) return;
        try{
            await scheduleSave();
            logger.info("Saved job history to disk");
        }catch(e){
            logger.warn(e);
        }
    }
};
