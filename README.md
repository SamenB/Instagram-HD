# Instagram HD Downloader

A lightweight and powerful Google Chrome extension designed to download original, maximum-quality photos and videos from Instagram feeds and stories with a single click.

## Features

- **High-Quality Downloads**: Extracts the highest available resolution for both images and videos.
- **Feed Integration**: Seamlessly adds a sleek, semi-transparent `▶ HD` download button to all posts in your feed.
- **Story Support**: Features a highly accurate, globally positioned `Download Story` button that guarantees the exact active media is downloaded, completely bypassing Instagram's aggressive DOM preloading.
- **Blob Encryption Bypass**: Intelligently intercepts internal API requests (XHR/Fetch) to extract direct CDN links, successfully bypassing Instagram's `blob:` video obfuscation.
- **Privacy First**: Operates entirely locally within your browser. No external servers or telemetry.

## Installation

1. Download or clone this repository to your local machine:
   ```bash
   git clone https://github.com/SamenB/Instagram-HD.git
   ```
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top right corner.
4. Click the **Load unpacked** button in the top left corner.
5. Select the directory containing the extension files.
6. Refresh your Instagram tab and start downloading!

## Technical Details

- **Event Interception (`injected.js`)**: Injects into the page context to monitor JSON responses from Instagram's GraphQL and REST APIs. It builds a real-time map linking media IDs to their direct CDN URLs.
- **UI Integration (`content.js`)**: Safely overlays the DOM with download buttons. For Stories, it dynamically parses the active story ID from the browser's URL and retrieves the exact video URL from the map, ensuring 100% accuracy despite React's dynamic container recycling. 
- **Isolated Styles (`styles.css`)**: Implements strict `z-index` stacking and `position: fixed` to prevent layout shifts and ensure buttons are always visible above Instagram's modals.
