export interface IGuicosLogger {
    log(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

export const GUICOS_NOOP_LOGGER: IGuicosLogger = {
    log: () => { },
    warn: () => { },
    error: () => { },
};
