export interface CliOptions {
  debug: boolean;
  noWindow: boolean;
  openWindow: boolean;
  pollIntervalSeconds?: number;
  startupAction: "install" | "uninstall" | null;
}


export function parseRuntimeCliArgs(argv: string[], isPackaged: boolean): CliOptions {
  return parseCliArgs(argv.slice(isPackaged ? 1 : 2));
}

function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = { debug: false, noWindow: false, openWindow: false, startupAction: null };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--log-debug" || arg === "--debug") options.debug = true;
    else if (arg === "--no-window") options.noWindow = true;
    else if (arg === "--open-window") options.openWindow = true;
    else if (arg === "--install-startup") options.startupAction = "install";
    else if (arg === "--uninstall-startup") options.startupAction = "uninstall";
    else if (arg === "--poll-interval-seconds") {
      const value = Number(args[index + 1]);
      if (Number.isFinite(value) && value > 0) {
        options.pollIntervalSeconds = value;
      }
      index++;
    }
  }
  return options;
}
