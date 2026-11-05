import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * Lazy loads a React component with automatic page reload resilience on stale chunk errors.
 * 
 * When a new deployment occurs, old hashed JS chunks are replaced on the hosting server.
 * If a user still has an older HTML page loaded in memory, trying to dynamically import a
 * lazy component triggers:
 * "Failed to fetch dynamically imported module: ... <chunk-name>.js"
 * 
 * This helper detects that condition, reloads the page once to hydrate with the latest assets,
 * and guards against infinite reload loops if there is an actual network or syntax failure.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
): LazyExoticComponent<T> {
  return lazy(async (): Promise<{ default: T }> => {
    const routeKey = `chunk_retry_${window.location.pathname}_${window.location.search}`;
    const alreadyRetried = sessionStorage.getItem(routeKey);

    try {
      const module = await factory();
      // On successful load, clear any retry flag
      sessionStorage.removeItem(routeKey);
      return module;
    } catch (error: any) {
      const errorMessage = String(error?.message || '');
      const isChunkLoadError =
        errorMessage.includes('dynamically imported module') ||
        errorMessage.includes('Loading chunk') ||
        errorMessage.includes('Importing a module script failed') ||
        errorMessage.includes('error loading dynamically imported module') ||
        error?.name === 'ChunkLoadError';

      const lastReload = sessionStorage.getItem('vite_last_chunk_reload');
      const now = Date.now();
      const recentlyReloaded = Boolean(lastReload && now - parseInt(lastReload, 10) < 10000);

      if (isChunkLoadError && !alreadyRetried && !recentlyReloaded) {
        console.warn('Stale dynamic chunk detected following a new deployment. Reloading application...', error);
        sessionStorage.setItem(routeKey, 'true');
        sessionStorage.setItem('vite_last_chunk_reload', String(now));
        window.location.reload();
        // Return a pending promise so React does not render an unhandled error during page unload
        return new Promise(() => {});
      }

      throw error;
    }
  });
}
