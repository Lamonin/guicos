import { director, Director, isValid, Node, Prefab } from "cc";
import { GuicosLoadOperation, GuicosSharedRequest } from "./GuicosCancellation";
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
    private readonly entries = new Map<string, { prefab: Prefab; users: number; generation: object; observed: boolean }>();
    private readonly pending = new Map<string, GuicosSharedRequest<Prefab>>();
    private disposed = false;
    private disposeScheduled = false;

    public constructor(
        private readonly options: GuicosRegistryOptions = {},
        private readonly logger: IGuicosLogger = GUICOS_NOOP_LOGGER,
    ) { }

    public async get(id: string, load: () => Promise<Prefab>, operation?: GuicosLoadOperation): Promise<Prefab> {
        this.assertActive();
        operation?.throwIfCanceled();
        const entry = this.entries.get(id);
        if (entry !== undefined) {
            if (!isValid(entry.prefab, true)) throw new Error(`Prefab was destroyed outside Guicos ownership: ${id}`);
            entry.observed = true;
            return entry.prefab;
        }
        let pending = this.pending.get(id);
        if (pending === undefined) {
            const generation = {};
            const request = new GuicosSharedRequest<Prefab>(async requestOperation => {
                const prefab = await load();
                prefab.addRef();
                if (this.disposed || requestOperation.isCanceled) {
                    this.release(id, prefab);
                    if (this.disposed) throw new Error("Guicos registry is disposed");
                    requestOperation.throwIfCanceled();
                }
                this.entries.set(id, { prefab, users: 0, generation, observed: false });
                return prefab;
            }, () => { if (this.pending.get(id) === request) this.pending.delete(id); }, prefab => {
                // Transport completion and observer delivery are different microtasks.
                // Aborting between them must not leave an unused owned cache entry.
                const entry = this.entries.get(id);
                if (entry?.generation === generation && entry.users === 0 && !entry.observed) {
                    this.entries.delete(id);
                    this.release(id, prefab);
                }
            });
            this.pending.set(id, request);
            pending = request;
        }
        return pending.read(operation);
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

    public stopLoading(): void {
        this.disposed = true;
        // Wake registry observers now; the transport can still complete later.
        for (const request of Array.from(this.pending.values())) request.cancel(new Error("Guicos registry is disposed"));
    }

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
