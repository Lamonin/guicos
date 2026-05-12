import { isValid, Node } from "cc";
import { IProvideContext, IReceiveContext } from "./GuicosContext";
import { GuicosEvent } from "./GuicosEvent";
import { GuicosGuiFacade, IGuicosGuiFacade } from "./GuicosGuiFacade";
import { GuicosHierarchy, ScreenHierarchyNode } from "./GuicosHierarchyRegistry";
import { GuicosId } from "./GuicosId";
import { GUICOS_NOOP_LOGGER, IGuicosLogger } from "./GuicosLogger";
import { IGuicosScreen } from "./GuicosScreen";
import { GuicosView } from "./GuicosView";
import { GuicosViewsRegistry } from "./GuicosViewsRegistry";
import { GuicosWidgetsRegistry } from "./GuicosWidgetsRegistry";

type RuntimeScreen = IGuicosScreen & IReceiveContext<any> & IProvideContext<any> & {
    readonly __screenId: GuicosId;
    __bindRuntime(screenId: GuicosId, gui: IGuicosGuiFacade): void;
    handleEvent(event: GuicosEvent): Promise<boolean>;
    __clearEventSubscriptions(): void;
};

type RuntimeView = GuicosView<any> & IReceiveContext<any> & {
    readonly __hostScreenId: GuicosId;
    __bindRuntime(viewId: GuicosId, hostScreenId: GuicosId, gui: IGuicosGuiFacade): void;
};

export class GuicosGui {
    private readonly _rootNode: Node;
    private readonly _hierarchy: GuicosHierarchy;
    private readonly _viewsRegistry: GuicosViewsRegistry;
    private readonly _widgetsRegistry: GuicosWidgetsRegistry;

    private readonly _historyStack: RuntimeScreen[] = [];
    private readonly _screenInstances: Map<GuicosId, RuntimeScreen> = new Map<GuicosId, RuntimeScreen>();
    private readonly _openedViews: Map<GuicosId, RuntimeView> = new Map<GuicosId, RuntimeView>();
    private readonly _openedViewIdsByOrder: GuicosId[] = [];
    private _transitionDepth = 0;
    private _transitionQueue: Promise<void> = Promise.resolve();

    constructor(
        rootNode: Node,
        hierarchy: GuicosHierarchy,
        viewsRegistry: GuicosViewsRegistry,
        widgetsRegistry: GuicosWidgetsRegistry,
        private readonly _logger: IGuicosLogger = GUICOS_NOOP_LOGGER,
    ) {
        this._rootNode = rootNode;
        this._hierarchy = hierarchy;
        this._viewsRegistry = viewsRegistry;
        this._widgetsRegistry = widgetsRegistry;
    }

    public async start<TContext>(context: TContext): Promise<void> {
        await this.runTransition(async () => {
            const rootScreen = this.createScreenInstance(this._hierarchy.getScreen(this._hierarchy.rootId));
            await rootScreen.setContext(context);
            this._historyStack.push(rootScreen);
            await rootScreen.mount();
        });
    }

    public async openScreen(screenId: GuicosId, contextOverride?: any): Promise<void> {
        // In case start not called first
        if (this._historyStack.length === 0) {
            if (screenId !== this._hierarchy.rootId) {
                throw new Error(`Cannot open screen: ${screenId} without an active parent screen`);
            }

            await this.start(contextOverride);
            return;
        }

        await this.openScreenFrom(this.getActiveScreenId(), screenId, contextOverride);
    }

    public async openScreenFrom(parentScreenId: GuicosId, screenId: GuicosId, contextOverride?: any): Promise<void> {
        await this.runTransition(async () => {
            const parentScreen = this.getScreenContextSource(parentScreenId);
            const childScreen = this._hierarchy.getDirectChildScreen(parentScreenId, screenId);
            const childContext = contextOverride !== undefined
                ? contextOverride
                : await parentScreen.getExtendedContext();

            await this.closeSameLayerSiblingScreens(screenId);

            const openedScreen = this._screenInstances.get(screenId);
            if (openedScreen !== undefined) {
                await openedScreen.setContext(childContext);
                return;
            }

            const screenInstance = this.createScreenInstance(childScreen);
            await screenInstance.setContext(childContext);
            this._historyStack.push(screenInstance);
            await screenInstance.mount();
        });
    }

    public async closeScreen(screenId: GuicosId): Promise<void> {
        await this.closeScreenFrom(this.getActiveScreenId(), screenId);
    }

    public async closeScreenFrom(parentScreenId: GuicosId, screenId: GuicosId): Promise<void> {
        await this.runTransition(async () => {
            const actualParentScreenId = this._hierarchy.getParentScreenId(screenId);
            if (actualParentScreenId !== parentScreenId) {
                throw new Error(`Cannot close screen ${screenId} from ${parentScreenId}: screen belongs to ${actualParentScreenId}`);
            }

            if (!this._screenInstances.has(screenId)) {
                throw new Error(`Cannot close screen ${screenId}: screen not instantiated`);
            }

            await this.closeScreenBranch(screenId);
        });
    }

