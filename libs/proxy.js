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
const HttpProxy = require('http-proxy');
const http = require('http');
const https = require('https');
const path = require('path');
const url = require('url');
const Busboy = require('busboy');
const fs = require('fs');
const nodes = require('./nodes');
const ValueCache = require('./classes/ValueCache');
const config = require('../config');
const utils = require('./utils');
const routetable = require('./routetable');
const tasktable = require('./tasktable');
const jobHistory = require('./jobHistory');
const reconcile = require('./reconcile');
const logger = require('./logger');
const accessLog = require('./accessLog');
const statusCodes = require('./statusCodes');
const taskNew = require('./taskNew');
const async = require('async');
const odmOptions = require('./odmOptions');
const asrProvider = require('./asrProvider');
const floodMonitor = require('./floodMonitor');
const concurrencyMonitor = require('./concurrencyMonitor');
const AWS = require('aws-sdk');
const ascUiRoutes = require('./ascUiRoutes');
const {sanitizeProjectName} = require('./gcsProjectName');
const querystring = require('querystring');
const events = require('events');

// Set by initialize() so the admin CLI can drive a commit and inspect stranded
// uploads without going through an HTTP client.
let commitFromAdmin = null;
let listPendingFromAdmin = null;

// Stands in for an http.ServerResponse when a commit is triggered out of band.
// It emits 'finish' so the same lifecycle logging applies to an admin resume.
function collectorResponse(){
    const res = new events.EventEmitter();
    res.statusCode = 200;
    res.body = null;
    res.writableFinished = false;
    res.setHeader = () => {};
    res.writeHead = (code) => { res.statusCode = code; return res; };
    res.end = (data) => {
        res.body = data;
        res.writableFinished = true;
        res.emit('finish');
    };
    return res;
}

