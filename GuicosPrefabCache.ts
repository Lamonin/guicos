import { director, Director, isValid, Node, Prefab } from "cc";
import { GUICOS_NOOP_LOGGER, IGuicosLogger } from "./GuicosLogger";

export interface GuicosRegistryOptions {
    /** Default: retain. Instance disposal and prefab caching are independent. */
    prefabCachePolicy?: "retain" | "releaseUnused";
    /** Called after this registry relinquishes an asset reference. */
    onPrefabReleased?: (id: string, prefab: Prefab) => void;
}

/** Run after Cocos flushes deferred node destruction, including onDestroy hooks. */
export function afterGuicosNodeDestruction(operation: () => void, node?: Node): void {
    director.once(Director.EVENT_AFTER_DRAW, () => {
        // A paused director may draw without flushing deferred destruction.
        if (node !== undefined && isValid(node)) afterGuicosNodeDestruction(operation, node);
        else operation();
    });
}

/** One owned reference per cached id; concurrent readers share both IO and ownership. */
export class GuicosPrefabCache {
    private readonly entries = new Map<string, { prefab: Prefab; users: number }>();
    private readonly pending = new Map<string, Promise<Prefab>>();
    private disposed = false;
    private disposeScheduled = false;

    public constructor(
        private readonly options: GuicosRegistryOptions = {},
        private readonly logger: IGuicosLogger = GUICOS_NOOP_LOGGER,
    ) { }

    public async get(id: string, load: () => Promise<Prefab>): Promise<Prefab> {
        this.assertActive();
        const entry = this.entries.get(id);
        if (entry !== undefined) {
            if (!isValid(entry.prefab, true)) throw new Error(`Prefab was destroyed outside Guicos ownership: ${id}`);
            return entry.prefab;
        }
        const pending = this.pending.get(id);
        if (pending !== undefined) return pending;
        const promise = (async () => {
            const prefab = await load();
            // Even a late result must take and relinquish our own reference. Never
            // release the resource manager's or another registry's ownership.
            prefab.addRef();
            if (this.disposed) {
                this.release(id, prefab);
                throw new Error("Guicos registry is disposed");
            }
            this.entries.set(id, { prefab, users: 0 });
            return prefab;
        })();
        this.pending.set(id, promise);
        try { return await promise; }
        finally { this.pending.delete(id); }
    }

    public acquire(id: string): void {
        this.assertActive();
        const entry = this.entries.get(id);
        if (entry === undefined) throw new Error(`Prefab is not loaded: ${id}`);
        entry.users++;
    }

    public relinquish(id: string): void {
        const entry = this.entries.get(id);
        if (entry === undefined) return;
        entry.users = Math.max(0, entry.users - 1);
        if (this.disposed || this.options.prefabCachePolicy === "releaseUnused") this.releaseUnused(id);
    }

    /** Explicit preloads stay warm until consumed, trimmed, or disposed. */
    public releaseUnused(id?: string): void {
        for (const [key, entry] of this.entries) {
            if ((id === undefined || id === key) && entry.users === 0) {
                this.entries.delete(key);
                this.release(key, entry.prefab);
            }
        }
    }

    public stopLoading(): void { this.disposed = true; }

    public dispose(): void {
        this.stopLoading();
        if (this.disposeScheduled) return;
        this.disposeScheduled = true;
        afterGuicosNodeDestruction(() => this.releaseUnused());
    }

    public assertActive(): void {
        if (this.disposed) throw new Error("Guicos registry is disposed");
    }

    private release(id: string, prefab: Prefab): void {
        prefab.decRef();
        try { this.options.onPrefabReleased?.(id, prefab); }
        catch (error) { this.logger.error(`[GuicosRegistry] Prefab release notification failed: ${id}`, error); }
    }
}
