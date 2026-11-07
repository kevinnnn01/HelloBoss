/*
 * Adapted from Peter Coles' full-page-screen-capture-chrome-extension (MIT).
 * Copyright (c) 2012,2013 Peter Coles (http://mrcoles.com/)
 * Upstream: page.js#getPositions, api.js#_initScreenshots / #_filterScreenshots.
 * Exact source, license and hashes are retained under ./upstream and provenance.json.
 * Adaptations: ES modules, explicit bounds, OffscreenCanvas, model-sized output tiles.
 */

export function createCapturePlan(fullWidth, fullHeight, windowWidth, windowHeight) {
  if (![fullWidth, fullHeight, windowWidth, windowHeight].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error("GoFullPage：页面尺寸无效。");
  }
  // Upstream's bottom-to-top overlapping sweep makes later frames overwrite sticky headers.
  const scrollPad = 200;
  const yDelta = windowHeight - (windowHeight > scrollPad ? scrollPad : 0);
  const xDelta = windowWidth;
  if (fullWidth <= xDelta + 1) fullWidth = xDelta;
  const arrangements = [];
  for (let yPos = fullHeight - windowHeight; yPos > -yDelta; yPos -= yDelta) {
    for (let xPos = 0; xPos < fullWidth; xPos += xDelta) arrangements.push([xPos, Math.max(0, yPos)]);
  }
  return arrangements.length ? arrangements : [[0, 0]];
}

export function createTileLayout(totalWidth, totalHeight, maxWidth = 8192, maxHeight = 2048) {
  if (![totalWidth, totalHeight, maxWidth, maxHeight].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error("GoFullPage：拼接尺寸无效。");
  }
  // Derived from upstream _initScreenshots; split early so the model can read small text.
  const width = Math.ceil(totalWidth), height = Math.ceil(totalHeight);
  if (width * height > 24000000) throw new Error("GoFullPage：图片超过 2400 万像素拼接预算，请缩小浏览器窗口或缩短页面。");
  const cols = Math.ceil(width / maxWidth), rows = Math.ceil(height / maxHeight);
  if (cols * rows > 12) throw new Error("GoFullPage：完整截图超过 12 个图片分片，请缩短岗位内容或使用其他模式。");
  const result = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const left = col * maxWidth, top = row * maxHeight;
      const tileWidth = Math.min(maxWidth, width - left), tileHeight = Math.min(maxHeight, height - top);
      result.push({ left, top, width: tileWidth, height: tileHeight,
        right: left + tileWidth, bottom: top + tileHeight });
    }
  }
  return result;
}

export function filterTiles(imgLeft, imgTop, imgWidth, imgHeight, screenshots) {
  // Upstream _filterScreenshots intersection semantics.
  const imgRight = imgLeft + imgWidth, imgBottom = imgTop + imgHeight;
  return screenshots.filter(tile => imgLeft < tile.right && imgRight > tile.left &&
    imgTop < tile.bottom && imgBottom > tile.top);
}

export class GoFullPageCompositor {
  constructor({ canvasFactory = (width, height) => new OffscreenCanvas(width, height) } = {}) {
    this.canvasFactory = canvasFactory;
    this.tiles = [];
  }

  draw(image, state) {
    const scale = image.width / state.rect.width;
    if (!this.tiles.length) {
      this.scale = scale;
      this.total = state.total;
      this.width = image.width;
      this.tiles = createTileLayout(image.width, state.total * scale).map(tile => {
        const canvas = this.canvasFactory(tile.width, tile.height);
        return { ...tile, canvas, ctx: canvas.getContext("2d") };
      });
    }
    if (Math.abs(this.scale - scale) > 0.01 || this.width !== image.width || Math.abs(state.total - this.total) > 2) {
      throw new Error("GoFullPage：页面尺寸在截图期间发生变化，请等待内容加载完成后重新截屏。");
    }
    const y = Math.round(state.top * this.scale);
    filterTiles(0, y, image.width, image.height, this.tiles).forEach(tile => {
      tile.ctx.drawImage(image, -tile.left, y - tile.top);
    });
  }

  async toBlobs() {
    if (!this.tiles.length) throw new Error("GoFullPage：没有可拼接的截图。");
    const blobs = [];
    for (const tile of this.tiles) blobs.push(await tile.canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 }));
    return blobs;
  }

  dispose() {
    for (const tile of this.tiles) { tile.canvas.width = 1; tile.canvas.height = 1; }
    this.tiles = [];
  }
}
