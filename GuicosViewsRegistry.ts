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

    public async getOrCreateView(viewId: GuicosId, viewCtor: GuicosViewCtor = null): Promise<GuicosView<any>> {
        const cachedView = this._viewsCache.get(viewId);
        if (cachedView !== undefined) {
            if (isValid(cachedView, true) && isValid(cachedView.node, true)) {
                return cachedView;
            }

            this._viewsCache.delete(viewId);
        }

        const prefab = await this.getPrefab(viewId);
        const view = this.createView(viewId, prefab, viewCtor);
        this._viewsCache.set(viewId, view);
        return view;
    }

    public async getPrefab(id: GuicosId): Promise<Prefab> {
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
