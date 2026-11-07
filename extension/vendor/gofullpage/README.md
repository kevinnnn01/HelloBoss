# GoFullPage historical open-source core integration

Repository: https://github.com/mrcoles/full-page-screen-capture-chrome-extension

Pinned commit: `d1b6bbbf4c3f8101d787dd737e5476a5be082014`

Author: Peter Coles. License: MIT; see `upstream/LICENSE`.

## Included materials

- `upstream/`: original LICENSE, README, page.js, api.js and manifest.json at the pinned commit.
- `provenance.json`: immutable download URLs and SHA-256 digests for each original file.
- `capture-core.js`: ES module adaptation of position planning, canvas tile layout and image/tile intersection/compositing logic.

The original extension is Manifest V2. Its popup, deprecated script injection and filesystem export APIs are not installed or executed. The preserved upstream files serve as source references. Runtime imports only `capture-core.js`; our existing Manifest V3 sidebar, scripting calls, cancellation, access checks and model client coordinate capture.

## Adaptation mapping

| Upstream | Adaptation |
| --- | --- |
| `page.js` getPositions arrangements loop | `createCapturePlan`: bottom-to-top sweep, 200 CSS-pixel vertical overlap, native-scroll clamping |
| `api.js` _initScreenshots | `createTileLayout`: bounded tiles using an 8192-pixel width and 2048-pixel height limit |
| `api.js` _filterScreenshots | `filterTiles`: intersect each captured image with output tiles |
| `api.js` capture canvas drawing | `GoFullPageCompositor.draw`: use measured image scale and actual scroll offsets to composite overlapping frames |

The integration measures a JD's scrollable area with our existing code, sweeps it using the upstream planner, then stitches and outputs tiles in top-to-bottom reading order. The viewport is sampled bottom-to-top as in the original algorithm; image output is ordered top-to-bottom.

Model-oriented changes: split output into at most 12 tiles, reject layouts exceeding 24 million pixels, retain the existing 12 MiB total compressed-image limit, and encode as JPEG at 0.9 quality. These are this project's limits, not official GoFullPage limits.

## Scope and verification

This is a port of the historical MIT source, not a wrapper around the currently installed commercial extension, and not a reconstruction of the current private branch. Official FAQ: https://gofullpage.com/faq .

Node tests compare planning with original page.js in a simulated DOM, check overlap overwrite and complete coverage using simulated pixels, validate output limits, verify source hashes, and exercise sidebar capture handling with mock browser APIs. Chrome pixel capture, actual BOSS layouts and live model calls still require verification in the user's extension environment. No browser installation, navigation to internal browser pages, runtime reverse engineering or proprietary-package execution is performed by these tests.

General limitations: dynamically changing page height aborts capture; cross-origin iframe capture is not implemented; sticky elements outside the overlap may still appear; horizontal page sweeping is available in the pure planner but not enabled by the sidebar's vertical JD capture adapter.
