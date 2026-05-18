import fs from "node:fs/promises";
import { app, dialog } from "electron";
import { ensureConfigDir } from "../main/logging";
import { getInstalledMarkerPath } from "./paths";

export async function runFirstRunPrompt(): Promise<void> {
  try {
    await fs.access(getInstalledMarkerPath());
    return;
  } catch {
    await ensureConfigDir();
  }

  const choice = await dialog.showMessageBox({
    type: "question",
    buttons: ["Yes", "No"],
    defaultId: 0,
    cancelId: 1,
    title: "QuotaBar for Windows",
    message: "Start QuotaBar automatically when Windows starts?"
  });

  if (choice.response === 0) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  await fs.writeFile(getInstalledMarkerPath(), new Date().toISOString(), "utf8");
}
