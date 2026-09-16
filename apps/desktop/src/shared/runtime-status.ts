export interface RuntimeStatus {
  dshPath: string | null;
  ready: boolean;
}

export function runtimeStatus(input: { dshPath: string | null }): RuntimeStatus {
  return { dshPath: input.dshPath, ready: input.dshPath !== null };
}
