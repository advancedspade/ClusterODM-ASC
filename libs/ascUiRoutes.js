"use strict";

const PUBLIC_PAGE_PATHS = new Set([
    "/",
    "/favicon.ico",
    "/index.html",
    "/login.html",
    "/home",
    "/uploads",
    "/projects",
    "/incomplete",
    "/history",
    "/auth/bootstrap"
]);

const PUBLIC_ASSET_EXTENSIONS = new Set([
    ".css",
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".json",
    ".map",
    ".mjs",
    ".png",
    ".svg",
    ".ttf",
    ".webp",
    ".woff",
    ".woff2"
]);

function hasPathPrefix(pathname, prefix){
    return pathname === prefix || pathname.indexOf(prefix + "/") === 0;
}

function isPublicUiPath(pathname){
    if (!pathname) return false;
    if (PUBLIC_PAGE_PATHS.has(pathname)) return true;
    if (hasPathPrefix(pathname, "/auth")) return true;
    const isStaticAsset = ["/css/", "/fonts/", "/js/", "/themes/"]
        .some(prefix => pathname.indexOf(prefix) === 0);
    if (!isStaticAsset) return false;

    const dot = pathname.lastIndexOf(".");
    if (dot === -1) return false;
    return PUBLIC_ASSET_EXTENSIONS.has(pathname.slice(dot).toLowerCase());
}

function isProtectedReferencePath(pathname){
    if (!pathname) return false;
    return hasPathPrefix(pathname, "/gcs") ||
           hasPathPrefix(pathname, "/rtk") ||
           hasPathPrefix(pathname, "/support") ||
           pathname === "/option-ui-defaults";
}

module.exports = {
    isPublicUiPath,
    isProtectedReferencePath
};
