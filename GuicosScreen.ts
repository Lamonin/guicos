import { IProvideContext, IReceiveContext, MaybePromise } from "./GuicosContext";
import { GuicosEvent } from "./GuicosEvent";
import {
    GUICOS_NOOP_EVENT_SUBSCRIPTION,
    GuicosEventCallback,
    GuicosEventCtor,
    GuicosEventSubscription,
    IGuicosEventSubscription,
} from "./GuicosEventSubscription";
import type { IGuicosGuiFacade } from "./GuicosGuiFacade";
import { GuicosId } from "./GuicosId";

export interface IGuicosScreen {
    set __gui(gui: IGuicosGuiFacade);
    get gui(): IGuicosGuiFacade;
    mount(): MaybePromise<void>;
    unmount(): MaybePromise<void>;
    handleEvent(event: GuicosEvent): MaybePromise<boolean>;
    __clearEventSubscriptions(): void;
}

export abstract class GuicosScreen<TContext, TExtendedContext extends TContext> implements IGuicosScreen, IReceiveContext<TContext>, IProvideContext<TExtendedContext> {
    public __gui!: IGuicosGuiFacade;
    private _screenId!: GuicosId;
    private readonly _eventSubscriptions = new Map<GuicosEventCtor<GuicosEvent>, GuicosEventSubscription<GuicosEvent>>();

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
        await this.dispatchSubscribedEvent(event);

        if (!event.isConsumed) {
            await this.onUnhandledEvent(event);
        }

        return event.isConsumed;
    }

    public __clearEventSubscriptions(): void {
        for (const subscription of this._eventSubscriptions.values()) {
            subscription.deactivate();
        }

        this._eventSubscriptions.clear();
    }

    protected onEvent<TEvent extends GuicosEvent>(
        eventCtor: GuicosEventCtor<TEvent>,
        callback: GuicosEventCallback<TEvent>,
    ): IGuicosEventSubscription {
        return this.subscribeEvent(eventCtor, callback, true);
    }

    protected onEventPassThrough<TEvent extends GuicosEvent>(
        eventCtor: GuicosEventCtor<TEvent>,
        callback: GuicosEventCallback<TEvent>,
    ): IGuicosEventSubscription {
        return this.subscribeEvent(eventCtor, callback, false);
    }

    protected onUnhandledEvent(event: GuicosEvent): MaybePromise<void> { }
    public mount(): MaybePromise<void> { }
    public unmount(): MaybePromise<void> { }

    private subscribeEvent<TEvent extends GuicosEvent>(
        eventCtor: GuicosEventCtor<TEvent>,
        callback: GuicosEventCallback<TEvent>,
        autoConsume: boolean,
    ): IGuicosEventSubscription {
        if (this._eventSubscriptions.has(eventCtor as GuicosEventCtor<GuicosEvent>)) {
            console.warn(`[GuicosScreen] Duplicate subscription for event: ${eventCtor.name}. Screen: ${this._screenId ?? this.constructor.name}.`);
            return GUICOS_NOOP_EVENT_SUBSCRIPTION;
        }

        const subscription = new GuicosEventSubscription(
            eventCtor,
            callback.bind(this) as GuicosEventCallback<TEvent>,
            autoConsume,
            this.unsubscribeEvent.bind(this),
        ) as GuicosEventSubscription<GuicosEvent>;

        this._eventSubscriptions.set(eventCtor as GuicosEventCtor<GuicosEvent>, subscription);
        return subscription;
    }

    private async dispatchSubscribedEvent(event: GuicosEvent): Promise<void> {
        for (const subscription of this._eventSubscriptions.values()) {
            const matched = await subscription.dispatch(event);
            if (matched) {
                return;
            }
        }
    }

    private unsubscribeEvent(subscription: GuicosEventSubscription<GuicosEvent>): void {
        const current = this._eventSubscriptions.get(subscription.eventCtor);
        if (current !== subscription) {
            return;
        }

        this._eventSubscriptions.delete(subscription.eventCtor);
    }
}
