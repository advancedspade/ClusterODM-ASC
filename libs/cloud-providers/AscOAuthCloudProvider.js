/**
 * ASC Google OAuth session validation for the ClusterODM edge.
 *
 * NodeODM-ASC issues the ndm_oauth cookie as an HS256 JWT. ClusterODM uses the
 * verified subject as its stable routing-table owner key, so session renewal
 * does not hide a user's existing tasks.
 */
"use strict";

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const AbstractCloudProvider = require("../classes/AbstractCloudProvider");
const config = require("../../config");

function parseCookies(header){
    const result = {};
    String(header || "").split(";").forEach(part => {
        const separator = part.indexOf("=");
        if (separator === -1) return;
        const name = part.slice(0, separator).trim();
        if (!name) return;
        const rawValue = part.slice(separator + 1).trim();
        try{
            result[name] = decodeURIComponent(rawValue);
        }catch(e){
            result[name] = rawValue;
        }
    });
    return result;
}

function allowedDomains(){
    const value = process.env.OAUTH_ALLOWED_DOMAINS || config.oauth_allowed_domains || "";
    if (Array.isArray(value)) return value.map(v => String(v).trim().toLowerCase()).filter(Boolean);
    return String(value).split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
}

function emailAllowed(email){
    const domains = allowedDomains();
    if (!domains.length) return true;
    const parts = String(email || "").toLowerCase().split("@");
    return parts.length === 2 && domains.indexOf(parts[1]) !== -1;
}

function ownerKey(prefix, value){
    const digest = crypto.createHash("sha256").update(String(value)).digest("hex");
    return `${prefix}:${digest}`;
}

module.exports = class AscOAuthCloudProvider extends AbstractCloudProvider{
    constructor(){
        super();
        this.sessionSecret = process.env.SESSION_SECRET || config.session_secret || "";
        this.cookieName = process.env.OAUTH_COOKIE_NAME || config.oauth_cookie_name || "ndm_oauth";

        if (!this.sessionSecret){
            throw new Error("ASC OAuth cloud provider requires session-secret or SESSION_SECRET");
        }
    }

    verifySession(token){
        if (!token) return null;
        try{
            const payload = jwt.verify(token, this.sessionSecret, {algorithms: ["HS256"]});
            if (!payload || payload.sub == null || !emailAllowed(payload.email)) return null;
            return payload;
        }catch(e){
            return null;
        }
    }

    issueInternalToken(payload){
        return jwt.sign(
            {email: payload.email, purpose: "cluster-internal"},
            this.sessionSecret,
            {
                algorithm: "HS256",
                subject: String(payload.sub),
                expiresIn: "2d"
            }
        );
    }

    async validate(token, req){
        const cookies = parseCookies(req && req.headers && req.headers.cookie);
        const sessionToken = cookies[this.cookieName] || token;
        const payload = this.verifySession(sessionToken);

        if (payload){
            return {
                valid: true,
                limits: {},
                token: ownerKey("oauth", payload.sub),
                accessToken: this.issueInternalToken(payload)
            };
        }

        // Preserve token-based API access for trusted automation.
        if (config.token && token === config.token){
            return {
                valid: true,
                limits: {},
                token: ownerKey("api", token),
                accessToken: token
            };
        }

        return {valid: false};
    }

    async approveNewTask(){
        return {approved: true, error: ""};
    }

    async taskFinished(){}
};

module.exports.parseCookies = parseCookies;
