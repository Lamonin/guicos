import { instantiate, isValid, Node, _decorator } from "cc";
import { Prefab } from "cc";
import { GuicosId } from "./GuicosId";
import { GuicosView } from "./GuicosView";
import { Component } from "cc";
import { IGuicosResourceManager } from "./GuicosResourceManager";
import { GUICOS_NOOP_LOGGER, IGuicosLogger } from "./GuicosLogger";
import { afterGuicosNodeDestruction, GuicosPrefabCache, GuicosRegistryOptions } from "./GuicosPrefabCache";
const { property } = _decorator;

export type GuicosViewCtor<TView extends GuicosView<any> = GuicosView<any>> = new (...args: any[]) => TView;

export abstract class GuicosPrefabViewRegistryData {
    @property()
    public id: string = "";
    @property({ type: Prefab, displayOrder: 10 })
    public prefab: Prefab | null = null;
}

export abstract class GuicosResourceViewRegistryData {
    @property()
    public id: string = "";
    @property({ displayOrder: 10 })
    public path: string = "";
}

export class GuicosViewsRegistry {
    private readonly _viewsCache: Map<GuicosId, GuicosView<any>> = new Map<GuicosId, GuicosView<any>>();
    private readonly _pendingViews: Map<GuicosId, Promise<GuicosView<any>>> = new Map<GuicosId, Promise<GuicosView<any>>>();
    private readonly _instancePrefabIds = new Map<GuicosId, GuicosId>();
    private readonly _prefabs: GuicosPrefabCache;

    constructor(
        private readonly prefabsRegistry: GuicosPrefabViewRegistryData[],
        private readonly resourcesRegistry: GuicosResourceViewRegistryData[],
        private readonly resourceManager: IGuicosResourceManager | null = null,
        private readonly logger: IGuicosLogger = GUICOS_NOOP_LOGGER,
        options: GuicosRegistryOptions = {},
    ) {
        this._prefabs = new GuicosPrefabCache(options, logger);
    }

    public async getOrCreateView(
        viewId: GuicosId,
        viewCtor: GuicosViewCtor | null = null,
        registryViewId: GuicosId = viewId,
    ): Promise<GuicosView<any>> {
        this._prefabs.assertActive();
        const cachedView = this._viewsCache.get(viewId);
        if (cachedView !== undefined) {
            if (isValid(cachedView, true) && isValid(cachedView.node, true)) {
                return cachedView;
            }

            this.destroyView(viewId);
            throw new Error(`Cached view was destroyed outside Guicos lifecycle: ${viewId}`);
        }

        const pendingView = this._pendingViews.get(viewId);
        if (pendingView !== undefined) {
            return await pendingView;
        }

        const viewPromise = this.createAndCacheView(viewId, viewCtor, registryViewId);
        this._pendingViews.set(viewId, viewPromise);

        try {
            return await viewPromise;
        } finally {
            this._pendingViews.delete(viewId);
        }
    }

    public destroyView(viewId: GuicosId): void {
        const view = this._viewsCache.get(viewId);
        this._viewsCache.delete(viewId);
        const prefabId = this._instancePrefabIds.get(viewId);
        this._instancePrefabIds.delete(viewId);
        if (view !== undefined && isValid(view.node, true)) {
            view.node.removeFromParent();
            view.node.destroy();
        }
        if (prefabId !== undefined) {
            afterGuicosNodeDestruction(() => this._prefabs.relinquish(prefabId), view?.node);
        }
    }

    /** Stop new IO immediately; existing instances remain available for unmount. */
    public stopLoading(): void { this._prefabs.stopLoading(); }

    public dispose(): void {
        for (const id of this._viewsCache.keys()) this.destroyView(id);
        this._prefabs.dispose();
    }

    public releaseUnusedPrefabs(): void { this._prefabs.releaseUnused(); }

    public async preloadView(registryViewId: GuicosId): Promise<void> {
        await this.getPrefab(registryViewId);
    }

    public getPrefab(id: GuicosId): Promise<Prefab> {
        return this._prefabs.get(id, () => this.loadPrefab(id));
    }

    private async loadPrefab(id: GuicosId): Promise<Prefab> {
        const prefabData = (this.prefabsRegistry ?? []).find((entry) => entry.id === id);
        if (prefabData === undefined) {
            const resourceData = (this.resourcesRegistry ?? []).find((entry) => entry.id === id);
            if (resourceData !== undefined) {
                if (this.resourceManager === null) {
                    throw new Error(`Resource manager is not assigned for id: ${id}`);
                }

                this.logger.log(`[GuicosViewsRegistry] Loading resource view prefab. id: ${id}, path: ${resourceData.path}`);
                const prefab = await this.resourceManager.load(resourceData.path, Prefab);
                this.logger.log(`[GuicosViewsRegistry] Loaded resource view prefab. id: ${id}, path: ${resourceData.path}`);
                return prefab;
            }

            throw new Error(`No prefab or resource registered with id: ${id}`);
        }

        if (prefabData.prefab == null) {
            throw new Error(`Prefab is not assigned for id: ${id}`);
        }

        return prefabData.prefab;
    }

    private async createAndCacheView(
        viewId: GuicosId,
        viewCtor: GuicosViewCtor | null,
        registryViewId: GuicosId,
    ): Promise<GuicosView<any>> {
        const prefab = await this.getPrefab(registryViewId);
        this._prefabs.assertActive();
        this._prefabs.acquire(registryViewId);
        let viewNode: Node | undefined;
        try {
            viewNode = instantiate(prefab);
            // Mount must prepare descendants before Cocos activates them on attach.
            viewNode.active = false;
            const view = viewCtor !== null ? viewNode.getComponent(viewCtor) : viewNode.getComponent(GuicosView);
            if (view === null) throw new Error(`View prefab must contain ${viewCtor?.name ?? "GuicosView"} component: ${registryViewId}`);
            this._instancePrefabIds.set(viewId, registryViewId);
            this._viewsCache.set(viewId, view);
            return view;
        } catch (error) {
            viewNode?.destroy();
            afterGuicosNodeDestruction(() => this._prefabs.relinquish(registryViewId), viewNode);
            throw error;
        }
    }

    public static loadFromPrefab<
        TRegistryComponent extends GuicosViewsRegistryComponent
    >(
        registryPrefab: Prefab,
        registryComponentType: new (...args: any[]) => TRegistryComponent,
        resourceManager: IGuicosResourceManager | null = null,
        logger: IGuicosLogger = GUICOS_NOOP_LOGGER,
    ): GuicosViewsRegistry | null {
        let registry: GuicosViewsRegistry | null = null;

        const target = instantiate(registryPrefab);
        const registryComponent = target.getComponent(registryComponentType);
        if (registryComponent === null) {
            logger.error("Failed to load views registry from prefab. " + registryPrefab.name);
        } else {
            registry = registryComponent.createRegistry(resourceManager ?? undefined, logger);
        }

        target.destroy();
        return registry;
    }
}

export abstract class GuicosViewsRegistryComponent extends Component {
    public abstract createRegistry(resourceManager?: IGuicosResourceManager, logger?: IGuicosLogger): GuicosViewsRegistry;
}
