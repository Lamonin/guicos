import type { MaybePromise } from "./GuicosContext";

export type GuicosViewLifecycleState =
    | "loading"
    | "mounted"
    | "showing"
    | "visible"
    | "hiding"
    | "hidden"
    | "disposing"
    | "disposed";

export type GuicosScreenLifecycleState =
    | "created"
    | "mounting"
    | "mounted"
    | "unmounting"
    | "disposed";

export type GuicosLifecycleCleanup = () => MaybePromise<void>;

export class GuicosLifecycleScope {
    private readonly cleanups: GuicosLifecycleCleanup[] = [];
    private _isActive = true;
    private _revision = 0;

    public constructor(public readonly name: string = "") { }

    public get isActive(): boolean {
        return this._isActive;
    }

    public get revision(): number {
        return this._revision;
    }

    public onDispose(cleanup: GuicosLifecycleCleanup): void {
        if (!this._isActive) {
            void cleanup();
            return;
        }

        this.cleanups.push(cleanup);
    }

    public createGuard(): GuicosLifecycleGuard {
        return new GuicosLifecycleGuard(this, this._revision);
    }

    public async dispose(): Promise<void> {
        if (!this._isActive) {
            return;
        }

        this._isActive = false;
        this._revision++;

        const errors: unknown[] = [];
        for (let index = this.cleanups.length - 1; index >= 0; index--) {
            try {
                await this.cleanups[index]();
            } catch (error: unknown) {
                errors.push(error);
            }
        }

        this.cleanups.length = 0;

        if (errors.length > 0) {
            throw errors[0];
        }
    }

    public static inactive(name = "inactive"): GuicosLifecycleScope {
        const scope = new GuicosLifecycleScope(name);
        scope._isActive = false;
        scope._revision = 1;
        return scope;
    }
}

export class GuicosLifecycleGuard {
    public constructor(
        private readonly scope: GuicosLifecycleScope,
        private readonly revision: number,
    ) { }

    public get isActive(): boolean {
        return this.scope.isActive && this.scope.revision === this.revision;
    }
}