    public async openView(viewId: GuicosId, contextOverride?: any): Promise<void> {
        await this.openViewFrom(this.getActiveScreenId(), viewId, contextOverride);
    }

    public async openViewFrom(parentScreenId: GuicosId, viewId: GuicosId, contextOverride?: any): Promise<void> {
        await this.runTransition(async () => {
            const parentScreen = this.getScreenContextSource(parentScreenId);
            const childView = this._hierarchy.getDirectChildView(parentScreenId, viewId);
            const view = await this.getOrCreateRuntimeView(childView.id, childView.ctor, parentScreenId);
            const childContext = contextOverride !== undefined
                ? contextOverride
                : await parentScreen.getExtendedContext();

            await view.setContext(childContext);
            const openedView = this._openedViews.get(viewId);
            if (openedView !== undefined) {
                if (this.isViewMounted(openedView)) {
                    return;
                }

                this._openedViews.delete(viewId);
                this.detachOpenedView(viewId);
            }

            if (view.node.parent !== this._rootNode) {
                this._rootNode.addChild(view.node);
            }

            await view.mount();
            view.node.active = true;
            this.attachOpenedView(viewId, view);
            await view.show();
            await this.closeSameLayerSiblingViews(viewId);
        });
    }

    public async closeView(viewId: GuicosId): Promise<void> {
        await this.closeViewFrom(this.getActiveScreenId(), viewId);
    }

    public async closeViewFrom(parentScreenId: GuicosId, viewId: GuicosId): Promise<void> {
        await this.runTransition(async () => {
            this._hierarchy.getDirectChildView(parentScreenId, viewId);

            const view = this._openedViews.get(viewId);
            if (view === undefined) {
                return;
            }

            if (view.hostScreenId !== parentScreenId) {
                throw new Error(`View with id: ${viewId} belongs to screen: ${view.hostScreenId}, not: ${parentScreenId}`);
            }

            if (!this.isViewMounted(view)) {
                this._openedViews.delete(viewId);
                this.detachOpenedView(viewId);
                return;
            }

            await this.closeMountedView(viewId, view);
        });
    }

    public async publishEventToScreen(targetScreenId: GuicosId | null, event: GuicosEvent): Promise<boolean> {
        if (targetScreenId === null) {
            if (!event.isConsumed) {
                this._logger.warn(`[GuicosGui] Event was not handled: ${event.id}`);
            }

            return event.isConsumed;
        }

        const targetScreen = this._screenInstances.get(targetScreenId);
        if (targetScreen === undefined) {
            throw new Error(`Cannot publish event: target screen ${targetScreenId} is not instantiated`);
        }

        const isConsumed = await targetScreen.handleEvent(event);
        if (isConsumed) {
            return true;
        }

        const parentScreenId = this._hierarchy.getParentScreenId(targetScreenId);
        return this.publishEventToScreen(parentScreenId, event);
    }

    private createFacade(ownerScreenId: GuicosId, eventTargetScreenId: GuicosId | null): IGuicosGuiFacade {
        return new GuicosGuiFacade(this, ownerScreenId, eventTargetScreenId, this._widgetsRegistry, this._logger);
    }

    private getActiveScreenId(): GuicosId {
        return this.getActiveScreen().__screenId;
    }

    private getActiveScreen(): RuntimeScreen {
        const activeScreen = this._historyStack[this._historyStack.length - 1];
        if (activeScreen === undefined) {
            throw new Error("Cannot resolve parent screen: there is no active screen");
        }

        return activeScreen;
    }

    private getScreenContextSource(parentScreenId: GuicosId): RuntimeScreen {
        const parentScreen = this._screenInstances.get(parentScreenId);
        if (parentScreen === undefined) {
            throw new Error(`Cannot resolve parent screen: ${parentScreenId} is not opened`);
        }

        return parentScreen;
    }

    private createScreenInstance(screenNode: ScreenHierarchyNode): RuntimeScreen {
        const screenInstance = new screenNode.ctor() as RuntimeScreen;
        this._screenInstances.set(screenNode.id, screenInstance);
        screenInstance.__bindRuntime(
            screenNode.id,
            this.createFacade(screenNode.id, this._hierarchy.getParentScreenId(screenNode.id)),
        );
        return screenInstance;
    }

    private async closeSameLayerSiblingScreens(screenId: GuicosId): Promise<void> {
        const siblingScreenIds = this._hierarchy.getSameLayerSiblingScreenIds(screenId);
        for (const siblingScreenId of siblingScreenIds) {
            if (!this._screenInstances.has(siblingScreenId)) {
                continue;
            }

            await this.closeScreenBranch(siblingScreenId);
        }
    }

    private async closeSameLayerSiblingViews(viewId: GuicosId): Promise<void> {
        const siblingViewIds = this._hierarchy.getSameLayerSiblingViewIds(viewId);
        for (const siblingViewId of siblingViewIds) {
            const siblingView = this._openedViews.get(siblingViewId);
            if (siblingView === undefined) {
                continue;
            }

            await this.closeMountedView(siblingViewId, siblingView);
        }
    }

