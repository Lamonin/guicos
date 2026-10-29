// Run with node --test path/to/guicos/.tests/run.cjs. No generated runtime assets.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
let ts;
for (const location of [process.env.GUICOS_TYPESCRIPT, path.resolve(root, '../../../external/dice-roll-engine/node_modules/typescript'), 'typescript'].filter(Boolean)) {
    try { ts = require(location); break; } catch { /* Try the next consumer installation. */ }
}
if (!ts) throw new Error('Install TypeScript or set GUICOS_TYPESCRIPT to its module path');

let destroyed = [], afterDraw = [];
class Node {
    static EventType = { NODE_DESTROYED: 'destroyed' };
    constructor(name = '') { this.name = name; this.children = []; this.parent = null; this.active = true; this.events = new Map(); this.valid = true; }
    get active() { return this._active; }
    set active(value) { const changed = value !== this._active; this._active = value; if (changed && value && this.parent) this.component?.onEnable?.(); }
    addChild(node) { node.removeFromParent(); node.parent = this; this.children.push(node); if (node.active) node.component?.onEnable?.(); }
    removeFromParent() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    setSiblingIndex(index) { const parent = this.parent; if (parent) { this.removeFromParent(); this.parent = parent; parent.children.splice(index, 0, this); } }
    getComponent(ctor) { return this.component instanceof ctor ? this.component : null; }
    once(event, callback) { this.events.set(event, callback); }
    destroy() { if (!this.pending && this.valid) { this.pending = true; destroyed.push(this); } }
    flush() { for (const child of [...this.children]) child.flush(); this.component?.onDestroy?.(); this.valid = false; this.component && (this.component.valid = false); this.events.get('destroyed')?.(); this.removeFromParent(); }
}
class Component { valid = true; }
class Prefab {
    constructor(factory = () => new Node()) { this.factory = factory; this.refCount = 0; this.valid = true; }
    addRef() { this.refCount++; return this; }
    decRef() { assert.ok(this.refCount > 0, 'owned references stay balanced'); this.refCount--; return this; }
}
const cc = {
    Node, Component, Prefab,
    instantiate: prefab => prefab.factory(),
    isValid: (value, strict) => !!value && value.valid !== false && (!strict || !value.pending),
    director: { once: (_event, callback) => afterDraw.push(callback), off: (_event, callback) => { afterDraw = afterDraw.filter(item => item !== callback); } },
    Director: { EVENT_AFTER_DRAW: 'afterDraw' },
    _decorator: { property: () => () => {}, ccclass: () => ctor => ctor },
};
const load = Module._load;
Module._load = function (request, parent, main) { return request === 'cc' ? cc : load.call(this, request, parent, main); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, experimentalDecorators: true }, fileName: filename,
}).outputText, filename);
const { GuicosGui, GuicosHierarchy, GuicosScreen, GuicosView, GuicosViewsRegistry, GuicosWidgetsRegistry, GuicosLoadOperation, defineGuicosEvent, screen, slot, view } = require('../Guicos.ts');
const flush = () => { const nodes = destroyed; destroyed = []; nodes.forEach(node => node.valid && node.flush()); const callbacks = afterDraw; afterDraw = []; callbacks.forEach(callback => callback()); };
afterEach(flush);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const waitUntil = async predicate => { const end = Date.now() + 1000; while (!predicate()) { assert.ok(Date.now() < end, 'condition timed out'); await new Promise(resolve => setTimeout(resolve, 2)); } };
const prefabFor = (ctor, created = []) => new Prefab(() => { const node = new Node(ctor.name); const component = new ctor(); component.node = node; node.component = component; created.push(component); return node; });
function fixture(rootScreen, children = [], entries = [], options) {
    const host = new Node('host');
    const external = new Node('external'); host.addChild(external);
    const managed = new Node('managed'); host.addChild(managed);
    const views = new GuicosViewsRegistry(entries, [], null, undefined, options);
    const widgets = new GuicosWidgetsRegistry([], []);
    const hierarchy = new GuicosHierarchy(screen('root', rootScreen, children), { backgroundPreload: false });
    return { host, managed, external, views, widgets, gui: new GuicosGui(managed, hierarchy, views, widgets) };
}

