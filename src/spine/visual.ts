import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";

import { SpineError } from "./errors.js";

const MAX_PIXELS = 16_000_000;
const MAX_PNG_BYTES = 64_000_000;
const DIVIDER = 4;
const SHEET_PADDING = 8;

export interface PixelImage {
  width: number;
  height: number;
  data: Buffer;
}

export interface ComparisonPair {
  beforePath: string;
  afterPath: string;
}

export interface ComparedFrame {
  path: string;
  width: number;
  height: number;
  meanAbsoluteDifference: number;
  changedPixelPercent: number;
}

function checkSize(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) {
    throw new SpineError("PREVIEW_TOO_LARGE", `Preview dimensions exceed the ${MAX_PIXELS.toLocaleString()} pixel limit.`);
  }
}

export async function decodePreviewPng(path: string): Promise<PixelImage> {
  const size = await stat(path).then((file) => file.size).catch(() => {
    throw new SpineError("PREVIEW_NOT_FOUND", `The rendered preview cannot be read: ${path}`);
  });
  if (size > MAX_PNG_BYTES) throw new SpineError("PREVIEW_TOO_LARGE", "A PNG preview exceeds the 64 MB input limit.");
  const bytes = await readFile(path).catch(() => {
    throw new SpineError("PREVIEW_NOT_FOUND", `The rendered preview cannot be read: ${path}`);
  });
  if (bytes.length > MAX_PNG_BYTES) throw new SpineError("PREVIEW_TOO_LARGE", "A PNG preview exceeds the 64 MB input limit.");
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new SpineError("INVALID_PREVIEW_PNG", `The rendered preview is not a PNG: ${path}`);
  }
  checkSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  try {
    const png = PNG.sync.read(bytes);
    checkSize(png.width, png.height);
    return png;
  } catch {
    throw new SpineError("INVALID_PREVIEW_PNG", `Could not decode the rendered PNG: ${path}`);
  }
}

function sampledPixel(image: PixelImage, x: number, y: number, canvasWidth: number, canvasHeight: number, background: number): [number, number, number] {
  const localX = x - Math.floor((canvasWidth - image.width) / 2);
  const localY = y - Math.floor((canvasHeight - image.height) / 2);
  if (localX < 0 || localY < 0 || localX >= image.width || localY >= image.height) return [background, background, background];
  const offset = (localY * image.width + localX) * 4;
  const alpha = image.data[offset + 3];
  return [0, 1, 2].map((channel) => Math.round((image.data[offset + channel] * alpha + background * (255 - alpha)) / 255)) as [number, number, number];
}

function setPixel(image: PNG, x: number, y: number, rgb: readonly number[]): void {
  const offset = (y * image.width + x) * 4;
  image.data[offset] = rgb[0];
  image.data[offset + 1] = rgb[1];
  image.data[offset + 2] = rgb[2];
  image.data[offset + 3] = 255;
}

function compose(before: PixelImage, after: PixelImage): { image: PNG; meanAbsoluteDifference: number; changedPixelPercent: number } {
  const canvasWidth = Math.max(before.width, after.width);
  const canvasHeight = Math.max(before.height, after.height);
  checkSize(canvasWidth * 2 + DIVIDER, canvasHeight);
  const image = new PNG({ width: canvasWidth * 2 + DIVIDER, height: canvasHeight });
  let sum = 0;
  let changed = 0;
  for (let y = 0; y < canvasHeight; y++) {
    for (let x = 0; x < canvasWidth; x++) {
      const background = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 224 : 192;
      const left = sampledPixel(before, x, y, canvasWidth, canvasHeight, background);
      const right = sampledPixel(after, x, y, canvasWidth, canvasHeight, background);
      setPixel(image, x, y, left);
      setPixel(image, x + canvasWidth + DIVIDER, y, right);
      const differences = left.map((value, index) => Math.abs(value - right[index]));
      sum += differences[0] + differences[1] + differences[2];
      if (Math.max(...differences) > 8) changed++;
    }
    for (let x = canvasWidth; x < canvasWidth + DIVIDER; x++) setPixel(image, x, y, [60, 70, 80]);
  }
  return {
    image,
    meanAbsoluteDifference: Number((sum / (canvasWidth * canvasHeight * 3 * 255)).toFixed(6)),
    changedPixelPercent: Number((changed * 100 / (canvasWidth * canvasHeight)).toFixed(2)),
  };
}

