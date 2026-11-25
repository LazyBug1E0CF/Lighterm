# Frontend Kernel & Layout Reference

Authoritative contract reference for Lighterm's frontend plugin kernel (`src/kernel/`), core shell service (`src/core/`), layout engine (`src/layout/`), and Settings UI (`src/components/settings/`).

---

## 1. Public Kernel Exports (`src/kernel`)

Import everything from `'../../kernel'` inside `src/plugins/<name>/`:

- **Functions & Kernel**: `definePlugin`, `validatePluginDefinition`, `isValidPluginId`, `PLUGIN_ID_PATTERN`, `PluginKernel`, `pluginKernel`
- **React Hooks & Provider**: `KernelProvider`, `useKernel`, `useKernelSnapshot`, `usePluginStatuses`, `useViewportDescriptors`, `usePluginSettingsPages`, `usePluginConfig`, `useSlotItems`, `useCommands`
- **Constants & Types**: `VIEWPORT_POSITIONS`, `VIEWPORT_POSITION_LABELS`, `LightermServiceMap`, `PluginDefinition`, `PluginContext`, `PluginRuntimeStatus`, `PluginIconComponent`, `ViewportPosition`, `PreferredDockPosition`, `ViewportRegistration`, `ViewportDescriptor`, `ViewportInstanceRef`, `ViewportComponentProps`, `PluginSettingsPageDescriptor`, `PluginSettingsPageProps`, `SettingsMountTarget`, `SlotName`, `SlotContribution`, `CommandDescriptor`, `KernelSnapshot`

---

## 2. `PluginDefinition` & Lifecycle

```ts
export interface PluginDefinition {
  id: string;                 // Matches /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/
  name: string;               // Non-empty display name in Plugin Manager
  version: string;            // Non-empty SemVer string (e.g. '1.0.0')
  description: string;        // Summary shown in Plugin Manager
  icon?: PluginIconComponent; // Fallback icon for Settings page when omitted there
  author?: string;
  inject?: string[];          // Service names required before activation
  provides?: string[];        // Service names exposed via ctx.provide(...)
  defaultEnabled?: boolean;   // Default true on first launch
  alwaysOn?: boolean;         // Default false; true prevents disabling & places Settings in General
  activate(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>;
}
```

### Kernel Guarantees & Constraints
- **`definePlugin(def)`** immediately runs `validatePluginDefinition(def)` and throws if `id` fails `PLUGIN_ID_PATTERN` or if `name` / `version` / `activate` are invalid.
- **Tick-0 Synchronous Activation**: `bootstrapLightermKernel()` runs synchronously until the first `await`, calling `pluginKernel.start()`, which runs `reconcileActivationsSync()`. Any plugin whose `activate(ctx)` registers viewports/pages/slots/commands synchronously is ready before frame 0 renders.
- **Dependency Graph**: If any service in `inject` is missing, the plugin remains inactive until dependencies activate. When a dependency plugin disables, `PluginKernel` cascades deactivation recursively.
- **`ctx.provide(name, impl)`**: Throws if `name.startsWith('core:')`. `'core:shell'` and `'core:layout'` are kernel-reserved.
- **`ctx.onCleanup(dispose)`**: Every disposer returned by `registerViewport`, `registerSettingsPage`, `registerSlot`, `registerCommand`, `provide`, plus `activate()`'s own optional return function and `onCleanup()` callbacks, runs automatically on disable or HMR reload.

---

## 3. `PluginContext` API Reference

```ts
export interface PluginContext {
  readonly pluginId: string;
  inject<T = undefined, K extends string = string>(serviceName: K): ...;
  tryInject<T = undefined, K extends string = string>(serviceName: K): ... | undefined;
  provide<T>(serviceName: string, impl: T): void;
  registerViewport(descriptor: ViewportRegistration): () => void;
  registerSettingsPage(page: Omit<PluginSettingsPageDescriptor, 'pluginId'>): () => void;
  registerSlot(contribution: Omit<SlotContribution, 'pluginId'>): () => void;
  registerCommand(command: Omit<CommandDescriptor, 'pluginId'>): () => void;
  getConfig<T extends Record<string, unknown>>(defaults: T): T;
  updateConfig<T extends Record<string, unknown>>(patch: Partial<T>): Promise<T>;
  resetConfig<T extends Record<string, unknown>>(defaults?: T): Promise<T>;
  onCleanup(dispose: () => void): void;
}
```

