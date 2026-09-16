import { join } from "node:path";

export interface DesktopResourcePaths {
  hostEntry: string;
  nextDir: string;
}

export function resolveResourcePaths(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appRoot: string;
}): DesktopResourcePaths {
  if (input.isPackaged) {
    return {
      hostEntry: join(input.resourcesPath, "host", "host.mjs"),
      nextDir: join(input.resourcesPath, "next", "apps", "web"),
    };
  }
  return {
    hostEntry: join(input.appRoot, "build", "host", "host.mjs"),
    nextDir: join(input.appRoot, "..", "web", ".next", "standalone", "apps", "web"),
  };
}
