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

// Durable per-user job ledger. Unlike routetable (routing only, expires) and
// tasktable (memory only), this survives gateway restarts and worker teardown,
// so users keep seeing a job's outcome and who acted on it.

const DEFAULT_HISTORY_FILE = path.join('data', 'jobs.json');
const SCHEMA_VERSION = 1;
const MAX_EVENTS_PER_JOB = 200;

const STATUS = {
    QUEUED: 'queued',
    RUNNING: 'running',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    CANCELED: 'canceled',
    DELETED: 'deleted'
};

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
        events: []
    };
}

function writeNow(){
    const payload = JSON.stringify({version: SCHEMA_VERSION, jobs});
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

module.exports = {
    STATUS,

    /**
     * Last known state in the shape NodeODM clients expect, so a task whose
     * worker is gone still reports an outcome instead of a routing error.
     */
    toTaskInfo: function(record){
        const settled = TERMINAL.indexOf(record.status) !== -1;
        return {
            uuid: record.uuid,
            name: record.name || record.uuid,
            dateCreated: record.createdAt,
            processingTime: (record.startedAt && record.finishedAt) ?
                                record.finishedAt - record.startedAt : -1,
            status: {code: record.statusCode || statusCodes.FAILED},
            options: [],
            imagesCount: record.imagesCount || 0,
            progress: settled ? 100 : 0
        };
    },

    initialize: async function(filePath){
        historyFile = filePath || DEFAULT_HISTORY_FILE;
        jobs = await this.loadFromDisk();
        logger.info(`Loaded ${Object.keys(jobs).length} job history records`);
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
        const includeDeleted = options.includeDeleted !== false;

        const result = Object.keys(jobs)
            .map(uuid => jobs[uuid])
            .filter(job => job.ownerKey === ownerKey)
            .filter(job => includeDeleted || job.status !== STATUS.DELETED)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        const limit = parseInt(options.limit, 10);
        const limited = limit > 0 ? result.slice(0, limit) : result;

        return limited.map(toPublic);
    },

    saveToDisk: async function(){
        if (!jobs) return;
        return scheduleSave();
    },

    loadFromDisk: async function(){
        try{
            const raw = await fs.promises.readFile(historyFile, 'utf8');
            const content = JSON.parse(raw);
            if (content && content.jobs && typeof content.jobs === 'object'){
                Object.keys(content.jobs).forEach(uuid => {
                    if (!Array.isArray(content.jobs[uuid].events)) content.jobs[uuid].events = [];
                });
                return content.jobs;
            }
            return {};
        }catch(err){
            if (err.code !== 'ENOENT'){
                logger.warn(`Cannot read job history from disk: ${err.message}`);
            }
            return {};
        }
    },

    cleanup: async function(){
        if (!jobs) return;
        try{
            await scheduleSave();
            logger.info("Saved job history to disk");
        }catch(e){
            logger.warn(e);
        }
    }
};
