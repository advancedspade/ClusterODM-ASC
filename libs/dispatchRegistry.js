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

// Which uploads have a dispatch running in this process right now.
//
// The ledger's dispatchPhase cannot answer this: reaching an outcome clears the
// phase, and a cancel settles the job long before the dispatch it aborted has
// unwound. In that window the upload, the ledger row and the autoscaled VM all
// still have an owner, and a restart that starts a second dispatch races it for
// every one of them.
//
// In-memory only, like tasktable/routetable. A gateway restart ends every
// dispatch it describes, so an empty registry after a boot is correct.
//
// Its own module rather than part of taskNew so reconcile and the proxy can ask
// without loading taskNew's native curl dependency.

const live = {};

module.exports = {
    // `token` identifies one attempt. Callers keep it and pass it back, which is
    // how a superseded dispatch can tell it no longer owns the uuid.
    claim: function(uuid, token){
        live[uuid] = token;
    },

    isDispatching: function(uuid){
        return !!live[uuid];
    },

    owns: function(uuid, token){
        return live[uuid] === token;
    },

    // A no-op once another attempt has taken over, so a slow unwind cannot
    // release its replacement's claim.
    release: function(uuid, token){
        if (live[uuid] === token) delete live[uuid];
    }
};
