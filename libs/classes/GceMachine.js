/**
 * Compute Engine VM lifecycle for the GCP ASR provider.
 * Replaces docker-machine so workers can be private-IP-only COS instances
 * without metadata SSH keys (blocked by compute.requireOsLogin).
 */
"use strict";

const http = require("http");
const {GoogleAuth} = require("google-auth-library");
const logger = require("../logger");

const COMPUTE_ROOT = "https://compute.googleapis.com/compute/v1";
const POLL_MS = 3000;
const CREATE_TIMEOUT_MS = 15 * 60 * 1000;
const DELETE_TIMEOUT_MS = 10 * 60 * 1000;

async function sleep(ms){
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = class GceMachine{
    constructor(machineName, options = {}){
        this.machineName = machineName;
        this.project = options.project;
        this.zone = options.zone;
        this.auth = options.auth || new GoogleAuth({
            scopes: ["https://www.googleapis.com/auth/cloud-platform"]
        });
        this._ip = null;
        this._zone = options.zone;
    }

    async _authorizedRequest(method, urlPath, body){
        const client = await this.auth.getClient();
        const url = `${COMPUTE_ROOT}${urlPath}`;
        const res = await client.request({
            url,
            method,
            data: body,
            retry: true
        });
        return res.data;
    }

    async _waitForZoneOperation(operationName, timeoutMs){
        const started = Date.now();
        const zone = this._zone;
        while (Date.now() - started < timeoutMs){
            const op = await this._authorizedRequest(
                "GET",
                `/projects/${this.project}/zones/${zone}/operations/${operationName}`
            );
            if (op.status === "DONE"){
                if (op.error && op.error.errors && op.error.errors.length){
                    const msg = op.error.errors.map(e => e.message || e.code).join("; ");
                    throw new Error(`GCE operation ${operationName} failed: ${msg}`);
                }
                return op;
            }
            await sleep(POLL_MS);
        }
        throw new Error(`GCE operation ${operationName} timed out after ${timeoutMs}ms`);
    }

    /**
     * @param {object} instanceSpec Compute Engine instances.insert body
     */
    async create(instanceSpec){
        if (!this.project) throw new Error("GceMachine.project is required");
        this._zone = instanceSpec.zone || this.zone;
        if (!this._zone) throw new Error("GceMachine.zone is required");

        // Zone in the URL is authoritative; strip any accidental body field.
        const body = Object.assign({}, instanceSpec);
        delete body.zone;

        logger.info(`Creating GCE instance ${this.machineName} in ${this.project}/${this._zone}`);
        const op = await this._authorizedRequest(
            "POST",
            `/projects/${this.project}/zones/${this._zone}/instances`,
            body
        );
        await this._waitForZoneOperation(op.name, CREATE_TIMEOUT_MS);

        const instance = await this._authorizedRequest(
            "GET",
            `/projects/${this.project}/zones/${this._zone}/instances/${this.machineName}`
        );
        const nic = instance.networkInterfaces && instance.networkInterfaces[0];
        if (!nic || !nic.networkIP){
            throw new Error(`GCE instance ${this.machineName} has no internal IP`);
        }
        this._ip = nic.networkIP;
        logger.info(`Created GCE instance ${this.machineName} at ${this._ip}`);
        return instance;
    }

    async getIP(){
        if (this._ip) return this._ip;
        const instance = await this._authorizedRequest(
            "GET",
            `/projects/${this.project}/zones/${this._zone}/instances/${this.machineName}`
        );
        const nic = instance.networkInterfaces && instance.networkInterfaces[0];
        if (!nic || !nic.networkIP){
            throw new Error(`Cannot get IP for machine: ${this.machineName}`);
        }
        this._ip = nic.networkIP;
        return this._ip;
    }

    /**
     * Teardown callers only know the instance name, and a delete aimed at the
     * wrong zone 404s, which is indistinguishable from "already deleted".
     * Returns the zone the instance actually lives in, or null if it's gone.
     */
    async locateZone(){
        const filter = encodeURIComponent(`name = "${this.machineName}"`);
        let pageToken = "";
        do{
            const query = `filter=${filter}&maxResults=500` + (pageToken ? `&pageToken=${pageToken}` : "");
            const res = await this._authorizedRequest(
                "GET",
                `/projects/${this.project}/aggregated/instances?${query}`
            );
            for (const scope of Object.values(res.items || {})){
                const match = (scope.instances || []).find(i => i.name === this.machineName);
                if (match) return String(match.zone || "").split("/").pop() || null;
            }
            pageToken = res.nextPageToken || "";
        }while (pageToken);

        return null;
    }

    async rm(force){
        try{
            logger.info(`Deleting GCE instance ${this.machineName}`);
            const op = await this._authorizedRequest(
                "DELETE",
                `/projects/${this.project}/zones/${this._zone}/instances/${this.machineName}`
            );
            await this._waitForZoneOperation(op.name, DELETE_TIMEOUT_MS);
        }catch(e){
            if (force && /not found|404/i.test(String(e.message || e))){
                logger.warn(`GCE instance ${this.machineName} already gone`);
                return;
            }
            throw e;
        }
    }

    // Kept for interface parity with DockerMachine; COS workers use startup-script.
    async ssh(){
        throw new Error("GceMachine does not support SSH; use instance metadata startup-script");
    }
};

/**
 * Read the gateway VM's internal IP from the metadata server.
 * Returns null when not running on GCE (local tests).
 */
module.exports.fetchGatewayInternalIp = function fetchGatewayInternalIp(){
    return new Promise(resolve => {
        const req = http.get({
            host: "metadata.google.internal",
            path: "/computeMetadata/v1/instance/network-interfaces/0/ip",
            headers: {"Metadata-Flavor": "Google"},
            timeout: 2000
        }, res => {
            if (res.statusCode !== 200){
                res.resume();
                return resolve(null);
            }
            let data = "";
            res.setEncoding("utf8");
            res.on("data", chunk => { data += chunk; });
            res.on("end", () => resolve(data.trim() || null));
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => {
            req.destroy();
            resolve(null);
        });
    });
};
