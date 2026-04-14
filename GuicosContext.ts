export type MaybePromise<T> = T | Promise<T>;

export interface IReceiveContext<TContext> {
    setContext(context: TContext): MaybePromise<void>;
}

export interface IProvideContext<TContext> {
    getExtendedContext(): MaybePromise<TContext>;
}
