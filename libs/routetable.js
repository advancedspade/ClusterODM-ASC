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
const fs = require('fs');
const async = require("async");
const logger = require('./logger');
const nodes = require('./nodes');

const ROUTES_FILE = 'data/routes.json';

let routes = null;
let writeChain = Promise.resolve();

// TODO: use redis to have a shared routing table
// accessible from multiple proxies

// The route table maps taskIDs to nodes and task owners (via token)

// Route mutations must be on disk before their caller acts on them: a route left
// only in memory turns a restart into a task the gateway cannot proxy, and a
// deletion left only in memory comes back to life. Write failures are logged by
// saveToDisk and swallowed here — they are not worth failing an operation that
// already succeeded, and an unhandled rejection would take the gateway down.
async function persist(){
    try{
        await module.exports.saveToDisk();
    }catch(e){
        // Already logged by saveToDisk.
    }
}

module.exports = {
    initialize: async function(){
        routes = await this.loadFromDisk();

        const cleanup = () => {
            const expires = 1000 * 60 * 60 * 24 * 5; // 5 days

            Object.keys(routes).forEach(taskId => {
                if ((routes[taskId].accessed + expires) < (new Date()).getTime()){
                    delete(routes[taskId]);
                }
            });

            persist();
        };

        cleanup();
        setInterval(cleanup, 1000 * 60 * 60);

        logger.info(`Loaded ${Object.keys(routes).length} routes`);
    },

    add: async function(taskId, node, token){
        if (!node) throw new Error("Node is not valid");
        if (!taskId) throw new Error("taskId is not valid");

        routes[taskId] = {
            node,
            token,
            accessed: new Date().getTime()
        };

        await persist();
    },

    lookup: async function(taskId){
        const entry = routes[taskId];
        if (entry){
            entry.accessed = new Date().getTime();
            return entry;
        }

        return null;
    },

    delete: async function(taskId){
        if (!routes[taskId]) return;

        delete(routes[taskId]);
        await persist();
    },

    removeByNode: async function(node){
        if (!node) return;

        const routesForNode = await this.findByNode(node);
        for (let taskId in routesForNode){
            delete(routes[taskId]);
        }

        await persist();
    },

    findByNode: async function(node = null){
        if (!node) return routes;
        else{
            const result = {};
            for (let taskId in routes){
                if (routes[taskId].node === node){
                    result[taskId] = routes[taskId];
                }
            }
            return result;
        }
    },

    findByToken: async function(token, activeOnly = false){
        const result = {};
        for (let taskId in routes){
            if (routes[taskId].token === token){
                result[taskId] = routes[taskId];
            }
        }
        if (!activeOnly) return result;

        // Actually ping the node for these tasks and filter out
        // inactive / deleted / stale ones
        return new Promise((resolve) => {
            async.each(Object.keys(result), (taskId, cb) => {
                (routes[taskId]).node.taskInfo(taskId).then((taskInfo) => {
                    if (taskInfo.error) delete(result[taskId]);
                    cb();
                });
            }, () => {
                resolve(result);
            });
        });
    },

    findAll: async function(activeOnly = false){
        const result = {};
        for (let taskId in routes){
            result[taskId] = routes[taskId];
        }
        if (!activeOnly) return result;

        return new Promise((resolve) => {
            async.each(Object.keys(result), (taskId, cb) => {
                (routes[taskId]).node.taskInfo(taskId).then((taskInfo) => {
                    if (taskInfo.error) delete(result[taskId]);
                    cb();
                });
            }, () => {
                resolve(result);
            });
        });
    },

    lookupNode: async function(taskId){
        const entry = await this.lookup(taskId);
        if (entry) return entry.node;

        return null;
    },

    lookupToken: async function(taskId){
        const entry = await this.lookup(taskId);
        if (entry) return entry.token;

        return null;
    },

    // Serialized through writeChain and committed by rename, so two concurrent
    // route changes cannot interleave chunks and leave a truncated routes.json
    // that loses every route on the next boot.
    saveToDisk: async function(){
        const payload = JSON.stringify(routes);
        const tmpFile = `${ROUTES_FILE}.${process.pid}.tmp`;

        const write = writeChain
            .then(() => fs.promises.writeFile(tmpFile, payload))
            .then(() => fs.promises.rename(tmpFile, ROUTES_FILE));

        // The chain itself must stay resolvable, or one failed write poisons
        // every write after it. The failure still reaches this caller.
        writeChain = write.catch(err => {
            logger.warn(`Cannot save routes to disk: ${err.message}`);
        });

        return write;
    },

    loadFromDisk: async function(){
        return new Promise((resolve, reject) => {
            fs.exists(ROUTES_FILE, (exists) => {
                if (exists){
                    fs.readFile(ROUTES_FILE, (err, json) => {
                        if (err){
                            logger.warn(`Cannot read routes from disk: ${err.message}`);
                            reject(err);
                        }else{
                            const content = JSON.parse(json);
                            const deleteList = [];

                            // Create Node class instances
                            for (let key of Object.keys(content)){
                                if (content[key].node){
                                    let cn = content[key].node;
                                    let n = nodes.find(n => n.hostname() === cn.hostname && n.port() === cn.port);
                                    if (n){
                                        content[key].node = n;
                                    }else{
                                        // Delete routes for which a node does not exist
                                        deleteList.push(key);
                                    }
                                }
                            }

                            deleteList.forEach(d => delete(content[d]));

                            resolve(content);
                        }
                    });
                }else{
                    resolve({});
                }
            });
        });
    },

    cleanup: async function(){
        try{
            await this.saveToDisk();
            logger.info("Saved routes to disk");
        }catch(e){
            logger.warn(e);
        }
    }
};
