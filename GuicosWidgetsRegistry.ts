import { Component, Prefab, instantiate, isValid, _decorator } from "cc";
import { GUICOS_NOOP_LOGGER, IGuicosLogger } from "./GuicosLogger";
import { IGuicosResourceManager } from "./GuicosResourceManager";

const { property, ccclass } = _decorator;

export abstract class GuicosWidgetRegistryData {
    @property()
    public id: string = "";
    @property({ type: Prefab, displayOrder: 10 })
    public prefab: Prefab = null;
}

export abstract class GuicosWidgetResourceData {
    @property()
    public id: string = "";
    @property({ displayOrder: 10 })
    public path: string = "";
}

export class GuicosWidgetsRegistry {
    private readonly prefabsRegistry: GuicosWidgetRegistryData[];
    private readonly resourcesRegistry: GuicosWidgetResourceData[];
    private readonly resourceManager: IGuicosResourceManager | null;
    private readonly cache: Map<string, Prefab> = new Map();

    constructor(
        prefabsRegistry: GuicosWidgetRegistryData[],
        resourcesRegistry: GuicosWidgetResourceData[],
        resourceManager: IGuicosResourceManager | null = null,
        private readonly logger: IGuicosLogger = GUICOS_NOOP_LOGGER,
    ) {
        this.prefabsRegistry = prefabsRegistry;
        this.resourcesRegistry = resourcesRegistry;
        this.resourceManager = resourceManager;
    }

    public async getPrefab(id: string): Promise<Prefab> {
        const cached = this.cache.get(id);
        if (cached !== undefined) {
            if (isValid(cached, true)) {
                return cached;
            }
            this.cache.delete(id);
        }

        const prefabData = (this.prefabsRegistry ?? []).find((entry) => entry.id === id);
        if (prefabData !== undefined) {
            if (prefabData.prefab == null) {
                throw new Error(`Widget prefab is not assigned for id: ${id}`);
            }
            this.cache.set(id, prefabData.prefab);
            return prefabData.prefab;
        }

        const resourceData = (this.resourcesRegistry ?? []).find((entry) => entry.id === id);
        if (resourceData !== undefined) {
            if (this.resourceManager === null) {
                throw new Error(`Resource manager is not assigned for widget id: ${id}`);
            }
            const prefab = await this.resourceManager.load(resourceData.path, Prefab);
            this.cache.set(id, prefab);
            return prefab;
        }

        throw new Error(`No widget registered with id: ${id}`);
    }

    public static loadFromPrefab(
        registryPrefab: Prefab,
        resourceManager: IGuicosResourceManager | null = null,
        logger: IGuicosLogger = GUICOS_NOOP_LOGGER,
    ): GuicosWidgetsRegistry {
        const target = instantiate(registryPrefab);
        const registryComponent = target.getComponent(GuicosWidgetsRegistryComponent);
        if (registryComponent === null) {
            logger.error("Failed to load widgets registry from prefab. " + registryPrefab.name);
            target.destroy();
            return null;
        }

        const registry = registryComponent.createRegistry(resourceManager, logger);
        target.destroy();
        return registry;
    }
}

@ccclass("GuicosWidgetsRegistryComponent")
export abstract class GuicosWidgetsRegistryComponent extends Component {
    public abstract createRegistry(resourceManager?: IGuicosResourceManager, logger?: IGuicosLogger): GuicosWidgetsRegistry;
}
