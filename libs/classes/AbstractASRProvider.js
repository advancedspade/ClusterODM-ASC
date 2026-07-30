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
const logger = require('../logger');
const fs = require('fs');
const DockerMachine = require('./DockerMachine').Class;
const short = require('short-uuid');
const Node = require('./Node');
const utils = require('../utils');

module.exports = class AbstractASRProvider{
    constructor(defaults, userConfigFile){
        logger.info(`ASR: ${this.constructor.name}`);
        
        this.config = defaults;

        if (userConfigFile){
            try{
                const userConfig = JSON.parse(fs.readFileSync(userConfigFile).toString());
                for (let k in userConfig){
                    this.config[k] = userConfig[k];
                }
            }catch(e){
                throw new Error(`Invalid configuration file ${userConfigFile}`);
            }
        }

        this.nodesPendingCreation = 0;
    }

    getDriverName(){
        throw new Error("Not implemented");
    }

    requiresDockerMachine(){
        return true;
    }

    createMachineClient(hostname){
        return new DockerMachine(hostname);
    }

    async getCreateArgs(imagesCount, attempt){
        throw new Error("Not implemented");
    }

    getFailureSleepTime(attempt){
        return 10000 * attempt;
    }

    canHandle(imagesCount){
        throw new Error("Not implemented");
    }

    getDownloadsBaseUrl(){
        throw new Error("Not implemented");
    }

    getServicePort(){
        return 3000;
    }

    getMachinesLimit(){
        return -1;
    }

    getCreateRetries(){
        return 1;
    }

    getMaxRuntime(){
        return -1;
    }

    getMaxUploadTime(){
        return -1;
    }

    getNodeOnlineAttempts(){
        return 5;
    }

    getNodeOnlineSleepMs(attempt){
        return 1000 * attempt;
    }

    getNodesPendingCreation(){
        return this.nodesPendingCreation;
    }

    validateConfigKeys(keys){
        for (let prop of keys){
            if (this.getConfig(prop) === "CHANGEME!" || this.getConfig(prop, undefined) === undefined) throw new Error(`You need to create a configuration file and set ${prop}.`);
        }
    }

    // Setup docker machine after creation
    // @param req {http.ClientRequest} request object from HttpProxy
    // @param token {String} user token
    // @param dm {DockerMachine|GceMachine} machine client
    // @param nodeToken {String} token to set to protect the new machine instance services
    async setupMachine(req, token, dm, nodeToken){
        // Override
    }

    // Helper function for debugging
    async debugCreateDockerMachineCmd(imagesCount){
        const args = await this.getCreateArgs(imagesCount, 1);
        return `docker-machine create --driver ${this.getDriverName()} ${args.join(" ")} debug-machine`;
    }

    // Spawn new nodes
    // @param req {http.ClientRequest} request object from HttpProxy
    // @param imagesCount {Number} number of images this node should be able to process
    // @param token {String} user token
    // @param hostname {String} docker-machine hostname
    // @param status {Object} status information about the task being created
    // @return {Node} a new Node instance
    async createNode(req, imagesCount, token, hostname, status){
        if (!this.canHandle(imagesCount)) throw new Error(`Cannot handle ${imagesCount} images.`);

        const dm = this.createMachineClient(hostname);
        const nodeToken = short.generate();
        const useInstanceSpec = typeof this.getInstanceSpec === "function";

        try{
            this.nodesPendingCreation++;

            let created = false;
            for (let i = 1; i <= this.getCreateRetries(); i++){
                if (status.aborted) throw new Error("Aborted");

                logger.info(`Trying to create machine... (${i})`);
                try{
                    if (useInstanceSpec){
                        const spec = await this.getInstanceSpec(imagesCount, i, hostname, req, token, nodeToken);
                        if (spec.zone && dm._zone !== undefined) dm._zone = spec.zone;
                        await dm.create(spec);
                    }else{
                        const args = ["--driver", this.getDriverName()]
                                .concat(await this.getCreateArgs(imagesCount, i));
                        await dm.create(args);
                    }
                    created = true;
                    break;
                }catch(e){
                    logger.warn(`Cannot create machine: ${e} (attempt ${i})`);
                    try{
                        await dm.rm(true);
                    }catch(e){
                        // Do nothing
                    }

                    await utils.sleep(this.getFailureSleepTime(i));
                }
            }
            if (!created) throw new Error(`Cannot create machine (attempted ${this.getCreateRetries()} times)`);
            if (status.aborted) throw new Error("Aborted");
            
            await this.setupMachine(req, token, dm, nodeToken);
            
            const node = new Node(await dm.getIP(), this.getServicePort(), nodeToken);
    
            const attempts = this.getNodeOnlineAttempts();
            for (let i = 1; i <= attempts; i++){
                if (status.aborted) throw new Error("Aborted");
                await node.updateInfo();
                if (node.isOnline()) break;
                logger.info(`Waiting for ${node} to get online... (${i}/${attempts})`);
                await utils.sleep(this.getNodeOnlineSleepMs(i));
            }
            if (!node.isOnline()) throw new Error("No nodes available (spawned a new node, but the node did not get online).");
    
            node.setDockerMachine(hostname, this.getMaxRuntime(), this.getMaxUploadTime());
            return node;
        }catch(e){
            try{
                await dm.rm(true);
            }catch(e){
                logger.warn("Could not remove machine, it's likely that the machine was not created, but double-check!");
            }
            throw e;
        }finally{
            this.nodesPendingCreation--;
        }
    }

    async destroyNode(node){
        if (node.isAutoSpawned()){
            logger.debug(`Destroying ${node}`);
            return this.destroyMachine(node.getDockerMachineName());
        }else{
            // Should never happen
            logger.warn(`Tried to call destroyNode on a non-autospawned node: ${node}`);
        }
    }
    
    async destroyMachine(dmHostname){
        logger.debug(`About to destroy ${dmHostname}`);
        const dm = this.createMachineClient(dmHostname);
        return dm.rm(true);
    }

    generateHostname(imagesCount){
        if (imagesCount === undefined) throw new Error("Images count missing");
        
        return `clusterodm-${imagesCount}-${short.generate()}`;
    }

    getConfig(key, defaultValue = ""){
        return utils.get(this.config, key, defaultValue);
    }

    getConfigArray(key, defaultValue = []){
        let val = this.getConfig(key, defaultValue);
        if (!Array.isArray(val)) val = [val];
        return val;
    }

    getConfigArrayItem(key, idx){
        let arr = this.getConfigArray(key, ["invalid"]);
        return arr[idx % arr.length];
    }
}
