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
const config = require('../config');
const nodes = require('./nodes');
const logger = require('./logger');
const routetable = require('./routetable');
const async = require('async');
const URL = require('url').URL;
const capacityEvents = require('./capacityEvents');

module.exports = {
    publicAddressPath: function(urlPath, req, token){
        const addrBase = config.public_address ? 
                    config.public_address : 
                    `${config.use_ssl ? "https" : "http"}://${req.headers.host}`;
        const url = new URL(urlPath, addrBase);
        if (token){
            url.search = `token=${token}`;
        }
        return url.toString();
    },

    findTasksByNode: async function(node = null){
        const routes = await routetable.findByNode(node);

        return new Promise((resolve) => {
            const tasks = [];

            async.each(Object.keys(routes), (taskId, cb) => {
                (routes[taskId]).node.taskInfo(taskId).then((taskInfo) => {
                    if (!taskInfo.error) tasks.push(taskInfo);
                    cb();
                });
            }, () => {
                resolve(tasks);
            });
        });
    },

    // Deregistration happens before the VM is destroyed: a cloud delete takes
    // seconds to minutes, and anything still routed to the node in that window
    // hangs until TCP timeout and reaches the client as a task error.
    removeAndCleanupNode: async function(node, asr = null){
        let result = false;

        try{
            await routetable.removeByNode(node);
            result = nodes.remove(node);
        }catch(e){
            logger.warn(`Remove and cleanup failed: ${e.message}`);
            logger.debug(e);
            return false;
        }

        if (node.isAutoSpawned()){
            if (asr){
                try{
                    await asr.destroyNode(node);
                }catch(e){
                    // The node is already unreachable from the gateway, so this
                    // only leaks a VM. Name it so the bill is traceable.
                    logger.event('node.destroy.failed', {
                        node: String(node),
                        machine: node.getDockerMachineName(),
                        detail: e.message
                    });
                }
            }

            // A worker just freed an autoscaling slot; let any locally queued
            // tasks (see taskNew.js) know it's worth checking for capacity.
            capacityEvents.emit('changed');
        }

        return result;
    }
};