    private async closeScreenBranch(screenId: GuicosId): Promise<void> {
        const screenIdsToClose = this._historyStack
            .map(screen => screen.__screenId)
            .filter(openedScreenId =>
                openedScreenId === screenId
                || this._hierarchy.isScreenDescendantOf(openedScreenId, screenId)
            )
            .reverse();

        for (const openedScreenId of screenIdsToClose) {
            await this.closeScreenInstance(openedScreenId);
        }
    }

    private async closeScreenInstance(screenId: GuicosId): Promise<void> {
        const screen = this._screenInstances.get(screenId);
        if (screen === undefined) {
            return;
        }

        await this.closeViewsForScreen(screenId);
        await screen.unmount();
        screen.__clearEventSubscriptions();
        this._screenInstances.delete(screenId);

        const stackIndex = this._historyStack.findIndex(s => s.__screenId === screenId);
        if (stackIndex !== -1) {
            this._historyStack.splice(stackIndex, 1);
        }
    }

    private async getOrCreateRuntimeView(viewId: GuicosId, viewCtor: new (...args: any[]) => GuicosView<any>, parentScreenId: GuicosId): Promise<RuntimeView> {
        const hostScreenId = this._hierarchy.getHostScreenId(viewId);
        if (hostScreenId !== parentScreenId) {
            throw new Error(`View with id: ${viewId} belongs to screen: ${hostScreenId}, not: ${parentScreenId}`);
        }

        const view = await this._viewsRegistry.getOrCreateView(viewId, viewCtor) as RuntimeView;
        view.__bindRuntime(viewId, parentScreenId, this.createFacade(parentScreenId, parentScreenId));
        return view;
    }

    private async runTransition(operation: () => Promise<void>): Promise<void> {
        if (this._transitionDepth > 0) {
            await this.executeTransition(operation);
            return;
        }

        const next = this._transitionQueue.then(() => this.executeTransition(operation));
        this._transitionQueue = next.catch(() => { });
        await next;
    }

    private async executeTransition(operation: () => Promise<void>): Promise<void> {
        this._transitionDepth++;
        try {
            await operation();
        } finally {
            this._transitionDepth--;
        }
    }

    private attachOpenedView(viewId: GuicosId, view: RuntimeView): void {
        const insertionIndex = this.findOpenedViewInsertionIndex(viewId);
        this._openedViews.set(viewId, view);
        this._openedViewIdsByOrder.splice(insertionIndex, 0, viewId);
        view.node.setSiblingIndex(insertionIndex);
    }

    private async closeViewsForScreen(screenId: GuicosId): Promise<void> {
        const viewIdsToClose = [...this._openedViews.entries()]
            .filter(([, view]) => view.hostScreenId === screenId)
            .map(([viewId]) => viewId);

        for (const viewId of viewIdsToClose) {
            const view = this._openedViews.get(viewId);
            if (view === undefined) {
                continue;
            }

            await this.closeMountedView(viewId, view);
        }
    }

    private async closeMountedView(viewId: GuicosId, view: RuntimeView): Promise<void> {
        try {
            if (!this.isViewAlive(view)) {
                return;
            }

            await view.hide();

            if (!this.isViewAlive(view)) {
                return;
            }

            // TODO call unmount only when view destroyed
            await view.unmount();

            if (!this.isViewAlive(view)) {
                return;
            }

            view.node.active = false;
            view.node.removeFromParent();
        } finally {
            this._openedViews.delete(viewId);
            this.detachOpenedView(viewId);
        }
    }

    private isViewAlive(view: RuntimeView): boolean {
        return isValid(view, true) && isValid(view.node, true);
    }

    private isViewMounted(view: RuntimeView): boolean {
        return this.isViewAlive(view) && view.node.parent === this._rootNode;
    }

    private detachOpenedView(viewId: GuicosId): void {
        const openedViewIndex = this.findOpenedViewIndex(viewId);
        if (openedViewIndex === -1) {
            return;
        }

        this._openedViewIdsByOrder.splice(openedViewIndex, 1);
    }

    private findOpenedViewInsertionIndex(viewId: GuicosId): number {
        const targetOrder = this._hierarchy.getViewOrder(viewId);
        let left = 0;
        let right = this._openedViewIdsByOrder.length;

        while (left < right) {
            const middle = Math.floor((left + right) / 2);
            const currentOrder = this._hierarchy.getViewOrder(this._openedViewIdsByOrder[middle]);
            if (currentOrder < targetOrder) {
                left = middle + 1;
            } else {
                right = middle;
            }
        }

        return left;
    }

    private findOpenedViewIndex(viewId: GuicosId): number {
        const targetOrder = this._hierarchy.getViewOrder(viewId);
        let left = 0;
        let right = this._openedViewIdsByOrder.length - 1;

        while (left <= right) {
            const middle = Math.floor((left + right) / 2);
            const currentViewId = this._openedViewIdsByOrder[middle];
            const currentOrder = this._hierarchy.getViewOrder(currentViewId);

            if (currentOrder === targetOrder) {
                return middle;
            }

            if (currentOrder < targetOrder) {
                left = middle + 1;
            } else {
                right = middle - 1;
            }
        }

        return -1;
    }
}
