import { instantiate, isValid, _decorator } from "cc";
import { Prefab } from "cc";
import { GuicosId } from "./GuicosId";
import { GuicosView } from "./GuicosView";
import { Component } from "cc";
import { IGuicosResourceManager } from "./GuicosResourceManager";
import { GUICOS_NOOP_LOGGER, IGuicosLogger } from "./GuicosLogger";
const { property } = _decorator;

export type GuicosViewCtor<TView extends GuicosView<any> = GuicosView<any>> = new (...args: any[]) => TView;

export abstract class GuicosPrefabViewRegistryData {
    @property()
    public id: string = "";
    @property({ type: Prefab, displayOrder: 10 })
    public prefab: Prefab = null;
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
    private readonly _prefabCache: Map<GuicosId, Prefab> = new Map<GuicosId, Prefab>();
    private readonly _pendingPrefabs: Map<GuicosId, Promise<Prefab>> = new Map<GuicosId, Promise<Prefab>>();
    private readonly prefabsRegistry: GuicosPrefabViewRegistryData[] = null;
    private readonly resourcesRegistry: GuicosResourceViewRegistryData[] = null;

    constructor(
        prefabsRegistry: GuicosPrefabViewRegistryData[],
        resourcesRegistry: GuicosResourceViewRegistryData[],
        private readonly resourceManager: IGuicosResourceManager = null,
        private readonly logger: IGuicosLogger = GUICOS_NOOP_LOGGER,
    ) {
        this.prefabsRegistry = prefabsRegistry;
        this.resourcesRegistry = resourcesRegistry;
    }

    public async getOrCreateView(
        viewId: GuicosId,
        viewCtor: GuicosViewCtor = null,
        registryViewId: GuicosId = viewId,
    ): Promise<GuicosView<any>> {
        const cachedView = this._viewsCache.get(viewId);
        if (cachedView !== undefined) {
            if (isValid(cachedView, true) && isValid(cachedView.node, true)) {
                return cachedView;
            }

            this._viewsCache.delete(viewId);
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

        if (view === undefined || !isValid(view, true) || !isValid(view.node, true)) {
            return;
        }

        view.node.removeFromParent();
        view.node.destroy();
    }

    public async preloadView(registryViewId: GuicosId): Promise<void> {
        await this.getPrefab(registryViewId);
    }

    public async getPrefab(id: GuicosId): Promise<Prefab> {
        const cachedPrefab = this._prefabCache.get(id);
        if (cachedPrefab !== undefined) {
            if (isValid(cachedPrefab, true)) {
                return cachedPrefab;
            }

            this._prefabCache.delete(id);
        }

        const pendingPrefab = this._pendingPrefabs.get(id);
        if (pendingPrefab !== undefined) {
            return await pendingPrefab;
        }

        const prefabPromise = this.loadPrefab(id);
        this._pendingPrefabs.set(id, prefabPromise);

        try {
            const prefab = await prefabPromise;
            this._prefabCache.set(id, prefab);
            return prefab;
        } finally {
            this._pendingPrefabs.delete(id);
        }
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

    private createView(viewId: GuicosId, prefab: Prefab, viewCtor: GuicosViewCtor): GuicosView<any> {
        const viewNode = instantiate(prefab);
        const view = viewCtor !== null
            ? viewNode.getComponent(viewCtor)
            : viewNode.getComponent(GuicosView);

        if (view === null) {
            viewNode.destroy();
            const componentName = viewCtor?.name ?? "GuicosView";
            throw new Error(`View prefab must contain ${componentName} component: ${viewId}`);
        }

        return view;
    }

    private async createAndCacheView(
        viewId: GuicosId,
        viewCtor: GuicosViewCtor,
        registryViewId: GuicosId,
    ): Promise<GuicosView<any>> {
        const prefab = await this.getPrefab(registryViewId);
        const view = this.createView(registryViewId, prefab, viewCtor);
        this._viewsCache.set(viewId, view);
        return view;
    }

    public static loadFromPrefab<
        TRegistryComponent extends GuicosViewsRegistryComponent
    >(
        registryPrefab: Prefab,
        registryComponentType: new (...args: any[]) => TRegistryComponent,
        resourceManager: IGuicosResourceManager = null,
        logger: IGuicosLogger = GUICOS_NOOP_LOGGER,
    ): GuicosViewsRegistry {
        let registry = null;

        const target = instantiate(registryPrefab);
        const registryComponent = target.getComponent(registryComponentType);
        if (registryComponent === null) {
            logger.error("Failed to load views registry from prefab. " + registryPrefab.name);
        } else {
            registry = registryComponent.createRegistry(resourceManager, logger);
        }

        target.destroy();
        return registry;
    }
}

export abstract class GuicosViewsRegistryComponent extends Component {
    public abstract createRegistry(resourceManager?: IGuicosResourceManager, logger?: IGuicosLogger): GuicosViewsRegistry;
}
