/**
 * Instagram HD Viewer - Content Script
 * Supports: feed images, feed videos, Stories images, Stories videos
 *
 * OVERVIEW OF HOW IT WORKS:
 *
 * Instagram is a Single-Page App (SPA) — content loads dynamically without
 * full page reloads. We use MutationObserver to watch for new DOM nodes and
 * react to them in real time.
 *
 * We handle three types of media:
 *  1. Images in feed posts  — <img> inside <article>
 *  2. Videos in feed posts  — <video> inside <article>
 *  3. Stories viewer media  — <img> and <video> NOT inside <article>
 *     (the Stories overlay uses a different DOM structure)
 *
 * For each piece of media we inject a floating "HD" button in the top-left
 * corner. Clicking it opens the raw media URL in a new tab.
 */

(function () {
  "use strict";

  // ─── WeakSets to track already-processed elements ────────────────────────
  // WeakSet holds object references without preventing garbage collection.
  // We use one set per media type so we never inject a button twice.
  const processedArticles = new WeakSet();
  const processedStoryMedia = new WeakSet();

  // ─── URL Extraction ───────────────────────────────────────────────────────

  /**
   * Given an <img> element, parse its `srcset` attribute and return the URL
   * with the highest declared width (e.g. "1080w").
   * Falls back to the plain `src` if srcset is absent or unparseable.
   *
   * What is srcset?
   *   It is an HTML attribute that provides a list of the same image in
   *   different resolutions, like:
   *   "https://...640w.jpg 640w, https://...1080w.jpg 1080w"
   *   The browser normally picks the right size — we just grab the biggest.
   *
   * @param {HTMLImageElement} img
   * @returns {string}
   */
  function getBestImageSrc(img) {
    const srcset = img.getAttribute("srcset") || "";
    if (!srcset) return img.src;

    let bestUrl = img.src;
    let bestWidth = 0;

    srcset.split(",").forEach((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (parts.length < 2) return;
      const width = parseInt(parts[1], 10); // "640w" → 640
      if (!isNaN(width) && width > bestWidth) {
        bestWidth = width;
        bestUrl = parts[0];
      }
    });

    return bestUrl;
  }

  /**
   * Given a <video> element, return the best available source URL.
   *
   * `currentSrc` — the URL the browser actually chose to play (most reliable,
   *               but only available after the video starts loading).
   * `src`        — the direct src attribute.
   * <source>     — Instagram sometimes puts the URL in a child <source> tag.
   *
   * We wrap this in a function and call it at click time so we always get
   * the freshest value, even if the video hadn't fully loaded when injected.
   *
   * @param {HTMLVideoElement} video
   * @returns {string|null}
   */
  function getVideoSrc(video) {
    if (video.currentSrc) return video.currentSrc;
    if (video.src) return video.src;
    const source = video.querySelector("source[src]");
    if (source) return source.getAttribute("src");
    return null;
  }

  // ─── Button Factory ───────────────────────────────────────────────────────

  /**
   * Creates the SVG "open-in-new-tab" icon.
   * We use inline SVG so no external image files are needed.
   *
   * @returns {SVGElement}
   */
  function createIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute(
      "d",
      "M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"
    );
    svg.appendChild(path);
    return svg;
  }

  /**
   * Builds the HD button element.
   *
   * @param {Function} getUrl  — a function that returns the media URL at
   *                             click time (so we always get the freshest URL)
   * @param {string}   label   — text label e.g. "HD" or "▶ HD"
   * @returns {HTMLButtonElement}
   */
  function createButton(getUrl, label) {
    const btn = document.createElement("button");
    btn.className = "ighd-btn";
    btn.title = "Open original in new tab";
    btn.setAttribute("aria-label", "Open original");
    btn.appendChild(createIcon());

    const span = document.createElement("span");
    span.textContent = label;
    btn.appendChild(span);

    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // prevent Instagram navigation events
      e.preventDefault();
      const url = getUrl();
      if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    });

    return btn;
  }

  // ─── Injection helpers ────────────────────────────────────────────────────

  /**
   * Ensures `container` has `position: relative` (needed so our absolutely-
   * positioned button sits in the correct corner) and the CSS wrapper class.
   *
   * @param {Element} container
   */
  function prepareContainer(container) {
    if (!container.classList.contains("ighd-wrapper")) {
      container.classList.add("ighd-wrapper");
    }
  }

  /**
   * Injects an HD button for an <img> element.
   * Finds the closest <div> parent to use as the positioning container.
   *
   * @param {HTMLImageElement} img
   * @param {string} label
   */
  function injectForImage(img, label) {
    const container = img.closest("div") || img.parentElement;
    if (!container) return;
    prepareContainer(container);

    const btn = createButton(() => getBestImageSrc(img), label);
    container.appendChild(btn);

    // Re-evaluate URL after full load in case srcset changed
    img.addEventListener("load", () => {
      // The button's click handler already calls getBestImageSrc at click time,
      // so nothing extra needed here — this is just a safety hook.
    });
  }

  /**
   * Injects an HD button for a <video> element.
   *
   * @param {HTMLVideoElement} video
   * @param {string} label
   */
  function injectForVideo(video, label) {
    const container = video.closest("div") || video.parentElement;
    if (!container) return;
    prepareContainer(container);

    const btn = createButton(() => getVideoSrc(video), label);
    container.appendChild(btn);
  }

  // ─── Feed posts processor ─────────────────────────────────────────────────

  /**
   * Scans all <article> elements (Instagram wraps each feed post in one).
   * Injects buttons for both images and videos found inside.
   */
  function processArticles() {
    document.querySelectorAll("article").forEach((article) => {
      if (processedArticles.has(article)) return;
      processedArticles.add(article);

      // ── Images ──
      const imgs = [...article.querySelectorAll("img")];
      // Pick the largest img by layout width — that's the main post image
      let bestImg = null;
      let maxW = 0;
      imgs.forEach((img) => {
        const w = img.offsetWidth || parseInt(img.getAttribute("width")) || 0;
        if (w >= 100 && w > maxW) {
          maxW = w;
          bestImg = img;
        }
      });
      if (bestImg) injectForImage(bestImg, "HD");

      // ── Videos ──
      article.querySelectorAll("video").forEach((video) => {
        injectForVideo(video, "▶ HD");
      });
    });
  }

  // ─── Stories processor ───────────────────────────────────────────────────

  /**
   * Stories in Instagram render in a full-screen overlay that is NOT wrapped
   * in <article> elements. We detect story media by finding:
   *   • <img> elements with srcset that are large (≥ 200px wide) and
   *     are not descendants of <article> (to avoid double-processing feed posts)
   *   • <video> elements with the same exclusion
   *
   * Why ≥ 200px? Story thumbnails in the top bar are small circles (≈ 56px).
   * The actual story content is much larger, so this threshold skips thumbnails.
   */
  function processStories() {
    // ── Story images ──
    document.querySelectorAll("img[srcset]").forEach((img) => {
      if (img.closest("article")) return;      // already handled as feed post
      if (processedStoryMedia.has(img)) return; // already processed
      const w = img.offsetWidth || 0;
      if (w < 200) return;                      // skip small thumbnails

      processedStoryMedia.add(img);
      injectForImage(img, "HD");
    });

    // ── Story videos ──
    document.querySelectorAll("video").forEach((video) => {
      if (video.closest("article")) return;
      if (processedStoryMedia.has(video)) return;

      processedStoryMedia.add(video);
      injectForVideo(video, "▶ HD");
    });
  }

  // ─── MutationObserver ─────────────────────────────────────────────────────

  /**
   * Watch the entire document for DOM changes.
   * Instagram adds new posts and changes story slides without page reloads,
   * so we must react to every DOM mutation.
   *
   * We debounce (delay) the scan by 300ms so we don't fire hundreds of times
   * per second during fast DOM updates — just wait for things to settle.
   */
  let debounceTimer = null;

  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      processArticles();
      processStories();
    }, 300);
  });

  observer.observe(document.body, {
    childList: true, // watch for nodes being added/removed
    subtree: true,   // watch the entire subtree, not just direct children
  });

  // Run once immediately in case content is already in the DOM on script load
  processArticles();
  processStories();
})();