test('independent public transitions wait, nested mount awaits succeed', { timeout: 2000 }, async () => {
    const gate = deferred(), started = deferred(), order = [];
    class View extends GuicosView { mount() { order.push('view'); } }
    class Root extends GuicosScreen { async mount() { order.push('root-start'); started.resolve(); await gate.promise; await this.gui.openView('view'); order.push('root-end'); } }
    class Child extends GuicosScreen { mount() { order.push('child'); } }
    const f = fixture(Root, [slot('view', [view('view', View)]), slot('route', [screen('child', Child)])], [{ id: 'view', prefab: prefabFor(View) }]);
    const start = f.gui.start({}); await started.promise;
    const child = f.gui.openScreenFrom('root', 'child');
    await tick(); assert.deepEqual(order, ['root-start']);
    gate.resolve(); await Promise.all([start, child]);
    assert.deepEqual(order, ['root-start', 'view', 'root-end', 'child']);
    assert.equal(f.host.children[0], f.external);
    assert.equal(f.host.children[1].children[0].name, 'View');
    await f.gui.dispose();
});

test('nested mount can await another screen which awaits its view', { timeout: 2000 }, async () => {
    const order = [];
    class View extends GuicosView { show() { order.push('show'); } }
    class Child extends GuicosScreen { async mount() { await this.gui.openView('view'); order.push('child'); } }
    class Root extends GuicosScreen { async mount() { await this.gui.openScreen('child'); order.push('root'); } }
    const f = fixture(Root, [slot('route', [screen('child', Child, [slot('main', [view('view', View)])])])], [{ id: 'view', prefab: prefabFor(View) }]);
    await f.gui.start({}); assert.deepEqual(order, ['show', 'child', 'root']); await f.gui.dispose();
});

test('mount prepares inactive view before attachment can trigger its first onEnable', async () => {
    const order = []; let prepared = false;
    class View extends GuicosView {
        mount() { assert.equal(this.node.active, false); prepared = true; order.push('mount'); }
        onEnable() { assert.equal(prepared, true); order.push('enable'); }
        show() { order.push('show'); }
    }
    const f = fixture(GuicosScreen, [slot('view', [view('view', View)])], [{ id: 'view', prefab: prefabFor(View) }]);
    await f.gui.start({}); await f.gui.openViewFrom('root', 'view');
    assert.deepEqual(order, ['mount', 'enable', 'show']); await f.gui.dispose();
});

test('external UI events during suspended mount wait, then handlers await nested navigation', { timeout: 2000 }, async () => {
    const Event = defineGuicosEvent('action'), ready = deferred(), gate = deferred(), views = [], order = [];
    class View extends GuicosView { async show() { views.push(this); ready.resolve(); await gate.promise; } }
    class Result extends GuicosView { show() { order.push('result'); } }
    class Root extends GuicosScreen {
        async mount() {
            this.onEvent(Event, async () => { order.push('event'); await this.gui.openView('result'); });
            await this.gui.openView('view'); order.push('mounted');
        }
    }
    const f = fixture(Root, [slot('view', [view('view', View)]), slot('result', [view('result', Result)])], [
        { id: 'view', prefab: prefabFor(View) }, { id: 'result', prefab: prefabFor(Result) },
    ]);
    const start = f.gui.start({}); await ready.promise;
    const event = views[0].gui.publishEvent(new Event()); await tick(); assert.deepEqual(order, []);
    gate.resolve(); await Promise.all([start, event]); assert.deepEqual(order, ['mounted', 'event', 'result']); await f.gui.dispose();
});

test('lifecycle can explicitly await nested publication and its handler navigation', { timeout: 2000 }, async () => {
    const Event = defineGuicosEvent('nested-action'); let handled = false;
    class View extends GuicosView { async show() { await this.gui.publishEvent(new Event(), { withinLifecycle: true }); } }
    class Root extends GuicosScreen { async mount() { this.onEvent(Event, () => { handled = true; }); await this.gui.openView('view'); } }
    const f = fixture(Root, [slot('view', [view('view', View)])], [{ id: 'view', prefab: prefabFor(View) }]);
    await f.gui.start({}); assert.equal(handled, true); await f.gui.dispose();
});

