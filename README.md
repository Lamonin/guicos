# Guicos

Guicos is a small UI orchestration library for Cocos Creator projects. It
organizes UI into screens, views, widgets, registries, and typed events:

- A screen is a controller for a UI state or route.
- A view is a Cocos `Component` mounted from a prefab and shown inside a screen.
- A widget is a reusable prefab loaded through the widget registry.
- A hierarchy declares which screens and views may be opened from each screen.
- A UI event is published by a view and handled by the nearest screen that cares.

The library is designed to keep reusable UI flow in Guicos while leaving project
business decisions in application code.

## Public Entry Point

Most consumers can import from the barrel file:

```ts
import {
    GuicosEvent,
    GuicosGui,
    GuicosHierarchy,
    GuicosScreen,
    GuicosView,
    GuicosViewsRegistry,
    GuicosWidgetsRegistry,
    defineGuicosEvent,
    screen,
    slot,
    view,
} from "game/guicos/Guicos";
```

If your project uses another path alias, point it at the folder that contains
`Guicos.ts`.

## Core Concepts

### Context

Every screen and view receives a context object. The root screen receives the
context passed to `gui.start(context)`. Child screens and views receive the
context returned by their parent screen's `getExtendedContext()`, unless the
caller passes an explicit context override to `openScreen` or `openView`.

```ts
export interface AppContext {
    readonly userName: string;
    readonly settings: {
        musicEnabled: boolean;
    };
}
```

### Events

Use `defineGuicosEvent` for payload-free events and extend `GuicosEvent` when an
event needs data.

```ts
import { GuicosEvent, defineGuicosEvent } from "game/guicos/Guicos";

export const SettingsRequestedEvent = defineGuicosEvent("settings_requested");
export type SettingsRequestedEvent = InstanceType<typeof SettingsRequestedEvent>;

export class ProfileSelectedEvent extends GuicosEvent {
    public constructor(public readonly profileId: string) {
        super("profile_selected");
    }
}
```

Screens subscribe with `onEvent` or `onEventPassThrough`:

- `onEvent` consumes the event after the handler runs.
- `onEventPassThrough` runs the handler and lets the event bubble to parent
  screens.
- Unhandled events bubble from the active screen toward the root screen.

## Define Screens

Screens are plain TypeScript classes. They own flow decisions and open views.

```ts
import { MaybePromise, GuicosScreen } from "game/guicos/Guicos";
import { SettingsRequestedEvent } from "./events/SettingsRequestedEvent";
import { ViewId } from "./UiIds";
import type { AppContext } from "./AppContext";

export class HomeScreen extends GuicosScreen<AppContext, AppContext> {
    private readonly settingsRequested = this.onEvent(
        SettingsRequestedEvent,
        this.handleSettingsRequested,
    );

    public override async mount(): Promise<void> {
        await this.gui.openView(ViewId.Home);
    }

    public override unmount(): MaybePromise<void> {
        this.settingsRequested.unsubscribe();
    }

    private async handleSettingsRequested(): Promise<void> {
        await this.gui.openView(ViewId.Settings);
    }
}

export class SettingsScreen extends GuicosScreen<AppContext, AppContext> {
    public override async mount(): Promise<void> {
        await this.gui.openView(ViewId.Settings);
    }
}
```

`GuicosScreen<TContext, TExtendedContext>` can narrow or extend context for child
nodes by overriding `getExtendedContext()`.

```ts
interface RootContext {
    readonly sessionId: string;
}

interface MenuContext extends RootContext {
    readonly menuOpenedAt: number;
}

export class RootScreen extends GuicosScreen<RootContext, MenuContext> {
    public override getExtendedContext(): MenuContext {
        return {
            ...this.context,
            menuOpenedAt: Date.now(),
        };
    }
}
```

## Define Views

Views are Cocos components mounted from prefabs. Use `mount` for one-time setup,
`show` for visible-state setup, `hide` for visible-state cleanup, and `unmount`
for final cleanup.

```ts
import { _decorator, Button, Label } from "cc";
import { GuicosView } from "game/guicos/Guicos";
import { SettingsRequestedEvent } from "./events/SettingsRequestedEvent";
import type { AppContext } from "./AppContext";

const { ccclass, property } = _decorator;

@ccclass("HomeView")
export class HomeView extends GuicosView<AppContext> {
    @property({ type: Label })
    private titleLabel: Label | null = null;

    @property({ type: Button })
    private settingsButton: Button | null = null;

    public override show(): void {
        if (this.titleLabel !== null) {
            this.titleLabel.string = `Welcome, ${this.context.userName}`;
        }

        this.settingsButton?.click.on(this.openSettings, this);
    }

    public override hide(): void {
        this.settingsButton?.click.off(this.openSettings, this);
    }

    private async openSettings(): Promise<void> {
        await this.gui.publishEvent(new SettingsRequestedEvent());
    }
}
```

Use `mountScope` and `visibleScope` when async work must stop after a view is
closed or disposed.

