export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