test('failed view mount and show dispose scopes and retry fresh', async () => {
    for (const failingHook of ['mount', 'show']) {
        const created = []; let cleanup = 0, attempts = 0;
        class View extends GuicosView {
            mount() { this.mountScope.onDispose(() => cleanup++); if (failingHook === 'mount' && attempts++ === 0) throw new Error('mount failed'); }
            show() { this.visibleScope.onDispose(() => cleanup++); if (failingHook === 'show' && attempts++ === 0) throw new Error('show failed'); }
        }
        const f = fixture(GuicosScreen, [slot('main', [view('view', View)])], [{ id: 'view', prefab: prefabFor(View, created) }]);
        await f.gui.start({}); await assert.rejects(f.gui.openViewFrom('root', 'view'), /failed/);
        assert.equal(created[0].lifecycleState, 'disposed'); assert.ok(cleanup > 0);
        await f.gui.openViewFrom('root', 'view'); assert.equal(created.length, 2);
        assert.equal(created[1].lifecycleState, 'visible'); await f.gui.dispose(); flush();
    }
});

test('replacement keeps old branch on preload and mount failure, clears failed subscriptions', async () => {
    let fail = true, failed, subscription;
    const Event = defineGuicosEvent('event');
    class Old extends GuicosScreen {}
    class Next extends GuicosScreen { constructor() { super(); failed = this; } mount() { subscription = this.onEvent(Event, () => {}); if (fail) throw new Error('mount failed'); } }
    const f = fixture(GuicosScreen, [slot('route', [screen('old', Old), screen('next', Next)])]);
    await f.gui.start({}); await f.gui.openScreenFrom('root', 'old');
    await assert.rejects(f.gui.openScreenFrom('root', 'next'), /mount failed/);
    assert.equal(f.gui.isScreenOpen('old'), true); assert.equal(f.gui.isScreenOpen('next'), false);
    assert.equal(failed.lifecycleState, 'disposed'); assert.equal(subscription.isActive, false); fail = false;
    await f.gui.openScreenFrom('root', 'next'); assert.equal(f.gui.isScreenOpen('old'), false); await f.gui.dispose();
});

test('failed prospective preload preserves old branch and retries IO', async () => {
    let attempts = 0;
    const prefab = prefabFor(GuicosView);
    const registry = new GuicosViewsRegistry([], [{ id: 'view', path: 'view' }], { load: async () => { if (attempts++ === 0) throw new Error('IO failed'); return prefab; } });
    const hierarchy = new GuicosHierarchy(screen('root', GuicosScreen, [slot('route', [
        screen('old', GuicosScreen), screen('next', GuicosScreen, [slot('view', [view('view', GuicosView)])], { preloadViews: ['view'] }),
    ])]));
    const gui = new GuicosGui(new Node(), hierarchy, registry, new GuicosWidgetsRegistry([], []));
    await gui.start({}); await gui.openScreenFrom('root', 'old');
    await assert.rejects(gui.openScreenFrom('root', 'next'), /IO failed/);
    assert.equal(gui.isScreenOpen('old'), true); assert.equal(gui.isScreenOpen('next'), false);
    await gui.openScreenFrom('root', 'next'); assert.equal(attempts, 2); await gui.dispose();
});

test('root mount failure can retry without stale subscriptions or nested screens', async () => {
    const Event = defineGuicosEvent('root-event'); let tries = 0, subscription;
    class Root extends GuicosScreen { async mount() { subscription = this.onEvent(Event, () => {}); await this.gui.openScreen('child'); if (tries++ === 0) throw new Error('root failed'); } }
    const f = fixture(Root, [slot('route', [screen('child', GuicosScreen)])]);
    await assert.rejects(f.gui.start({}), /root failed/);
    assert.equal(subscription.isActive, false); assert.equal(f.gui.isScreenOpen('root'), false); assert.equal(f.gui.isScreenOpen('child'), false);
    await f.gui.start({}); assert.equal(f.gui.isScreenOpen('child'), true); await f.gui.dispose();
});