```ts
public override async show(): Promise<void> {
    const guard = this.visibleScope.createGuard();
    const avatar = await this.context.avatarService.loadCurrentAvatar();

    if (!guard.isActive) {
        return;
    }

    this.renderAvatar(avatar);
}
```

## Declare The Hierarchy

The hierarchy is the routing map. A screen may contain named slots. Each slot
contains child screens or direct child views.

Views or screens in the same slot are mutually exclusive: opening one closes its
siblings in that slot.

```ts
import { GuicosHierarchy, screen, slot, view } from "game/guicos/Guicos";
import { AppScreen } from "./screens/AppScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { HomeView } from "./views/HomeView";
import { SettingsView } from "./views/SettingsView";
import { ScreenId, ViewId } from "./UiIds";

export const hierarchy = new GuicosHierarchy(
    screen(ScreenId.App, AppScreen, [
        slot("content", [
            screen(ScreenId.Home, HomeScreen, [
                slot("main", [
                    view(ViewId.Home, HomeView),
                ]),
                slot("modal", [
                    view(ViewId.Settings, SettingsView, {
                        disposePolicy: "disposeOnClose",
                    }),
                ]),
            ], {
                preloadViews: [ViewId.Home],
            }),
            screen(ScreenId.Settings, SettingsScreen, [
                slot("main", [
                    view(ViewId.Settings, SettingsView),
                ]),
            ]),
        ]),
    ]),
);
```

### Hierarchy Options

`GuicosHierarchy` accepts a root screen and optional hierarchy options:

```ts
export const hierarchy = new GuicosHierarchy(rootScreen, {
    backgroundPreload: true,
});
```

Useful options:

- `preloadViews`: direct child view ids to load before a screen mounts.
- `backgroundPreload`: enables or disables background prefab preloading.
- `excludeBackgroundPreloadViews`: excludes selected direct child views from a
  screen's background preload queue.
- `disposePolicy: "disposeWithScreen"` keeps a hidden view instance cached until
  its host screen is disposed.
- `disposePolicy: "disposeOnClose"` destroys the view instance each time it is
  closed.

## Register View Prefabs

Guicos creates views from prefabs. A registry can contain direct prefab
references, resource paths, or both.

```ts
import { Enum, _decorator } from "cc";
import {
    GUICOS_NOOP_LOGGER,
    GuicosPrefabViewRegistryData,
    GuicosResourceViewRegistryData,
    GuicosViewsRegistry,
    GuicosViewsRegistryComponent,
    IGuicosLogger,
    IGuicosResourceManager,
} from "game/guicos/Guicos";
import { ViewId } from "./UiIds";

const { ccclass, property } = _decorator;

@ccclass("ViewPrefabData")
class ViewPrefabData extends GuicosPrefabViewRegistryData {
    @property({ type: Enum(ViewId) })
    public override id: ViewId = ViewId.Home;
}

@ccclass("ViewResourceData")
class ViewResourceData extends GuicosResourceViewRegistryData {
    @property({ type: Enum(ViewId) })
    public override id: ViewId = ViewId.Home;
}

@ccclass("ViewsRegistryConfig")
export class ViewsRegistryConfig extends GuicosViewsRegistryComponent {
    @property({ type: ViewPrefabData })
    private prefabs: ViewPrefabData[] = [];

    @property({ type: ViewResourceData })
    private resources: ViewResourceData[] = [];

    public override createRegistry(
        resourceManager: IGuicosResourceManager,
        logger: IGuicosLogger = GUICOS_NOOP_LOGGER,
    ): GuicosViewsRegistry {
        return new GuicosViewsRegistry(
            this.prefabs,
            this.resources,
            resourceManager,
            logger,
        );
    }
}
```

Each view prefab must contain the matching `GuicosView` subclass component.

## Register Widget Prefabs

Widgets are reusable prefabs that views can request through `this.gui.widgets`.
Guicos does not instantiate widgets for you; it loads and caches their prefabs.

```ts
import { instantiate } from "cc";
import { GuicosView } from "game/guicos/Guicos";
import { WidgetId } from "./UiIds";
import type { AppContext } from "./AppContext";

export class InventoryView extends GuicosView<AppContext> {
    public override async show(): Promise<void> {
        const itemPrefab = await this.gui.widgets.getPrefab(WidgetId.InventoryItem);
        const itemNode = instantiate(itemPrefab);
        itemNode.setParent(this.node);
    }
}
```

Widget registries are configured the same way as view registries:

