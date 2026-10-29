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

- `onEvent` consumes the event before the handler runs.
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
Use `createWidget(id)` to load and instantiate a tracked widget. `getPrefab(id)` remains available for callers that manage their own instances and asset lifetime.

```ts
import { GuicosView } from "game/guicos/Guicos";
import { WidgetId } from "./UiIds";
import type { AppContext } from "./AppContext";

export class InventoryView extends GuicosView<AppContext> {
    public override async show(): Promise<void> {
        const itemNode = await this.gui.widgets.createWidget(WidgetId.InventoryItem);
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

    if (viewsRegistry === null || widgetsRegistry === null) {
        throw new Error("Guicos registry prefab is missing its registry component.");
    }

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

## Transition Ordering and Cleanup

Public runtime navigation calls and event publication enter one queue. Each
lifecycle hook and event handler receives an operation-scoped `this.gui` facade,
so it can await child navigation without blocking its own queued transition:

```ts
public override async mount(): Promise<void> {
    await this.gui.openView(ViewId.Home);
}
```

Await navigation started by a hook. Independent model or service callbacks must
use public `GuicosGui` methods or queued `publishEvent`, rather than navigation
through a lifecycle-scoped facade while that hook is suspended. Guicos cannot
infer the async origin of calls made through the same captured facade.

UI events are queued even if a view is currently inside an asynchronous hook.
Queued events retain their source lifetime: a hidden or disposed view cannot
deliver input into a replacement, even if its screen id is reopened. Such late
publications resolve to `false`, including when GUI disposal cancels queued view
input; new public runtime navigation still rejects after disposal.
When a hook or event handler deliberately needs to await nested publication,
opt in explicitly so its handler can run in the current operation:

```ts
await this.gui.publishEvent(new ReadyEvent(), { withinLifecycle: true });
```

A replacement screen loads its blocking prefabs and finishes mounting before
Guicos closes its previous sibling branch. If loading or mounting fails, the
old branch stays open. Failed views and screens are disposed, their lifecycle
scopes and subscriptions are cleared, and a later open can retry. Cleanup runs
all remaining hooks and disposals after an error, then rejects with the first
error.

`gui.isScreenOpen(id)` reports whether a screen instance exists, including while
mounting. `gui.isDisposed` becomes true as soon as disposal starts.

Call `await gui.dispose()` when the runtime is no longer needed. Disposal is
idempotent: it returns the same promise, immediately rejects new work, invalidates
view and preload guards, and stops new registry loads. It waits for active
navigation to settle, then closes every branch including the root and disposes
both registries. Custom resource preloaders can check the optional
`context.scope?.isActive` or use a guard to ignore late results. Third-party transport cannot be canceled by Guicos. Canceled registry observers
stop waiting immediately; late results relinquish their own asset reference and
never attach or show a view.

Pass a dedicated UI root configured with your project's `UITransform` and layout
components. Guicos uses the supplied root directly and manages sibling ordering
inside it. Disposal destroys managed views; the caller owns the root node.

## Prefab Ownership and Cache Policy

Both registries accept an optional fifth constructor argument:

```ts
const views = new GuicosViewsRegistry(prefabs, paths, resources, logger, {
    prefabCachePolicy: "releaseUnused",
    onPrefabReleased: (id, prefab) => logger.log(`Released ${id}: ${prefab.name}`),
});
```

The default `"retain"` keeps loaded prefabs cached after views close, preserving
the existing behavior. `"releaseUnused"` drops a prefab after its last tracked
instance is destroyed. Set view `disposePolicy: "disposeOnClose"` as well if the
application should retain only currently presented views. These policies control
different lifetimes: hidden instances using `"disposeWithScreen"` still keep
their prefabs alive.

Each registry owns one `addRef()` per cached prefab id. Shared instances keep
that reference alive until all deferred Cocos node destruction has completed;
only then does the registry call `decRef()` and `onPrefabReleased`. A paused
director can delay destruction and therefore delay release. The callback is a
notification after relinquishing ownership, not permission to destroy resources
still owned elsewhere. Resource managers remain responsible for any references
they own independently. Concurrent requests for an id share a single load, and
failed loads can be retried.

Explicit preloads stay warm until consumed, trimmed with
`registry.releaseUnusedPrefabs()`, or disposed. Trimming preserves every tracked
live instance. Widgets created by `createWidget()` are tracked through their
Cocos destruction event; `destroyWidget(node)` requests their destruction and
registry disposal destroys remaining tracked widgets. Callers using `getPrefab()`
and `instantiate()` directly must manage their instances and ensure they do not
outlive the registry or explicitly trimmed prefab ownership.

## Regression Tests

The hidden `.tests` directory keeps test helpers outside the Cocos asset import
surface. From a Zonk checkout:

```sh
node --test assets/scripts/guicos/.tests/run.cjs
```

The runner uses Node's test framework, lightweight Cocos doubles, and an existing
TypeScript installation. In another consumer, install TypeScript or set
`GUICOS_TYPESCRIPT` to its module path. The suite covers transition overlap,
nested lifecycle navigation and event publication, failure retry, disposal
during IO, asset reference ownership, and widget load coalescing. Consumer Cocos
TypeScript checks and engine integration tests remain necessary.
With Creator's loose script transform, use `Array.from(map.values())` or
`Array.from(set)` when an array snapshot is needed. Spreading an iterator can
compile as an array containing the iterator itself, although direct Node tests
accept that source.

## Cancelable Navigation Loads

`start(context, options)`, `openScreen(id, context, options)`,
`openView(id, context, options)`, and their `From(parent, id, context, options)`
variants accept `GuicosNavigationOptions`. Lifecycle facade `openScreen` and
`openView` accept the same optional third argument:

```ts
const controller = new AbortController();
await gui.openScreenFrom("app", "profile", context, {
    signal: controller.signal,
    timeoutMs: 15000,
});
// A newer requested target can call controller.abort().
```

The options follow nested lifecycle navigation and widget loading automatically.
Cancellation interrupts library load waits, unwinds failed screen/view cleanup,
and allows queued navigation to continue even when the abandoned transport never
settles. A retry of the same id can issue fresh IO once all observers of its old
request have canceled. Another active observer keeps shared IO alive. Late
abandoned results do not populate the cache or instantiate a replacement view;
an abort between completion and delivery also releases unused owned assets.

`GuicosNavigationCanceledError` has `name: "AbortError"` for cancellation or
`name: "TimeoutError"` and `timedOut: true` for a deadline. Deadlines begin when
navigation executes, excluding time spent waiting in the transition queue.
Explicit child options inherit parent cancellation. Without options, navigation
has no deadline, preserving existing behavior.

Guicos does not race or terminate arbitrary lifecycle hooks, event handlers,
application promises, or transport requests. A hook awaiting a third-party
promise outside the registries must implement its own cooperative cancellation.
If cancellation arrives during a hook, Guicos lets it finish before checking
whether the navigation may commit. This keeps asset destruction and application
side effects ordered safely. Callers implementing a loading overlay should
abort the navigation's controller on timeout and unlock input in `finally`.

## Progressive Download Preloading

Calling `startBackgroundPreload(context)` without options preserves the existing
warm-prefab preload behavior. Supplying options opts into a progressive serial
scheduler:

```ts
await gui.startBackgroundPreload(undefined, {
    mode: "downloadOnly",
    priorityViewIds: ["shop", "profile", "settings"],
    delayBetweenMs: 120,
    itemTimeoutMs: 15000,
    canRun: () => !app.busy && document.visibilityState !== "hidden",
});
```

Start it after the application presents its initial screen. The scheduler waits
for the next draw, yields between every item, and starts no new task while
foreground transitions are queued or `canRun()` returns false. Download-only
mode visits every resource-backed view registered in the views registry,
regardless of hierarchy background-preload flags. Priority ids run first and the
rest follow registration order. A finite per-item timeout logs a failure and
continues. Optional `signal` cancels the schedule; GUI disposal stops its waits
and pending tasks. Cancellation resolves the background schedule normally.

Download-only mode requires the resource manager's optional
`preload(path, type): Promise<void>` capability, which must download dependencies
without retaining instantiated assets. It never calls `load`, instantiates
nodes, or adds prefab references; if that capability is absent, it skips the
item. On-demand foreground loading remains unchanged. Cocos adapters can wrap
`resources.preload(path, Prefab, completedCallback)`.

Progressive `mode: "warm"` loads the hierarchy's background-preload views and
runs their declared resource preloaders. These still follow the registry cache
policy. Their scopes invalidate when an item times out, and their widget waits
are cancelable. Only one scheduled observer runs at a time; an underlying
transport that ignores cancellation can continue after its timeout. Foreground
work does not wait for background download tasks.
