import { GuicosId } from "./GuicosId";
import { IGuicosScreen } from "./GuicosScreen";
import { IGuicosView } from "./GuicosView";
import { IProvideContext, IReceiveContext } from "./GuicosContext";

type ScreenCtor<TScreen extends IGuicosScreen> = new (...args: any[]) => TScreen;
type ViewCtor<TView extends IGuicosView> = new (...args: any[]) => TView;
type SlotKey = string;
type ScopedViewKey = string;

type ReceivedContext<T> =
    T extends IReceiveContext<infer C> ? C : never;

type ProvidedContext<T> =
    T extends IProvideContext<infer C> & IReceiveContext<infer Context>
        ? C extends Context
            ? C
            : never
        : never;

export interface HierarchyNode {
    id: GuicosId;
}

export interface ScreenHierarchyNode extends HierarchyNode {
    type: "screen";
    ctor: ScreenCtor<any>;
    slots: SlotHierarchyNode[];
}

export interface SlotHierarchyNode {
    type: "slot";
    name: string;
    children: Array<ViewHierarchyNode | ScreenHierarchyNode>;
}

export interface ViewHierarchyNode extends HierarchyNode {
    type: "view";
    ctor: ViewCtor<any>;
}

export interface TypedScreenHierarchyNode<
    TScreen extends IGuicosScreen & IReceiveContext<any> & IProvideContext<any>
> extends ScreenHierarchyNode {
    ctor: ScreenCtor<TScreen>;
    slots: TypedSlotHierarchyNode<ProvidedContext<TScreen>>[];
}

export interface TypedViewHierarchyNode<
    TView extends IGuicosView & IReceiveContext<any>
> extends ViewHierarchyNode {
    ctor: ViewCtor<TView>;
}

type AnyTypedScreenNode =
    TypedScreenHierarchyNode<
        IGuicosScreen & IReceiveContext<any> & IProvideContext<any>
    >;

type AnyTypedViewNode =
    TypedViewHierarchyNode<
        IGuicosView & IReceiveContext<any>
    >;

type SlotChild = AnyTypedViewNode | AnyTypedScreenNode;

type ChildContext<TChild extends SlotChild> =
    TChild extends TypedViewHierarchyNode<infer TView>
        ? ReceivedContext<TView>
        : TChild extends TypedScreenHierarchyNode<infer TScreen>
            ? ReceivedContext<TScreen>
            : never;

type WrongContext<
    TGotContext,
    TExpectedContext
> = {
    __wrongContext__: {
        got: TGotContext;
        expected: TExpectedContext;
    };
};

type CompatibleChild<
    TContext,
    TChild extends SlotChild
> = TContext extends ChildContext<TChild>
    ? TChild
    : WrongContext<
        ChildContext<TChild>,
        TContext
    >;

type CompatibleChildren<
    TContext,
    TChildren extends readonly SlotChild[]
> = {
    [K in keyof TChildren]: CompatibleChild<TContext, TChildren[K]>;
};

export interface TypedSlotHierarchyNode<TContext> extends SlotHierarchyNode {
    children: SlotChild[];
}

export function screen<
    TScreen extends IGuicosScreen & IReceiveContext<any> & IProvideContext<any>
>(
    id: GuicosId,
    ctor: ScreenCtor<TScreen>,
    slots: TypedSlotHierarchyNode<ProvidedContext<TScreen>>[] = []
): TypedScreenHierarchyNode<TScreen> {
    return { type: "screen", id, ctor, slots };
}

export function slot<
    TContext,
    TChildren extends readonly SlotChild[]
>(
    name: string,
    children: CompatibleChildren<TContext, TChildren>
): TypedSlotHierarchyNode<TContext> {
    if (name.length === 0) {
        throw new Error("Slot name must not be empty");
    }

    return { type: "slot", name, children: [...children] as SlotChild[] };
}

export function view<
    TView extends IGuicosView & IReceiveContext<any>
>(
    id: string,
    ctor: ViewCtor<TView>
): TypedViewHierarchyNode<TView> {
    return { type: "view", id, ctor };
}

export class GuicosHierarchy {
    private _hierarchy: ScreenHierarchyNode;
    private _screenLookup!: Map<GuicosId, ScreenHierarchyNode>;
    private _screenChildren!: Map<GuicosId, Map<GuicosId, ScreenHierarchyNode | ViewHierarchyNode>>;
    private _screenParents!: Map<GuicosId, GuicosId>;
    private _screenSlots!: Map<GuicosId, SlotKey>;
    private _screenIdsByParentSlot!: Map<GuicosId, Map<SlotKey, GuicosId[]>>;
    private _viewSlots!: Map<ScopedViewKey, SlotKey>;
    private _viewIdsByHostSlot!: Map<GuicosId, Map<SlotKey, GuicosId[]>>;
    private _viewOrder!: Map<ScopedViewKey, number>;

