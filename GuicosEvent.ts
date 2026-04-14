import { GuicosId } from "./GuicosId";

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
