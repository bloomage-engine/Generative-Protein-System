import { join } from "node:path";

export interface DesktopPaths {
  userDataDir: string;
  configPath: string;
  settingsPath: string;
  recordStorePath: string;
  projectRoot: string;
  dshHome: string;
  transcriptDir: string;
}

export function resolveDesktopPaths(input: {
  userDataDir: string;
  homeDir: string;
  env?: NodeJS.ProcessEnv;
}): DesktopPaths {
  const env = input.env ?? {};
  return {
    userDataDir: input.userDataDir,
    configPath: join(input.userDataDir, "config.env"),
    settingsPath: join(input.userDataDir, "settings.json"),
    recordStorePath: join(input.userDataDir, "record.jsonl"),
    projectRoot: env.PROJECT_ROOT ?? join(input.homeDir, "Documents", "Science Studio", "projects"),
    dshHome: join(input.userDataDir, "dsh"),
    transcriptDir: join(input.userDataDir, "transcripts"),
  };
}
