import { IProvideContext, IReceiveContext, MaybePromise } from "./GuicosContext";
import { GuicosEvent } from "./GuicosEvent";
import { IGuicosGuiFacade } from "./GuicosGuiFacade";
import { GuicosId } from "./GuicosId";

export interface IGuicosScreen {
    set __gui(gui: IGuicosGuiFacade);
    get gui(): IGuicosGuiFacade;
    mount(): MaybePromise<void>;
    unmount(): MaybePromise<void>;
    handleEvent(event: GuicosEvent): MaybePromise<boolean>;
}

export abstract class GuicosScreen<TContext, TExtendedContext extends TContext> implements IGuicosScreen, IReceiveContext<TContext>, IProvideContext<TExtendedContext> {
    public __gui!: IGuicosGuiFacade;
    private _screenId!: GuicosId;

    public get gui(): IGuicosGuiFacade {
        return this.__gui;
    }

    private _context!: TExtendedContext;
    protected get context(): TExtendedContext { return this._context; }
    public get __screenId(): GuicosId { return this._screenId; }

    public __bindRuntime(screenId: GuicosId, gui: IGuicosGuiFacade): void {
        this._screenId = screenId;
        this.__gui = gui;
    }

    /**
     * Устанавливает контекст экрана. Может быть переопределена, если необходимо расширить контекст.
     */
    public setContext(context: TContext): MaybePromise<void> {
        this._context = context as TExtendedContext;
    }

    /**
     * Получить расширенный контекст экрана (или входной контекст если не было расширения).
     * Может быть переопределена, если необходимо выполнить действия при получении контекста извне.
     * Внутри экрана рекомендуется использовать this.context
     */
    public getExtendedContext(): MaybePromise<TExtendedContext> {
        return this.context;
    }

    public async handleEvent(event: GuicosEvent): Promise<boolean> {
        await this.onEvent(event);
        return event.isConsumed;
    }

    protected onEvent(event: GuicosEvent): MaybePromise<void> { }
    public mount(): MaybePromise<void> { }
    public unmount(): MaybePromise<void> { }
}
