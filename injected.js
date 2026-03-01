/**
 * injected.js v3 — runs inside Instagram's JavaScript context.
 *
 * NEW IN v3:
 *   Just grabbing the newest video URL wasn't enough because feeds have
 *   MANY videos loading at once, so clicking Video A might open Video B.
 *   
 *   Now we extract BOTH the video URL and its associated poster image URL
 *   from Instagram's JSON. We send them together to content.js.
 *   content.js can then look at the poster <img src="..."> next to the
 *   <video>, match the image filename, and get the EXACT correct video URL!
 */
(function () {
    "use strict";

    function dispatch(videoUrl, posterUrl, id, pk, code) {
        if (!videoUrl || typeof videoUrl !== "string" || !videoUrl.startsWith("http")) return;
        // IGNORING SYSTEM VIDEOS: rsrc.php is Instagram's loading animation/placeholder
        if (videoUrl.includes("rsrc.php")) return;
        window.dispatchEvent(
            new CustomEvent("ighd-video-url", { detail: { videoUrl, posterUrl, id, pk, code } })
        );
    }

    /** Recursively search objects for media fields */
    function extractMedia(obj, depth) {
        if (!obj || depth > 20) return;
        if (typeof obj !== "object") return;

        // Check if this object represents an Instagram media item
        if (obj.video_versions || obj.video_url) {
            let vUrl = obj.video_url;
            if (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) {
                // Pick highest resolution standard MP4 (type 101, 102, 103). Ignore 104 (DASH audio-less stream).
                const valid = obj.video_versions.filter((v) => v.type === 101 || v.type === 102 || v.type === 103 || !v.type);
                const versions = valid.length > 0 ? valid : obj.video_versions;
                vUrl = [...versions].sort((a, b) => ((b.width || 0) * (b.height || 1)) - ((a.width || 0) * (a.height || 1)))[0].url;
            }

            let pUrl = obj.thumbnail_url || obj.display_url || obj.pic_url;
            if (obj.image_versions2 && Array.isArray(obj.image_versions2.candidates) && obj.image_versions2.candidates.length > 0) {
                // Pick highest resolution poster
                pUrl = [...obj.image_versions2.candidates].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
            }

            if (vUrl) dispatch(vUrl, pUrl, obj.id, obj.pk, (obj.code || obj.shortcode));
        }

        // Recurse into children
        try {
            if (Array.isArray(obj)) {
                for (let i = obj.length - 1; i >= 0; i--) extractMedia(obj[i], depth + 1);
            } else {
                for (const key in obj) {
                    if (Object.prototype.hasOwnProperty.call(obj, key)) {
                        extractMedia(obj[key], depth + 1);
                    }
                }
            }
        } catch (_) { }
    }

    function scanData() {
        document.querySelectorAll('script[type="application/json"]').forEach((s) => {
            try { extractMedia(JSON.parse(s.textContent), 0); } catch (_) { }
        });
        try { extractMedia(window.__additionalData, 0); } catch (_) { }
        try { extractMedia(window._sharedData, 0); } catch (_) { }

        // Regex Fallback: Instagram often escapes JSON inside <script> tags
        // so it doesn't parse cleanly. We just search the raw text for "video_url".
        // WE PROCESS SCRIPTS IN REVERSE so that the top-most videos on the screen
        // are dispatched LAST. This puts them at index 0 in the fallbackUrls array!
        const scripts = Array.from(document.querySelectorAll("script:not([src])"));
        scripts.reverse().forEach((s) => {
            const text = s.textContent;
            if (!text || (!text.includes("video_url") && !text.includes("video_versions"))) return;

            const matches = text.match(/"video_url"\s*:\s*"([^"]+)"/g) || [];
            matches.reverse().forEach((m) => {
                const match = m.match(/"video_url"\s*:\s*"([^"]+)"/);
                if (match) {
                    const vUrl = match[1].replace(/\\u0026/g, "&").replace(/\\u003C/g, "<").replace(/\\\//g, "/");
                    // We only have the video URL here, so posterUrl is null
                    dispatch(vUrl, null);
                }
            });
        });
    }

    // Network Interceptors
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.addEventListener("readystatechange", function () {
            if (this.readyState === 4 && this.responseText) {
                const text = this.responseText;
                try {
                    const data = JSON.parse(text);
                    extractMedia(data, 0);
                } catch (e) { }

                if (text.includes("video_versions") || text.includes("video_url")) {
                    const matches = text.match(/"video_url"\s*:\s*"([^"]+)"/g) || [];
                    matches.reverse().forEach((m) => {
                        const match = m.match(/"video_url"\s*:\s*"([^"]+)"/);
                        if (match) {
                            const vUrl = match[1].replace(/\\u0026/g, "&").replace(/\\u003C/g, "<").replace(/\\\//g, "/");
                            dispatch(vUrl, null);
                        }
                    });
                }
            }
        });
        origOpen.apply(this, arguments);
    };

    const origFetch = window.fetch;
    window.fetch = function (...args) {
        const promise = origFetch.apply(this, args);
        promise.then(response => {
            try {
                const clone = response.clone();
                clone.text().then(text => {
                    try {
                        const data = JSON.parse(text);
                        extractMedia(data, 0);
                    } catch (e) { }

                    if (text.includes("video_versions") || text.includes("video_url")) {
                        const matches = text.match(/"video_url"\s*:\s*"([^"]+)"/g) || [];
                        matches.reverse().forEach((m) => {
                            const match = m.match(/"video_url"\s*:\s*"([^"]+)"/);
                            if (match) {
                                const vUrl = match[1].replace(/\\u0026/g, "&").replace(/\\u003C/g, "<").replace(/\\\//g, "/");
                                dispatch(vUrl, null);
                            }
                        });
                    }
                }).catch(() => { });
            } catch (_) { }
        }).catch(() => { });
        return promise;
    };

    // Watch for dynamic SPA page loads
    new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeName === "SCRIPT" && !node.src) {
                    setTimeout(() => {
                        try { extractMedia(JSON.parse(node.textContent), 0); } catch (_) { }
                    }, 0);
                }
            }
        }
    }).observe(document.documentElement, { childList: true, subtree: true });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", scanData);
    } else {
        scanData();
    }
})();