test('dispose during loading prevents late instance and balances late resource ownership', async () => {
    const gate = deferred(), prefab = prefabFor(GuicosView), instances = [];
    prefab.factory = () => { instances.push(true); return new Node(); };
    const f = fixture(GuicosScreen, [slot('main', [view('view', GuicosView)])]);
    const registry = new GuicosViewsRegistry([], [{ id: 'view', path: 'view' }], { load: () => gate.promise });
    const gui = new GuicosGui(new Node(), new GuicosHierarchy(screen('root', GuicosScreen, [slot('main', [view('view', GuicosView)])])), registry, f.widgets);
    await gui.start({}); const opening = gui.openViewFrom('root', 'view'); await tick();
    const disposed = gui.dispose(); assert.equal(gui.dispose(), disposed);
    await assert.rejects(gui.openViewFrom('root', 'view'), /disposed/);
    gate.resolve(prefab); await assert.rejects(opening, /disposed/); await disposed; flush();
    assert.equal(instances.length, 0, 'late loads never instantiate a disposed GUI');
    assert.equal(prefab.refCount, 0); assert.equal(gui.isScreenOpen('root'), false);
});

test('registry disposed during IO rejects coalesced readers and releases late asset once', async () => {
    const gate = deferred(), prefab = new Prefab(); let loads = 0, released = 0;
    const registry = new GuicosViewsRegistry([], [{ id: 'a', path: 'a' }], { load: () => { loads++; return gate.promise; } }, undefined, { onPrefabReleased: () => released++ });
    const a = registry.getPrefab('a'), b = registry.getPrefab('a'); registry.dispose(); gate.resolve(prefab);
    await Promise.all([assert.rejects(a, /disposed/), assert.rejects(b, /disposed/)]);
    assert.equal(loads, 1); assert.equal(released, 1); assert.equal(prefab.refCount, 0);
});

test('cancel after transport completion but before delivery releases its unused cache ownership', async () => {
    const gate = deferred(), prefab = new Prefab(), operation = new GuicosLoadOperation();
    const registry = new GuicosViewsRegistry([], [{ id: 'a', path: 'a' }], { load: () => gate.promise }, undefined, { prefabCachePolicy: 'releaseUnused' });
    const reading = registry.getPrefab('a', operation);
    gate.resolve(prefab); queueMicrotask(() => operation.cancel());
    await assert.rejects(reading, /canceled/); await tick();
    assert.equal(prefab.refCount, 0); registry.dispose();
});

test('cancel nested never-resolving navigation, retry same view, and ignore late abandoned completion', { timeout: 2000 }, async () => {
    const first = deferred(), created = [], prefabs = [prefabFor(GuicosView, created), prefabFor(GuicosView, created)];
    let loads = 0;
    const registry = new GuicosViewsRegistry([], [{ id: 'view', path: 'view' }], { load: () => ++loads === 1 ? first.promise : Promise.resolve(prefabs[1]) }, undefined, { prefabCachePolicy: 'releaseUnused' });
    class Child extends GuicosScreen { async mount() { await this.gui.openView('view'); } }
    const hierarchy = new GuicosHierarchy(screen('root', GuicosScreen, [slot('route', [screen('child', Child, [slot('view', [view('view', GuicosView)])])])]));
    const gui = new GuicosGui(new Node(), hierarchy, registry, new GuicosWidgetsRegistry([], []));
    await gui.start({}); const controller = new AbortController();
    const firstOpen = gui.openScreenFrom('root', 'child', undefined, { signal: controller.signal });
    await tick(); assert.equal(loads, 1); controller.abort(); await assert.rejects(firstOpen, /canceled/);
    assert.equal(gui.isScreenOpen('child'), false);
    await gui.openScreenFrom('root', 'child'); assert.equal(loads, 2); assert.equal(created.length, 1);
    first.resolve(prefabs[0]); await tick(); assert.equal(created.length, 1); assert.equal(prefabs[0].refCount, 0);
    assert.equal(prefabs[1].refCount, 1); await gui.dispose(); flush(); assert.equal(prefabs[1].refCount, 0);
});

