import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createCapturePlan, createTileLayout, filterTiles, GoFullPageCompositor } from "../extension/vendor/gofullpage/capture-core.js";

const upstreamRoot = new URL("../extension/vendor/gofullpage/upstream/", import.meta.url);
const originalPage = readFileSync(new URL("page.js", upstreamRoot), "utf8");

function upstreamPositions(width, height, viewWidth, viewHeight) {
  const positions = [];
  const window = {
    innerWidth: viewWidth, innerHeight: viewHeight, scrollX: 0, scrollY: 0, devicePixelRatio: 1,
    setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
    scrollTo(x, y) {
      this.scrollX = Math.max(0, Math.min(x, width - viewWidth));
      this.scrollY = Math.max(0, Math.min(y, height - viewHeight));
    },
  };
  const context = {
    window, console: { log() {}, error() {} },
    document: {
      body: { style: { overflowY: "auto" }, scrollWidth: width, offsetWidth: width, scrollHeight: height, offsetHeight: height },
      documentElement: { style: { overflow: "auto" }, clientWidth: viewWidth, clientHeight: viewHeight,
        scrollWidth: width, offsetWidth: width, scrollHeight: height, offsetHeight: height },
    },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage(data, callback) { positions.push([data.x, data.y]); callback(true); },
    } },
  };
  vm.runInNewContext(`${originalPage}\ngetPositions(function() {});`, context);
  return positions;
}

test("ported arrangements match original GoFullPage page.js after native scroll clamping", () => {
  for (const [width, height, vw, vh] of [[800, 1800, 800, 800], [800, 800, 800, 800],
    [800, 500, 800, 800], [1800, 1950, 800, 600], [800, 700, 800, 180]]) {
    const port = createCapturePlan(width, height, vw, vh).map(([x, y]) => [
      Math.max(0, Math.min(x, width - vw)), Math.max(0, Math.min(y, height - vh)),
    ]);
    assert.deepEqual(port, upstreamPositions(width, height, vw, vh));
  }
});

test("tiles cover complete output and intersections exclude boundary-only contact", () => {
  const tiles = createTileLayout(9000, 2500);
  assert.equal(tiles.length, 4);
  assert.equal(tiles.reduce((area, tile) => area + tile.width * tile.height, 0), 9000 * 2500);
  assert.equal(filterTiles(0, 0, 8192, 2048, tiles).length, 1);
  assert.throws(() => createTileLayout(8000, 10000), /预算/);
  assert.throws(() => createTileLayout(1, 50000), /12/);
});

test("compositor removes overlapping sticky headers and has no gaps across output tiles", async () => {
  const compositor = new GoFullPageCompositor({ canvasFactory(width, height) {
    const pixels = new Int32Array(width * height).fill(-9);
    return {
      width, height, pixels,
      getContext: () => ({ drawImage(image, dx, dy) {
        for (let sy = 0; sy < image.height; sy++) for (let sx = 0; sx < image.width; sx++) {
          const x = dx + sx, y = dy + sy;
          if (x >= 0 && x < width && y >= 0 && y < height) pixels[y * width + x] = image.rows[sy];
        }
      } }),
      convertToBlob: async () => new Blob([pixels]),
    };
  } });
  for (const [, top] of createCapturePlan(4, 3000, 4, 800)) {
    compositor.draw({ width: 4, height: 800,
      rows: Array.from({ length: 800 }, (_, row) => row < 200 ? -1 : top + row),
    }, { top, total: 3000, rect: { width: 4 } });
  }
  assert.equal(compositor.tiles.length, 2);
  for (const tile of compositor.tiles) for (let row = 0; row < tile.height; row++) {
    const globalRow = tile.top + row;
    assert.equal(tile.canvas.pixels[row * tile.width], globalRow < 200 ? -1 : globalRow);
  }
  assert.equal((await compositor.toBlobs()).length, 2);
  compositor.dispose();
  assert.equal(compositor.tiles.length, 0);
});

test("viewport/layout changes reject the stitched result", () => {
  const compositor = new GoFullPageCompositor({ canvasFactory: () => ({ getContext: () => ({ drawImage() {} }) }) });
  compositor.draw({ width: 800, height: 600 }, { top: 600, total: 1200, rect: { width: 800 } });
  assert.throws(() => compositor.draw({ width: 800, height: 600 }, { top: 0, total: 1400, rect: { width: 800 } }), /尺寸/);
});

test("vendored upstream files match pinned provenance hashes and retain MIT license", () => {
  const provenance = JSON.parse(readFileSync(new URL("../extension/vendor/gofullpage/provenance.json", import.meta.url), "utf8"));
  assert.equal(provenance.commit, "d1b6bbbf4c3f8101d787dd737e5476a5be082014");
  for (const item of provenance.files) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(item.file, upstreamRoot))).digest("hex"), item.sha256);
  }
  assert.match(readFileSync(new URL("LICENSE", upstreamRoot), "utf8"), /The MIT License/);
});
