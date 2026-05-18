import { nativeImage, NativeImage } from "electron";
import { PNG } from "pngjs";
import { getUsageColor, getUsageColorHex, hexToRgb } from "./colors";

export interface TrayIconState {
  maxUsage?: number;
  connected: boolean;
  hasError: boolean;
}

export function renderTrayIcon(state: TrayIconState, size = 32): NativeImage {
  const png = new PNG({ width: size, height: size });
  const usage = state.connected ? Math.max(0, Math.min(100, state.maxUsage ?? 0)) : 0;
  const color = state.connected ? getUsageColorHex(getUsageColor(usage)) : getUsageColorHex("gray");
  const [r, g, b] = hexToRgb(color);
  const dim = state.hasError ? 0.65 : 1;

  fillTransparent(png);
  drawRing(png, Math.floor(size / 2), Math.floor(size / 2), Math.floor(size * 0.42), [60, 60, 60, 255]);
  drawArc(png, Math.floor(size / 2), Math.floor(size / 2), Math.floor(size * 0.42), usage / 100, [
    Math.round(r * dim),
    Math.round(g * dim),
    Math.round(b * dim),
    255
  ]);

  if (!state.connected) {
    drawExclamation(png, size);
  } else if (state.hasError) {
    drawErrorDot(png, size);
  }

  return nativeImage.createFromBuffer(PNG.sync.write(png));
}

function fillTransparent(png: PNG): void {
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      setPixel(png, x, y, [0, 0, 0, 0]);
    }
  }
}

function drawRing(png: PNG, cx: number, cy: number, radius: number, color: RGBA): void {
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist >= radius - 2 && dist <= radius + 1) {
        setPixel(png, x, y, color);
      }
    }
  }
}

function drawArc(png: PNG, cx: number, cy: number, radius: number, fraction: number, color: RGBA): void {
  const end = Math.PI * 2 * fraction;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < radius - 2 || dist > radius + 1) continue;
      const angle = (Math.atan2(y - cy, x - cx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
      if (angle <= end) {
        setPixel(png, x, y, color);
      }
    }
  }
}

function drawExclamation(png: PNG, size: number): void {
  const cx = Math.floor(size / 2);
  for (let y = Math.floor(size * 0.28); y < Math.floor(size * 0.58); y++) {
    setPixel(png, cx, y, [255, 255, 255, 255]);
    setPixel(png, cx + 1, y, [255, 255, 255, 255]);
  }
  for (let y = Math.floor(size * 0.68); y < Math.floor(size * 0.75); y++) {
    setPixel(png, cx, y, [255, 255, 255, 255]);
    setPixel(png, cx + 1, y, [255, 255, 255, 255]);
  }
}

function drawErrorDot(png: PNG, size: number): void {
  const start = Math.floor(size * 0.66);
  for (let y = start; y < start + 6; y++) {
    for (let x = start; x < start + 6; x++) {
      setPixel(png, x, y, [255, 68, 68, 255]);
    }
  }
}

type RGBA = [number, number, number, number];

function setPixel(png: PNG, x: number, y: number, color: RGBA): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx] = color[0];
  png.data[idx + 1] = color[1];
  png.data[idx + 2] = color[2];
  png.data[idx + 3] = color[3];
}
