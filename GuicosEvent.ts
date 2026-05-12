import { GuicosId } from "./GuicosId";

export type GuicosEventCtor<TEvent extends GuicosEvent = GuicosEvent> = (new (...args: any[]) => TEvent) & {
    readonly eventId?: GuicosId;
};

export type GuicosEmptyEvent<TId extends GuicosId = GuicosId> = GuicosEvent & {
    readonly id: TId;
};

export type GuicosEmptyEventCtor<TId extends GuicosId = GuicosId> = (new () => GuicosEmptyEvent<TId>) & {
    readonly eventId: TId;
};

export class GuicosEvent {
    private _consumed = false;

    constructor(
        public readonly id: GuicosId,
    ) { }

    public get isConsumed(): boolean {
        return this._consumed;
    }

    public consume(): void {
        this._consumed = true;
    }
}

export function defineGuicosEvent<TId extends GuicosId>(id: TId): GuicosEmptyEventCtor<TId> {
    class EmptyGuicosEvent extends GuicosEvent {
        public static readonly eventId = id;

        public constructor() {
            super(id);
        }
    }

    return EmptyGuicosEvent as GuicosEmptyEventCtor<TId>;
}