function thumbnail(image: PNG): PNG {
  const scale = Math.min(1, 720 / image.width, 240 / image.height);
  const width = Math.max(1, Math.floor(image.width * scale));
  const height = Math.max(1, Math.floor(image.height * scale));
  if (width === image.width && height === image.height) return image;
  const result = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(image.width - 1, Math.floor(x * image.width / width));
      const sourceY = Math.min(image.height - 1, Math.floor(y * image.height / height));
      const sourceOffset = (sourceY * image.width + sourceX) * 4;
      image.data.copy(result.data, (y * width + x) * 4, sourceOffset, sourceOffset + 4);
    }
  }
  return result;
}

function opaqueThumbnail(image: PixelImage): PNG {
  const scale = Math.min(1, 720 / image.width, 240 / image.height);
  const width = Math.max(1, Math.floor(image.width * scale));
  const height = Math.max(1, Math.floor(image.height * scale));
  const result = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(image.width - 1, Math.floor(x * image.width / width));
      const sourceY = Math.min(image.height - 1, Math.floor(y * image.height / height));
      const background = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 224 : 192;
      setPixel(result, x, y, sampledPixel(image, sourceX, sourceY, image.width, image.height, background));
    }
  }
  return result;
}

function contactSheet(images: PNG[]): PNG {
  const sizes = images.map((image) => {
    const scale = Math.min(1, 720 / image.width, 240 / image.height);
    return { width: Math.max(1, Math.floor(image.width * scale)), height: Math.max(1, Math.floor(image.height * scale)) };
  });
  const width = Math.max(...sizes.map((size) => size.width)) + SHEET_PADDING * 2;
  const height = sizes.reduce((sum, size) => sum + size.height + SHEET_PADDING, SHEET_PADDING);
  checkSize(width, height);
  const sheet = new PNG({ width, height });
  for (let i = 0; i < sheet.data.length; i += 4) {
    sheet.data[i] = 36;
    sheet.data[i + 1] = 42;
    sheet.data[i + 2] = 48;
    sheet.data[i + 3] = 255;
  }
  let top = SHEET_PADDING;
  for (let index = 0; index < images.length; index++) {
    const source = images[index];
    const size = sizes[index];
    const left = Math.floor((width - size.width) / 2);
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        const sourceX = Math.min(source.width - 1, Math.floor(x * source.width / size.width));
        const sourceY = Math.min(source.height - 1, Math.floor(y * source.height / size.height));
        const sourceOffset = (sourceY * source.width + sourceX) * 4;
        const targetOffset = ((top + y) * width + left + x) * 4;
        source.data.copy(sheet.data, targetOffset, sourceOffset, sourceOffset + 4);
      }
    }
    top += size.height + SHEET_PADDING;
  }
  return sheet;
}

export async function createFrameContactSheet(paths: string[], outputDir: string): Promise<{
  directory: string;
  path: string;
  width: number;
  height: number;
}> {
  if (paths.length < 1 || paths.length > 12) throw new SpineError("INVALID_COMPARISON", "A contact sheet requires 1 to 12 frames.");
  await mkdir(outputDir, { recursive: true });
  const directory = await mkdtemp(join(outputDir, "spine-contact-sheet-"));
  try {
    const images: PNG[] = [];
    for (const framePath of paths) images.push(opaqueThumbnail(await decodePreviewPng(framePath)));
    const sheet = contactSheet(images);
    const path = join(directory, "contact-sheet.png");
    await writeFile(path, PNG.sync.write(sheet));
    return { directory, path, width: sheet.width, height: sheet.height };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function createVisualComparison(pairs: ComparisonPair[], outputDir: string): Promise<{
  directory: string;
  frames: ComparedFrame[];
  contactSheetPath: string;
  contactSheetWidth: number;
  contactSheetHeight: number;
}> {
  if (pairs.length < 1 || pairs.length > 12) throw new SpineError("INVALID_COMPARISON", "Comparison requires 1 to 12 frame pairs.");
  await mkdir(outputDir, { recursive: true });
  const directory = await mkdtemp(join(outputDir, "spine-comparison-"));
  try {
    const frames: ComparedFrame[] = [];
    const images: PNG[] = [];
    for (let index = 0; index < pairs.length; index++) {
      const before = await decodePreviewPng(pairs[index].beforePath);
      const after = await decodePreviewPng(pairs[index].afterPath);
      const { image, meanAbsoluteDifference, changedPixelPercent } = compose(before, after);
      const path = join(directory, `pair-${String(index + 1).padStart(2, "0")}.png`);
      await writeFile(path, PNG.sync.write(image));
      frames.push({ path, width: image.width, height: image.height, meanAbsoluteDifference, changedPixelPercent });
      images.push(thumbnail(image));
    }
    const sheet = contactSheet(images);
    const contactSheetPath = join(directory, "contact-sheet.png");
    await writeFile(contactSheetPath, PNG.sync.write(sheet));
    return { directory, frames, contactSheetPath, contactSheetWidth: sheet.width, contactSheetHeight: sheet.height };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
