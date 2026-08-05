/**
 * Must stay in sync with NodeODM-ASC/libs/gcsProjectName.js.
 * Maps a raw task title to the outputs/<name>/ folder used in GCS.
 */
"use strict";

function sanitizeProjectName(name, fallback) {
    const sanitized = String(name || "")
        .trim()
        .replace(/[^a-zA-Z0-9_\-\s]/g, "")
        .replace(/\s+/g, "_")
        .substring(0, 100);
    return sanitized || fallback || "";
}

module.exports = {
    sanitizeProjectName
};