- Calling `ctx.inject('core:shell')` infers `ShellService`; `ctx.inject('core:layout')` infers `LayoutService`.
- Calling `ctx.tryInject(...)` returns `undefined` instead of throwing when a service is optional.

---

## 4. GUI Viewports & Layout Engine (`core:layout`)

### `ViewportRegistration`
```ts
export type ViewportPosition =
  | 'left-drawer'
  | 'right-drawer'
  | 'bottom'
  | 'top'
  | 'left'
  | 'right'
  | 'center'
  | 'float';

export interface ViewportComponentProps {
  viewport: ViewportInstanceRef; // { id, typeId, pluginId, title, params }
  isActive: boolean;
  isFloating: boolean;
  onClose: () => void;
}
```

- `typeId`: Must be globally unique across all viewports (registering duplicate `typeId`s across plugins or twice inside the same plugin throws). A single plugin can register **multiple viewports** by calling `ctx.registerViewport(...)` multiple times with distinct `typeId`s, `component`s, and `defaultPosition`s.
- `defaultPosition`: **Required** (legacy alias `defaultDock` is accepted and kept synchronized, but always write `defaultPosition` in new plugins).
- `defaultDockRatio?`: Optional split ratio (`0.1`–`0.9`) for edge positions (`bottom`, `top`, `left`, `right`). For `'bottom'`, `0.68` allocates 68% height above and 32% below. For `'left'`/`'top'`, it sets the size ratio of the newly docked edge.
- `defaultFloatSize?`: `{ width: number; height: number }`, used when `defaultPosition === 'float'` and whenever a user drags the viewport out into floating mode.
- `singleton?`: Set `true` for panel plugins (focus/toggle one instance), `false` for multi-instance viewports (tabs/split panes).
- `openOnStartup?`: When `true` and `singleton !== false`, `mountStartupPluginViewports()` mounts the viewport on clean launch AND when the user enables the plugin dynamically in Plugin Manager (`onPluginActivated`).
- `activateOnStartup?`: When `true` inside `'left-drawer'` or `'right-drawer'` during startup mounting, activates that drawer tab and opens the drawer.
- `order?`: Sort priority within shared areas (`left-drawer`, `right-drawer`, `Reset Layout`, multi-viewport lists), default `100` (lower first).
- `onClose?`: Callback fired after viewport closure; use to release backing resources (e.g., closing a linked shell session).

### Multi-Viewport Plugins & Sub-Panel Tear-Off
- **Plugin Manager & Activity Rail Integration**: When a plugin registers multiple viewports, `pluginKernel.getPluginViewportDescriptors(pluginId)` returns all of them sorted by `order`. `SideDrawer`'s `+` menu groups multi-viewport plugins into a collapsible plugin row (collapsed by default) instead of flattening every sub-viewport at top level, and `PluginManagerModal` renders a default-collapsed `Plugin Viewports (N)` section with per-viewport `Left` / `Right` / `Bottom` / `Float` / `Open` controls.
- **Reference Implementation (`lighterm.monitor`)**: Registers both the aggregate dashboard `monitor.panel` (`openOnStartup: true`) and 6 modular sub-viewports (`monitor.host`, `monitor.cpu`, `monitor.memory`, `monitor.network`, `monitor.disks`, `monitor.processes`, `openOnStartup: false`). Any card can be dragged onto the Left/Right Activity Rail, Edge Split, Dock Compass, or open workspace to detach into an independent viewport, or merged back via `Return <Title> to System Status`.

### Preserved Bottom/Edge Split Behavior
When a `'center'` viewport (such as a terminal) opens while `dockRoot` contains only a single group of edge-docked plugin viewports (e.g., `sftp.browser` at `'bottom'`), `LayoutService.openViewport` automatically splits relative to that edge using `firstDesc?.defaultDockRatio` instead of tab-merging into the bottom panel.

