import { nativeImage, NativeImage } from "electron";
import { PNG } from "pngjs";

export interface BarData {
  usedPercent?: number;
  isStale: boolean;
}

export interface TrayIconState {
  codex?: BarData;
  claude?: BarData;
  gemini?: BarData;
  hasError: boolean;
}

type RGBA = [number, number, number, number];

export function renderTrayIcon(state: TrayIconState, size = 32): NativeImage {
  const png = new PNG({ width: size, height: size });
  fillTransparent(png);
  return nativeImage.createFromBuffer(PNG.sync.write(png));
}

function fillTransparent(png: PNG): void {
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      setPixel(png, x, y, [0, 0, 0, 0]);
    }
  }
}

function setPixel(png: PNG, x: number, y: number, color: RGBA): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx] = color[0];
  png.data[idx + 1] = color[1];
  png.data[idx + 2] = color[2];
  png.data[idx + 3] = color[3];
}
