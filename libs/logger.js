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

let config = require('../config');
let winston = require('winston');
let fs = require('fs');
let path = require('path');
const package_info = require('../package_info');

// Set up logging
// Configure custom File transport to write plain text messages
let logPath = ( config.logger.logDirectory ? 
				config.logger.logDirectory : 
				path.join(__dirname, "..") );

// Check that log file directory can be written to
try {
	fs.accessSync(logPath, fs.W_OK);
} catch (e) {
	console.log( "Log directory '" + logPath + "' cannot be written to"  );
	throw e;
}
logPath += path.sep;
logPath += package_info.name + ".log";

let transports = [];
if (!config.deamon){
    transports.push(new winston.transports.Console({ level: config.logger.level, format: winston.format.simple() }));
}

let logger = winston.createLogger({ transports });
logger.add(new winston.transports.File({
        format: winston.format.simple(), 
        filename: logPath, // Write to projectname.log
        json: false, // Write in plain text, not JSON
        maxsize: config.logger.maxFileSize, // Max size of each file
        maxFiles: config.logger.maxFiles, // Max number of files
        level: config.logger.level // Level of log messages
    }));

// The Docker gcplogs driver ships stdout as an opaque textPayload, so JSON
// printed to the console still arrives unqueryable. Writing to the Cloud
// Logging API directly is what produces real jsonPayload fields, which is what
// makes `jsonPayload.taskId="<uuid>"` filters work.
if (process.env.GOOGLE_CLOUD_PROJECT){
    try{
        const {LoggingWinston} = require('@google-cloud/logging-winston');
        logger.add(new LoggingWinston({
            projectId: process.env.GOOGLE_CLOUD_PROJECT,
            logName: process.env.GCP_LOG_NAME || 'clusterodm',
            level: config.logger.level,
            redirectToStdout: false,
            // A failed log write must never take the gateway down with it.
            defaultCallback: err => {
                if (err) console.error(`Cloud Logging write failed: ${err.message}`);
            }
        }));
    }catch(e){
        console.error(`Cannot enable Cloud Logging transport: ${e.message}`);
    }
}

/**
 * Structured lifecycle event. `name` lands in jsonPayload.event and the rest of
 * `fields` becomes sibling jsonPayload keys, so an incident can be reconstructed
 * from a single taskId filter instead of substring-matching free text.
 */
logger.event = function(name, fields = {}){
    const payload = Object.assign({}, fields, {event: name});
    const level = payload.level || (/\.(failed|orphaned)$/.test(String(name)) ? 'warn' : 'info');
    delete payload.level;

    // Keeps the console/file transports readable. The Cloud Logging transport
    // consumes the structured fields instead of this string.
    const summary = Object.keys(payload)
        .filter(k => k !== 'event' && payload[k] !== undefined && payload[k] !== null)
        .map(k => `${k}=${typeof payload[k] === 'object' ? JSON.stringify(payload[k]) : payload[k]}`)
        .join(' ');

    logger.log(level, `${name}${summary ? ' ' + summary : ''}`, payload);
};

module.exports = logger;