module.exports = {
    /**
     * Re-runs the commit for an upload the gateway still has on disk. Same code
     * path (and therefore same idempotency guarantees) as the HTTP endpoint.
     */
    resumeTask: async function(taskId){
        if (!utils.isTaskUuid(taskId)) throw new Error("Invalid taskId");
        if (!commitFromAdmin) throw new Error("Proxy is not initialized yet");

        const job = await jobHistory.lookup(taskId);
        const res = collectorResponse();
        const req = Object.assign(new events.EventEmitter(), {
            headers: {host: `localhost:${config.port}`},
            clusterAuthToken: (job && job.ownerKey) || config.token || ""
        });

        await commitFromAdmin({
            req,
            res,
            taskId,
            userToken: (job && job.ownerKey) || undefined,
            actor: {source: 'admin'},
            limits: {}
        });

        try{
            return JSON.parse(res.body);
        }catch(e){
            return {error: `Unexpected commit response: ${res.body}`};
        }
    },

    pendingUploads: async function(){
        if (!listPendingFromAdmin) throw new Error("Proxy is not initialized yet");
        return listPendingFromAdmin(null);
    },

    initialize: async function(cloudProvider){
        await routetable.initialize();
        await tasktable.initialize();
        await jobHistory.initialize();

        // Cleanup consults the ledger, so it only runs once the ledger is loaded.
        utils.cleanupTemporaryDirectory(config.stale_uploads_timeout, config.tmp_max_age);
        setInterval(() => {
            utils.cleanupTemporaryDirectory(config.stale_uploads_timeout, config.tmp_max_age);
        }, 1000 * 60 * 30);

        await reconcile.initialize();

        // Allow index, .css and .js files to be retrieved from nodes
        // without authentication
        const publicPath = (p) => {
            for (let ext of [".css", ".js", ".woff", ".ttf", ".ico"]){
                if (p.substr(-ext.length) === ext){
                    return true;
                }
            }
            return false;
        };

        // Paths that are forwarded as-is, without additional logic
        // (but require authentication)
        const directPath = (p) => {
            if (p === '/') return true;

            return false;
        };

        // JSON helper for responses
        const json = utils.json;
        const ascUiEnabled = String(config.cloud_provider || "").toLowerCase() === "ascoauth";

        const forwardToReferenceNode = (req, res) => {
            const referenceNode = nodes.referenceNode();
            if (referenceNode){
                proxy.web(req, res, { target: referenceNode.proxyTargetUrl() });
            }else{
                json(res, {error: "No nodes available"});
            }
        };

        const forwardToUiReferenceNode = (req, res) => {
            const referenceNode = nodes.uiReferenceNode();
            if (referenceNode){
                proxy.web(req, res, {
                    target: referenceNode.proxyTargetUrl(),
                    xfwd: true
                });
            }else{
                res.writeHead(503, {"Content-Type": "application/json"});
                res.end(JSON.stringify({error: "The locked NodeODM-ASC UI reference node is unavailable"}));
            }
        };

        const getLimitedOptions = async (token, limits, node) => {
            const cacheValue = optionsCache.get(token);
            if (cacheValue) return cacheValue;

            const options = await node.getOptions();
            const limitedOptions = odmOptions.optionsWithLimits(options, limits.options);
            return optionsCache.set(token, limitedOptions);
        };

        const maxConcurrencyLimitReached = async (maxConcurrentTasks, token) => {
            if (maxConcurrentTasks === 0) return true;
            if (!maxConcurrentTasks) return false;

            const userRoutes = await routetable.findByToken(token);
            let runningTasks = 0;
            await new Promise((resolve) => {
                async.each(Object.keys(userRoutes), (taskId, cb) => {
                    (userRoutes[taskId]).node.taskInfo(taskId).then((taskInfo) => {
                        if (taskInfo.status && [statusCodes.QUEUED, statusCodes.RUNNING].indexOf(taskInfo.status.code) !== -1) runningTasks++;
                        cb();
                    });
                }, resolve);
            });
            
            return runningTasks >= maxConcurrentTasks;
        };

        const getReqBody = async (req) => {
            return new Promise((resolve, reject) => {
                let body = [];
                req.on('data', (chunk) => {
                    body.push(chunk);
                }).on('end', () => {
                    resolve(Buffer.concat(body).toString());
                });
            });
        };

        const getCappedReqBody = async (req, maxBytes) => {
            return new Promise((resolve, reject) => {
                let size = 0;
                const chunks = [];
                req.on('data', chunk => {
                    size += chunk.length;
                    if (size > maxBytes){
                        req.destroy();
                        reject(new Error(`body exceeds ${maxBytes} bytes`));
                        return;
                    }
                    chunks.push(chunk);
                });
                req.on('end', () => resolve(Buffer.concat(chunks).toString()));
                req.on('error', reject);
            });
        };

        // Emits once per response. `outcome` is what tells a commit the client
        // never received apart from one the gateway never answered.
        const trackResponse = (res, event, fields) => {
            const startedAt = new Date().getTime();
            let emitted = false;
            const emit = (outcome) => {
                if (emitted) return;
                emitted = true;
                logger.event(event, Object.assign({}, fields, {
                    durationMs: new Date().getTime() - startedAt,
                    outcome
                }));
            };

            res.once('finish', () => emit('responded'));
            res.once('close', () => emit(res.writableFinished ? 'responded' : 'aborted'));
        };

        // Replace token 
        const overrideRequest = (req, node, query, pathname) => {
            if (node.getToken()){
                // Override token. When requests come in through
                // the proxy, the token is the user's token
                // but when we redirect them to a node
                // the token is specific to the node.
                query.token = node.getToken();
            }

            req.url = url.format({ query, pathname });
        };

        // Uploads that finished but were never handed to a worker. This is what
        // makes a commit lost to a dropped connection visible and resumable
        // instead of invisible until the retention window deletes it.
        const listPendingUploads = async (userToken) => {
            let entries = [];
            try{
                entries = await fs.promises.readdir('tmp');
            }catch(e){
                logger.warn(`Cannot list pending uploads: ${e.message}`);
                return [];
            }

            const now = new Date().getTime();
            const pending = [];

            for (const entry of entries){
                if (!utils.isTaskUuid(entry)) continue;

                const tmpPath = path.join('tmp', entry);
                let files, stats, body;
                try{
                    stats = await fs.promises.stat(tmpPath);
                    if (!stats.isDirectory()) continue;
                    files = await fs.promises.readdir(tmpPath);
                    if (files.indexOf('body.json') === -1) continue;
                    body = JSON.parse(await fs.promises.readFile(path.join(tmpPath, 'body.json'), 'utf8'));
                }catch(e){
                    continue;
                }

                // Anything the gateway is still working on is not stranded.
                if (await routetable.lookup(entry)) continue;
                if (await tasktable.lookup(entry)) continue;
                if (await jobHistory.hasActiveDispatch(entry)) continue;

                const job = await jobHistory.lookup(entry);
                if (job){
                    if (job.ownerKey && userToken && job.ownerKey !== userToken) continue;

                    if (!jobHistory.isResumable(job)) continue;
                }

                const createdAt = (job && job.createdAt) || stats.mtime.getTime();
                pending.push({
                    uuid: entry,
                    name: (job && job.name) || body.taskName || null,
                    imagesCount: files.filter(f => f.toLowerCase() !== 'body.json').length,
                    createdAt,
                    ageMs: now - createdAt,
                    status: (job && job.status) || null
                });
            }

            return pending.sort((a, b) => b.createdAt - a.createdAt);
        };

        /**
         * Hands an uploaded task to a worker. Idempotent: a client that never saw
         * the response can POST the same commit again and gets the original uuid
         * back rather than starting a second run.
         */
        const commitTask = async ({ req, res, taskId, userToken, actor, limits }) => {
            const tmpPath = path.join('tmp', taskId);
            const bodyFile = path.join(tmpPath, 'body.json');
            const actorEmail = actor && actor.email;

            logger.event('task.commit.received', {taskId, actor: actorEmail});
            trackResponse(res, 'task.commit.responded', {taskId, actor: actorEmail});

            const duplicate = (reason, extra = {}) => {
                logger.event('task.commit.duplicate', Object.assign({taskId, reason, actor: actorEmail}, extra));
                json(res, {uuid: taskId});
            };

            const die = async (err) => {
                await jobHistory.record(taskId, 'failed', {
                    ownerKey: userToken,
                    actor,
                    status: jobHistory.STATUS.FAILED,
                    detail: err
                });
                logger.event('task.failed', {taskId, actor: actorEmail, detail: err});
                utils.rmdir(tmpPath);
                asrProvider.cleanup(taskId);
                json(res, {error: err});
            };

            // Early exits that mean "this upload is already spoken for" must run
            // before concurrency accounting, so a retry does not burn the
            // per-minute commit budget reserved for genuinely new tasks. The
            // ledger claim itself waits until validation succeeds: otherwise a
            // concurrent retry can be told {uuid} while the winner later rejects
            // and clears the phase.
            const routedNode = await routetable.lookupNode(taskId);
            if (routedNode){
                duplicate('routed', {node: String(routedNode)});
                return;
            }
            if (await tasktable.lookup(taskId)){
                duplicate('dispatching');
                return;
            }
            if (await jobHistory.hasActiveDispatch(taskId)){
                duplicate('in-progress');
                return;
            }
            const existing = await jobHistory.lookup(taskId);
            if (existing && existing.dispatchPhase === jobHistory.DISPATCH_PHASE.ROUTED){
                duplicate('routed');
                return;
            }
            if (existing && (existing.status === jobHistory.STATUS.DELETED ||
                             existing.status === jobHistory.STATUS.CANCELED)){
                logger.event('task.commit.rejected', {taskId, actor: actorEmail, detail: existing.status});
                json(res, {error: `Task ${taskId} was ${existing.status} and cannot be committed again.`});
                return;
            }
            if (existing && existing.status === jobHistory.STATUS.SUCCEEDED){
                duplicate('succeeded');
                return;
            }

            if (!fs.existsSync(bodyFile)){
                logger.event('task.commit.rejected', {taskId, actor: actorEmail, detail: 'missing upload'});
                json(res, {error: `Cannot commit task ${taskId}: its uploaded files are no longer available. Please upload again.`});
                return;
            }

            if (concurrencyMonitor.checkCommitLimitReached(limits.maxConcurrentTasks, userToken)){
                logger.event('task.commit.rejected', {taskId, actor: actorEmail, detail: 'commit limit'});
                json(res, {error: `Reached maximum number of concurrent tasks, please wait until other tasks have finished, then restart the task.`});
                return;
            }

            if (await maxConcurrencyLimitReached(limits.maxConcurrentTasks, userToken)){
                logger.event('task.commit.rejected', {taskId, actor: actorEmail, detail: 'concurrency limit'});
                json(res, {error: `Reached maximum number of concurrent tasks. Please wait until other tasks have finished, then restart the task.`});
                return;
            }

            let body, files;
            try{
                body = JSON.parse(await fs.promises.readFile(bodyFile, 'utf8'));
                files = (await fs.promises.readdir(tmpPath)).filter(f => f.toLowerCase() !== 'body.json');
            }catch(e){
                logger.event('task.commit.rejected', {taskId, actor: actorEmail, detail: e.message});
                json(res, {error: `Cannot commit task: ${e.message}`});
                return;
            }

            body.fileNames = files;
            body.imagesCount = files.length;

            const claim = jobHistory.tryAcceptCommit(taskId, {ownerKey: userToken});
            if (!claim.accepted){
                if (claim.reason === jobHistory.STATUS.DELETED || claim.reason === jobHistory.STATUS.CANCELED){
                    logger.event('task.commit.rejected', {taskId, actor: actorEmail, detail: claim.reason});
                    json(res, {error: `Task ${taskId} was ${claim.reason} and cannot be committed again.`});
                }else{
                    duplicate(claim.reason);
                }
                return;
            }

            // Nothing may observe the claim before it is durable: a restart
            // between here and the worker hand-off would reload a ledger with no
            // claim and dispatch this same upload a second time.
            await claim.saved;

            floodMonitor.recordTaskCommit(userToken);
            utils.markTaskAsCommitted(taskId);

            await jobHistory.record(taskId, 'uploaded', {
                ownerKey: userToken,
                actor,
                name: body.taskName,
                imagesCount: body.imagesCount,
                // Resuming a swept orphan has to move it off `failed` explicitly,
                // since the ledger otherwise refuses to walk a settled job back.
                status: claim.revived ? jobHistory.STATUS.QUEUED : undefined,
                allowRevive: claim.revived
            });

            logger.event('task.commit.accepted', {
                taskId,
                actor: actorEmail,
                imagesCount: body.imagesCount,
                name: body.taskName,
                resumed: claim.revived
            });

            try{
                await taskNew.process(req, res, cloudProvider, taskId, body, userToken, limits, getLimitedOptions, actor);
            }catch(e){
                await die(e.message);
            }
        };

        // Client-side diagnostics. Capped and rate limited because this is reachable
        // from a public host, even though it sits behind the auth gate.
        const CLIENT_DIAG_MAX_BODY = 8 * 1024;
        const CLIENT_DIAG_WINDOW = 5 * 60 * 1000;
        const CLIENT_DIAG_MAX_REPORTS = 30;
        const clientDiagHits = {};

        const clientDiagAllowed = (token) => {
            const key = token || 'anonymous';
            const now = new Date().getTime();

            Object.keys(clientDiagHits).forEach(k => {
                clientDiagHits[k] = clientDiagHits[k].filter(t => now - t < CLIENT_DIAG_WINDOW);
                if (!clientDiagHits[k].length) delete clientDiagHits[k];
            });

            const hits = clientDiagHits[key] || (clientDiagHits[key] = []);
            hits.push(now);
            return hits.length <= CLIENT_DIAG_MAX_REPORTS;
        };

        commitFromAdmin = commitTask;
        listPendingFromAdmin = listPendingUploads;

        const clipField = (value, maxLength) => {
            if (value === undefined || value === null) return null;
            const str = String(value).replace(/[\r\n]+/g, ' ');
            return str.length > maxLength ? str.slice(0, maxLength) : str;
        };

        const numberField = (value) => {
            const num = Number(value);
            return Number.isFinite(num) ? num : null;
        };

        const READONLY_TASK_ACTIONS = ['info', 'output'];

        /**
         * Answers /task/<uuid>/info and /task/<uuid>/output from the gateway's own
         * state: the task table snapshot taken before a worker is torn down, then
         * the durable job ledger. Returns false when the gateway knows nothing
         * about the task and the caller has to produce an error.
         */
        const serveTaskFromLocalState = async (res, taskId, action, query = {}) => {
            const taskTableEntry = await tasktable.lookup(taskId);
            // An entry with no snapshot cannot answer /info; the ledger can.
            if (taskTableEntry && (action !== 'info' || taskTableEntry.taskInfo)){
                if (action === 'info'){
                    let response = taskTableEntry.taskInfo;

                    // ?with_output support
                    if (query.with_output !== undefined){
                        const line = parseInt(query.with_output) || 0;
                        const output = taskTableEntry.output || [];
                        response.output = output.slice(line, output.length);
                    }

                    // Populate processingTime if needed
                    if (response.processingTime === undefined){
                        response = utils.clone(response);
                        if (response.dateCreated && response.status && response.status.code === statusCodes.RUNNING){
                            response.processingTime = (new Date().getTime()) - response.dateCreated;
                        }else{
                            response.processingTime = -1;
                        }
                    }

                    json(res, response);
                }else if (action === 'output'){
                    const line = query.line || 0;
                    const output = taskTableEntry.output || [];
                    json(res, output.slice(line, output.length));
                }else{
                    json(res, { error: `Invalid route for taskId ${taskId}:${action}, no valid route possible.`});
                }
                return true;
            }

            const job = await jobHistory.lookup(taskId);
            if (job){
                if (action === 'info'){
                    const taskInfo = jobHistory.toTaskInfo(job);
                    if (query.with_output !== undefined) taskInfo.output = [];
                    json(res, taskInfo);
                }else if (action === 'output'){
                    json(res, []);
                }else{
                    json(res, { error: `Invalid route for taskId ${taskId}:${action}, no valid route possible.`});
                }
                return true;
            }

            return false;
        };

        const proxy = new HttpProxy();
        const optionsCache = new ValueCache({expires: 60 * 60 * 1000});
        const pathHandlers = {
            '/info': function(req, res, user){
                const { limits } = user;
                const node = nodes.referenceNode();
                
                json(res, {
                    version: "1.5.3", // this is the version we speak
                    taskQueueCount: 0,
                    totalMemory: 99999999999, 
                    availableMemory: 99999999999,
                    cpuCores: 99999999999,
                    maxImages: limits.maxImages || null,
                    maxParallelTasks: limits.maxConcurrentTasks !== undefined ? limits.maxConcurrentTasks : 99999999999,
                    engineVersion: node !== undefined ? node.getInfo().engineVersion : '?',
                    engine: node !== undefined ? node.getInfo().engine : '?'
                });
            },

            '/options': async function(req, res, user){
                const { token, limits } = user;
                const node = nodes.referenceNode();
                if (!node) json(res, {'error': 'Cannot compute /options, no nodes are online.'});
                else{
                    const options = await getLimitedOptions(token, limits, node);
                    json(res, options);
                }
            },

            '/cache/clear': async function(req, res, user){
                const { token } = user;
                optionsCache.clear(token);
                cloudProvider.clearCache(token);
                json(res, {ok: true});
            },
        }

        // Listen for the `error` event on `proxy`.
        proxy.on('error', async function (err, req, res) {
            const ctx = req.proxyTaskContext || {};

            // A worker that died mid-flight is a transport failure, not a task
            // outcome. Keep it out of the task.* namespace so it stays queryable
            // without reading as a processing failure.
            logger.event('proxy.redirect.failed', {
                taskId: ctx.taskId || null,
                action: ctx.action || null,
                node: ctx.node ? String(ctx.node) : null,
                errorCode: err.code || 'UNKNOWN',
                detail: err.message,
                level: 'warn'
            });

            // Reads can still be answered from what the gateway knows, which is
            // the whole point of the task table snapshot and the job ledger.
            if (ctx.taskId && READONLY_TASK_ACTIONS.indexOf(ctx.action) !== -1 && !res.headersSent){
                try{
                    if (await serveTaskFromLocalState(res, ctx.taskId, ctx.action, ctx.query)) return;
                }catch(e){
                    logger.warn(`Cannot serve ${ctx.taskId}:${ctx.action} from local state: ${e.message}`);
                }
            }

            if (res.headersSent){
                if (res.socket) res.socket.destroy();
                return;
            }

            // Nothing local to fall back on: drop the connection rather than hand
            // back a JSON body, which a NodeODM client reads as the task itself
            // having failed.
            if (res.socket) res.socket.destroy();
            else json(res, {error: `Proxy redirect error: ${err.message}`});
        });

        // Added for CORS support
        var enableCors = function(req, res) {
          if (req.headers['access-control-request-method']) {
              res.setHeader('access-control-allow-methods', req.headers['access-control-request-method']);
          }

          if (req.headers['access-control-request-headers']) {
              res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers']);
          }

          if (req.headers.origin) {
              res.setHeader('access-control-allow-origin', req.headers.origin);
              res.setHeader('access-control-allow-credentials', 'true');
          }
        };

        const requestListener = async function (req, res) {
            enableCors(req, res);

            try{
                const urlParts = url.parse(req.url, true);
                const { query, pathname } = urlParts;

                // NodeODM-ASC owns the public UI and OAuth endpoints. Keep these
                // ahead of ClusterODM's auth gate so unsigned users can reach
                // login and Google can reach the OAuth callback.
                if (ascUiEnabled && ascUiRoutes.isPublicUiPath(pathname)){
                    forwardToUiReferenceNode(req, res);
                    return;
                }
                
                if (publicPath(pathname)){
                    forwardToReferenceNode(req, res);
                    return;
                }

                accessLog(req.socket.remoteAddress, req.url);

                if (req.method === 'POST' && pathname === '/commit'){
                    const body = await getReqBody(req);
                    try{
                        const taskInfo = JSON.parse(body);
                        const taskId = taskInfo.uuid;

                        asrProvider.onCommit(taskId, 10 * 1000);
                        
                        // Add reference to S3 path if necessary
                        if (asrProvider.downloadsPath()){
                            taskInfo.s3Path = asrProvider.downloadsPath();
                        }
                        
                        const token = await routetable.lookupToken(taskId);
                        concurrencyMonitor.decreaseCount(token);

                        await jobHistory.recordWorkerOutcome(taskId, taskInfo, {
                            ownerKey: token || undefined
                        });

                        try{
                            cloudProvider.taskFinished(token, taskInfo);
                        }catch(e){
                            logger.error(`cloudProvider.taskFinished: ${e.message}`);
                        }

                        json(res, {ok: true});
                    }catch(e){
                        logger.warn(`Malformed /commit request: ${body}`);
                        json(res, {error: "Malformed /commit request"});
                    }

                    return;
                }

                if (pathname === '/auth/info'){
                    cloudProvider.handleAuthInfo(req, res);
                    return;
                }

                // Validate user token
                const validation = await cloudProvider.validate(query.token, req);
                const valid = validation && validation.valid;
                const limits = (validation && validation.limits) || {};
                const userToken = (validation && validation.token) || query.token;
                const actor = (validation && validation.actor) || null;
                req.clusterAuthToken = (validation && validation.accessToken) || query.token;
                if (!valid || query._debugUnauthorized){
                    // json(res, {error: "Invalid authentication token"});
                    res.writeHead(401, "unauthorized");
                    res.end();
                    return;
                }

                // These custom APIs stay on the locked NodeODM-ASC reference
                // node, but only after the OAuth cookie/JWT has been verified.
                if (ascUiEnabled && ascUiRoutes.isProtectedReferencePath(pathname)){
                    forwardToUiReferenceNode(req, res);
                    return;
                }

                if (directPath(pathname)){
                    forwardToReferenceNode(req, res);
                    return;
                }

                if (pathHandlers[pathname]){
                    (pathHandlers[pathname])(req, res, { token: userToken, limits });
                    return;
                }

                if (req.method === 'POST' && pathname === '/task/new/init'){
                    let ctx = null;
                    try{
                        ctx = await taskNew.createContext(req, res);
                    }catch(e){
                        json(res, {error: e.message});
                        return;
                    }

                    const { uuid, tmpPath, die } = ctx;

                    taskNew.formDataParser(req, async function(params){
                        const { options } = params;
                        if (params.error){
                            die(params.error);
                            return;
                        }

                        const referenceNode = nodes.referenceNode();
                        if (!referenceNode){
                            die("Cannot create task, no nodes are online.");
                            return;
                        }

                        if (await maxConcurrencyLimitReached(limits.maxConcurrentTasks, userToken)){
                            // TODO: A better solution would be to put the task in a queue
                            // but it's non-trivial to keep such a state, as well as to deal
                            // with scalability of storage requirements.
                            die(`Reached maximum number of concurrent tasks: ${limits.maxConcurrentTasks}. Please wait until other tasks have finished, then restart the task.`);
                            return;
                        }

                        // Validate options
                        try{
                            odmOptions.filterOptions(options, await getLimitedOptions(userToken, limits, referenceNode));
                        }catch(e){
                            die(e.message);
                            return;
                        }

                        floodMonitor.recordTaskInit(userToken);
                        
                        if (floodMonitor.isFlooding(userToken)){
                            die(`Uuh, slow down! It seems like you are sending a lot of tasks. Check that your connection is not dropping, or wait ${floodMonitor.FORGIVE_TIME} minutes and try again.`);
                            return;
                        }

                        // Save
                        fs.writeFile(path.join(tmpPath, "body.json"),
                                    JSON.stringify(params), {encoding: 'utf8'}, async err => {
                            if (err) json(res, { error: err });
                            else{
                                await jobHistory.record(uuid, 'created', {
                                    ownerKey: userToken,
                                    actor,
                                    name: params.taskName,
                                    status: jobHistory.STATUS.QUEUED
                                });

                                logger.event('task.init', {
                                    taskId: uuid,
                                    actor: actor && actor.email,
                                    name: params.taskName || null
                                });

                                // All good
                                json(res, { uuid });
                            }
                        });
                    });
                }else if (req.method === 'POST' && pathname.indexOf('/task/new/upload') === 0){
                    // Destroy sockets after 30s of inactivity
                    req.setTimeout(30000, () => {
                        req.destroy();
                    });

                    const taskId = taskNew.getTaskIdFromPath(pathname);
                    if (taskId){
                        const saveFilesToDir = path.join('tmp', taskId);
                        async.series([
                            cb => {
                                fs.exists(saveFilesToDir, exists => {
                                    if (!exists) cb(new Error("Invalid taskId: the task no longer exists."));
                                    else cb();
                                });
                            },
                            cb => {
                                if (limits && limits.maxImages){
                                    // Check if we've exceeding image limits
                                    fs.readdir(saveFilesToDir, (err, files) => {
                                        if (err){
                                            logger.warn(`Failed to read files from ${saveFilesToDir}`);
                                            cb();
                                        }else if (files.length - 1 > limits.maxImages){
                                            // -1 accounts for _body.json
                                            cb(new Error("Max images count exceeded."));
                                        }else{
                                            cb();
                                        }
                                    });
                                }else{
                                    // No limits
                                    cb();
                                }
                            },
                            cb => {
                                taskNew.formDataParser(req, function(params){
                                    if (!params.imagesCount) cb(new Error("No files uploaded."));
                                    else if (params.error) cb(new Error(params.error));
                                    else cb(null, params.imagesCount);
                                }, { saveFilesToDir, parseFields: false});
                            }
                        ], (err, results) => {
                            if (err){
                                logger.event('task.upload.batch', {
                                    taskId,
                                    actor: actor && actor.email,
                                    detail: err.message,
                                    level: 'warn'
                                });
                                json(res, {error: err.message});
                            }else{
                                logger.event('task.upload.batch', {
                                    taskId,
                                    actor: actor && actor.email,
                                    batchCount: results[results.length - 1] || 0,
                                    level: 'debug'
                                });
                                json(res, {success: true});
                            }
                        });
                    }else json(res, { error: `No uuid found in ${pathname}`});
                }else if (req.method === 'POST' && pathname.indexOf('/task/new/commit') === 0){
                    const taskId = taskNew.getTaskIdFromPath(pathname);
                    if (taskId) await commitTask({ req, res, taskId, userToken, actor, limits });
                    else json(res, { error: `No uuid found in ${pathname}`});
                }else if (req.method === 'POST' && pathname === '/task/new') {
                    // Absorb set-uuid retries before createContext: getUuid() would
                    // otherwise reject any uuid already in tasktable/routetable as a
                    // collision, which is exactly the idempotent retry we want to keep.
                    const requestedUuid = req.headers['set-uuid'];
                    if (requestedUuid && utils.isTaskUuid(requestedUuid)){
                        if (await routetable.lookup(requestedUuid) ||
                            await tasktable.lookup(requestedUuid) ||
                            await jobHistory.hasActiveDispatch(requestedUuid)){
                            logger.event('task.commit.duplicate', {
                                taskId: requestedUuid,
                                reason: 'in-progress',
                                endpoint: '/task/new',
                                actor: actor && actor.email
                            });
                            json(res, {uuid: requestedUuid});
                            return;
                        }
                        const existingJob = await jobHistory.lookup(requestedUuid);
                        // Canceled and deleted are final. Say so before reading the
                        // body, or the client uploads an entire task to a uuid that
                        // can never be dispatched.
                        if (existingJob && (existingJob.status === jobHistory.STATUS.DELETED ||
                                            existingJob.status === jobHistory.STATUS.CANCELED)){
                            logger.event('task.commit.rejected', {
                                taskId: requestedUuid,
                                endpoint: '/task/new',
                                actor: actor && actor.email,
                                detail: existingJob.status
                            });
                            json(res, {error: `Task ${requestedUuid} was ${existingJob.status} and cannot be committed again.`});
                            return;
                        }
                        if (existingJob && existingJob.dispatchPhase === jobHistory.DISPATCH_PHASE.ROUTED){
                            logger.event('task.commit.duplicate', {
                                taskId: requestedUuid,
                                reason: 'routed',
                                endpoint: '/task/new',
                                actor: actor && actor.email
                            });
                            json(res, {uuid: requestedUuid});
                            return;
                        }
                    }

                    let ctx = null;
                    try{
                        ctx = await taskNew.createContext(req, res);
                    }catch(e){
                        json(res, {error: e.message});
                        return;
                    }

                    const { uuid, tmpPath, die } = ctx;

                    taskNew.formDataParser(req, async function(params) {
                        if (params.error){
                            die(params.error);
                            return;
                        }

                        if (await maxConcurrencyLimitReached(limits.maxConcurrentTasks, userToken)){
                            die(`Reached maximum number of concurrent tasks: ${limits.maxConcurrentTasks}. Please wait until other tasks have finished, then restart the task.`);
                            return;
                        }

                        // Claim only after the body parsed and quota cleared, so a
                        // concurrent retry is not told {uuid} for an attempt that
                        // later dies on validation.
                        const claim = jobHistory.tryAcceptCommit(uuid, {ownerKey: userToken});
                        if (!claim.accepted){
                            // A canceled or deleted uuid is settled for good, not a
                            // retry of something in flight: reporting {uuid} would
                            // claim success for a body nobody will ever dispatch and
                            // strand it in tmp. Only genuine in-flight or already
                            // finished work answers idempotently.
                            if (claim.reason === jobHistory.STATUS.DELETED ||
                                claim.reason === jobHistory.STATUS.CANCELED){
                                logger.event('task.commit.rejected', {
                                    taskId: uuid,
                                    endpoint: '/task/new',
                                    actor: actor && actor.email,
                                    detail: claim.reason
                                });
                                die(`Task ${uuid} was ${claim.reason} and cannot be committed again.`);
                                return;
                            }

                            logger.event('task.commit.duplicate', {
                                taskId: uuid,
                                reason: claim.reason,
                                endpoint: '/task/new',
                                actor: actor && actor.email
                            });
                            json(res, { uuid });
                            return;
                        }

                        await claim.saved;

                        await jobHistory.record(uuid, 'created', {
                            ownerKey: userToken,
                            actor,
                            name: params.taskName,
                            imagesCount: params.imagesCount,
                            status: jobHistory.STATUS.QUEUED
                        });

                        logger.event('task.commit.received', {
                            taskId: uuid,
                            actor: actor && actor.email,
                            imagesCount: params.imagesCount,
                            endpoint: '/task/new'
                        });
                        trackResponse(res, 'task.commit.responded', {
                            taskId: uuid,
                            actor: actor && actor.email,
                            endpoint: '/task/new'
                        });

                        try{
                            await taskNew.process(req, res, cloudProvider, uuid, params, userToken, limits, getLimitedOptions, actor);
                        }catch(e){
                            await jobHistory.record(uuid, 'failed', {
                                ownerKey: userToken,
                                actor,
                                status: jobHistory.STATUS.FAILED,
                                detail: e.message
                            });
                            logger.event('task.failed', {
                                taskId: uuid,
                                actor: actor && actor.email,
                                endpoint: '/task/new',
                                detail: e.message
                            });
                            die(e.message);
                            return;
                        }
                    }, { saveFilesToDir: tmpPath, limits });
                }else if (req.method === 'POST' && ['/task/restart', '/task/cancel', '/task/remove'].indexOf(pathname) !== -1){
                    // Lookup task id from body
                    let taskId = null;
                    let body = await getReqBody(req);

                    const busboy = new Busboy({ headers: req.headers });
                    busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated) {
                        if (fieldname === 'uuid'){
                            taskId = val;
                        }
                    });
                    busboy.on('finish', async function() {
                        if (!taskId){
                            json(res, { error: `No uuid found in ${pathname}`});
                            return;
                        }
                        if (!utils.isTaskUuid(taskId)){
                            json(res, { error: `Invalid uuid`});
                            return;
                        }

                        concurrencyMonitor.decreaseCount(userToken);

                        const recordAction = async () => {
                            if (pathname === '/task/remove'){
                                await jobHistory.record(taskId, 'deleted', {
                                    ownerKey: userToken,
                                    actor,
                                    status: jobHistory.STATUS.DELETED
                                });
                            }else if (pathname === '/task/cancel'){
                                await jobHistory.record(taskId, 'canceled', {
                                    ownerKey: userToken,
                                    actor,
                                    status: jobHistory.STATUS.CANCELED
                                });
                            }else{
                                await jobHistory.record(taskId, 'restarted', {
                                    ownerKey: userToken,
                                    actor,
                                    status: jobHistory.STATUS.RUNNING,
                                    allowRevive: true
                                });
                            }
                        };

                        let node = await routetable.lookupNode(taskId);
                        if (node){
                            await recordAction();
                            overrideRequest(req, node, query, pathname);
                            proxy.web(req, res, { 
                                    target: node.proxyTargetUrl(),
                                    buffer: utils.stringToStream(body)
                                });
                        }else{
                            const taskTableEntry = await tasktable.lookup(taskId);
                            if (taskTableEntry && taskTableEntry.taskInfo){
                                if (pathname === '/task/cancel' || pathname === '/task/remove'){
                                    if (taskTableEntry.abort){
                                        taskTableEntry.abort();
                                        taskTableEntry.abort = null;
                                        logger.info(`Task ${taskId} aborted via ${pathname}`);
                                    }
                                    
                                    utils.rmdir(path.join('tmp', taskId));

                                    if (pathname === '/task/remove'){
                                        await tasktable.delete(taskId);
                                    }

                                    if (pathname === '/task/cancel'){
                                        taskTableEntry.taskInfo.status.code = statusCodes.CANCELED;
                                        await tasktable.add(taskId, taskTableEntry, userToken);
                                    }

                                    await recordAction();
                                    json(res, { success: true });
                                }else{
                                    json(res, { error: `Action not supported. Please create a new task.` });
                                }
                            }else{
                                // The worker is gone and nothing is cached, which is the
                                // normal end state of an autoscaled job. Removing and
                                // canceling are idempotent for any signed-in teammate.
                                const job = await jobHistory.lookup(taskId);
                                if (pathname === '/task/restart'){
                                    json(res, { error: `Cannot restart task ${taskId}: its processing node is no longer available. Please create a new task.`});
                                }else{
                                    utils.rmdir(path.join('tmp', taskId));

                                    // Jobs predating the history ledger have no row to
                                    // update, but the client still needs to drop them.
                                    if (job) await recordAction();

                                    json(res, { success: true });
                                }
                            }
                        }
                    });

                    utils.stringToStream(body).pipe(busboy);
                }else if (req.method === 'POST' && ['/project/archive', '/project/restore'].indexOf(pathname) !== -1){
                    const body = querystring.parse(await getReqBody(req));
                    const requestedName = String(body.name || "").trim();
                    const projectName = sanitizeProjectName(requestedName, "");
                    if (!projectName || projectName !== requestedName){
                        json(res, {error: "Invalid project name"});
                        return;
                    }

                    const archived = pathname === '/project/archive';
                    const project = await jobHistory.setProjectArchived(projectName, archived, actor);
                    json(res, {
                        success: !!project,
                        project
                    });
                }else if (req.method === 'GET' && pathname === '/task/pending') {
                    json(res, { pending: await listPendingUploads(userToken) });
                }else if (req.method === 'POST' && pathname === '/diag/client') {
                    if (!clientDiagAllowed(userToken)){
                        res.writeHead(429, {"Content-Type": "application/json"});
                        res.end(JSON.stringify({error: "Too many diagnostic reports"}));
                        return;
                    }

                    let report;
                    try{
                        report = JSON.parse(await getCappedReqBody(req, CLIENT_DIAG_MAX_BODY));
                        if (!report || typeof report !== 'object') throw new Error("expected a JSON object");
                    }catch(e){
                        json(res, {error: `Invalid diagnostic report: ${e.message}`});
                        return;
                    }

                    logger.event('client.error', {
                        taskId: utils.isTaskUuid(report.taskId) ? report.taskId : null,
                        actor: actor && actor.email,
                        // Not `message`: winston folds a metadata field by that
                        // name into its summary line, so it never becomes a
                        // queryable field on the log entry.
                        clientMessage: clipField(report.message, 500),
                        endpoint: clipField(report.endpoint, 300),
                        phase: clipField(report.phase, 60),
                        status: numberField(report.status),
                        attempt: numberField(report.attempt),
                        elapsedMs: numberField(report.elapsedMs),
                        sessionMs: numberField(report.sessionMs),
                        imagesCount: numberField(report.imagesCount),
                        connection: clipField(report.connection, 40),
                        userAgent: clipField(report.userAgent, 300),
                        source: clipField(report.source, 60)
                    });

                    json(res, {ok: true});
                }else if (req.method === 'GET' && pathname === '/task/history') {
                    const includeDeleted = ['0', 'false'].indexOf(String(query.include_deleted)) === -1;
                    json(res, {
                        jobs: await jobHistory.list({
                            includeDeleted,
                            limit: query.limit
                        }),
                        archivedProjects: await jobHistory.listArchivedProjects(),
                        projectArchivesSupported: true
                    });
                }else if (req.method === 'GET' && pathname === '/task/list') {
                    const taskIds = {};
                    const taskTableEntries = await tasktable.findAll();
                    for (let taskId in taskTableEntries){
                        taskIds[taskId] = true;
                    }

                    const routeTableEntries = await routetable.findAll(true);
                    for (let taskId in routeTableEntries){
                        taskIds[taskId] = true;
                    }

                    json(res, Object.keys(taskIds).map(uuid => { return { uuid } }));
                }else{
                    // Lookup task id
                    const matches = pathname.match(/^\/task\/([\w\d]+\-[\w\d]+\-[\w\d]+\-[\w\d]+\-[\w\d]+)\/(.+)$/);
                    if (matches && matches[1]){
                        const taskId = matches[1];
                        const action = matches[2];

                        // Post-teardown downloads: stream from object storage
                        // when the worker VM is already gone.
                        if (asrProvider.downloadsPath() && action.indexOf('download') === 0){
                            const assetsMatch = action.match(/^download\/(.+)$/);
                            if (assetsMatch && assetsMatch[1]){
                                let assetPath = assetsMatch[1];

                                // Special case for orthophoto.tif
                                if (assetPath === 'orthophoto.tif') assetPath = 'odm_orthophoto/odm_orthophoto.tif';

                                const provider = asrProvider.get();
                                const gcsConfig = provider.getConfig("gcs");
                                const s3Config = provider.getConfig("s3");

                                const key = utils.storageObjectKey(taskId, assetPath);
                                if (!key){
                                    res.statusCode = 400;
                                    res.end('Bad request');
                                    return;
                                }
                                // Traversal-safe relative path (taskId/ stripped). Forward this
                                // rather than raw assetPath so ../ segments never leave ClusterODM.
                                const relativePath = key.slice(taskId.length + 1);

                                // GCP ASR: build the download from outputs/<name>/ on the
                                // reference node (on-demand zip / single-file stream).
                                if (gcsConfig && gcsConfig.bucket && provider.getDriverName && provider.getDriverName() === "gce"){
                                    const job = await jobHistory.lookup(taskId);
                                    const sanitizedName = sanitizeProjectName(
                                        (job && job.name) || "",
                                        taskId
                                    );
                                    const qs = Object.assign({}, query);
                                    let forwardPath;
                                    if (relativePath === "all.zip"){
                                        delete qs.path;
                                        forwardPath = `/gcs/projects/${encodeURIComponent(sanitizedName)}/archive`;
                                    }else{
                                        qs.path = relativePath;
                                        forwardPath = `/gcs/projects/${encodeURIComponent(sanitizedName)}/download`;
                                    }
                                    const qsStr = querystring.stringify(qs);
                                    req.url = qsStr ? `${forwardPath}?${qsStr}` : forwardPath;
                                    forwardToUiReferenceNode(req, res);
                                    return;
                                }

                                const s3Url = url.parse(asrProvider.downloadsPath());
                                s3Url.pathname = key;

                                // Legacy S3 ASR providers (aws/do/hetzner/scaleway).
                                if (s3Config && s3Config.acl !== undefined && s3Config.acl !== "public-read") {
                                    const s3 = new AWS.S3({
                                        endpoint: new AWS.Endpoint(s3Config.endpoint),
                                        signatureVersion: 'v4',
                                        accessKeyId: provider.getConfig("accessKey"),
                                        secretAccessKey: provider.getConfig("secretKey")
                                    });

                                    const objectRequest = s3.getObject({Bucket: s3Config.bucket, Key: key});
                                    objectRequest.on('httpHeaders', (statusCode, headers) => {
                                        if (headers['content-type']) res.setHeader('Content-Type', headers['content-type']);
                                        if (headers['content-length']) res.setHeader('Content-Length', headers['content-length']);
                                    });
                                    objectRequest.createReadStream()
                                        .on('error', err => {
                                            logger.error(`Error encountered downloading object ${err}`);
                                            if (!res.headersSent){
                                                res.statusCode = 500;
                                                res.end('Internal server error');
                                            }else{
                                                res.destroy(err);
                                            }
                                        })
                                        .pipe(res);
                                    return;

                                } else {
                                    res.writeHead(301, {
                                        'Location': url.format(s3Url)
                                    });
                                    res.end();
                                    return;
                                }
                            }
                        }

                        let node = await routetable.lookupNode(taskId);

                        // A route can outlive its node when a worker is reaped or
                        // deregistered. Proxying to the old IP hangs until TCP
                        // timeout and surfaces to the client as a task error.
                        if (node && !nodes.find(n => n.hostname() === node.hostname() && n.port() === node.port())){
                            logger.event('task.route.stale', {
                                taskId,
                                action,
                                node: String(node)
                            });
                            await routetable.delete(taskId);
                            node = null;
                        }

                        // A task table entry alongside a live route means the worker
                        // already committed its outcome and is being torn down, so
                        // the snapshot — not the VM — is the source of truth.
                        const snapshot = node && READONLY_TASK_ACTIONS.indexOf(action) !== -1 ?
                                            await tasktable.lookup(taskId) :
                                            null;
                        const preferLocal = !!snapshot && (action !== 'info' || !!snapshot.taskInfo);

                        if (node && !preferLocal){
                            // Read by the proxy error handler, which has no other way
                            // to know which task a failed socket belonged to.
                            req.proxyTaskContext = { taskId, action, node, query };
                            overrideRequest(req, node, query, pathname);
                            proxy.web(req, res, { target: node.proxyTargetUrl() });
                        }else if (!await serveTaskFromLocalState(res, taskId, action, query)){
                            json(res, { error: `Invalid route for taskId ${taskId}:${action}, no task table entry.`});
                        }
                    }else{
                        json(res, { error: `Cannot handle ${pathname}`});
                    }
                }
            }catch(e){
                logger.warn(`Uncaught exception: ${e}`);
                json(res, { error: 'exception'});
                if (config.debug) throw e;
            }
        };

        const servers = [{
            server: http.createServer(requestListener),
            secure: false
        }];

        if (config.use_ssl){
            servers.push({
                server: https.createServer({
                    key: fs.readFileSync(config.ssl_key, 'utf8'),
                    cert: fs.readFileSync(config.ssl_cert, 'utf8')
                }, requestListener),
                secure: true
            });
        }

        return servers;
    }
};