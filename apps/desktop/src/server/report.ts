export function readyMessage(ports: { webPort: number; apiPort: number }): {
  type: "ready";
  webPort: number;
  apiPort: number;
} {
  return { type: "ready", webPort: ports.webPort, apiPort: ports.apiPort };
}

export function reportReady(ports: { webPort: number; apiPort: number }): void {
  const message = readyMessage(ports);
  if (typeof process.send === "function") process.send(message);
  else process.stdout.write(`${JSON.stringify(message)}\n`);
}
