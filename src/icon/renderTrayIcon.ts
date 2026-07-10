import { nativeImage, NativeImage } from "electron";
import { PNG } from "pngjs";
import { getUsageColor, getUsageColorHex, hexToRgb } from "./colors";

let _cachedStateKey: string | null = null;
let _cachedImage: NativeImage | null = null;

export interface BarData {
  provider: string;
  usedPercent?: number;
  isStale: boolean;
}

export interface TrayIconState {
  bars: BarData[];
  hasError: boolean;
}

type RGBA = [number, number, number, number];

const PADDING_H = 3;
const BAR_WIDTH = 26;
const TRACK_COLOR: RGBA = [40, 40, 40, 255];

function trayStateKey(state: TrayIconState, size: number): string {
  const bars = state.bars
    .map((bar) => `${bar.provider}:${bar.usedPercent ?? ""}:${bar.isStale}`)
    .join("|");
  return `${size}|${state.hasError}|${bars}`;
}

export function renderTrayIcon(state: TrayIconState, size = 32): NativeImage {
  const key = trayStateKey(state, size);
  if (key === _cachedStateKey && _cachedImage) return _cachedImage;

  const png = new PNG({ width: size, height: size });
  fillTransparent(png);

  const slots = state.bars;

  if (slots.length === 0) {
    const barH = 8;
    const y = Math.floor((size - barH) / 2);
    drawRect(png, PADDING_H, y, BAR_WIDTH, barH, TRACK_COLOR);
  } else {
    const barH = slots.length === 1 ? 8 : 7;
    const gap = slots.length === 2 ? 4 : 0;
    const totalH = slots.length * barH + Math.max(0, slots.length - 1) * gap;
    const startY = Math.floor((size - totalH) / 2);

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const y = startY + i * (barH + gap);
      drawRect(png, PADDING_H, y, BAR_WIDTH, barH, TRACK_COLOR);
      const { fillWidth, color } = barFill(slot);
      if (fillWidth > 0) {
        drawRect(png, PADDING_H, y, fillWidth, barH, color);
      }
    }
  }

  const img = nativeImage.createFromBuffer(PNG.sync.write(png));
  _cachedStateKey = key;
  _cachedImage = img;
  return img;
}

function barFill(bar: BarData): { fillWidth: number; color: RGBA } {
  const dim = bar.isStale ? 0.65 : 1;

  if (bar.usedPercent === undefined) {
    const v = Math.round(120 * dim);
    return { fillWidth: BAR_WIDTH, color: [v, v, v, 255] };
  }

  const fillWidth = Math.round(BAR_WIDTH * bar.usedPercent / 100);
  const hex = getUsageColorHex(getUsageColor(bar.usedPercent));
  const [r, g, b] = hexToRgb(hex);
  return {
    fillWidth,
    color: [Math.round(r * dim), Math.round(g * dim), Math.round(b * dim), 255],
  };
}

function drawRect(png: PNG, x: number, y: number, w: number, h: number, color: RGBA): void {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      setPixel(png, col, row, color);
    }
  }
}

function fillTransparent(png: PNG): void {
  png.data.fill(0);
}

function setPixel(png: PNG, x: number, y: number, color: RGBA): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx] = color[0];
  png.data[idx + 1] = color[1];
  png.data[idx + 2] = color[2];
  png.data[idx + 3] = color[3];
}
