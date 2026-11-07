/** React effects from the previous render can run after a map has been replaced.
 * Readiness belongs to the loaded map instance, never to the host or a boolean. */
export function trafficMapForUpdate<
  T extends { getLayer: (id: string) => unknown },
>(current: T | null, loaded: T | null): T | null {
  return current && current === loaded && current.getLayer("edges")
    ? current
    : null;
}