### Common `LayoutService` (`core:layout`) Methods
- `toggleSingletonViewport({ typeId, ...overrides })`: Opens at `defaultPosition` if absent; toggles drawer collapse or closes workspace panel if already visible; re-docks if detached.
- `openPluginViewport(typeId, opts?)`: Opens or focuses a viewport using its registered `ViewportDescriptor` defaults (`defaultPosition`, `defaultDockRatio`, `defaultFloatSize`).
- `openViewport(opts)`: Explicit lower-level viewport creation with custom `preferredDock`, `dockRatio`, `targetGroupId`, `splitZone`, or `floatRect`.
- `detachToViewport(spec)`: Programmatically opens or focuses a tear-off viewport at `spec.preferredDock` (defaulting to the descriptor's `defaultPosition`) and invokes `spec.onCommit(viewport)`.
- `startTearOffDrag(opts)`: Transitions an internal card/sub-panel pointer drag into a global cross-layout viewport drag (`source: 'tear-off'`). `WorkspaceCanvas` snaps against `[data-activity-rail]` / `[data-drop-drawer]`, `[data-drop-edge]`, `[data-drop-group][data-drop-zone]`, or falls back to floating on drop, then invokes `opts.onCommit(viewport)`.
- `closeViewport(viewportId)`: Closes an open viewport instance and triggers `descriptor.onClose`.
- `findViewportsByType(typeId)` / `findWorkspaceViewportsByType(typeId)`
- `getViewportLocation(viewportId)`: Returns `'left-drawer' | 'right-drawer' | 'docked' | 'floating' | null`.
- `dockToDrawer(viewportId, side, activate?)` / `dockToEdge(viewportId, edge, ratio?)` / `floatViewport(viewportId, partialRect?)`
- `resetLayoutPreservingViewports()`: Rebuilds drawers, workspace splits, and floating layer strictly from each open viewport's `defaultPosition` without closing active viewports.

---

## 5. Settings Pages, Mounted Panels & `PluginConfig` Persistence

### Settings Navigation & Mounting Modes
`SettingsModal` (`src/components/settings/SettingsModal.tsx`) splits its left `<nav aria-label="Settings Navigation">` into two `role="group"` sections:
1. **`General Settings`** (`aria-label="General Settings"`): `Appearance`, followed by standalone Settings pages registered by plugins with `alwaysOn: true` (sorted by `order`, then `title`), then `Shortcuts`.
2. **`Plugin Settings`** (`aria-label="Plugin Settings"`): Standalone Settings pages registered by active optional (`alwaysOn !== true`) plugins. Shows count badge when non-empty.

Plugins registering via `ctx.registerSettingsPage(...)` support two placement modes:
- **Standalone Page (default, omit `mountTo`)**: Gets its own left-nav entry under `General` (`alwaysOn: true`) or `Plugins` (optional) keyed by `${pluginId}:${id}`.
- **Mounted Collapsible Panel (`mountTo` set)**: Does **not** create a separate left-nav item; instead appends a collapsible panel inside the target Settings page:
  - Accepted targets (`SettingsMountTarget`): `'appearance'`, `'shortcuts'`, `'${hostPluginId}:${hostPageId}'` (recommended, e.g. `'lighterm.terminal:terminal'` — where `lighterm.history` mounts), or shorthand `'${hostPluginId}'`.
  - Self-mounting (`mountTo === '${pluginId}:${id}'` or `mountTo === pluginId`) throws during registration.
  - Fallback: if an optional target plugin is disabled/missing, the kernel/UI gracefully promotes the mounted page to a standalone tab so settings remain reachable.
  - Deep-link from Plugin Manager `Configure` (`shell.openSettings('${pluginId}:${pageId}')`): automatically opens the host tab in the sidebar and expands the mounted panel (ignoring prior collapse state until toggled).
  - If a currently viewed standalone plugin is disabled while Settings is open, its tab disappears and `SettingsModal` falls back to `'appearance'`.

### `registerSettingsPage` & `usePluginConfig`
```ts
// Standalone page (default)
ctx.registerSettingsPage({
  id: 'my-plugin',
  title: 'My Plugin',
  description: 'Configure plugin options.',
  icon: MyIcon, // Optional: defaults to PluginDefinition.icon -> Puzzle
  order: 60,    // Built-ins reserve 10-50; start third-party extensions at 60+
  component: MyPluginSettingsPage,
});

// Collapsible panel mounted onto Terminal settings
ctx.registerSettingsPage({
  id: 'my-terminal-addon',
  title: 'My Terminal Addon',
  description: 'Extra options appended inside Terminal settings.',
  order: 60,
  mountTo: 'lighterm.terminal:terminal',
  defaultExpanded: false, // Defaults to true
  component: MyPluginSettingsPage,
});
```

Inside React (`MyPluginSettingsPage` or `MyPluginViewport`):
```tsx
// MUST be a module-level constant reference to avoid React 19 useSyncExternalStore loops
export const DEFAULT_MY_CONFIG = {
  refreshIntervalMs: 2000,
  compactMode: false,
};

export const MyPluginSettingsPage: React.FC<PluginSettingsPageProps> = ({ pluginId }) => {
  const { config, updateConfig, resetConfig } = usePluginConfig(pluginId, DEFAULT_MY_CONFIG);
  ...
};
```

- **Storage locations**:
  - Browser / Vitest: `localStorage` key `lighterm:plugin-config:<pluginId>`.
  - Tauri Desktop: `<data_dir>/plugin-configs.json` via `plugin_config_save` / `plugin_config_reset`, automatically hydrated at startup via `plugin_configs_get_all`.

---

## 6. UI Slots & Command Palette

### Available `SlotName` Targets
| Slot | Context | Usage Guidelines |
| --- | --- | --- |
| `'topbar:right'` | none | Compact icon buttons (`h-7 w-7`) for global workspace actions |
| `'statusbar:left'` | none | Read-only status badges (e.g., `80x24` terminal dimensions) |
| `'statusbar:right'` | none | Quick panel toggle buttons (`flex items-center gap-1`) |
| `'host:actions'` | `{ host?: HostConfig }` | Per-host hover buttons on SSH Host cards (`px-1.5 py-0.5 text-[10px]`) |
| `'settings:tabs'` | none | **Deprecated** — always use `ctx.registerSettingsPage(...)` instead |

### Commands (`ctx.registerCommand`)
```ts
ctx.registerCommand({
  id: 'my-plugin:toggle',
  group: 'Action',      // e.g. 'Action', 'Layout', 'Snippet', 'History'
  label: 'Toggle My Plugin',
  subtitle: 'Optional secondary text',
  shortcut: 'Ctrl+Shift+Y',
  run: () => { ... },
});
```
For dynamic commands (lists loaded async): store disposers in an array, run old disposers before replacing on update, and clear all disposers inside `ctx.onCleanup`.

---

## 7. Core Shell (`core:shell`) & IPC (`src/core/ipc.ts`) APIs

### Key `ShellService` Methods & Store (`useShellStore`)
- Sessions: `createLocalSession(params?)`, `createSshSession(params)`, `quickConnectSsh(rawInput)`, `writeSession(sessionId, dataBase64)`, `sendTextToActiveSession(text, appendNewline?)`, `resizeSession(sessionId, cols, rows)`, `closeSession(sessionId)`, `setActiveSession(sessionId)`, `getActiveSession()`, `getSession(sessionId)`, `listSessions()`, `getReplayBytes(sessionId)`
- Session subscriptions (all return `() => void` disposer — pass to `ctx.onCleanup`):
  - `onSessionCreated((record, meta) => ...)`
  - `onSessionClosed((sessionId) => ...)`
  - `onSessionInput((sessionId, text) => ...)`
  - `onSessionOutput((sessionId, bytes) => ...)`
  - `onActiveSessionChanged((sessionId) => ...)`
- Hosts & Modals: `listHosts()`, `saveHost(host)`, `deleteHost(id)`, `testHostConnection(host)`, `openHostModal(host?)`, `openSettings(tabKey?)`, `setSettingsModalOpen(open)`, `setSettingsActiveTab(tabKey)`, `setCommandPaletteOpen(open)`, `setPluginManagerOpen(open)`, `setBannerError(msg)`, `clearBannerError()`
- Reactive state (`useShellStore`): `sessions`, `activeSessionId`, `hosts`, `settings` (`settings.shortcuts`, `settings.themeId`, etc.).

### IPC Helpers (`src/core/ipc.ts`)
- `isTauriRuntime()`: `true` when `'__TAURI_INTERNALS__' in window`.
- `invokeTauri<T>(cmd, args?)`: Async wrapper around `@tauri-apps/api/core`'s `invoke`.
- `listenTauri<T>(event, handler)`: Async wrapper around `@tauri-apps/api/event`'s `listen`; returns `Promise<() => void>`. Protect async setup with a `disposed` flag in `ctx.onCleanup`.
- `pickOpenFile(title)` / `pickSaveFile(title, defaultName)`: Native file dialogs via `@tauri-apps/plugin-dialog` (return `null` outside Tauri).
- `readLs<T>(key, fallback)` / `writeLs<T>(key, value)` / `makeUuid(prefix?)`.