```ts
import { Enum, _decorator } from "cc";
import {
    GUICOS_NOOP_LOGGER,
    GuicosWidgetRegistryData,
    GuicosWidgetResourceData,
    GuicosWidgetsRegistry,
    GuicosWidgetsRegistryComponent,
    IGuicosLogger,
    IGuicosResourceManager,
} from "game/guicos/Guicos";
import { WidgetId } from "./UiIds";

const { ccclass, property } = _decorator;

@ccclass("WidgetPrefabData")
class WidgetPrefabData extends GuicosWidgetRegistryData {
    @property({ type: Enum(WidgetId) })
    public override id: WidgetId = WidgetId.InventoryItem;
}

@ccclass("WidgetResourceData")
class WidgetResourceData extends GuicosWidgetResourceData {
    @property({ type: Enum(WidgetId) })
    public override id: WidgetId = WidgetId.InventoryItem;
}

@ccclass("WidgetsRegistryConfig")
export class WidgetsRegistryConfig extends GuicosWidgetsRegistryComponent {
    @property({ type: WidgetPrefabData })
    private prefabs: WidgetPrefabData[] = [];

    @property({ type: WidgetResourceData })
    private resources: WidgetResourceData[] = [];

    public override createRegistry(
        resourceManager: IGuicosResourceManager | null,
        logger: IGuicosLogger = GUICOS_NOOP_LOGGER,
    ): GuicosWidgetsRegistry {
        return new GuicosWidgetsRegistry(
            this.prefabs,
            this.resources,
            resourceManager,
            logger,
        );
    }
}
```

## Start Guicos

Create `GuicosGui` after your context, hierarchy, registries, and root UI node
are ready.

```ts
import { Node, Prefab, resources } from "cc";
import {
    GuicosGui,
    GuicosResourceType,
    GuicosViewsRegistry,
    GuicosWidgetsRegistry,
    IGuicosLogger,
    IGuicosResourceManager,
} from "game/guicos/Guicos";
import { hierarchy } from "./UiHierarchy";
import { ViewsRegistryConfig } from "./ViewsRegistryConfig";
import type { AppContext } from "./AppContext";

const resourceManager: IGuicosResourceManager = {
    load<TResource>(path: string, type: GuicosResourceType<TResource>): Promise<TResource> {
        return new Promise((resolve, reject) => {
            resources.load(path, type, (error, asset) => {
                if (error !== null) {
                    reject(error);
                    return;
                }

                resolve(asset as TResource);
            });
        });
    },
};

const logger: IGuicosLogger = {
    log: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
};

export async function startGui(
    context: AppContext,
    rootNode: Node,
    viewsRegistryPrefab: Prefab,
    widgetsRegistryPrefab: Prefab,
): Promise<GuicosGui> {
    const viewsRegistry = GuicosViewsRegistry.loadFromPrefab(
        viewsRegistryPrefab,
        ViewsRegistryConfig,
        resourceManager,
        logger,
    );

    const widgetsRegistry = GuicosWidgetsRegistry.loadFromPrefab(
        widgetsRegistryPrefab,
        resourceManager,
        logger,
    );

    const gui = new GuicosGui(
        rootNode,
        hierarchy,
        viewsRegistry,
        widgetsRegistry,
        logger,
    );

    await gui.start(context);
    return gui;
}
```

## Typical Flow

1. Define ids for screens, views, and widgets.
2. Create `GuicosEvent` classes for user intent.
3. Implement screens as flow controllers.
4. Implement views as Cocos components.
5. Declare the hierarchy with `screen`, `slot`, and `view`.
6. Configure view and widget registry prefabs in Cocos Creator.
7. Create `GuicosGui` and call `start(context)`.

Example ids:

```ts
export enum ScreenId {
    App = "App",
    Home = "Home",
    Settings = "Settings",
}

export enum ViewId {
    Home = "Home",
    Settings = "Settings",
}

export enum WidgetId {
    InventoryItem = "InventoryItem",
}
```

## Runtime Behavior

- `openScreen` opens a direct child of the active screen.
- `openScreenFrom(parentScreenId, screenId)` opens a direct child of a specific
  parent screen.
- `closeScreen` closes an instantiated child screen branch.
- `openView` opens a direct child view of the active screen.
- `openViewFrom(parentScreenId, viewId)` opens a direct child view of a specific
  screen.
- `closeView` hides or disposes the active screen's direct child view.
- `publishEvent` sends an event to the current screen and then bubbles upward
  until it is consumed.

Guicos serializes transitions internally, so concurrent open and close requests
are executed in order.

## Cocos Creator Setup Notes

- Assign required Cocos references in the Inspector.
- Each registered view prefab must contain its `GuicosView` subclass.
- Registry prefabs should contain a `GuicosViewsRegistryComponent` or
  `GuicosWidgetsRegistryComponent` implementation.
- Resource registry entries use paths compatible with your
  `IGuicosResourceManager`.
- Do not manually create `.meta` files for scripts; let Cocos Creator generate
  them.

## Common Pitfalls

- A view id must be a direct child of the screen that opens it.
- Screen ids must be unique across the hierarchy.
- View ids must be unique within the same host screen.
- Slot names must not be empty and must be unique within a screen.
- `preloadViews` and `excludeBackgroundPreloadViews` may only reference direct
  child views of that screen.
- If a registry entry uses a resource path, a resource manager must be provided.
- If a view is destroyed outside Guicos lifecycle, the views registry will throw
  when the cached instance is requested again.
