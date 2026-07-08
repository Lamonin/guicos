import { Component, _decorator } from "cc";
import { IReceiveContext, MaybePromise } from "./GuicosContext";
import { IGuicosGuiFacade } from "./GuicosGuiFacade";
import { GuicosId } from "./GuicosId";
import { GuicosLifecycleScope, GuicosViewLifecycleState } from "./GuicosLifecycle";
import type { IGuicosLogger } from "./GuicosLogger";
import type { GuicosWidgetsRegistry } from "./GuicosWidgetsRegistry";
const { ccclass } = _decorator;

export interface IGuicosView {
    get gui(): IGuicosGuiFacade;
    mount(): MaybePromise<void>;
    unmount(): MaybePromise<void>;
    show(): MaybePromise<void>;
    hide(): MaybePromise<void>;
}

export interface GuicosViewPreloadContext<TContext> {
    readonly context: TContext;
    readonly widgets: GuicosWidgetsRegistry;
    readonly logger: IGuicosLogger;
}

export interface IGuicosViewResourcePreloader<TContext> {
    preloadResources(context: GuicosViewPreloadContext<TContext>): MaybePromise<void>;
}

export type GuicosPreloadableViewCtor<TView extends IGuicosView = IGuicosView> =
    (new (...args: any[]) => TView)
    & Partial<IGuicosViewResourcePreloader<any>>;

@ccclass("GuicosView")
export abstract class GuicosView<TContext> extends Component implements IGuicosView, IReceiveContext<TContext> {
    private _viewId!: GuicosId;
    private _hostScreenId!: GuicosId;
    private _gui!: IGuicosGuiFacade;
    private _context!: TContext;
    private _lifecycleState: GuicosViewLifecycleState = "loading";
    private _mountScope = GuicosLifecycleScope.inactive("view:mount");
    private _visibleScope = GuicosLifecycleScope.inactive("view:visible");

    public get viewId(): GuicosId { return this._viewId; }
    public get hostScreenId(): GuicosId { return this._hostScreenId; }
    public get gui(): IGuicosGuiFacade { return this._gui; }
    public get lifecycleState(): GuicosViewLifecycleState { return this._lifecycleState; }
    protected get context(): TContext { return this._context; }
    protected get mountScope(): GuicosLifecycleScope { return this._mountScope; }
    protected get visibleScope(): GuicosLifecycleScope { return this._visibleScope; }

    public __bindRuntime(viewId: GuicosId, hostScreenId: GuicosId, gui: IGuicosGuiFacade): void {
        this._viewId = viewId;
        this._hostScreenId = hostScreenId;
        this._gui = gui;
    }

    public __setLifecycleState(state: GuicosViewLifecycleState): void {
        this._lifecycleState = state;
    }

    public __bindMountScope(scope: GuicosLifecycleScope): void {
        this._mountScope = scope;
    }

    public __clearMountScope(): void {
        this._mountScope = GuicosLifecycleScope.inactive("view:mount");
    }

    public __bindVisibleScope(scope: GuicosLifecycleScope): void {
        this._visibleScope = scope;
    }

    public __clearVisibleScope(): void {
        this._visibleScope = GuicosLifecycleScope.inactive("view:visible");
    }

    /**
     * Устанавливает контекст view. Может быть переопределена, если необходимо расширить контекст.
     */
    public setContext(context: TContext): MaybePromise<void> {
        this._context = context;
    }

    public mount(): MaybePromise<void> { }
    public unmount(): MaybePromise<void> { }
    public show(): MaybePromise<void> { }
    public hide(): MaybePromise<void> { }
}