test('one canceled asset observer cannot cancel another consumer sharing its transport', async () => {
    const gate = deferred(), prefab = new Prefab(), operation = new GuicosLoadOperation(); let loads = 0;
    const registry = new GuicosViewsRegistry([], [{ id: 'a', path: 'a' }], { load: () => { loads++; return gate.promise; } });
    const canceled = registry.getPrefab('a', operation), surviving = registry.getPrefab('a');
    operation.cancel(); await assert.rejects(canceled, /canceled/); gate.resolve(prefab);
    assert.equal(await surviving, prefab); assert.equal(loads, 1); assert.equal(prefab.refCount, 1);
    registry.dispose(); flush(); assert.equal(prefab.refCount, 0);
});

test('late abandoned IO returning the same asset cannot release a newer request ownership', async () => {
    const first = deferred(), prefab = new Prefab(), operation = new GuicosLoadOperation(); let loads = 0;
    const registry = new GuicosViewsRegistry([], [{ id: 'a', path: 'a' }], { load: () => ++loads === 1 ? first.promise : Promise.resolve(prefab) });
    const canceled = registry.getPrefab('a', operation); operation.cancel(); await assert.rejects(canceled, /canceled/);
    assert.equal(await registry.getPrefab('a'), prefab); assert.equal(prefab.refCount, 1);
    first.resolve(prefab); await tick(); assert.equal(prefab.refCount, 1);
    registry.dispose(); flush(); assert.equal(prefab.refCount, 0);
});

test('aborting a queued navigation cannot terminate an active domain event handler', async () => {
    const Event = defineGuicosEvent('domain-action'), gate = deferred(), entered = deferred(); let completed = false;
    class Root extends GuicosScreen { mount() { this.onEvent(Event, async () => { entered.resolve(); await gate.promise; completed = true; }); } }
    const f = fixture(Root, [slot('view', [view('view', GuicosView)])], [{ id: 'view', prefab: prefabFor(GuicosView) }]);
    await f.gui.start({}); const event = f.gui.publishEventToScreen('root', new Event()); await entered.promise;
    const controller = new AbortController(), navigation = f.gui.openViewFrom('root', 'view', undefined, { signal: controller.signal });
    controller.abort(); await tick(); assert.equal(completed, false);
    gate.resolve(); assert.equal(await event, true); assert.equal(completed, true);
    await assert.rejects(navigation, /canceled/); await f.gui.dispose();
});

test('lifecycle widget load inherits cancellation and retry does not wait on abandoned transport', { timeout: 2000 }, async () => {
    const first = deferred(), widgets = [new Prefab(), new Prefab()]; let loads = 0;
    const registry = new GuicosWidgetsRegistry([], [{ id: 'item', path: 'item' }], { load: () => ++loads === 1 ? first.promise : Promise.resolve(widgets[1]) });
    class Child extends GuicosScreen { async mount() { await this.gui.widgets.createWidget('item'); } }
    const gui = new GuicosGui(new Node(), new GuicosHierarchy(screen('root', GuicosScreen, [slot('route', [screen('child', Child)])])), new GuicosViewsRegistry([], []), registry);
    await gui.start({}); const controller = new AbortController();
    const firstOpen = gui.openScreenFrom('root', 'child', undefined, { signal: controller.signal }); await tick();
    controller.abort(); await assert.rejects(firstOpen, /canceled/);
    await gui.openScreenFrom('root', 'child'); assert.equal(loads, 2);
    first.resolve(widgets[0]); await tick(); assert.equal(widgets[0].refCount, 0); assert.equal(widgets[1].refCount, 1);
    await gui.dispose(); flush(); assert.equal(widgets[1].refCount, 0);
});

