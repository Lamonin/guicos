import { isValid, Node } from "cc";
import { IProvideContext, IReceiveContext } from "./GuicosContext";
import { GuicosEvent } from "./GuicosEvent";
import { GuicosGuiFacade, IGuicosGuiFacade } from "./GuicosGuiFacade";
import { GuicosHierarchy, ScreenHierarchyNode } from "./GuicosHierarchyRegistry";
import type { ViewHierarchyNode } from "./GuicosHierarchyRegistry";
import { GuicosId } from "./GuicosId";
import { GuicosLifecycleScope, GuicosViewLifecycleState } from "./GuicosLifecycle";
import { GUICOS_NOOP_LOGGER, IGuicosLogger } from "./GuicosLogger";
import { IGuicosScreen } from "./GuicosScreen";
import { GuicosView } from "./GuicosView";
import type { GuicosPreloadableViewCtor } from "./GuicosView";
import { GuicosViewsRegistry } from "./GuicosViewsRegistry";
import { GuicosWidgetsRegistry } from "./GuicosWidgetsRegistry";

type RuntimeScreen = IGuicosScreen & IReceiveContext<any> & IProvideContext<any> & {
    readonly __screenId: GuicosId;
    __bindRuntime(screenId: GuicosId, gui: IGuicosGuiFacade): void;
    __setLifecycleState(state: "created" | "mounting" | "mounted" | "unmounting" | "disposed"): void;
    handleEvent(event: GuicosEvent): Promise<boolean>;
    __clearEventSubscriptions(): void;
};

type RuntimeView = GuicosView<any> & IReceiveContext<any> & {
    __bindRuntime(viewId: GuicosId, hostScreenId: GuicosId, gui: IGuicosGuiFacade): void;
    __setLifecycleState(state: GuicosViewLifecycleState): void;
    __bindMountScope(scope: GuicosLifecycleScope): void;
    __clearMountScope(): void;
    __bindVisibleScope(scope: GuicosLifecycleScope): void;
    __clearVisibleScope(): void;
};

type ScopedViewKey = string;
const BACKGROUND_PRELOAD_CONCURRENCY = 2;

interface GuicosViewRecord {
    readonly key: ScopedViewKey;
    readonly viewId: GuicosId;
    readonly hostScreenId: GuicosId;
    readonly view: RuntimeView;
    state: GuicosViewLifecycleState;
    revision: number;
    mountScope: GuicosLifecycleScope | null;
    visibleScope: GuicosLifecycleScope | null;
}

export class GuicosGui {
    private readonly _rootNode: Node;
    private readonly _hierarchy: GuicosHierarchy;
    private readonly _viewsRegistry: GuicosViewsRegistry;
    private readonly _widgetsRegistry: GuicosWidgetsRegistry;

