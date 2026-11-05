/**
 * Lazy, cached access to the CMSIS-Pack device catalog.
 *
 * Scanning the local packs takes a few seconds (thousands of `.pdsc` files), so
 * the catalog is:
 * - loaded from a JSON cache inside the extension global storage directory,
 * - refreshed in the background when missing/stale (callers never block),
 * - re-scanned only when the list of pack roots changes.
 */
import * as path from 'path';
import {
    DeviceCatalog,
    readCachedCatalog,
    scanDeviceCatalog,
    writeCachedCatalog
} from './deviceDatabase';

/** Cache lifetime; packs change rarely. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const CACHE_FILE_NAME = 'keil-device-catalog.json';

export type PackRootsProvider = () => string[];

export class DeviceCatalogService {
    private catalog: DeviceCatalog | undefined;
    private scanning = false;
    private loadedFromDisk = false;
    private scanPromise: Promise<DeviceCatalog | undefined> | undefined;
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly storageDir: string,
        private readonly getPackRoots: PackRootsProvider
    ) {}

    get catalogFile(): string {
        return path.join(this.storageDir, CACHE_FILE_NAME);
    }

    /** Catalog currently in memory (may be `undefined` until loaded/scanned). */
    getCatalog(): DeviceCatalog | undefined {
        return this.catalog;
    }

    isScanning(): boolean {
        return this.scanning;
    }

    /** Register a callback fired after a background scan completed. */
    onChange(listener: () => void): void {
        this.listeners.add(listener);
    }

    /**
     * Return the catalog immediately when it is available, otherwise start a
     * background scan and return `undefined`. Callers should reload the panel
     * after {@link onChange} fires.
     */
    ensure(): DeviceCatalog | undefined {
        const loaded = this.ensureLoadedFromCache();
        if (loaded) {
            return loaded;
        }
        void this.startScan();
        return undefined;
    }

    private ensureLoadedFromCache(): DeviceCatalog | undefined {
        if (this.catalog) {
            return this.catalog;
        }
        if (this.loadedFromDisk) {
            return undefined;
        }
        this.loadedFromDisk = true;
        const cached = readCachedCatalog(this.catalogFile);
        if (cached && this.isFresh(cached)) {
            this.catalog = cached;
        }
        return this.catalog;
    }

    private startScan(): Promise<DeviceCatalog | undefined> {
        if (this.scanPromise) {
            return this.scanPromise;
        }
        const roots = this.getPackRoots();
        if (!roots || roots.length === 0) {
            this.scanPromise = Promise.resolve(undefined);
            return this.scanPromise;
        }

        this.scanning = true;
        this.scanPromise = scanDeviceCatalog(roots)
            .then((catalog) => {
                this.catalog = catalog;
                try {
                    writeCachedCatalog(this.catalogFile, catalog);
                } catch {
                    // A failed cache write must not break the panel.
                }
                this.emit();
                return catalog;
            })
            .catch(() => undefined)
            .finally(() => {
                this.scanning = false;
                this.scanPromise = undefined;
            });
        return this.scanPromise;
    }

    private isFresh(catalog: DeviceCatalog): boolean {
        const generated = Date.parse(catalog.generatedAt || '');
        if (Number.isNaN(generated)) {
            return false;
        }
        if (Date.now() - generated > MAX_AGE_MS) {
            return false;
        }
        const roots = this.getPackRoots();
        if (roots.length === 0) {
            return true;
        }
        const knownRoots = new Set(
            (catalog.packRoots || []).map((root) => path.resolve(root).toLowerCase())
        );
        return roots.every((root) => knownRoots.has(path.resolve(root).toLowerCase()));
    }

    private emit(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                // A broken listener must not stop the others.
            }
        }
    }
}
