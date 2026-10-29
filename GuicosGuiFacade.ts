import { GuicosNavigationOptions } from "./GuicosCancellation";
import { GuicosGui } from "./GuicosGui";
import { GuicosEvent } from "./GuicosEvent";
import { GuicosId } from "./GuicosId";
import { IGuicosLogger } from "./GuicosLogger";
import { GuicosWidgetsRegistry } from "./GuicosWidgetsRegistry";

export interface GuicosEventPublishOptions {
    /** Opt in only for publication awaited directly by a lifecycle hook. */
    withinLifecycle?: boolean;
}

export interface IGuicosGuiFacade {
    readonly widgets: GuicosWidgetsRegistry;
    readonly logger: IGuicosLogger;
    openScreen<TContext>(screenId: GuicosId, contextOverride?: TContext, options?: GuicosNavigationOptions): Promise<void>;
    closeScreen(screenId: GuicosId): Promise<void>;
    openView<TContext>(viewId: GuicosId, contextOverride?: TContext, options?: GuicosNavigationOptions): Promise<void>;
    closeView(viewId: GuicosId): Promise<void>;
    publishEvent<TEvent extends GuicosEvent>(event: TEvent, options?: GuicosEventPublishOptions): Promise<boolean>;
}

export class GuicosGuiFacade implements IGuicosGuiFacade {
    constructor(
        private readonly runtime: GuicosGui,
        private readonly ownerScreenId: GuicosId,
        private readonly eventTargetScreenId: GuicosId | null,
        private readonly widgetsRegistry: GuicosWidgetsRegistry,
        private readonly guicosLogger: IGuicosLogger,
        private readonly transitionToken?: object,
        private readonly eventSourceIsActive?: () => boolean,
    ) { }

    public get widgets(): GuicosWidgetsRegistry {
        return this.widgetsRegistry;
    }

    public get logger(): IGuicosLogger {
        return this.guicosLogger;
    }

    public async openScreen<TContext>(screenId: GuicosId, contextOverride?: TContext, options?: GuicosNavigationOptions): Promise<void> {
        await this.runtime.openScreenFrom(this.ownerScreenId, screenId, contextOverride, options, this.transitionToken);
    }

    public async closeScreen(screenId: GuicosId): Promise<void> {
        await this.runtime.closeScreenFrom(this.ownerScreenId, screenId, this.transitionToken);
    }

    public async openView<TContext>(viewId: GuicosId, contextOverride?: TContext, options?: GuicosNavigationOptions): Promise<void> {
        await this.runtime.openViewFrom(this.ownerScreenId, viewId, contextOverride, options, this.transitionToken);
    }

    public async closeView(viewId: GuicosId): Promise<void> {
        await this.runtime.closeViewFrom(this.ownerScreenId, viewId, this.transitionToken);
    }

    public async publishEvent<TEvent extends GuicosEvent>(event: TEvent, options?: GuicosEventPublishOptions): Promise<boolean> {
        return this.runtime.publishEventToScreen(this.eventTargetScreenId, event,
            options?.withinLifecycle === true ? this.transitionToken : undefined, this.eventSourceIsActive);
    }
}
