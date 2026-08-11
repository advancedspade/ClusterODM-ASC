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

// Reconciles the durable ledger with what the gateway actually knows how to
// reach. Both jobs run at boot and on a short interval:
//
//   1. Release dispatch claims stranded by a gateway that died mid-hand-off,
//      otherwise a persisted claim would reject every retry and resume forever.
//   2. Settle jobs the gateway has permanently lost track of, so they stop
//      rendering as "In progress" with no activity.
//
// See ../docs/observability.md for how to query what this emits.

const config = require('../config');
const logger = require('./logger');
const jobHistory = require('./jobHistory');
const routetable = require('./routetable');
const tasktable = require('./tasktable');
const nodes = require('./nodes');
const statusCodes = require('./statusCodes');
const Node = require('./classes/Node');

const DEFAULT_ORPHAN_TIMEOUT_HOURS = 6;
// Static processing nodes do not receive the autoscaler's completion webhook.
// Poll routed tasks often enough that their UI status matches production.
const SWEEP_INTERVAL = 1000 * 30;

// Generous by default: a cold autoscale boot plus a large upload can legitimately
// keep a job quiet for a long time, and a false "failed" is worse than a late one.
function orphanTimeoutMs(){
    const hours = parseInt(config.orphan_timeout, 10);
    const effective = (Number.isFinite(hours) && hours > 0) ? hours : DEFAULT_ORPHAN_TIMEOUT_HOURS;
    return 1000 * 60 * 60 * effective;
}

// A dispatch is live only while the gateway holds in-memory state for it. After
// a restart nothing does, which is precisely when a persisted claim must go.
async function hasLiveDispatch(uuid){
    if (await tasktable.lookup(uuid)) return true;
    if (await routetable.lookup(uuid)) return true;
    return false;
}

// NodeODM's wording when it has no record of a uuid. Node.taskInfo() flattens
// transport failures and API errors into the same {error} shape, so the message
// is the only signal that separates "worker is down" from "task is gone".
const TASK_MISSING = /not found/i;

async function workerAnswers(node){
    const info = await node.getRequest('/info');
    return !!(info && !info.error);
}

/**
 * Asks the last known worker whether it still has the task. routetable discards
 * routes whose node vanished from nodes.json, so a job with a healthy worker can
 * lose its route; failing it without asking would kill a running job's record.
 */
async function probeWorker(job, routedNode = null){
    const hint = jobHistory.lastNodeHint(job);
    if (!routedNode && !hint){
        return {reachable: false, registered: false, reason: 'no worker was ever assigned'};
    }

    const registered = routedNode || nodes.find(n => n.hostname() === hint.hostname && n.port() === hint.port);
    const node = registered || new Node(hint.hostname, hint.port);

    const info = await node.taskInfo(job.uuid);
    if (!info || info.error){
        const reason = (info && info.error) || 'no response';

        // A worker that still answers /info is healthy, so its verdict on a task
        // it no longer holds is final rather than a network blip worth waiting out.
        const taskGone = TASK_MISSING.test(reason) && await workerAnswers(node);

        return {reachable: false, taskGone, registered: !!registered, node, reason};
    }

    return {reachable: true, registered: !!registered, node, info};
}

async function sweep(){
    const now = new Date().getTime();
    const threshold = orphanTimeoutMs();
    const candidates = await jobHistory.listNonTerminal();

    let orphaned = 0;
    let healed = 0;

    for (const job of candidates){
        const age = now - (job.updatedAt || job.createdAt || now);
        // In-memory task entries mean the gateway is still dispatching. Routed
        // tasks are different: their worker may have reached a terminal state
        // without a webhook, so they must be probed even while the route exists.
        if (await tasktable.lookup(job.uuid)) continue;

        const route = await routetable.lookup(job.uuid);
        if (!route && age < threshold) continue;

        let probe;
        try{
            probe = await probeWorker(job, route && route.node);
        }catch(e){
            probe = {reachable: false, registered: false, reason: e.message};
        }

        if (probe.reachable){
            const code = probe.info.status && probe.info.status.code;
            const unfinished = [statusCodes.QUEUED, statusCodes.RUNNING].indexOf(code) !== -1;

            if (unfinished){
                if (route) continue;

                // Only restore a route we can actually persist; a node absent from
                // nodes.json would be dropped again on the next reload.
                if (probe.registered) await routetable.add(job.uuid, probe.node, job.ownerKey);
                await jobHistory.record(job.uuid, 'recovered', {
                    status: jobHistory.STATUS.RUNNING,
                    detail: `worker ${probe.node} still has this task`
                });
            }else{
                const status = probe.info.status || {};
                await jobHistory.recordWorkerOutcome(job.uuid, probe.info, {
                    detail: status.errorMessage || `reported by worker ${probe.node}`
                });
            }

            healed++;
            logger.event('task.recovered', {
                taskId: job.uuid,
                imagesCount: job.imagesCount,
                node: String(probe.node),
                statusCode: code,
                ageMs: age
            });
            continue;
        }

        // A transient worker outage must not turn a healthy routed task into a
        // failure. The same age threshold used for route-less orphans applies,
        // unless the worker itself already told us the task is gone.
        if (!probe.taskGone && age < threshold) continue;

        // Leaving the route behind would keep proxying status reads to a worker
        // that answers "not found", hiding the outcome we just recorded.
        if (route) await routetable.delete(job.uuid);

        await jobHistory.record(job.uuid, 'failed', {
            status: jobHistory.STATUS.FAILED,
            detail: probe.taskGone ? `worker ${probe.node} no longer has this task`
                                   : 'orphaned - gateway lost track of this task'
        });
        await jobHistory.clearDispatchPhase(job.uuid);

        orphaned++;
        logger.event('task.orphaned', {
            taskId: job.uuid,
            name: job.name,
            imagesCount: job.imagesCount,
            ageMs: age,
            detail: probe.reason
        });
    }

    if (orphaned || healed){
        logger.info(`Orphan sweep: ${orphaned} marked failed, ${healed} recovered`);
    }

    return {orphaned, healed, examined: candidates.length};
}

/**
 * Non-terminal jobs that the sweeper would settle right now. Read-only, so the
 * admin CLI can show what is at risk before anything is changed.
 */
async function findOrphans(){
    const now = new Date().getTime();
    const threshold = orphanTimeoutMs();
    const result = [];

    for (const job of await jobHistory.listNonTerminal()){
        const age = now - (job.updatedAt || job.createdAt || now);
        if (await hasLiveDispatch(job.uuid)) continue;

        result.push({
            uuid: job.uuid,
            name: job.name,
            status: job.status,
            dispatchPhase: job.dispatchPhase || null,
            imagesCount: job.imagesCount,
            ageMs: age,
            agedOut: age >= threshold
        });
    }

    return result.sort((a, b) => b.ageMs - a.ageMs);
}

module.exports = {
    initialize: async function(){
        const cleared = await jobHistory.clearStaleDispatchPhases(hasLiveDispatch);
        if (cleared.length){
            logger.event('task.dispatch.reset', {
                count: cleared.length,
                taskIds: cleared.slice(0, 20)
            });
        }

        await sweep();
        setInterval(() => {
            sweep().catch(e => logger.warn(`Orphan sweep failed: ${e.message}`));
        }, SWEEP_INTERVAL);
    },

    hasLiveDispatch,
    sweep,
    findOrphans
};
