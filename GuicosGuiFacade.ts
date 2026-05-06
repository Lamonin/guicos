import { GuicosGui } from "./GuicosGui";
import { GuicosEvent } from "./GuicosEvent";
import { GuicosId } from "./GuicosId";
import { GuicosWidgetsRegistry } from "./GuicosWidgetsRegistry";

export interface IGuicosGuiFacade {
    readonly widgets: GuicosWidgetsRegistry;
    openScreen<TContext>(screenId: GuicosId, contextOverride?: TContext): Promise<void>;
    closeScreen(screenId: GuicosId): Promise<void>;
    openView<TContext>(viewId: GuicosId, contextOverride?: TContext): Promise<void>;
    closeView(viewId: GuicosId): Promise<void>;
    publishEvent<TEvent extends GuicosEvent>(event: TEvent): Promise<boolean>;
}

export class GuicosGuiFacade implements IGuicosGuiFacade {
    constructor(
        private readonly runtime: GuicosGui,
        private readonly ownerScreenId: GuicosId,
        private readonly eventTargetScreenId: GuicosId | null,
        private readonly widgetsRegistry: GuicosWidgetsRegistry,
    ) { }

    public get widgets(): GuicosWidgetsRegistry {
        return this.widgetsRegistry;
    }

    public async openScreen<TContext>(screenId: GuicosId, contextOverride?: TContext): Promise<void> {
        await this.runtime.openScreenFrom(this.ownerScreenId, screenId, contextOverride);
    }

    public async closeScreen(screenId: GuicosId): Promise<void> {
        await this.runtime.closeScreenFrom(this.ownerScreenId, screenId);
    }

    public async openView<TContext>(viewId: GuicosId, contextOverride?: TContext): Promise<void> {
        await this.runtime.openViewFrom(this.ownerScreenId, viewId, contextOverride);
    }

    public async closeView(viewId: GuicosId): Promise<void> {
        await this.runtime.closeViewFrom(this.ownerScreenId, viewId);
    }

    public async publishEvent<TEvent extends GuicosEvent>(event: TEvent): Promise<boolean> {
        return this.runtime.publishEventToScreen(this.eventTargetScreenId, event);
    }
}
