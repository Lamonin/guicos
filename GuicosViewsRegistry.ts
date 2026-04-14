import { instantiate, _decorator } from "cc";
import { Prefab } from "cc";
import { GuicosId } from "./GuicosId";
import { GuicosView } from "./GuicosView";
import { Component } from "cc";
import { error } from "cc";
const { property } = _decorator;

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

    constructor(prefabsRegistry: GuicosPrefabViewRegistryData[], resourcesRegistry: GuicosResourceViewRegistryData[]) {
        this.prefabsRegistry = prefabsRegistry;
        this.resourcesRegistry = resourcesRegistry;
    }

    public getOrCreateView(viewId: GuicosId): GuicosView<any> {
        const cachedView = this._viewsCache.get(viewId);
        if (cachedView !== undefined) {
            return cachedView;
        }

        const prefabData = this.prefabsRegistry.find((entry) => entry.id === viewId);
        if (prefabData === undefined) {
            const resourceData = this.resourcesRegistry.find((entry) => entry.id === viewId);
            if (resourceData !== undefined) {
                throw new Error(`Loading view by resource is not implemented yet: ${viewId}`);
            }

            throw new Error(`No view registered with id: ${viewId}`);
        }

        if (prefabData.prefab === null) {
            throw new Error(`View prefab is not assigned for id: ${viewId}`);
        }

        const viewNode = instantiate(prefabData.prefab);
        const view = viewNode.getComponent(GuicosView);
        if (view === null) {
            viewNode.destroy();
            throw new Error(`View prefab does not contain GuicosView component: ${viewId}`);
        }

        this._viewsCache.set(viewId, view);
        return view;
    }

    public static loadFromPrefab<
        TRegistryComponent extends GuicosViewsRegistryComponent
    >(
        registryPrefab: Prefab,
        registryComponentType: new (...args: any[]) => TRegistryComponent
    ): GuicosViewsRegistry {
        let registry = null;

        const target = instantiate(registryPrefab);
        const registryComponent = target.getComponent(registryComponentType);
        if (registryComponent === null) {
            error("Failed to load views registry from prefab. " + registryPrefab.name);
        } else {
            registry = registryComponent.createRegistry();
        }

        target.destroy();
        return registry;
    }
}

export abstract class GuicosViewsRegistryComponent extends Component {
    public abstract createRegistry(): GuicosViewsRegistry;
}
