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

// Project-folder questions the gateway cannot answer alone: it holds no bucket
// credentials, so everything here is asked of the locked reference node, which
// is the only long-lived process with a GCS client.

const axios = require('axios');
const nodes = require('./nodes');
const logger = require('./logger');
const asrProvider = require('./asrProvider');

const REQUEST_TIMEOUT = 15000;

// The worker pool is ephemeral, so a spawned node is a bad place to ask: it may
// be torn down mid-request. The locked UI node is the same one serving /gcs to
// the browser.
function reference(){
    const node = nodes.uiReferenceNode() || nodes.referenceNode();
    if (!node) return null;
    return { base: node.proxyTargetUrl(), token: node.getToken() };
}

module.exports = {
    /** Whether workers back their projects with a GCS bucket at all. */
    enabled: function(){
        const provider = asrProvider.get();
        const gcsConfig = provider && provider.getConfig && provider.getConfig("gcs");
        return !!(gcsConfig && gcsConfig.bucket &&
                  provider.getDriverName && provider.getDriverName() === "gce");
    },

    /**
     * Whether outputs/<project>/ is already taken.
     *
     * Null means unknown — no reference node, or the bucket did not answer.
     * Callers must let an unknown through: refusing uploads because a health
     * check blipped is worse than the collision, which the worker still catches
     * at dispatch either way.
     */
    exists: async function(projectName){
        if (!this.enabled() || !projectName) return null;

        const ref = reference();
        if (!ref) return null;

        try{
            const res = await axios.get(
                `${ref.base}/gcs/projects/${encodeURIComponent(projectName)}/exists`,
                { params: { token: ref.token }, timeout: REQUEST_TIMEOUT }
            );
            if (!res.data || res.data.error) return null;
            return !!res.data.exists;
        }catch(e){
            logger.warn(`Cannot check GCS project "${projectName}": ${e.message}`);
            return null;
        }
    },

    /**
     * Deletes outputs/<project>/ so the name can be reused. The node refuses
     * projects that already have an orthophoto, so this cannot destroy
     * delivered results even if handed the wrong name.
     */
    remove: async function(projectName){
        if (!this.enabled() || !projectName) return { removed: false };

        const ref = reference();
        if (!ref) return { removed: false, error: 'no reference node' };

        try{
            const res = await axios.delete(
                `${ref.base}/gcs/projects/${encodeURIComponent(projectName)}`,
                { params: { token: ref.token }, timeout: REQUEST_TIMEOUT }
            );
            if (res.data && res.data.error) return { removed: false, error: res.data.error };
            return { removed: true };
        }catch(e){
            const detail = (e.response && e.response.data && e.response.data.error) || e.message;
            return { removed: false, error: detail };
        }
    }
};
