/**
 * Instagram HD Viewer — Content Script (v7)
 *
 * MAJOR FIX FOR STORIES & CAROUSELS:
 *   1. Ghost Clicks: Instagram Stories have invisible layers (`div`) overlayed
 *      on the video that intercept all mouse clicks. This killed `.ighd-btn`.
 *      The solution is a global `document.addEventListener("click", ..., true)`
 *      that intercepts clicks globally and manually triggers our button if
 *      the coordinates overlap.
 *   2. Cached Poster: In Carousels, when a video starts playing, Instagram
 *      removes its `<img>` poster to save memory! Our previous logic tried
 *      to find the `<img>` on click, but couldn't, falling back to the wrong
 *      video URL. Now, we cache the poster filename immediately when the
 *      `<video>` is first observed.
 */

(function () {
  "use strict";

  // ── Inject script ────────────────────────────────────────────────────────
  (function injectPageScript() {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("injected.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  })();

  // ── Data Matching ────────────────────────────────────────────────────────

  // Maps poster filename (e.g. "12345_n.jpg") -> video_url
  const videoMap = new Map();
  // Maps media PK/ID/shortcode to video_url for 100% perfect URL-based matching!
  const igIdMap = new Map();
  // Fallback list of URLs if we can't match a poster
  const fallbackUrls = [];

  function getFilename(urlStr) {
    try {
      const url = new URL(urlStr);
      const parts = url.pathname.split('/');
      const filename = parts[parts.length - 1];
      if (filename && filename.includes('.')) return filename;
      return null;
    } catch (e) {
      return null;
    }
  }

  window.addEventListener("ighd-video-url", (e) => {
    const { videoUrl, posterUrl, id, pk, code } = e.detail || {};
    if (!videoUrl) return;

    // Link this video to its exact Media ID / Shortcode
    if (id) igIdMap.set(String(id), videoUrl);
    if (pk) igIdMap.set(String(pk), videoUrl);
    if (code) igIdMap.set(String(code), videoUrl);
    if (id && String(id).includes('_')) {
      igIdMap.set(String(id).split('_')[0], videoUrl);
    }

    // Link this video to its poster image filename
    if (posterUrl) {
      const pFile = getFilename(posterUrl);
      if (pFile) videoMap.set(pFile, videoUrl);
    }

    // Add to fallback history
    const idx = fallbackUrls.indexOf(videoUrl);
    if (idx !== -1) fallbackUrls.splice(idx, 1);
    fallbackUrls.unshift(videoUrl);
    if (fallbackUrls.length > 50) fallbackUrls.pop();
  });

  const seen = new WeakSet();

  // ── URLs ─────────────────────────────────────────────────────────────────

  function getBestImageSrc(img) {
    const srcset = img.getAttribute("srcset") || "";
    if (!srcset) return img.src;
    let best = img.src || "";
    let maxW = 0;
    srcset.split(",").forEach((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (parts.length < 2) return;
      const w = parseInt(parts[1], 10);
      if (!isNaN(w) && w > maxW) { maxW = w; best = parts[0]; }
    });
    return best;
  }

  function getPosterOnce(video) {
    // 1. Prioritize authoritative poster attribute
    const directPoster = video.getAttribute("poster") || video.poster;
    if (directPoster && directPoster.length > 5) {
      const pFile = getFilename(directPoster);
      if (pFile) return pFile;
    }

    // 2. Walk up the DOM slightly to find the narrowest container
    // holding both the video and its specific poster image.
    let node = video.parentElement;
    let limit = 6;
    while (node && node !== document.body && limit > 0) {
      const imgs = node.querySelectorAll("img");
      for (const img of imgs) {
        // IGNORE AVATARS/ICONS: Ensure it's large enough to be a poster
        const w = img.getAttribute("width") || img.clientWidth || img.naturalWidth || 0;
        if (w > 0 && w < 120) continue;
        if (img.alt && img.alt.toLowerCase().includes("profile")) continue;

        const pFile = getFilename(img.src);
        if (pFile) return pFile;
      }
      node = node.parentElement;
      limit--;
    }
    return null;
  }

  function getVideoSrc(video, articleNode) {
    // 1. Precise Match: Use the poster filename we cached when the video was first injected
    const pFile = video._ighdPosterFile;
    if (pFile && videoMap.has(pFile)) {
      return videoMap.get(pFile);
    }

    // 1.5. Post Shortcode Match: If poster is missing, find the post shortcode
    const getCodeFromPath = (path) => {
      const parts = path.split('/').filter(Boolean);
      if ((parts[0] === 'p' || parts[0] === 'reel' || parts[0] === 'reels') && parts.length >= 2) {
        return parts[1];
      }
      return null;
    };

    // Check page URL first (if user opened post in a modal or dedicated page)
    const pageCode = getCodeFromPath(window.location.pathname);
    if (pageCode && igIdMap.has(pageCode)) {
      return igIdMap.get(pageCode);
    }

    // Check post article links if available in feed
    if (articleNode) {
      const links = articleNode.querySelectorAll("a[href*='/p/'], a[href*='/reel/'], a[href*='/reels/']");
      for (const link of links) {
        const href = link.getAttribute("href");
        if (href) {
          try {
            const urlObj = new URL(href, window.location.origin);
            const code = getCodeFromPath(urlObj.pathname);
            if (code && igIdMap.has(code)) {
              return igIdMap.get(code);
            }
          } catch (e) { }
        }
      }
    }

    // 2. Direct Source: if it's already an MP4 (not a blob)
    const src = video.getAttribute("src") || video.src;
    if (src && !src.startsWith("blob:")) return src;

    const source = video.querySelector("source[src]");
    if (source) {
      const sSrc = source.getAttribute("src") || source.src;
      if (sSrc && !sSrc.startsWith("blob:")) return sSrc;
    }

    // 3. Blind Fallback: just return the newest captured URL
    return fallbackUrls.length > 0 ? fallbackUrls[0] : null;
  }

  // ── Button UI ────────────────────────────────────────────────────────────

  function createIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d",
      "M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 " +
      "2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"
    );
    svg.appendChild(p);
    return svg;
  }

  function createButton(getUrl, label) {
    const btn = document.createElement("button");
    btn.className = "ighd-btn";
    btn.title = "Open original in new tab";
    btn.setAttribute("aria-label", "Open original");
    btn.appendChild(createIcon());
    const span = document.createElement("span");
    span.textContent = label;
    btn.appendChild(span);

    // Provide the getUrl to the global click listener
    btn._ighdUrlGetter = getUrl;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const url = getUrl();
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        console.log("Instagram HD Viewer: ⏳ Direct video link has not loaded yet.");
      }
    });
    return btn;
  }

  // ── Global Ghost Click Listener (Bypass Instagram Overlays) ──────────────
  document.addEventListener("click", (e) => {
    const buttons = document.querySelectorAll(".ighd-btn");
    for (const btn of buttons) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue; // Hidden

      // Expand hit area slightly by 5px for ease of clicking
      if (e.clientX >= rect.left - 5 && e.clientX <= rect.right + 5 &&
        e.clientY >= rect.top - 5 && e.clientY <= rect.bottom + 5) {

        e.preventDefault();
        e.stopPropagation();

        const getUrl = btn._ighdUrlGetter;
        if (getUrl) {
          const url = getUrl();
          if (url) {
            window.open(url, "_blank", "noopener,noreferrer");
          } else {
            console.log("Instagram HD Viewer: ⏳ Direct video link has not loaded yet.");
          }
        }
        return; // Click handled
      }
    }
  }, true); // useCapture: true catches the click BEFORE Instagram's overlays!

  function findWrapper(el) {
    if (!el || !el.parentElement) return null;
    let node = el.parentElement;
    // Walk past any anchor tags
    while (node && node.tagName === "A" && node !== document.body) {
      node = node.parentElement;
    }
    node.classList.add("ighd-wrapper");
    return node;
  }

  function inject(el, label, getUrl) {
    const wrapper = findWrapper(el);
    if (!wrapper) return;
    if (wrapper.querySelector(".ighd-btn")) return;

    const btn = createButton(getUrl, label);
    wrapper.appendChild(btn);
  }

  // ── Scanners ──────────────────────────────────────────────────────────────

  const seenVideos = new WeakSet();
  const seenImages = new WeakSet();
  const videoButtonCenters = [];

  function trackVideoSources() {
    document.querySelectorAll("video").forEach((video) => {
      const currentSrc = video.getAttribute("src") || video.src;
      if (!currentSrc) return;

      if (seenVideos.has(video)) {
        if (video._ighdLastSrc !== currentSrc) {
          const isDomReuse = (video._ighdLastSrc && video._ighdLastSrc.length > 5 && currentSrc.length > 5);
          video._ighdLastSrc = currentSrc;

          const newPoster = getPosterOnce(video);
          if (newPoster) {
            video._ighdPosterFile = newPoster;
          } else if (isDomReuse) {
            video._ighdPosterFile = null;
          }
        }
      } else {
        seenVideos.add(video);
        video._ighdLastSrc = currentSrc;
        video._ighdPosterFile = getPosterOnce(video);
      }
    });
  }

  function injectFeedUI() {
    document.querySelectorAll("article").forEach((article) => {
      videoButtonCenters.length = 0;

      article.querySelectorAll("video").forEach((video) => {
        inject(video, "▶ HD", () => getVideoSrc(video, article));

        let wrapper = video.parentElement;
        while (wrapper && wrapper.tagName === "A" && wrapper !== document.body) {
          wrapper = wrapper.parentElement;
        }
        if (wrapper) {
          const r = wrapper.getBoundingClientRect();
          videoButtonCenters.push({ cx: r.left + r.width / 2, cy: r.top + r.height / 2 });
        }
      });

      article.querySelectorAll("img").forEach((img) => {
        if (seenImages.has(img)) return;
        const w = Math.max(img.naturalWidth || 0, img.clientWidth || 0);
        const h = Math.max(img.naturalHeight || 0, img.clientHeight || 0);
        if (w < 200 || h < 120) return;

        let wrapper = img.parentElement;
        while (wrapper && wrapper.tagName === "A" && wrapper !== document.body) {
          wrapper = wrapper.parentElement;
        }
        let overlapsVideo = false;
        if (wrapper) {
          const r = wrapper.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          for (const vCenter of videoButtonCenters) {
            if (Math.abs(cx - vCenter.cx) < 50 && Math.abs(cy - vCenter.cy) < 50) {
              overlapsVideo = true;
              break;
            }
          }
        }

        if (!overlapsVideo) {
          seenImages.add(img);
          inject(img, "HD", () => getBestImageSrc(img));
        }
      });
    });
  }

  function getActiveStoryMedia() {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    let bestEl = null;
    let maxArea = 0;

    const elements = document.querySelectorAll("video, img");
    for (const el of elements) {
      if (el.tagName === "IMG") {
        const w = el.clientWidth || el.naturalWidth || 0;
        if (w < 120) continue;
        if (el.alt && el.alt.toLowerCase().includes("profile")) continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
          const area = r.width * r.height;
          if (area > maxArea) {
            maxArea = area;
            bestEl = el;
          }
        }
      }
    }

    if (!bestEl) return null;
    return { type: bestEl.tagName.toLowerCase(), el: bestEl };
  }

  function injectStoryUI() {
    const isStory = window.location.href.includes("stories");
    let btn = document.querySelector(".ighd-story-btn");

    if (!isStory) {
      if (btn) btn.style.display = "none";
      return;
    }

    if (!btn) {
      btn = document.createElement("button");
      btn.className = "ighd-btn ighd-story-btn";
      btn.title = "Download Story Media";

      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", "M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z");
      svg.appendChild(p);
      btn.appendChild(svg);

      const span = document.createElement("span");
      span.textContent = "Download Story";
      btn.appendChild(span);

      btn._ighdUrlGetter = () => {
        // 1. 100% PERFECT MATCH by Story URL (id/pk/shortcode)
        const pathParts = window.location.pathname.split('/').filter(Boolean);
        if (pathParts[0] === "stories" && pathParts.length >= 3) {
          const mediaId = pathParts[2]; // https://.../stories/username/1234.../
          if (igIdMap.has(mediaId)) {
            return igIdMap.get(mediaId);
          }
        }

        // 2. DOM geometry fallback
        const media = getActiveStoryMedia();
        if (!media) return null;
        return (media.type === "video") ? getVideoSrc(media.el, null) : getBestImageSrc(media.el);
      };

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const getUrl = btn._ighdUrlGetter;
        if (getUrl) {
          const url = getUrl();
          if (url) {
            window.open(url, "_blank", "noopener,noreferrer");
          } else {
            console.log("Instagram HD Viewer: ⏳ Direct video link has not loaded yet.");
          }
        }
      });

      document.body.appendChild(btn);
    }
    btn.style.display = "flex";
  }

  function scanAll() {
    trackVideoSources();
    injectFeedUI();
    injectStoryUI();
  }

  let debounce = null;
  new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(scanAll, 50);
  }).observe(document.body, { childList: true, subtree: true });

  scanAll();
})();