test('timeout releases the navigation queue while its network request never settles', { timeout: 2000 }, async () => {
    class Slow extends GuicosView {}
    const registry = new GuicosViewsRegistry([], [{ id: 'slow', path: 'slow' }], { load: () => new Promise(() => {}) });
    const gui = new GuicosGui(new Node(), new GuicosHierarchy(screen('root', GuicosScreen, [slot('view', [view('slow', Slow)])])), registry, new GuicosWidgetsRegistry([], []));
    await gui.start({});
    const slow = gui.openViewFrom('root', 'slow', undefined, { timeoutMs: 15 });
    const queued = gui.closeViewFrom('root', 'slow');
    await assert.rejects(slow, error => error.name === 'TimeoutError');
    await queued;
    await gui.dispose();
});

test('progressive download-only covers every registered resource, waits for frame, prioritizes ids and foreground', { timeout: 2000 }, async () => {
    const downloads = [], firstDownload = deferred(), foreground = deferred(), foregroundStarted = deferred();
    let canRun = false;
    class Child extends GuicosScreen { async mount() { foregroundStarted.resolve(); await foreground.promise; } }
    const registry = new GuicosViewsRegistry([], ['menu', 'rules', 'shop', 'profile'].map(id => ({ id, path: id })), {
        load: () => assert.fail('download-only cannot load Prefabs'),
        preload: async path => { downloads.push(path); if (path === 'shop') await firstDownload.promise; },
    });
    const hierarchy = new GuicosHierarchy(screen('root', GuicosScreen, [slot('route', [screen('child', Child)])]), { backgroundPreload: false });
    const gui = new GuicosGui(new Node(), hierarchy, registry, new GuicosWidgetsRegistry([], []));
    await gui.start({});
    const preload = gui.startBackgroundPreload(undefined, { mode: 'downloadOnly', priorityViewIds: ['shop', 'profile', 'missing'], delayBetweenMs: 2, itemTimeoutMs: 1000, canRun: () => canRun });
    await tick(); assert.deepEqual(downloads, []); flush();
    await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(downloads, []);
    canRun = true; await waitUntil(() => downloads.length === 1); assert.deepEqual(downloads, ['shop']);
    const opening = gui.openScreenFrom('root', 'child'); await foregroundStarted.promise;
    firstDownload.resolve(); await new Promise(resolve => setTimeout(resolve, 25)); assert.deepEqual(downloads, ['shop']);
    foreground.resolve(); await opening; await preload;
    assert.deepEqual(downloads, ['shop', 'profile', 'menu', 'rules']); await gui.dispose();
});

test('progressive preload times out a hung item and disposal prevents further download tasks', { timeout: 2000 }, async () => {
    const downloads = [], late = deferred();
    const registry = new GuicosViewsRegistry([], ['hung', 'next', 'last'].map(id => ({ id, path: id })), {
        load: () => assert.fail('download-only cannot load'),
        preload: path => { downloads.push(path); return path === 'hung' ? late.promise : Promise.resolve(); },
    });
    const gui = new GuicosGui(new Node(), new GuicosHierarchy(screen('root', GuicosScreen)), registry, new GuicosWidgetsRegistry([], []));
    await gui.start({});
    const background = gui.startBackgroundPreload(undefined, { mode: 'downloadOnly', delayBetweenMs: 15, itemTimeoutMs: 10 }); flush();
    await waitUntil(() => downloads.length === 2); await gui.dispose(); await background;
    assert.deepEqual(downloads, ['hung', 'next']); late.resolve(); await tick(); assert.deepEqual(downloads, ['hung', 'next']);
});

test('download-only without a preload capability never falls back to asset loading', async () => {
    let loads = 0;
    const registry = new GuicosViewsRegistry([], [{ id: 'a', path: 'a' }], { load: async () => { loads++; return new Prefab(); } });
    await registry.preloadViewDownload('a'); assert.equal(loads, 0); registry.dispose();
});