    /**
     * Id корневого экрана
     */
    public get rootId(): GuicosId {
        return this._hierarchy.id;
    }

    constructor(hierarchy: ScreenHierarchyNode) {
        this._hierarchy = hierarchy;
        this.createLookup();
    }

    private createLookup() {
        this._screenLookup = new Map<GuicosId, ScreenHierarchyNode>();
        this._screenChildren = new Map<GuicosId, Map<GuicosId, ScreenHierarchyNode | ViewHierarchyNode>>();
        this._screenParents = new Map<GuicosId, GuicosId>();
        this._screenSlots = new Map<GuicosId, SlotKey>();
        this._screenIdsByParentSlot = new Map<GuicosId, Map<SlotKey, GuicosId[]>>();
        this._viewSlots = new Map<ScopedViewKey, SlotKey>();
        this._viewIdsByHostSlot = new Map<GuicosId, Map<SlotKey, GuicosId[]>>();
        this._viewOrder = new Map<ScopedViewKey, number>();
        let nextViewOrder = 0;

        const registerNode = (
            node: ScreenHierarchyNode | ViewHierarchyNode,
            parentScreenId?: GuicosId,
            hostScreenId?: GuicosId,
            slotKey?: SlotKey,
        ) => {
            if (node.type === "screen") {
                if (this._screenLookup.has(node.id)) {
                    throw new Error(`Duplicate screen hierarchy node id: ${node.id}`);
                }

                this._screenLookup.set(node.id, node);
            }

            if (parentScreenId !== undefined) {
                this._screenParents.set(node.id, parentScreenId);

                if (node.type === "screen") {
                    if (slotKey === undefined) {
                        throw new Error(`No slot for screen: ${node.id}`);
                    }

                    this._screenSlots.set(node.id, slotKey);
                    let screenIdsBySlot = this._screenIdsByParentSlot.get(parentScreenId);
                    if (screenIdsBySlot === undefined) {
                        screenIdsBySlot = new Map<SlotKey, GuicosId[]>();
                        this._screenIdsByParentSlot.set(parentScreenId, screenIdsBySlot);
                    }

                    let screenIds = screenIdsBySlot.get(slotKey);
                    if (screenIds === undefined) {
                        screenIds = [];
                        screenIdsBySlot.set(slotKey, screenIds);
                    }

                    screenIds.push(node.id);
                }
            }

            if (hostScreenId !== undefined) {
                if (node.type === "view") {
                    if (slotKey === undefined) {
                        throw new Error(`No slot for view: ${node.id}`);
                    }

                    const scopedViewKey = this.createScopedViewKey(hostScreenId, node.id);
                    if (this._viewSlots.has(scopedViewKey)) {
                        throw new Error(`Duplicate view id: ${node.id} in screen: ${hostScreenId}`);
                    }

                    this._viewSlots.set(scopedViewKey, slotKey);
                    this._viewOrder.set(scopedViewKey, nextViewOrder++);

                    let viewIdsBySlot = this._viewIdsByHostSlot.get(hostScreenId);
                    if (viewIdsBySlot === undefined) {
                        viewIdsBySlot = new Map<SlotKey, GuicosId[]>();
                        this._viewIdsByHostSlot.set(hostScreenId, viewIdsBySlot);
                    }

                    let viewIds = viewIdsBySlot.get(slotKey);
                    if (viewIds === undefined) {
                        viewIds = [];
                        viewIdsBySlot.set(slotKey, viewIds);
                    }

                    viewIds.push(node.id);
                }
            }

            if (node.type !== "screen") {
                return;
            }

            const screenChildren = new Map<GuicosId, ScreenHierarchyNode | ViewHierarchyNode>();
            const screenSlotNames = new Set<string>();
            this._screenChildren.set(node.id, screenChildren);

            for (let slotIndex = 0; slotIndex < node.slots.length; slotIndex++) {
                const slot = node.slots[slotIndex];
                const slotKey = slot.name;

                if (screenSlotNames.has(slotKey)) {
                    throw new Error(`Duplicate slot name: ${slotKey} in screen: ${node.id}`);
                }

                screenSlotNames.add(slotKey);

                for (const child of slot.children) {
                    if (screenChildren.has(child.id)) {
                        throw new Error(`Duplicate child node id: ${child.id} in screen: ${node.id}`);
                    }

                    screenChildren.set(child.id, child);

                    if (child.type === "view") {
                        registerNode(child, undefined, node.id, slotKey);
                    } else {
                        registerNode(child, node.id, undefined, slotKey);
                    }
                }
            }
        };

        registerNode(this._hierarchy);
    }