    private readonly _historyStack: RuntimeScreen[] = [];
    private readonly _screenInstances: Map<GuicosId, RuntimeScreen> = new Map<GuicosId, RuntimeScreen>();
    private readonly _viewRecords: Map<ScopedViewKey, GuicosViewRecord> = new Map<ScopedViewKey, GuicosViewRecord>();
    private readonly _openedViewKeysByOrder: ScopedViewKey[] = [];
    private _transitionDepth = 0;
    private _transitionQueue: Promise<void> = Promise.resolve();
    private _backgroundPreloadPromise: Promise<void> | null = null;

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
            await this.preloadBlockingViews(this._hierarchy.rootId);
            const rootScreen = this.createScreenInstance(this._hierarchy.getScreen(this._hierarchy.rootId));
            await rootScreen.setContext(context);
            this._historyStack.push(rootScreen);
            rootScreen.__setLifecycleState("mounting");
            await rootScreen.mount();
            rootScreen.__setLifecycleState("mounted");
        });

        this.startBackgroundPreload(context);
    }

    public async openScreen(screenId: GuicosId, contextOverride?: any): Promise<void> {
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

            await this.closeSameSlotSiblingScreens(screenId);

            const openedScreen = this._screenInstances.get(screenId);
            if (openedScreen !== undefined) {
                await openedScreen.setContext(childContext);
                return;
            }

            await this.preloadBlockingViews(screenId);

            const screenInstance = this.createScreenInstance(childScreen);
            await screenInstance.setContext(childContext);
            this._historyStack.push(screenInstance);
            screenInstance.__setLifecycleState("mounting");
            await screenInstance.mount();
            screenInstance.__setLifecycleState("mounted");
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
            const record = await this.getOrCreateViewRecord(
                this.createScopedViewKey(parentScreenId, viewId),
                childView.id,
                childView.ctor as new (...args: any[]) => GuicosView<any>,
                parentScreenId,
            );
            const revision = this.beginViewOperation(record);

            if (await this.shouldAbortViewOpen(record, revision)) {
                return;
            }

            const childContext = contextOverride !== undefined
                ? contextOverride
                : await parentScreen.getExtendedContext();

            if (await this.shouldAbortViewOpen(record, revision)) {
                return;
            }

            await record.view.setContext(childContext);

            if (await this.shouldAbortViewOpen(record, revision)) {
                return;
            }

            await this.ensureViewMounted(record, revision);

            if (await this.shouldAbortViewOpen(record, revision)) {
                return;
            }

            await this.showViewRecord(record, revision);

            if (await this.shouldAbortViewOpen(record, revision)) {
                return;
            }

            await this.closeSameSlotSiblingViews(parentScreenId, viewId);
        });
    }

    public async closeView(viewId: GuicosId): Promise<void> {
        await this.closeViewFrom(this.getActiveScreenId(), viewId);
    }

    public async closeViewFrom(parentScreenId: GuicosId, viewId: GuicosId): Promise<void> {
        await this.runTransition(async () => {
            this._hierarchy.getDirectChildView(parentScreenId, viewId);
            const scopedViewKey = this.createScopedViewKey(parentScreenId, viewId);

            const record = this._viewRecords.get(scopedViewKey);
            if (record === undefined) {
                return;
            }

            if (record.hostScreenId !== parentScreenId) {
                throw new Error(`View with id: ${viewId} belongs to screen: ${record.hostScreenId}, not: ${parentScreenId}`);
            }

            await this.closeViewRecord(record);
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

    private isScreenInstantiated(screenId: GuicosId): boolean {
        return this._screenInstances.has(screenId);
    }

    private createScreenInstance(screenNode: ScreenHierarchyNode): RuntimeScreen {
        const screenInstance = new screenNode.ctor() as RuntimeScreen;
        this._screenInstances.set(screenNode.id, screenInstance);
        screenInstance.__bindRuntime(
            screenNode.id,
            this.createFacade(screenNode.id, this._hierarchy.getParentScreenId(screenNode.id)),
        );
        screenInstance.__setLifecycleState("created");
        return screenInstance;
    }

    private async closeSameSlotSiblingScreens(screenId: GuicosId): Promise<void> {
        const siblingScreenIds = this._hierarchy.getSameSlotSiblingScreenIds(screenId);
        for (const siblingScreenId of siblingScreenIds) {
            if (!this._screenInstances.has(siblingScreenId)) {
                continue;
            }

            await this.closeScreenBranch(siblingScreenId);
        }
    }

    private async closeSameSlotSiblingViews(hostScreenId: GuicosId, viewId: GuicosId): Promise<void> {
        const siblingViewIds = this._hierarchy.getSameSlotSiblingViewIds(hostScreenId, viewId);
        for (const siblingViewId of siblingViewIds) {
            const scopedSiblingViewKey = this.createScopedViewKey(hostScreenId, siblingViewId);
            const siblingRecord = this._viewRecords.get(scopedSiblingViewKey);
            if (siblingRecord === undefined) {
                continue;
            }

            await this.closeViewRecord(siblingRecord);
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

        screen.__setLifecycleState("unmounting");
        await this.closeViewsForScreen(screenId);
        await this.destroyCachedViewsForScreen(screenId);
        await screen.unmount();
        screen.__clearEventSubscriptions();
        screen.__setLifecycleState("disposed");
        this._screenInstances.delete(screenId);

        const stackIndex = this._historyStack.findIndex(s => s.__screenId === screenId);
        if (stackIndex !== -1) {
            this._historyStack.splice(stackIndex, 1);
        }
    }

    private async getOrCreateViewRecord(
        scopedViewKey: ScopedViewKey,
        viewId: GuicosId,
        viewCtor: new (...args: any[]) => GuicosView<any>,
        parentScreenId: GuicosId,
    ): Promise<GuicosViewRecord> {
        const cachedRecord = this._viewRecords.get(scopedViewKey);
        if (cachedRecord !== undefined && cachedRecord.state !== "disposed" && this.isViewAlive(cachedRecord.view)) {
            return cachedRecord;
        }

        if (cachedRecord !== undefined) {
            this._viewRecords.delete(scopedViewKey);
            this.detachOpenedView(scopedViewKey);
        }

        const view = await this._viewsRegistry.getOrCreateView(scopedViewKey, viewCtor, viewId) as RuntimeView;
        view.__bindRuntime(viewId, parentScreenId, this.createFacade(parentScreenId, parentScreenId));

        const record: GuicosViewRecord = {
            key: scopedViewKey,
            viewId,
            hostScreenId: parentScreenId,
            view,
            state: "loading",
            revision: 0,
            mountScope: null,
            visibleScope: null,
        };
        record.view.__setLifecycleState(record.state);
        this._viewRecords.set(scopedViewKey, record);
        return record;
    }

    private beginViewOperation(record: GuicosViewRecord): number {
        record.revision++;
        return record.revision;
    }

    private async shouldAbortViewOpen(record: GuicosViewRecord, revision: number): Promise<boolean> {
        if (!this.isViewAlive(record.view) || !this.isScreenInstantiated(record.hostScreenId)) {
            await this.disposeViewRecord(record);
            return true;
        }

        return record.revision !== revision || record.state === "disposing" || record.state === "disposed";
    }

    private async ensureViewMounted(record: GuicosViewRecord, revision: number): Promise<void> {
        if (record.state !== "loading") {
            if (record.view.node.parent !== this._rootNode) {
                this._rootNode.addChild(record.view.node);
            }
            return;
        }

        if (record.view.node.parent !== this._rootNode) {
            this._rootNode.addChild(record.view.node);
        }

        record.mountScope = new GuicosLifecycleScope(`${record.key}:mount`);
        record.view.__bindMountScope(record.mountScope);
        record.state = "mounted";
        record.view.__setLifecycleState(record.state);
        await record.view.mount();

        if (record.revision !== revision || !this.isScreenInstantiated(record.hostScreenId)) {
            return;
        }

        record.state = "mounted";
        record.view.__setLifecycleState(record.state);
    }

    private async showViewRecord(record: GuicosViewRecord, revision: number): Promise<void> {
        if (record.state === "visible") {
            this.attachOpenedView(record);
            return;
        }

        if (record.state === "showing") {
            return;
        }

        if (record.view.node.parent !== this._rootNode) {
            this._rootNode.addChild(record.view.node);
        }

        record.visibleScope = new GuicosLifecycleScope(`${record.key}:visible:${revision}`);
        record.view.__bindVisibleScope(record.visibleScope);
        record.state = "showing";
        record.view.__setLifecycleState(record.state);
        record.view.node.active = true;
        this.attachOpenedView(record);

        await record.view.show();

        if (record.revision !== revision) {
            return;
        }

        record.state = "visible";
        record.view.__setLifecycleState(record.state);
    }

    private async hideViewRecord(record: GuicosViewRecord): Promise<void> {
        if (record.state === "hidden" || record.state === "loading" || record.state === "disposed" || record.state === "disposing") {
            this.detachOpenedView(record.key);
            return;
        }

        const revision = ++record.revision;
        record.state = "hiding";
        record.view.__setLifecycleState(record.state);

        try {
            await this.disposeVisibleScope(record);

            if (this.isViewAlive(record.view)) {
                await record.view.hide();
            }

            if (record.revision === revision && this.isViewAlive(record.view)) {
                record.view.node.active = false;
                record.view.node.removeFromParent();
            }
        } finally {
            if (record.revision === revision) {
                this.detachOpenedView(record.key);
            }

            if (record.revision === revision) {
                record.state = "hidden";
                record.view.__setLifecycleState(record.state);
            }
        }
    }

    private async closeViewRecord(record: GuicosViewRecord): Promise<void> {
        await this.hideViewRecord(record);

        if (this._hierarchy.getViewDisposePolicy(record.hostScreenId, record.viewId) === "disposeOnClose") {
            await this.disposeViewRecord(record);
        }
    }

    private async disposeViewRecord(record: GuicosViewRecord): Promise<void> {
        if (record.state === "disposed" || record.state === "disposing") {
            return;
        }

        record.revision++;

        if (record.state === "showing" || record.state === "visible" || record.state === "hiding") {
            await this.hideViewRecord(record);
        }

        const shouldUnmount = record.mountScope !== null && record.state !== "loading";
        record.state = "disposing";
        record.view.__setLifecycleState(record.state);

        try {
            await this.disposeVisibleScope(record);

            try {
                if (shouldUnmount && this.isViewAlive(record.view)) {
                    await record.view.unmount();
                }
            } finally {
                await this.disposeMountScope(record);
            }
        } finally {
            this.detachOpenedView(record.key);
            this._viewRecords.delete(record.key);
            this._viewsRegistry.destroyView(record.key);
            record.state = "disposed";
            record.view.__setLifecycleState(record.state);
        }
    }

    private async disposeVisibleScope(record: GuicosViewRecord): Promise<void> {
        const visibleScope = record.visibleScope;
        record.visibleScope = null;
        record.view.__clearVisibleScope();

        if (visibleScope !== null) {
            await visibleScope.dispose();
        }
    }

    private async disposeMountScope(record: GuicosViewRecord): Promise<void> {
        const mountScope = record.mountScope;
        record.mountScope = null;
        record.view.__clearMountScope();

        if (mountScope !== null) {
            await mountScope.dispose();
        }
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

    private async preloadBlockingViews(screenId: GuicosId): Promise<void> {
        const viewIds = this._hierarchy.getBlockingPreloadViewIds(screenId);
        if (viewIds.length === 0) {
            return;
        }

        await Promise.all(viewIds.map(viewId => this._viewsRegistry.preloadView(viewId)));
    }

    private startBackgroundPreload<TContext>(context: TContext): void {
        if (this._backgroundPreloadPromise !== null) {
            return;
        }

        const views = this._hierarchy.getBackgroundPreloadViews();
        this._backgroundPreloadPromise = this.preloadViewsInBackground(views, context);
    }

    private async preloadViewsInBackground<TContext>(views: ViewHierarchyNode[], context: TContext): Promise<void> {
        if (views.length === 0) {
            return;
        }

        let nextIndex = 0;
        const preloadNext = async () => {
            while (nextIndex < views.length) {
                const view = views[nextIndex++];
                try {
                    await this.preloadViewInBackground(view, context);
                } catch (error: unknown) {
                    this._logger.warn(`[GuicosGui] Failed to background preload view: ${view.id}`, error);
                }
            }
        };

        const workerCount = Math.min(BACKGROUND_PRELOAD_CONCURRENCY, views.length);
        const workers = Array.from({ length: workerCount }, () => preloadNext());
        await Promise.all(workers);
    }

    private async preloadViewInBackground<TContext>(view: ViewHierarchyNode, context: TContext): Promise<void> {
        await this._viewsRegistry.preloadView(view.id);

        const viewCtor = view.ctor as GuicosPreloadableViewCtor;
        if (viewCtor.preloadResources === undefined) {
            return;
        }

        await viewCtor.preloadResources({
            context,
            widgets: this._widgetsRegistry,
            logger: this._logger,
        });
    }

    private attachOpenedView(record: GuicosViewRecord): void {
        this.pruneOpenedViews();
        this.detachOpenedView(record.key);
        const insertionIndex = this.findOpenedViewInsertionIndex(record.hostScreenId, record.viewId);
        this._openedViewKeysByOrder.splice(insertionIndex, 0, record.key);
        record.view.node.setSiblingIndex(insertionIndex);
    }

    private async closeViewsForScreen(screenId: GuicosId): Promise<void> {
        this.pruneOpenedViews();
        const recordsToClose: GuicosViewRecord[] = [];

        for (const record of this._viewRecords.values()) {
            if (record.hostScreenId === screenId) {
                recordsToClose.push(record);
            }
        }

        for (const record of recordsToClose) {
            await this.hideViewRecord(record);
        }
    }

    private isViewAlive(view: RuntimeView): boolean {
        return isValid(view, true) && isValid(view.node, true);
    }

    private detachOpenedView(scopedViewKey: ScopedViewKey): void {
        const openedViewIndex = this.findOpenedViewIndex(scopedViewKey);
        if (openedViewIndex === -1) {
            return;
        }

        this._openedViewKeysByOrder.splice(openedViewIndex, 1);
    }

    private findOpenedViewInsertionIndex(hostScreenId: GuicosId, viewId: GuicosId): number {
        const targetOrder = this._hierarchy.getViewOrder(hostScreenId, viewId);
        let left = 0;
        let right = this._openedViewKeysByOrder.length;

        while (left < right) {
            const middle = Math.floor((left + right) / 2);
            const currentRecord = this._viewRecords.get(this._openedViewKeysByOrder[middle]);
            if (currentRecord === undefined) {
                break;
            }

            const currentOrder = this._hierarchy.getViewOrder(currentRecord.hostScreenId, currentRecord.viewId);
            if (currentOrder < targetOrder) {
                left = middle + 1;
            } else {
                right = middle;
            }
        }

        return left;
    }

    private pruneOpenedViews(): void {
        for (let index = this._openedViewKeysByOrder.length - 1; index >= 0; index--) {
            const scopedViewKey = this._openedViewKeysByOrder[index];
            const record = this._viewRecords.get(scopedViewKey);
            if (record !== undefined && this.isViewAlive(record.view) && (record.state === "showing" || record.state === "visible")) {
                continue;
            }

            this._openedViewKeysByOrder.splice(index, 1);
        }
    }

    private async destroyCachedViewsForScreen(screenId: GuicosId): Promise<void> {
        const viewIds = this._hierarchy.getDirectChildViewIds(screenId);
        for (const viewId of viewIds) {
            const scopedViewKey = this.createScopedViewKey(screenId, viewId);
            const record = this._viewRecords.get(scopedViewKey);
            if (record !== undefined) {
                await this.disposeViewRecord(record);
                continue;
            }

            this.detachOpenedView(scopedViewKey);
            this._viewsRegistry.destroyView(scopedViewKey);
        }
    }

    private findOpenedViewIndex(scopedViewKey: ScopedViewKey): number {
        return this._openedViewKeysByOrder.indexOf(scopedViewKey);
    }

    private createScopedViewKey(hostScreenId: GuicosId, viewId: GuicosId): ScopedViewKey {
        return `${hostScreenId}::${viewId}`;
    }
}