test('background disposal before the first draw releases its wait without starting IO', async () => {
    const registry = new GuicosViewsRegistry([], [{ id: 'a', path: 'a' }], { load: () => assert.fail(), preload: () => assert.fail() });
    const gui = new GuicosGui(new Node(), new GuicosHierarchy(screen('root', GuicosScreen)), registry, new GuicosWidgetsRegistry([], []));
    await gui.start({}); const background = gui.startBackgroundPreload(undefined, { mode: 'downloadOnly' });
    await gui.dispose(); await background;
});

test('progressive warm item timeout invalidates its resource preloader scope', { timeout: 2000 }, async () => {
    const late = deferred(); let scope;
    class View extends GuicosView { static async preloadResources(context) { scope = context.scope; await late.promise; } }
    const f = fixture(GuicosScreen, [slot('view', [view('view', View)])], [{ id: 'view', prefab: prefabFor(View) }]);
    // This test intentionally uses the legacy hierarchy participation flags.
    const hierarchy = new GuicosHierarchy(screen('root', GuicosScreen, [slot('view', [view('view', View)])]));
    const gui = new GuicosGui(new Node(), hierarchy, f.views, f.widgets); await gui.start({});
    const preload = gui.startBackgroundPreload(undefined, { mode: 'warm', delayBetweenMs: 0, itemTimeoutMs: 10 }); flush();
    await preload; assert.equal(scope.isActive, false); late.resolve(); await tick(); await gui.dispose();
});

test('releaseUnused protects shared live instances until deferred destruction', async () => {
    let destroyedWithRefs = 0, releases = 0;
    class View extends GuicosView { onDestroy() { assert.ok(prefab.refCount > 0); destroyedWithRefs++; } }
    const prefab = prefabFor(View);
    const registry = new GuicosViewsRegistry([{ id: 'a', prefab }], [], null, undefined, { prefabCachePolicy: 'releaseUnused', onPrefabReleased: () => releases++ });
    const [a, duplicate, b] = await Promise.all([registry.getOrCreateView('one', View, 'a'), registry.getOrCreateView('one', View, 'a'), registry.getOrCreateView('two', View, 'a')]);
    assert.equal(a, duplicate); assert.notEqual(a, b); assert.equal(prefab.refCount, 1);
    registry.releaseUnusedPrefabs(); assert.equal(prefab.refCount, 1);
    registry.destroyView('one'); assert.equal(prefab.refCount, 1); flush(); assert.equal(prefab.refCount, 1);
    registry.destroyView('two'); assert.equal(prefab.refCount, 1); flush(); assert.equal(prefab.refCount, 0);
    assert.equal(releases, 1); assert.equal(destroyedWithRefs, 2); registry.dispose();
});

test('default cache retains prefab after instance destruction and dispose releases it', async () => {
    const prefab = prefabFor(GuicosView), registry = new GuicosViewsRegistry([{ id: 'a', prefab }], []);
    await registry.getOrCreateView('a'); registry.destroyView('a'); flush(); assert.equal(prefab.refCount, 1);
    registry.dispose(); assert.equal(prefab.refCount, 1); flush(); assert.equal(prefab.refCount, 0);
});

test('paused destruction retains references, and notification errors cannot interrupt release', async () => {
    const prefab = prefabFor(GuicosView); let errors = 0;
    const registry = new GuicosViewsRegistry([{ id: 'a', prefab }], [], null, {
        log() {}, warn() {}, error() { errors++; },
    }, { prefabCachePolicy: 'releaseUnused', onPrefabReleased() { throw new Error('notification failed'); } });
    await registry.getOrCreateView('a'); registry.destroyView('a'); registry.dispose();
    const callbacks = afterDraw; afterDraw = []; callbacks.forEach(callback => callback());
    assert.equal(prefab.refCount, 1, 'draw alone does not guarantee deferred destruction ran');
    flush(); assert.equal(prefab.refCount, 0); assert.equal(errors, 1);
});

