import { existsSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

export interface WatchTreeOptions {
  debounceMs?: number;
  ignore?: (relativePath: string) => boolean;
  onChange: (relativePaths: string[]) => void;
  onError?: (error: unknown) => void;
}

export interface TreeWatcher {
  close(): Promise<void>;
}

/**
 * Native recursive directory watcher using Node 22's fs.watch({ recursive: true })
 * (FSEvents on macOS, ReadDirectoryChangesW on Windows) with debounced batching
 * and unref'd timers so shutdown never hangs.
 */
export function watchDirectoryTree(dir: string, options: WatchTreeOptions): TreeWatcher {
  const debounceMs = options.debounceMs ?? 250;
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const pending = new Set<string>();

  const flush = () => {
    timer = null;
    if (closed || pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    try {
      options.onChange(batch);
    } catch (error) {
      options.onError?.(error);
    }
  };

  if (existsSync(dir)) {
    try {
      watcher = watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
        if (closed) return;
        const raw = typeof filename === 'string' ? filename : filename ? String(filename) : '';
        const normalized = raw.split(path.sep).join('/').replace(/^\/+/, '');
        if (normalized && options.ignore?.(normalized)) return;
        pending.add(normalized);
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, debounceMs);
        timer.unref();
      });
      watcher.on('error', error => {
        if (!closed) options.onError?.(error);
      });
    } catch (error) {
      options.onError?.(error);
    }
  }

  return {
    async close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // ignore close errors on already-closed watcher
        }
        watcher = null;
      }
    },
  };
}
