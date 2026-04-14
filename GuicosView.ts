import { Component, _decorator } from "cc";
import { IReceiveContext, MaybePromise } from "./GuicosContext";
import { IGuicosGuiFacade } from "./GuicosGuiFacade";
import { GuicosId } from "./GuicosId";
const { ccclass } = _decorator;

export interface IGuicosView {
    get gui(): IGuicosGuiFacade;
    mount(): MaybePromise<void>;
    unmount(): MaybePromise<void>;
    show(): MaybePromise<void>;
    hide(): MaybePromise<void>;
}

@ccclass("GuicosView")
export abstract class GuicosView<TContext> extends Component implements IGuicosView, IReceiveContext<TContext> {
    private _viewId!: GuicosId;
    private _hostScreenId!: GuicosId;
    private _gui!: IGuicosGuiFacade;
    private _context!: TContext;

    public get viewId(): GuicosId { return this._viewId; }
    public get hostScreenId(): GuicosId { return this._hostScreenId; }
    public get gui(): IGuicosGuiFacade { return this._gui; }
    protected get context(): TContext { return this._context; }

    public __bindRuntime(viewId: GuicosId, hostScreenId: GuicosId, gui: IGuicosGuiFacade): void {
        this._viewId = viewId;
        this._hostScreenId = hostScreenId;
        this._gui = gui;
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
