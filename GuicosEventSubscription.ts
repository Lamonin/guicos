import type { MaybePromise } from "./GuicosContext";
import { GuicosEvent } from "./GuicosEvent";

export type GuicosEventCtor<TEvent extends GuicosEvent> = new (...args: any[]) => TEvent;

export interface IGuicosEventSubscription {
    readonly isActive: boolean;
    unsubscribe(): void;
}

export type GuicosEventCallback<TEvent extends GuicosEvent> = (event: TEvent) => MaybePromise<void>;

export class GuicosEventSubscription<TEvent extends GuicosEvent> implements IGuicosEventSubscription {
    private _isActive = true;

    public constructor(
        public readonly eventCtor: GuicosEventCtor<TEvent>,
        private readonly callback: GuicosEventCallback<TEvent>,
        public readonly autoConsume: boolean,
        private readonly unsubscribeSelf: (subscription: GuicosEventSubscription<TEvent>) => void,
    ) { }

    public get isActive(): boolean {
        return this._isActive;
    }

    public async dispatch(event: GuicosEvent): Promise<boolean> {
        if (!this._isActive || !(event instanceof this.eventCtor)) {
            return false;
        }

        if (this.autoConsume) {
            event.consume();
        }

        await this.callback(event);
        return true;
    }

    public unsubscribe(): void {
        if (!this._isActive) {
            return;
        }

        this._isActive = false;
        this.unsubscribeSelf(this);
    }

    public deactivate(): void {
        this._isActive = false;
    }
}

class GuicosNoopEventSubscription implements IGuicosEventSubscription {
    public get isActive(): boolean {
        return false;
    }

    public unsubscribe(): void { }
}

export const GUICOS_NOOP_EVENT_SUBSCRIPTION: IGuicosEventSubscription = new GuicosNoopEventSubscription();
