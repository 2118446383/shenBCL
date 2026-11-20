/** Project images remain inert <img> resources from Modrinth's public CDN. */
export function catalogIconUrl(value: unknown, projectId?: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.modrinth.com' || url.port || url.username || url.password || url.hash || url.search) return undefined;
    const path = /^\/data\/([A-Za-z\d_-]{1,80})\/[A-Za-z\d_.-]+\.(?:png|webp|jpe?g|gif|avif|svg)$/i.exec(url.pathname);
    if (!path || projectId && path[1] !== projectId) return undefined;
    return url.href;
  } catch { return undefined; }
}