test('widgets coalesce IO and track destruction without releasing a live instance', async () => {
    const gate = deferred(), prefab = new Prefab(); let loads = 0;
    const widgets = new GuicosWidgetsRegistry([], [{ id: 'a', path: 'a' }], { load: () => { loads++; return gate.promise; } }, undefined, { prefabCachePolicy: 'releaseUnused' });
    const [a, b] = [widgets.getPrefab('a'), widgets.getPrefab('a')]; gate.resolve(prefab);
    assert.equal(await a, await b); assert.equal(loads, 1); assert.equal(prefab.refCount, 1);
    const node = await widgets.createWidget('a'); widgets.releaseUnusedPrefabs(); assert.equal(prefab.refCount, 1);
    widgets.dispose(); flush(); assert.equal(prefab.refCount, 0);
    await assert.rejects(widgets.getPrefab('a'), /disposed/); assert.equal(node.valid, false);
});

test('queued input from a replaced view is discarded even while its host screen remains open', async () => {
    const Event = defineGuicosEvent('retired-view-input'), gate = deferred(), started = deferred(), created = [];
    let handled = 0;
    class Old extends GuicosView {}
    class Next extends GuicosView { async show() { started.resolve(); await gate.promise; } }
    class Root extends GuicosScreen { mount() { this.onEvent(Event, () => { handled++; }); } }
    const f = fixture(Root, [slot('main', [view('old', Old, { disposePolicy: 'disposeOnClose' }), view('next', Next)])], [
        { id: 'old', prefab: prefabFor(Old, created) }, { id: 'next', prefab: prefabFor(Next) },
    ]);
    await f.gui.start({}); await f.gui.openViewFrom('root', 'old');
    const retired = created[0], replacement = f.gui.openViewFrom('root', 'next'); await started.promise;
    const input = retired.gui.publishEvent(new Event());
    gate.resolve(); await replacement;
    assert.equal(await input, false); assert.equal(handled, 0);
    await f.gui.openViewFrom('root', 'old');
    assert.equal(await retired.gui.publishEvent(new Event()), false, 'Reopening an id cannot revive its previous source');
    assert.equal(await created[1].gui.publishEvent(new Event()), true); assert.equal(handled, 1);
    await f.gui.dispose();
});

test('disposal cancels queued view input without an unhandled publication error', async () => {
    const Event = defineGuicosEvent('closing-view-input'), gate = deferred(), started = deferred(), created = [];
    class View extends GuicosView { async show() { started.resolve(); await gate.promise; } }
    class Root extends GuicosScreen { mount() { this.onEvent(Event, () => assert.fail('Disposed input was delivered')); } }
    const f = fixture(Root, [slot('main', [view('view', View)])], [{ id: 'view', prefab: prefabFor(View, created) }]);
    await f.gui.start({}); const opening = f.gui.openViewFrom('root', 'view'); await started.promise;
    const input = created[0].gui.publishEvent(new Event());
    const disposed = f.gui.dispose(); gate.resolve();
    await opening; await disposed;
    assert.equal(await input, false); assert.equal(await created[0].gui.publishEvent(new Event()), false);
    await assert.rejects(f.gui.openViewFrom('root', 'view'), /disposed/);
});

test('hook errors cannot leave other views, nodes, subscriptions or references alive', async () => {
    const created = [], prefabs = [];
    class View extends GuicosView { hide() { throw new Error('hide failure'); } unmount() { throw new Error('unmount failure'); } }
    class Root extends GuicosScreen { async mount() { await this.gui.openView('a'); await this.gui.openView('b'); } unmount() { throw new Error('screen failure'); } }
    for (let i = 0; i < 2; i++) prefabs.push(prefabFor(View, created));
    const f = fixture(Root, [slot('a', [view('a', View)]), slot('b', [view('b', View)])], prefabs.map((prefab, i) => ({ id: i ? 'b' : 'a', prefab })));
    await f.gui.start({}); await assert.rejects(f.gui.dispose(), /hide failure/);
    assert.equal(f.gui.isScreenOpen('root'), false); assert.ok(created.every(v => v.lifecycleState === 'disposed'));
    flush(); assert.ok(prefabs.every(prefab => prefab.refCount === 0)); assert.equal(f.host.children.length, 2); assert.equal(f.managed.children.length, 0);
});

