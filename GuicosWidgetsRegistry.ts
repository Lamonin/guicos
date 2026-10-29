import { Component, Node, Prefab, instantiate, _decorator } from "cc";
import { GUICOS_NOOP_LOGGER, IGuicosLogger } from "./GuicosLogger";
import { IGuicosResourceManager } from "./GuicosResourceManager";

import { afterGuicosNodeDestruction, GuicosPrefabCache, GuicosRegistryOptions } from "./GuicosPrefabCache";

const { property, ccclass } = _decorator;

export abstract class GuicosWidgetRegistryData {
    @property()
    public id: string = "";
    @property({ type: Prefab, displayOrder: 10 })
    public prefab: Prefab | null = null;
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
    private readonly cache: GuicosPrefabCache;
    private readonly instances = new Set<Node>();

    constructor(
        prefabsRegistry: GuicosWidgetRegistryData[],
        resourcesRegistry: GuicosWidgetResourceData[],
        resourceManager: IGuicosResourceManager | null = null,
        private readonly logger: IGuicosLogger = GUICOS_NOOP_LOGGER,
        options: GuicosRegistryOptions = {},
    ) {
        this.prefabsRegistry = prefabsRegistry;
        this.resourcesRegistry = resourcesRegistry;
        this.resourceManager = resourceManager;
        this.cache = new GuicosPrefabCache(options, logger);
    }

    public getPrefab(id: string): Promise<Prefab> {
        return this.cache.get(id, () => this.loadPrefab(id));
    }

    public async createWidget(id: string): Promise<Node> {
        const prefab = await this.getPrefab(id);
        this.cache.assertActive();
        this.cache.acquire(id);
        let node: Node;
        try { node = instantiate(prefab); }
        catch (error) { this.cache.relinquish(id); throw error; }
        this.instances.add(node);
        node.once(Node.EventType.NODE_DESTROYED, () => {
            this.instances.delete(node);
            afterGuicosNodeDestruction(() => this.cache.relinquish(id), node);
        });
        return node;
    }

    public destroyWidget(node: Node): void {
        if (!this.instances.has(node)) return;
        node.removeFromParent();
        node.destroy();
    }

    public releaseUnusedPrefabs(): void { this.cache.releaseUnused(); }

    /** Stop new IO immediately; existing instances remain available for unmount. */
    public stopLoading(): void { this.cache.stopLoading(); }

    public dispose(): void {
        for (const node of this.instances) this.destroyWidget(node);
        this.cache.dispose();
    }

    private async loadPrefab(id: string): Promise<Prefab> {
        const prefabData = (this.prefabsRegistry ?? []).find((entry) => entry.id === id);
        if (prefabData !== undefined) {
            if (prefabData.prefab == null) {
                throw new Error(`Widget prefab is not assigned for id: ${id}`);
            }
            return prefabData.prefab;
        }

        const resourceData = (this.resourcesRegistry ?? []).find((entry) => entry.id === id);
        if (resourceData !== undefined) {
            if (this.resourceManager === null) {
                throw new Error(`Resource manager is not assigned for widget id: ${id}`);
            }

            this.logger.log(`[GuicosWidgetsRegistry] Loading resource widget prefab. id: ${id}, path: ${resourceData.path}`);
            const prefab = await this.resourceManager.load(resourceData.path, Prefab);
            this.logger.log(`[GuicosWidgetsRegistry] Loaded resource widget prefab. id: ${id}, path: ${resourceData.path}`);
            return prefab;
        }

        throw new Error(`No widget registered with id: ${id}`);
    }

    public static loadFromPrefab(
        registryPrefab: Prefab,
        resourceManager: IGuicosResourceManager | null = null,
        logger: IGuicosLogger = GUICOS_NOOP_LOGGER,
    ): GuicosWidgetsRegistry | null {
        const target = instantiate(registryPrefab);
        const registryComponent = target.getComponent(GuicosWidgetsRegistryComponent);
        if (registryComponent === null) {
            logger.error("Failed to load widgets registry from prefab. " + registryPrefab.name);
            target.destroy();
            return null;
        }

        const registry = registryComponent.createRegistry(resourceManager ?? undefined, logger);
        target.destroy();
        return registry;
    }
}

@ccclass("GuicosWidgetsRegistryComponent")
export abstract class GuicosWidgetsRegistryComponent extends Component {
    public abstract createRegistry(resourceManager?: IGuicosResourceManager, logger?: IGuicosLogger): GuicosWidgetsRegistry;
}
