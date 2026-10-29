export interface GuicosNavigationOptions {
    signal?: AbortSignal;
    /** Deadline for navigation load waits. Hooks are allowed to finish safely. */
    timeoutMs?: number;
}

export class GuicosNavigationCanceledError extends Error {
    public constructor(public readonly timedOut = false, message = timedOut ? "Guicos navigation timed out" : "Guicos navigation canceled") {
        super(message);
        this.name = timedOut ? "TimeoutError" : "AbortError";
    }
}

/** Cancellation of observers, never of a resource manager's shared transport. */
export class GuicosLoadOperation {
    private readonly listeners = new Set<() => void>();
    private error: Error | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly detach: Array<() => void> = [];

    public constructor(options: GuicosNavigationOptions = {}, parent?: GuicosLoadOperation) {
        if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
            throw new RangeError("Guicos timeoutMs must be positive and finite");
        }
        if (parent !== undefined) this.detach.push(parent.onCancel(() => this.cancel(parent.reason)));
        if (options.signal !== undefined) {
            const signal = options.signal;
            const abort = () => this.cancel();
            if (signal.aborted) abort();
            else { signal.addEventListener("abort", abort); this.detach.push(() => signal.removeEventListener("abort", abort)); }
        }
        if (options.timeoutMs !== undefined && !this.isCanceled) {
            this.timer = setTimeout(() => this.cancel(new GuicosNavigationCanceledError(true)), options.timeoutMs);
        }
    }

    public get isCanceled(): boolean { return this.error !== undefined; }
    public get reason(): Error { return this.error ?? new GuicosNavigationCanceledError(); }

    public throwIfCanceled(): void { if (this.error !== undefined) throw this.error; }

    public cancel(reason: Error = new GuicosNavigationCanceledError()): void {
        if (this.error !== undefined) return;
        this.error = reason;
        this.dispose();
        for (const listener of Array.from(this.listeners)) listener();
        this.listeners.clear();
    }

    public onCancel(listener: () => void): () => void {
        if (this.isCanceled) { listener(); return () => {}; }
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    public wait<T>(promise: Promise<T>): Promise<T> {
        if (this.isCanceled) return Promise.reject(this.reason);
        return new Promise<T>((resolve, reject) => {
            const detach = this.onCancel(() => reject(this.reason));
            promise.then(value => { detach(); if (this.isCanceled) reject(this.reason); else resolve(value); },
                error => { detach(); reject(error); });
        });
    }

    public dispose(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        for (const detach of this.detach.splice(0)) detach();
    }
}

/** Coalesced IO with independently cancelable readers and retry after abandonment. */
export class GuicosSharedRequest<T> {
    public readonly operation = new GuicosLoadOperation();
    private readonly promise: Promise<T>;
    private readers = 0;
    private delivered = false;
    private settled = false;
    private abandoned = false;
    private value: T | undefined;
    private hasValue = false;

    public constructor(start: (operation: GuicosLoadOperation) => Promise<T>,
        private readonly detach: () => void,
        private readonly discard?: (value: T) => void) {
        this.promise = start(this.operation);
        this.promise.then(value => {
            this.settled = true; this.value = value; this.hasValue = true;
            this.operation.dispose(); this.detach(); this.discardIfUnobserved();
        }, () => { this.settled = true; this.operation.dispose(); this.detach(); });
    }

    public async read(operation?: GuicosLoadOperation): Promise<T> {
        operation?.throwIfCanceled();
        this.readers++;
        try {
            const value = await (operation === undefined ? this.operation.wait(this.promise) : operation.wait(this.operation.wait(this.promise)));
            operation?.throwIfCanceled();
            this.delivered = true;
            return value;
        } finally {
            this.readers--;
            if (this.readers === 0 && !this.delivered) {
                this.abandoned = true;
                this.operation.cancel();
                this.detach();
                this.discardIfUnobserved();
            }
        }
    }

    public cancel(reason: Error): void { this.operation.cancel(reason); }

    private discardIfUnobserved(): void {
        if (this.abandoned && this.settled && this.hasValue) {
            this.hasValue = false;
            this.discard?.(this.value!);
        }
    }
}