    public getScreen(screenId: GuicosId): ScreenHierarchyNode {
        if (!this._screenLookup.has(screenId)) {
            throw new Error(`No screen with id: ${screenId} in hierarchy`);
        }

        return this._screenLookup.get(screenId)!;
    }

    public getDirectChild(parentScreenId: GuicosId, childId: GuicosId): ScreenHierarchyNode | ViewHierarchyNode {
        const screenChildren = this._screenChildren.get(parentScreenId);
        if (screenChildren === undefined) {
            throw new Error(`No screen with id: ${parentScreenId} in hierarchy`);
        }

        const child = screenChildren.get(childId);
        if (child === undefined) {
            throw new Error(`Node with id: ${childId} is not a direct child of screen: ${parentScreenId}`);
        }

        return child;
    }

    public getDirectChildScreen(parentScreenId: GuicosId, childScreenId: GuicosId): ScreenHierarchyNode {
        const child = this.getDirectChild(parentScreenId, childScreenId);
        if (child.type !== "screen") {
            throw new Error(`Node with id: ${childScreenId} is ${child.type} not a screen`);
        }

        return child;
    }

    public getDirectChildView(parentScreenId: GuicosId, viewId: GuicosId): ViewHierarchyNode {
        const child = this.getDirectChild(parentScreenId, viewId);
        if (child.type !== "view") {
            throw new Error(`Node with id: ${viewId} is ${child.type} not a view`);
        }

        return child;
    }

    public getParentScreenId(screenId: GuicosId): GuicosId | null {
        if (screenId === this.rootId) {
            return null;
        }

        const parentScreenId = this._screenParents.get(screenId);
        if (parentScreenId === undefined) {
            throw new Error(`No parent screen for screen id: ${screenId} in hierarchy`);
        }

        return parentScreenId;
    }

    public getSameSlotSiblingScreenIds(screenId: GuicosId): GuicosId[] {
        this.getScreen(screenId);

        const parentScreenId = this.getParentScreenId(screenId);
        if (parentScreenId === null) {
            return [];
        }

        const slotKey = this._screenSlots.get(screenId);
        if (slotKey === undefined) {
            throw new Error(`No slot for screen id: ${screenId}`);
        }

        const screenIdsBySlot = this._screenIdsByParentSlot.get(parentScreenId);
        const screenIds = screenIdsBySlot?.get(slotKey) ?? [];

        return screenIds.filter(siblingScreenId => siblingScreenId !== screenId);
    }

    public getSameSlotSiblingViewIds(hostScreenId: GuicosId, viewId: GuicosId): GuicosId[] {
        this.getDirectChildView(hostScreenId, viewId);

        const scopedViewKey = this.createScopedViewKey(hostScreenId, viewId);
        const slotKey = this._viewSlots.get(scopedViewKey);
        if (slotKey === undefined) {
            throw new Error(`No slot for view id: ${viewId} in screen: ${hostScreenId}`);
        }

        const viewIdsBySlot = this._viewIdsByHostSlot.get(hostScreenId);
        const viewIds = viewIdsBySlot?.get(slotKey) ?? [];

        return viewIds.filter(siblingViewId => siblingViewId !== viewId);
    }

    public isScreenDescendantOf(screenId: GuicosId, ancestorScreenId: GuicosId): boolean {
        this.getScreen(screenId);
        this.getScreen(ancestorScreenId);

        let parentScreenId = this.getParentScreenId(screenId);
        while (parentScreenId !== null) {
            if (parentScreenId === ancestorScreenId) {
                return true;
            }

            parentScreenId = this.getParentScreenId(parentScreenId);
        }

        return false;
    }

    public getViewOrder(hostScreenId: GuicosId, viewId: GuicosId): number {
        const viewOrder = this._viewOrder.get(this.createScopedViewKey(hostScreenId, viewId));
        if (viewOrder === undefined) {
            throw new Error(`No view with id: ${viewId} in screen: ${hostScreenId}`);
        }

        return viewOrder;
    }

    private createScopedViewKey(hostScreenId: GuicosId, viewId: GuicosId): ScopedViewKey {
        return `${hostScreenId}::${viewId}`;
    }
}
