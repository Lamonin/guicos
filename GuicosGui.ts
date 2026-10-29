import { director, Director, isValid, Node } from "cc";
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
import { GuicosLoadOperation, GuicosNavigationOptions } from "./GuicosCancellation";
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

export interface GuicosBackgroundPreloadOptions {
    /** downloadOnly uses resourceManager.preload and never falls back to load. */
    mode?: "warm" | "downloadOnly";
    priorityViewIds?: GuicosId[];
    delayBetweenMs?: number;
    itemTimeoutMs?: number;
    canRun?: () => boolean;
    signal?: AbortSignal;
}

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
    private readonly _lifecycleTokens = new Map<object, GuicosLoadOperation | undefined>();
    private _activeLoadOperation: GuicosLoadOperation | undefined;
    private _foregroundTransitions = 0;
    private _disposed = false;
    private readonly _preloadScope = new GuicosLifecycleScope("gui:preload");
    private _disposePromise: Promise<void> | null = null;
    private _transitionQueue: Promise<void> = Promise.resolve();
    private _backgroundPreloadPromise: Promise<void> | null = null;
    private _backgroundOperation: GuicosLoadOperation | undefined;

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

    public async start<TContext>(context: TContext, options?: GuicosNavigationOptions, transitionToken?: object): Promise<void> {
        await this.runTransition(async () => {
            if (this._historyStack.length > 0) throw new Error("Guicos is already started");
            await this.preloadBlockingViews(this._hierarchy.rootId);
            this.assertNavigationActive();
            const rootScreen = this.createScreenInstance(this._hierarchy.getScreen(this._hierarchy.rootId));
            try {
                await this.withScreenFacade(rootScreen, () => rootScreen.setContext(context));
                this.assertNavigationActive();
                this._historyStack.push(rootScreen);
                rootScreen.__setLifecycleState("mounting");
                await this.withScreenFacade(rootScreen, () => rootScreen.mount());
                this.assertNavigationActive();
                rootScreen.__setLifecycleState("mounted");
            } catch (error) {
                await this.cleanupFailedScreen(rootScreen.__screenId);
                throw error;
            }
        }, transitionToken, options, true);
    }

    public startBackgroundPreload<TContext>(context: TContext, options?: GuicosBackgroundPreloadOptions): Promise<void> {
        this.assertActive();
        if (this._backgroundPreloadPromise === null) {
            this._backgroundPreloadPromise = options === undefined
                ? this.preloadViewsInBackground(this._hierarchy.getBackgroundPreloadViews(), context)
                : this.preloadViewsProgressively(context, options);
        }

        return this._backgroundPreloadPromise;
    }

    /**
     * Preloads one direct child view prefab without instantiating it or running
     * the view's optional resource preloader.
     */
    public async preloadViewPrefabFrom(hostScreenId: GuicosId, viewId: GuicosId): Promise<void> {
        this.assertActive();
        this._hierarchy.getDirectChildView(hostScreenId, viewId);
        await this._viewsRegistry.preloadView(viewId);
    }

    /**
     * Preloads one direct child view and its declared resources without opening
     * the host screen. This is useful for user-driven, predictable navigation.
     */
    public async preloadViewFrom<TContext>(
        hostScreenId: GuicosId,
        viewId: GuicosId,
        context: TContext,
    ): Promise<void> {
        this.assertActive();
        const view = this._hierarchy.getDirectChildView(hostScreenId, viewId);
        await this.preloadViewInBackground(view, context);
    }

    public async openScreen(screenId: GuicosId, contextOverride?: any, options?: GuicosNavigationOptions): Promise<void> {
        await this.runTransition(async () => {
            const token = {};
            this._lifecycleTokens.set(token, this._activeLoadOperation);
            try {
                if (this._historyStack.length === 0) {
                    if (screenId !== this._hierarchy.rootId) throw new Error(`Cannot open screen: ${screenId} without an active parent screen`);
                    await this.start(contextOverride, undefined, token);
                } else await this.openScreenFrom(this.getActiveScreenId(), screenId, contextOverride, undefined, token);
            } finally { this._lifecycleTokens.delete(token); }
        }, undefined, options, true);
    }

    public async openScreenFrom(parentScreenId: GuicosId, screenId: GuicosId, contextOverride?: any, options?: GuicosNavigationOptions, transitionToken?: object): Promise<void> {
        await this.runTransition(async () => {
            const parentScreen = this.getScreenContextSource(parentScreenId);
            const childScreen = this._hierarchy.getDirectChildScreen(parentScreenId, screenId);
            const childContext = contextOverride !== undefined
                ? contextOverride
                : await this.withScreenFacade(parentScreen, () => parentScreen.getExtendedContext());

            const openedScreen = this._screenInstances.get(screenId);
            if (openedScreen !== undefined) {
                await this.withScreenFacade(openedScreen, () => openedScreen.setContext(childContext));
                return;
            }

            await this.preloadBlockingViews(screenId);

            this.assertNavigationActive();
            const screenInstance = this.createScreenInstance(childScreen);
            try {
                await this.withScreenFacade(screenInstance, () => screenInstance.setContext(childContext));
                this.assertNavigationActive();
                this._historyStack.push(screenInstance);
                screenInstance.__setLifecycleState("mounting");
                await this.withScreenFacade(screenInstance, () => screenInstance.mount());
                this.assertNavigationActive();
                screenInstance.__setLifecycleState("mounted");
            } catch (error) {
                await this.cleanupFailedScreen(screenId);
                throw error;
            }
            this.assertNavigationActive();
            await this.closeSameSlotSiblingScreens(screenId);
        }, transitionToken, options, true);
    }

    public async closeScreen(screenId: GuicosId): Promise<void> {
        await this.runTransition(async () => {
            const token = {};
            this._lifecycleTokens.set(token, this._activeLoadOperation);
            try { await this.closeScreenFrom(this.getActiveScreenId(), screenId, token); }
            finally { this._lifecycleTokens.delete(token); }
        });
    }

    public async closeScreenFrom(parentScreenId: GuicosId, screenId: GuicosId, transitionToken?: object): Promise<void> {
        await this.runTransition(async () => {
            const actualParentScreenId = this._hierarchy.getParentScreenId(screenId);
            if (actualParentScreenId !== parentScreenId) {
                throw new Error(`Cannot close screen ${screenId} from ${parentScreenId}: screen belongs to ${actualParentScreenId}`);
            }

            if (!this._screenInstances.has(screenId)) {
                throw new Error(`Cannot close screen ${screenId}: screen not instantiated`);
            }

            await this.closeScreenBranch(screenId);
        }, transitionToken);
    }

    public async openView(viewId: GuicosId, contextOverride?: any, options?: GuicosNavigationOptions): Promise<void> {
        await this.runTransition(async () => {
            const token = {};
            this._lifecycleTokens.set(token, this._activeLoadOperation);
            try { await this.openViewFrom(this.getActiveScreenId(), viewId, contextOverride, undefined, token); }
            finally { this._lifecycleTokens.delete(token); }
        }, undefined, options, true);
    }

    public async openViewFrom(parentScreenId: GuicosId, viewId: GuicosId, contextOverride?: any, options?: GuicosNavigationOptions, transitionToken?: object): Promise<void> {
        await this.runTransition(async () => {
            const parentScreen = this.getScreenContextSource(parentScreenId);
            const childView = this._hierarchy.getDirectChildView(parentScreenId, viewId);
            const record = await this.getOrCreateViewRecord(
                this.createScopedViewKey(parentScreenId, viewId),
                childView.id,
                childView.ctor as new (...args: any[]) => GuicosView<any>,
                parentScreenId,
            );
            try {
                const revision = this.beginViewOperation(record);

                if (await this.shouldAbortViewOpen(record, revision)) {
                    return;
                }

                const childContext = contextOverride !== undefined
                    ? contextOverride
                    : await this.withScreenFacade(parentScreen, () => parentScreen.getExtendedContext());

                if (await this.shouldAbortViewOpen(record, revision)) {
                    return;
                }

                await this.withViewFacade(record, () => record.view.setContext(childContext));

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
            } catch (error) {
                try { await this.disposeViewRecord(record); }
                catch (cleanupError) { this._logger.warn("[GuicosGui] Failed view cleanup", cleanupError); }
                throw error;
            }
        }, transitionToken, options, true);
    }

    public async closeView(viewId: GuicosId): Promise<void> {
        await this.runTransition(async () => {
            const token = {};
            this._lifecycleTokens.set(token, this._activeLoadOperation);
            try { await this.closeViewFrom(this.getActiveScreenId(), viewId, token); }
            finally { this._lifecycleTokens.delete(token); }
        });
    }

    public async closeViewFrom(parentScreenId: GuicosId, viewId: GuicosId, transitionToken?: object): Promise<void> {
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
        }, transitionToken);
    }

    public async publishEventToScreen(targetScreenId: GuicosId | null, event: GuicosEvent,
        transitionToken?: object, sourceIsActive?: () => boolean): Promise<boolean> {
        if (sourceIsActive !== undefined && !sourceIsActive()) return false;
        const target = targetScreenId === null ? undefined : this._screenInstances.get(targetScreenId);
        try {
            return await this.runTransition(() => {
                // Input can enter the queue while its view is visible, then run after
                // a replacement has destroyed it or even reopened the same screen id.
                if (sourceIsActive !== undefined && !sourceIsActive()) return Promise.resolve(false);
                if (target !== undefined && this._screenInstances.get(targetScreenId!) !== target) return Promise.resolve(false);
                return this.dispatchEventToScreen(targetScreenId, event);
            }, transitionToken);
        } catch (error) {
            if (sourceIsActive !== undefined && (this._disposed || !sourceIsActive())) return false;
            throw error;
        }
    }

    private async dispatchEventToScreen(targetScreenId: GuicosId | null, event: GuicosEvent): Promise<boolean> {
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

        const isConsumed = await this.withScreenFacade(targetScreen, () => targetScreen.handleEvent(event));
        if (isConsumed) {
            return true;
        }

        const parentScreenId = this._hierarchy.getParentScreenId(targetScreenId);
        return this.dispatchEventToScreen(parentScreenId, event);
    }

    private createFacade(ownerScreenId: GuicosId, eventTargetScreenId: GuicosId | null,
        transitionToken?: object, sourceIsActive?: () => boolean): IGuicosGuiFacade {
        const owner = this._screenInstances.get(ownerScreenId);
        const guard = sourceIsActive ?? (() => this._screenInstances.get(ownerScreenId) === owner);
        const operation = transitionToken === undefined ? undefined : this._lifecycleTokens.get(transitionToken);
        const widgets = operation === undefined ? this._widgetsRegistry : this._widgetsRegistry.forOperation(operation);
        return new GuicosGuiFacade(this, ownerScreenId, eventTargetScreenId, widgets,
            this._logger, transitionToken, guard);
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

        await this.cleanupAll(screenIdsToClose.map(id => () => this.closeScreenInstance(id)));
    }

    private async cleanupAll(operations: Array<() => unknown | Promise<unknown>>): Promise<void> {
        let firstError: unknown;
        for (const operation of operations) {
            try { await operation(); } catch (error) { firstError ??= error; }
        }
        if (firstError !== undefined) throw firstError;
    }

    private async closeScreenInstance(screenId: GuicosId): Promise<void> {
        const screen = this._screenInstances.get(screenId);
        if (screen === undefined) return;
        screen.__setLifecycleState("unmounting");
        try {
            await this.cleanupAll([
                () => this.closeViewsForScreen(screenId),
                () => this.destroyCachedViewsForScreen(screenId),
                () => this.withScreenFacade(screen, () => screen.unmount()),
            ]);
        } finally {
            screen.__clearEventSubscriptions();
            screen.__setLifecycleState("disposed");
            this._screenInstances.delete(screenId);
            const index = this._historyStack.indexOf(screen);
            if (index !== -1) this._historyStack.splice(index, 1);
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

        const view = await this._viewsRegistry.getOrCreateView(scopedViewKey, viewCtor, viewId, this._activeLoadOperation) as RuntimeView;
        if (this._disposed) {
            this._viewsRegistry.destroyView(scopedViewKey);
            this.assertActive();
        }
        try { this._activeLoadOperation?.throwIfCanceled(); }
        catch (error) { this._viewsRegistry.destroyView(scopedViewKey); throw error; }
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
        view.__bindRuntime(viewId, parentScreenId, this.createFacade(parentScreenId, parentScreenId,
            undefined, () => this.isEventSourceActive(record)));
        record.view.__setLifecycleState(record.state);
        this._viewRecords.set(scopedViewKey, record);
        return record;
    }

    private beginViewOperation(record: GuicosViewRecord): number {
        record.revision++;
        return record.revision;
    }

    private async shouldAbortViewOpen(record: GuicosViewRecord, revision: number): Promise<boolean> {
        if (this._disposed || !this.isViewAlive(record.view) || !this.isScreenInstantiated(record.hostScreenId)) {
            await this.disposeViewRecord(record);
            return true;
        }

        this._activeLoadOperation?.throwIfCanceled();
        return record.revision !== revision || record.state === "disposing" || record.state === "disposed";
    }

    private async ensureViewMounted(record: GuicosViewRecord, revision: number): Promise<void> {
        this.assertNavigationActive();
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
        await this.withViewFacade(record, () => record.view.mount());

        if (record.revision !== revision || !this.isScreenInstantiated(record.hostScreenId)) {
            return;
        }

        record.state = "mounted";
        record.view.__setLifecycleState(record.state);
    }

    private async showViewRecord(record: GuicosViewRecord, revision: number): Promise<void> {
        this.assertNavigationActive();
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

        await this.withViewFacade(record, () => record.view.show());

        if (record.revision !== revision) {
            return;
        }

        record.state = "visible";
        record.view.__setLifecycleState(record.state);
    }

    private async hideViewRecord(record: GuicosViewRecord): Promise<void> {
        if (["hidden", "loading", "disposed", "disposing"].includes(record.state)) {
            this.detachOpenedView(record.key);
            return;
        }
        const revision = ++record.revision;
        record.state = "hiding";
        record.view.__setLifecycleState(record.state);
        try {
            await this.cleanupAll([
                () => this.disposeVisibleScope(record),
                () => this.isViewAlive(record.view) ? this.withViewFacade(record, () => record.view.hide()) : undefined,
            ]);
        } finally {
            if (record.revision === revision) {
                if (this.isViewAlive(record.view)) {
                    record.view.node.active = false;
                    record.view.node.removeFromParent();
                }
                this.detachOpenedView(record.key);
                record.state = "hidden";
                record.view.__setLifecycleState(record.state);
            }
        }
    }

    private async closeViewRecord(record: GuicosViewRecord): Promise<void> {
        await this.cleanupAll([
            () => this.hideViewRecord(record),
            () => this._hierarchy.getViewDisposePolicy(record.hostScreenId, record.viewId) === "disposeOnClose"
                ? this.disposeViewRecord(record) : undefined,
        ]);
    }

    private async disposeViewRecord(record: GuicosViewRecord): Promise<void> {
        if (record.state === "disposed" || record.state === "disposing") return;
        record.revision++;
        record.mountScope?.invalidate();
        record.visibleScope?.invalidate();
        const shouldHide = ["showing", "visible", "hiding"].includes(record.state);
        const shouldUnmount = record.mountScope !== null;
        record.state = "disposing";
        record.view.__setLifecycleState(record.state);
        try {
            await this.cleanupAll([
                () => this.disposeVisibleScope(record),
                () => shouldHide && this.isViewAlive(record.view)
                    ? this.withViewFacade(record, () => record.view.hide()) : undefined,
                () => shouldUnmount && this.isViewAlive(record.view)
                    ? this.withViewFacade(record, () => record.view.unmount()) : undefined,
                () => this.disposeMountScope(record),
            ]);
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

    private assertActive(): void {
        if (this._disposed) throw new Error("GuicosGui is disposed");
    }

    private assertNavigationActive(): void {
        this.assertActive();
        this._activeLoadOperation?.throwIfCanceled();
    }

    private async runTransition<T>(operation: () => Promise<T>, token?: object,
        options?: GuicosNavigationOptions, navigation = false): Promise<T> {
        // Check runtime state here, rather than an unrelated active navigation's cancellation.
        if (this._disposed) throw new Error("GuicosGui is disposed");
        const nested = token !== undefined && this._lifecycleTokens.has(token);
        const inherited = nested ? this._lifecycleTokens.get(token!) : undefined;
        const execute = async () => {
            if (this._disposed) throw new Error("GuicosGui is disposed");
            const owned = navigation && (options !== undefined || inherited === undefined)
                ? new GuicosLoadOperation(options, inherited) : undefined;
            const previous = this._activeLoadOperation;
            this._activeLoadOperation = owned ?? inherited;
            try {
                this._activeLoadOperation?.throwIfCanceled();
                return await operation();
            } finally {
                this._activeLoadOperation = previous;
                owned?.dispose();
            }
        };
        if (nested) return execute();
        this._foregroundTransitions++;
        const next = this._transitionQueue.then(execute);
        this._transitionQueue = next.then(() => {}, () => {});
        try { return await next; }
        finally { this._foregroundTransitions--; }
    }

    private async withScreenFacade<T>(screen: RuntimeScreen, operation: () => T | Promise<T>): Promise<T> {
        const token = {};
        const original = screen.gui;
        this._lifecycleTokens.set(token, this._activeLoadOperation);
        screen.__bindRuntime(screen.__screenId, this.createFacade(screen.__screenId, this._hierarchy.getParentScreenId(screen.__screenId), token));
        try { return await operation(); }
        finally {
            this._lifecycleTokens.delete(token);
            screen.__bindRuntime(screen.__screenId, original);
        }
    }

    private async withViewFacade<T>(record: GuicosViewRecord, operation: () => T | Promise<T>): Promise<T> {
        const token = {};
        const original = record.view.gui;
        this._lifecycleTokens.set(token, this._activeLoadOperation);
        record.view.__bindRuntime(record.viewId, record.hostScreenId, this.createFacade(record.hostScreenId, record.hostScreenId,
            token, () => this.isEventSourceActive(record)));
        try { return await operation(); }
        finally {
            this._lifecycleTokens.delete(token);
            record.view.__bindRuntime(record.viewId, record.hostScreenId, original);
        }
    }

    private async cleanupFailedScreen(screenId: GuicosId): Promise<void> {
        try { await this.closeScreenBranch(screenId); }
        catch (error) { this._logger.warn("[GuicosGui] Failed screen cleanup", error); }
        // setContext can fail before the screen enters the history stack.
        if (this._screenInstances.has(screenId)) {
            try { await this.closeScreenInstance(screenId); }
            catch (error) { this._logger.warn("[GuicosGui] Failed screen cleanup", error); }
        }
    }

    private isEventSourceActive(record: GuicosViewRecord): boolean {
        return this._viewRecords.get(record.key) === record && this.isViewAlive(record.view)
            && record.state !== "hidden" && record.state !== "disposing" && record.state !== "disposed";
    }

    public get isDisposed(): boolean { return this._disposed; }

    public isScreenOpen(screenId: GuicosId): boolean { return this._screenInstances.has(screenId); }

    /** Reject new work immediately; invalidate guards before awaiting hooks or IO. */
    public dispose(): Promise<void> {
        if (this._disposePromise !== null) return this._disposePromise;
        this._disposed = true;
        this._activeLoadOperation?.cancel(new Error("GuicosGui is disposed"));
        this._backgroundOperation?.cancel(new Error("GuicosGui is disposed"));
        this._preloadScope.invalidate();
        this._viewsRegistry.stopLoading();
        this._widgetsRegistry.stopLoading();
        for (const record of this._viewRecords.values()) {
            record.revision++;
            record.mountScope?.invalidate();
            record.visibleScope?.invalidate();
        }
        this._disposePromise = this._transitionQueue.then(async () => {
            let firstError: unknown;
            try { await this._preloadScope.dispose(); } catch (error) { firstError ??= error; }
            for (const id of Array.from(this._screenInstances.keys()).reverse()) {
                try { await this.closeScreenInstance(id); }
                catch (error) { firstError ??= error; }
            }
            for (const record of Array.from(this._viewRecords.values())) {
                try { await this.disposeViewRecord(record); }
                catch (error) { firstError ??= error; }
            }
            try { this._viewsRegistry.dispose(); } catch (error) { firstError ??= error; }
            try { this._widgetsRegistry.dispose(); } catch (error) { firstError ??= error; }
            if (firstError !== undefined) throw firstError;
        });
        return this._disposePromise;
    }

    private async preloadBlockingViews(screenId: GuicosId): Promise<void> {
        const viewIds = this._hierarchy.getBlockingPreloadViewIds(screenId);
        if (viewIds.length === 0) {
            return;
        }

        await Promise.all(viewIds.map(viewId => this._viewsRegistry.preloadView(viewId, this._activeLoadOperation)));
    }

    private async preloadViewsProgressively<TContext>(context: TContext, options: GuicosBackgroundPreloadOptions): Promise<void> {
        const delayMs = options.delayBetweenMs ?? 120;
        const timeoutMs = options.itemTimeoutMs ?? 15000;
        if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError("Guicos delayBetweenMs must be finite and nonnegative");
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Guicos itemTimeoutMs must be positive and finite");
        const operation = new GuicosLoadOperation({ signal: options.signal });
        this._backgroundOperation = operation;
        const views = this._hierarchy.getBackgroundPreloadViews();
        const ids = options.mode === "downloadOnly"
            ? this._viewsRegistry.getResourceViewIds() : views.map(view => view.id);
        const priority = options.priorityViewIds ?? [];
        const ordered = Array.from(new Set(priority.filter(id => ids.includes(id)).concat(ids)));
        try {
            let onDraw: (() => void) | undefined;
            const frame = new Promise<void>(resolve => { onDraw = resolve; director.once(Director.EVENT_AFTER_DRAW, onDraw); });
            try { await operation.wait(frame); }
            finally { if (onDraw !== undefined) director.off(Director.EVENT_AFTER_DRAW, onDraw); }
            for (const id of ordered) {
                // Always yield, even with delayBetweenMs=0. Foreground work can enter the queue.
                await this.backgroundDelay(delayMs, operation);
                while (this._foregroundTransitions > 0 || options.canRun?.() === false) {
                    await this.backgroundDelay(Math.max(16, delayMs), operation);
                }
                operation.throwIfCanceled();
                if (this._disposed) return;
                const item = new GuicosLoadOperation({ timeoutMs }, operation);
                try {
                    if (options.mode === "downloadOnly") await this._viewsRegistry.preloadViewDownload(id, item);
                    else {
                        const view = views.find(view => view.id === id);
                        if (view !== undefined) await this.preloadViewInBackground(view, context, item);
                    }
                } catch (error) {
                    if (operation.isCanceled) return;
                    this._logger.warn(`[GuicosGui] Failed to background preload view: ${id}`, error);
                } finally { item.dispose(); }
            }
        } catch (error) {
            if (!operation.isCanceled) throw error;
        } finally {
            operation.dispose();
            if (this._backgroundOperation === operation) this._backgroundOperation = undefined;
        }
    }

    private async backgroundDelay(ms: number, operation: GuicosLoadOperation): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await operation.wait(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })); }
        finally { if (timer !== undefined) clearTimeout(timer); }
    }

    private async preloadViewsInBackground<TContext>(views: ViewHierarchyNode[], context: TContext): Promise<void> {
        if (views.length === 0) {
            return;
        }

        let nextIndex = 0;
        const preloadNext = async () => {
            while (!this._disposed && nextIndex < views.length) {
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

    private async preloadViewInBackground<TContext>(view: ViewHierarchyNode, context: TContext, operation?: GuicosLoadOperation): Promise<void> {
        await this._viewsRegistry.preloadView(view.id, operation);
        operation?.throwIfCanceled();

        this.assertActive();
        const viewCtor = view.ctor as GuicosPreloadableViewCtor;
        if (viewCtor.preloadResources === undefined) {
            return;
        }

        const scope = operation === undefined ? this._preloadScope : new GuicosLifecycleScope(`preload:${view.id}`);
        const detach = operation?.onCancel(() => scope.invalidate());
        if (operation !== undefined) this._preloadScope.onDispose(() => scope.dispose());
        try {
            const preloading = Promise.resolve(viewCtor.preloadResources({
                context,
                widgets: operation === undefined ? this._widgetsRegistry : this._widgetsRegistry.forOperation(operation),
                logger: this._logger,
                scope,
            }));
            if (operation === undefined) await preloading;
            else await operation.wait(preloading);
        } finally {
            detach?.();
            if (operation?.isCanceled) await scope.dispose();
        }
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

        await this.cleanupAll(recordsToClose.map(record => () => this.hideViewRecord(record)));
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
        await this.cleanupAll(viewIds.map(viewId => async () => {
            const key = this.createScopedViewKey(screenId, viewId);
            const record = this._viewRecords.get(key);
            if (record !== undefined) await this.disposeViewRecord(record);
            else {
                this.detachOpenedView(key);
                this._viewsRegistry.destroyView(key);
            }
        }));
    }

    private findOpenedViewIndex(scopedViewKey: ScopedViewKey): number {
        return this._openedViewKeysByOrder.indexOf(scopedViewKey);
    }

    private createScopedViewKey(hostScreenId: GuicosId, viewId: GuicosId): ScopedViewKey {
        return `${hostScreenId}::${viewId}`;
    }
}
