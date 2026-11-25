# Lighterm 插件开发规范

本文档定义了 **Lighterm** 前后端一体化插件系统的设计规范、API 契约、命名标准、GUI 视口布局规则、Settings 配置页接入规范及 Rust 后端扩展标准。所有内置插件与第三方扩展均须遵循本规范。

---

## 1. 架构理念与核心边界

Lighterm 采用受 **Cordis** 启发的 **Everything-is-a-Plugin（微内核 + 插件生态）** 架构：

### 1.1 Minimal Core 职责边界
内核层仅承担不可拆分的基础能力，严禁包含任何具体业务插件逻辑：
- **后端内核（`crates/lighterm-core`）**：
  - 本地 PTY（`portable-pty`）与异步 SSH2（`russh`）会话连接池 `SessionManager` / `SshConnectionPool`
  - 原子文件持久化 `Storage`（`hosts.json`、`workspaces.json`、`settings.json`、`plugins.json`、`plugin-configs.json` 以及插件专属 JSON 存储）
  - 后端插件注册与生命周期管理 `CorePlugin` / `PluginRegistry`
- **前端内核（`src/core/`, `src/harness/`, `src/layout/`）**：
  - `core:shell`（`ShellService`）：会话、主机配置、全局外观设置、模态框控制
  - `core:layout`（`LayoutService`）：统一递归 `DockNode` 分栏树、左右可折叠抽屉（`SideDrawer`）与浮动窗口管理
  - `HarnessKernel`：插件定义校验、依赖解析（`inject` / `provide`）、`EffectScope` 可逆清理、视口/配置页/插槽/命令注册与插件配置持久化

### 1.2 禁止硬编码与可逆清理原则
- **严禁硬编码耦合**：Core、Layout 引擎、Bootstrap 启动流程和 Tauri 命令层禁止硬编码特定插件 ID、视口 `typeId` 或直接下转型具体插件类型来触发副作用。启动挂载、布局重置（`resetLayoutPreservingViewports`）必须通过 `ViewportDescriptor` 元数据驱动；后端主机缓存失效通过 `CorePlugin::on_host_invalidated` 生命周期钩子广播。
- **可逆清理（EffectScope）**：插件在 `activate(ctx)` 中注册的一切视口、Settings 配置页、UI 插槽、命令、提供出去的服务、以及全局事件监听器，均须通过 `ctx` 返回的清理机制或 `ctx.onCleanup(...)` 注册卸载回调，确保在插件禁用或热重载（HMR）时 100% 释放，不留孤儿 UI 或内存泄漏。

---

## 2. 目录结构与命名规范

### 2.1 目录组织标准

```text
src/plugins/<plugin-name>/
├── index.tsx                  # 插件入口：export const <name>Plugin = definePlugin(...)
├── <Name>Viewport.tsx         # 主 GUI 视口组件（如有视口）
├── <Name>SettingsPage.tsx     # Settings 配置页组件（如有配置页）
├── <name>Client.ts            # 前端状态 store、默认配置常量及 Tauri IPC 封装
└── ...                        # 其他辅助模块

crates/plugins/<plugin-name>/
├── Cargo.toml                 # crate 名：lighterm-plugin-<plugin-name>
└── src/
    └── lib.rs                 # 实现 CorePlugin trait 及领域能力
```

### 2.2 标识符命名规范

| 实体 | 格式规范 | 正则 / 规则 | 示例 |
| --- | --- | --- | --- |
| `plugin.id` | 反向域名小写两段及以上 | `/^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/` | `lighterm.sftp`、`acme.port-forward` |
| `viewport.typeId` | `<namespace>.<viewport>` | 必须全局唯一；禁止跨插件占用同一 `typeId` | `sftp.browser`、`monitor.panel` |
| `serviceName` | `<domain>:<service>` | **`core:` 前缀为内核保留命名空间**，插件禁止 `provide('core:*', ...)` | `terminal:service`、`acme:tunnel` |
| `settingsPage.id` | 短小写标识符 | 非空字符串；内核以 `${pluginId}:${id}` 为唯一键 | `sftp`、`monitor`、`terminal` |
| `command.id` | `<namespace>:<action>` | 唯一命令 ID | `sftp:toggle`、`monitor:reset-panels` |
| `slot.id` | `<plugin>-<purpose>` | 非空字符串 | `sftp-statusbar-btn` |
| Tauri Command | `<plugin>_<action>` | `snake_case` 前缀隔离 | `sftp_list_dir`、`monitor_get_stats` |
| Tauri Event | `<plugin>:<event>` | 冒号分隔事件名 | `sftp:progress` |

---

## 3. 前端插件生命周期与依赖注入

### 3.1 使用 `definePlugin` 定义插件

所有前端插件须通过 `definePlugin`（导出自 `src/harness`）定义，内核会在定义及注册阶段立即校验 `id`、`name`、`version` 与 `activate`。

```ts
import { definePlugin } from '../../harness';

export const myPlugin = definePlugin({
  id: 'acme.demo',
  name: 'Demo Workbench',
  version: '1.0.0',
  description: 'Demonstrates standard Lighterm plugin capabilities',
  icon: Puzzle,
  author: 'Acme',
  inject: ['core:shell', 'core:layout'],
  provides: ['acme:demo-api'],
  defaultEnabled: true,
  alwaysOn: false,

  activate(ctx) {
    // 同步完成服务注入与 UI 描述符注册，保证第 0 帧即可渲染
  },
});
```

#### `PluginDefinition` 字段说明
- `id` (`string`, 必填)：符合 `PLUGIN_ID_PATTERN` 的唯一插件 ID。
- `name` (`string`, 必填)：人类可读插件名称（展示于 Plugin Manager）。
- `version` (`string`, 必填)：遵循 SemVer 的版本号，如 `'1.0.0'`。
- `description` (`string`, 必填)：简明功能描述。
- `icon` (`PluginIconComponent`, 可选)：默认图标组件，将作为未显式指定图标的 Settings 配置页的默认图标。
- `author` (`string`, 可选)：作者或维护者标识。
- `inject` (`string[]`, 可选)：依赖的服务名数组。内核会按拓扑顺序激活插件；依赖服务缺失时插件保持 `Waiting Deps` 状态，依赖被禁用时会级联卸载本插件。
- `provides` (`string[]`, 可选)：声明对外提供的服务名（供其他插件 `inject`）。
- `defaultEnabled` (`boolean`, 可选，默认 `true`)：首次启动未在本地记录开关状态时的默认启用态。
- `alwaysOn` (`boolean`, 可选，默认 `false`)：设为 `true` 时视为核心基础设施插件，禁止在 UI 或 `disablePlugin` 中关闭。

### 3.2 类型安全服务注入与清理
- **核心服务自动类型推导**：`LightermServiceMap` 已映射 `'core:shell'` (`ShellService`) 与 `'core:layout'` (`LayoutService`)，调用 `ctx.inject('core:shell')` 或 `ctx.inject('core:layout')` 可自动获得完整类型推导；消费插件自定义服务可使用 `ctx.inject<MyApi>('acme:api')` 或非阻塞的 `ctx.tryInject(...)`。
- **禁止覆盖内核服务**：调用 `ctx.provide('core:*', ...)` 会直接抛出异常。
- **首帧同步原则**：所有 `ctx.registerViewport`、`ctx.registerSettingsPage`、`ctx.registerSlot`、`ctx.registerCommand` 应在 `activate(ctx)` 同步阶段完成；异步初始化任务（如事件订阅、初始数据拉取）可在同步注册之后启动，并使用 `disposed` 标记配合 `ctx.onCleanup` 防止竞态泄漏。

---

## 4. GUI 视口（Viewport）与默认显示位置规范

具有 GUI 界面的插件须在 `activate(ctx)` 中调用 `ctx.registerViewport(...)` 注册视口，并在注册时**显式指定视口的默认显示位置**（`defaultPosition`）。

### 4.1 注册 API 与参数契约

```ts
ctx.registerViewport({
  typeId: 'acme.demo.panel',
  title: 'Demo Panel',
  icon: TerminalSquare,
  defaultPosition: 'bottom',
  defaultDockRatio: 0.68,
  defaultFloatSize: { width: 640, height: 360 },
  singleton: true,
  openOnStartup: false,
  activateOnStartup: false,
  order: 30,
  component: DemoViewport,
});
```

#### 字段说明
- `typeId` (`string`, 必填)：视口类型唯一 ID，不可与其他已激活插件冲突。
- `title` (`string`, 必填)：Tab、抽屉标题栏及窗口标题文本。
- `icon` (`PluginIconComponent`, 必填)：Tab、Activity Rail 与菜单使用的图标组件。
- `defaultPosition` (`ViewportPosition`, 必填)：视口默认显示位置（兼容旧别名 `defaultDock`，内核会双向归一化同步）。
- `defaultDockRatio` (`number`, 可选，范围 `0.1` ~ `0.9`)：当 `defaultPosition` 为边缘分栏位置（`left`/`right`/`top`/`bottom`）时，Split 分割比（对 `bottom` 而言 `0.68` 表示上方主区占 `68%`、底部视口占 `32%`；对 `top`/`left` 表示该边缘占 `defaultDockRatio`）。
- `defaultFloatSize` (`{ width: number; height: number }`, 可选)：悬浮窗口模式下的默认宽高（同时用于首次 `float` 打开及用户将停靠视口拖出悬浮时的初始尺寸）。
- `singleton` (`boolean`, 可选)：为 `true` 时整个应用仅维持一个实例，重复打开会聚焦或展开现有实例；为 `false` 时可打开多个独立实例（如终端标签页）。
- `openOnStartup` (`boolean`, 可选，默认 `false`)：仅对 `singleton !== false` 的视口生效；设为 `true` 时，在首次启动（无既有视口时）以及用户后续在 Plugin Manager 中动态启用插件时，内核自动按 `defaultPosition` 挂载该视口。
- `activateOnStartup` (`boolean`, 可选，默认 `false`)：当 `defaultPosition` 为 `'left-drawer'` 或 `'right-drawer'` 且 `openOnStartup: true` 时，控制启动挂载时是否将其设为当前抽屉激活页并展开抽屉。
- `order` (`number`, 可选，默认 `100`)：同一位置（如左侧抽屉 Activity Rail 或重置布局时）的排序权重，数值越小越靠前。
- `component` (`React.ComponentType<ViewportComponentProps>`, 必填)：视口渲染组件，接收 `{ viewport, isActive, isFloating, onClose }`。
- `onClose` (`(viewport: ViewportInstanceRef) => void`, 可选)：视口关闭时回调，用于回收底层会话或后台资源。

### 4.2 `defaultPosition` 8 种标准位置及适用场景

| `defaultPosition` | 所属区域 | 适用场景 | 典型插件示例 |
| --- | --- | --- | --- |
| `'left-drawer'` | 左侧可折叠抽屉与 Activity Rail | 导航树、主机目录、代码片段库、命令历史等常驻辅栏 | `hosts.manager`、`snippets.panel`、`history.panel` |
| `'right-drawer'` | 右侧可折叠抽屉与 Activity Rail | 实时遥测监控、AI 助手、诊断检查器等右侧观察面板 | `monitor.panel` |
| `'bottom'` | 主工作区底部水平分栏视口 | 文件管理器、日志流、传输队列、输出控制台等宽幅面板 | `sftp.browser` |
| `'top'` | 主工作区顶部水平分栏视口 | 顶部工具台或全局监控条 | 自定义顶部面板 |
| `'left'` | 主工作区左侧内嵌分栏 | 强耦合主画布且需常驻对比的左分栏视口 | 自定义分栏编辑器 |
| `'right'` | 主工作区右侧内嵌分栏 | 强耦合主画布的右侧预览/调试视口 | 自定义分栏预览 |
| `'center'` | 中央主标签组（Tab Group） | 终端会话、主工作区文档或独占型交互画布 | `terminal.viewport` |
| `'float'` | 自由拖拽与 8 向缩放悬浮窗 | 临时工具弹窗、独立校验器、多屏浮窗 | 自定义悬浮工具 |

### 4.3 多视口插件与子面板拖出（Tear-Off）规范

一个插件可在 `activate(ctx)` 中多次调用 `ctx.registerViewport(...)` 注册**多个不同职责的 GUI 视口**，且每个视口都可以拥有完全不同的内容组件、标题、图标与默认显示位置（`defaultPosition`），并在运行期独立停靠到抽屉、边缘分栏或悬浮窗中：
- 同一插件内的各个视口须使用全局唯一的 `typeId`（重复注册同一 `typeId` 会抛出异常）；Plugin Manager 与侧边栏 `Add Viewport` (`+`) 菜单均会按插件聚合多视口列表并默认折叠，避免多层视口平铺，同时保留每个视口的独立打开/停靠控制。
- 内置范例 `lighterm.monitor` 注册了聚合面板 `monitor.panel` 以及 `monitor.host`、`monitor.cpu`、`monitor.memory`、`monitor.network`、`monitor.disks`、`monitor.processes` 等独立子视口：它们既可以在 `System Status` 内以卡片排序展示，也可独立打开在不同区域同时显示不同内容。
- **子面板拖出（Tear-Off）标准能力**：当插件内含可独立成窗的子卡片时，可使用 `core:layout` 提供的通用 API：
  - `layout.startTearOffDrag({ typeId, pluginId, title, params, startX, startY, currentX, currentY, floatRect, dockRatio, onCommit, onCancel })`：当指针拖出源视口边界或进入外部 Activity Rail / 分栏 / 边缘热区时，无缝切换为全局跨区域视口拖拽，支持直接拖入左侧/右侧抽屉（含 Activity Rail）、工作区五向罗盘、四向边缘分栏或松手生成悬浮窗，并在落点确认后触发 `onCommit(viewport)`。
  - `layout.detachToViewport({ typeId, pluginId, title, preferredDock, onCommit })`：点击卡片上的「独立打开」快捷按钮时，一步创建或聚焦独立视口。

### 4.4 位置调度、打开、切换与布局重置
- **打开/切换辅助方法**：插件内无需重复编写位置分支判断，直接调用 `layout.toggleSingletonViewport({ typeId })` 或 `layout.openPluginViewport(typeId)`，布局引擎会自动读取注册的 `defaultPosition`、`defaultDockRatio` 与 `defaultFloatSize`；可通过 `harnessKernel.getPluginViewportDescriptors(pluginId)` 查询插件名下全部视口。
- **布局重置（Reset Layout）**：用户点击顶部 `Reset Layout` 时，`layoutService.resetLayoutPreservingViewports()` 会保留所有当前打开的视口实例，并严格按照每个视口注册的 `defaultPosition` 归位（抽屉视口归位至左右抽屉，底部/边缘视口归位至边缘分栏，悬浮视口归位至浮动层）。
- **主题样式与拖拽隔离**：
  - 视口样式必须使用全局 CSS 变量（`--bg-app`、`--bg-surface`、`--bg-elevated`、`--border-subtle`、`--text-primary`、`--text-muted`、`--accent`、`--success`、`--warning`、`--danger`），严禁硬编码固定深/浅色 hex 值。
  - 若视口内部包含可拖拽卡片或可交互按钮，须在 `onPointerDown` 调用 `e.stopPropagation()` 或标记 `data-no-drag="true"`，避免误触发外层视口拖拽；内部卡片支持拖出时再通过 `startTearOffDrag` 主动接管全局拖拽。

---

## 5. Settings 插件配置页与配置持久化规范

### 5.1 Settings 左侧导航分区与两种挂载模式

`SettingsModal` 左侧导航栏固定划分为两个语义区块：
1. **General 区块**（`aria-label="General Settings"`）：展示核心通用设置（`Appearance`、`Shortcuts`）以及 **`alwaysOn: true` 核心常驻插件**的独立配置页（如 `lighterm.terminal`）。
2. **Plugins 区块**（`aria-label="Plugin Settings"`）：展示所有**已激活的非 `alwaysOn` 可选插件**的独立配置页（按 `order` 升序、`title` 字母序排列）。

插件通过 `ctx.registerSettingsPage(...)` 注册配置界面时支持两种展示模式：
1. **独立配置页模式（默认，不传 `mountTo`）**：在 `General`（`alwaysOn: true`）或 `Plugins`（可选插件）中拥有独立的左侧导航入口。
2. **宿主挂载可折叠面板模式（指定 `mountTo`）**：不占用左侧导航独立 Tab，而是在指定的宿主配置页末尾追加一个**可折叠面板（Collapsible Panel）**，并在其中渲染该插件的配置组件（例如 `lighterm.history` 挂载在 `'lighterm.terminal:terminal'` 上）。
   - 支持的目标格式：`'appearance'`、`'shortcuts'`、`'${hostPluginId}:${hostPageId}'`（推荐，如 `'lighterm.terminal:terminal'`）或简写 `'${hostPluginId}'`。
   - 若指定的可选宿主插件当前被禁用或不存在，内核会安全回退为独立配置页，避免配置项不可达；禁止将配置页挂载到自身。

当某插件在 Plugin Manager 中被禁用时，其独立配置页或挂载面板会自动移除；若当前正停留在被禁用的独立页，Settings 界面会自动安全回退至 `Appearance`。在 Plugin Manager 中点击插件卡片上的 `Configure` 按钮可直接跳转打开 Settings——若目标为挂载面板，会自动切换至宿主配置页并将该折叠面板自动展开。

### 5.2 注册插件配置页 (`ctx.registerSettingsPage`)

```tsx
// 独立配置页（默认）
ctx.registerSettingsPage({
  id: 'general',
  title: 'Demo Workbench',
  description: 'Configure refresh rate and display options for Demo Workbench.',
  icon: Puzzle,
  order: 60,
  component: DemoSettingsPage,
});

// 挂载到宿主配置页中的可折叠 Panel
ctx.registerSettingsPage({
  id: 'history',
  title: 'Command History',
  description: 'Configure history entry limits, Command Palette suggestions, and cleanup.',
  icon: History,
  order: 50,
  mountTo: 'lighterm.terminal:terminal',
  defaultExpanded: true,
  component: HistorySettingsPage,
});
```

- `id` (`string`, 必填)：同一插件内唯一标识，最终 Tab 键为 `${pluginId}:${id}`。
- `title` (`string`, 必填)：显示在 Settings 左侧列表/可折叠面板标题栏及页头的标题。
- `description` (`string`, 可选)：配置页或可折叠面板正文顶部的简短说明。
- `icon` (`PluginIconComponent`, 可选)：省略时自动回退为 `PluginDefinition.icon` 或默认拼图图标。
- `order` (`number`, 可选，默认 `100`)：控制插件在导航列表或同一宿主页面挂载面板中的排序位置（内置插件占用 `10`–`50`，建议扩展插件从 `60` 起）。
- `mountTo` (`SettingsMountTarget`, 可选)：省略时注册为独立配置页；传入 `'appearance'`、`'shortcuts'` 或 `'${hostPluginId}:${hostPageId}'` 时，作为可折叠 Panel 挂载至目标配置页底部。
- `defaultExpanded` (`boolean`, 可选，默认 `true`)：仅在指定 `mountTo` 时生效，控制该可折叠 Panel 初始是否展开；通过 Plugin Manager 的 `Configure` 按钮直达时始终临时展开。
- `component` (`React.ComponentType<PluginSettingsPageProps>`, 必填)：接收 `{ pluginId }`。

### 5.3 标准化配置读写与持久化 (`PluginConfig`)
内核为每个插件提供独立的命名空间配置持久化，无需各插件手动拼接 `localStorage` 键或编写单独的后端设置命令：
- **非 React 上下文（插件 `activate` / 服务层）**：
  - `ctx.getConfig(DEFAULT_CONFIG)`：同步读取当前插件配置并与默认值浅合并。
  - `await ctx.updateConfig(patch)`：局部增量更新并持久化，自动通知所有订阅组件刷新。
  - `await ctx.resetConfig(DEFAULT_CONFIG)`：恢复默认配置并清除持久化覆盖。
- **React 组件（视口组件 & Settings 配置页）**：
  - 使用 `usePluginConfig(pluginId, DEFAULT_CONFIG)` Hook 获取 `{ config, updateConfig, resetConfig }`。
- **双端持久化机制**：
  - 浏览器/预览模式：写入 `localStorage` 键 `lighterm:plugin-config:<pluginId>`。
  - Tauri 桌面运行时：同步调用后端 `plugin_config_save` / `plugin_config_reset` 原子写入 `<data_dir>/plugin-configs.json`，并在启动时通过 `plugin_configs_get_all` 自动水合。

> 注意：`DEFAULT_CONFIG` 建议定义为模块级只读常量对象（如 `export const DEFAULT_DEMO_CONFIG = { ... }`），避免每次渲染重建默认值对象。

---

## 6. 插槽（Slots）、命令（Commands）与快捷键规范

### 6.1 可用 UI 插槽（`SlotName`）
- `'topbar:right'`：顶部栏右侧工具区（仅放置高频全局动作图标按钮）。
- `'statusbar:left'`：底部状态栏左侧信息区（如终端行列数徽标）。
- `'statusbar:right'`：底部状态栏右侧快捷入口（如 SFTP、Status 开关按钮）。
- `'host:actions'`：SSH 主机卡片悬停操作区，通过 `render: (context) => ...` 接收 `{ host }`。
- `'settings:tabs'`：**已废弃（Deprecated）**，仅作向后兼容保留；新插件一律使用 `ctx.registerSettingsPage(...)`。

### 6.2 命令面板（Command Palette）
使用 `ctx.registerCommand({ id, group, label, subtitle?, shortcut?, run })` 注册命令。对于随数据变化的动态命令（如片段、历史记录），应在数据变更回调中先清理旧的命令 disposer 再重新注册，并在 `ctx.onCleanup` 中清理全部 disposers。

### 6.3 快捷键监听
若插件需要监听全局快捷键，应在 `activate` 中绑定 `window.addEventListener('keydown', handler)` 并立即通过 `ctx.onCleanup(() => window.removeEventListener('keydown', handler))` 注销，确保禁用插件后快捷键立即失效。

---

## 7. Rust 后端插件开发规范

### 7.1 实现 `CorePlugin` trait（`crates/lighterm-core/src/plugin.rs`）

```rust
use std::any::Any;
use std::sync::Arc;
use lighterm_core::error::CoreResult;
use lighterm_core::plugin::{CoreContext, CorePlugin};

impl CorePlugin for MyBackendPlugin {
    fn id(&self) -> &'static str {
        "acme.demo" // 必须与前端 plugin.id 严格一致且符合命名空间规范
    }

    fn name(&self) -> &'static str {
        "Demo Workbench"
    }

    fn version(&self) -> &'static str {
        "1.0.0"
    }

    fn description(&self) -> &'static str {
        "Backend capability for Demo Workbench"
    }

    fn dependencies(&self) -> &'static [&'static str] {
        &[]
    }

    fn always_on(&self) -> bool {
        false // 设为 true 时核心常驻不可禁用，且其 Settings 页面自动归入 General 区块
    }

    fn on_activate(&self, ctx: &CoreContext) -> CoreResult<()> {
        // 保存所需核心引用（ctx.storage / ctx.ssh_pool / ctx.sessions）
        Ok(())
    }

    fn on_deactivate(&self) -> CoreResult<()> {
        // 清理缓存与会话引用
        Ok(())
    }

    fn on_host_invalidated(&self, _host_id: &str) {
        // 当主机配置被修改或删除时自动回调，清理主机关联缓存
    }

    fn as_any_arc(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}
```

### 7.2 后端插件存储与 Tauri 命令激活态守卫
- **插件业务数据持久化**：使用 `ctx.storage.has_plugin_file`、`read_plugin_json`、`write_plugin_json` 读写插件专属 JSON 文件（如 `snippets.json`、`history.json`）；含敏感信息的文件需传入 `restricted = true` 以在 Unix 上设置 `0600` 权限。
- **插件通用配置持久化**：通用插件配置统一由内核 `plugin-configs.json` 与 `plugin_configs_get_all` / `plugin_config_get` / `plugin_config_save` / `plugin_config_reset` 管理，插件 crate 无需重复实现。
- **命令激活守卫**：所有 Tauri IPC 命令处理器须通过 `state.core.plugins.get_active::<MyBackendPlugin>("acme.demo")?` 获取插件实例；若插件当前处于禁用状态，内核会自动返回 `CoreError::PluginDisabled`，阻止未激活插件被调用。

---

## 8. 完整实战示例与合入自检清单

### 8.1 完整插件模板（含底部视口 + Settings 配置页 + 响应式配置）

```tsx
// src/plugins/quick-notes/index.tsx
import React from 'react';
import { StickyNote, RotateCcw } from 'lucide-react';
import {
  definePlugin,
  usePluginConfig,
  type PluginSettingsPageProps,
  type ViewportComponentProps,
} from '../../harness';

export const NOTES_VIEWPORT_TYPE = 'acme.quick-notes.panel';

export const DEFAULT_NOTES_CONFIG = {
  autoSave: true,
  fontSizePx: 12,
};

const QuickNotesViewport: React.FC<ViewportComponentProps> = () => {
  const { config } = usePluginConfig('acme.quick-notes', DEFAULT_NOTES_CONFIG);
  return (
    <div
      className="flex-1 p-3 bg-[var(--bg-surface)] text-[var(--text-primary)]"
      style={{ fontSize: `${config.fontSizePx}px` }}
    >
      <textarea
        className="w-full h-full resize-none bg-[var(--bg-app)] border border-[var(--border-subtle)] rounded p-2 outline-none focus:border-[var(--accent)]"
        placeholder="Scratchpad notes..."
      />
    </div>
  );
};

const QuickNotesSettingsPage: React.FC<PluginSettingsPageProps> = ({ pluginId }) => {
  const { config, updateConfig, resetConfig } = usePluginConfig(pluginId, DEFAULT_NOTES_CONFIG);
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-[var(--text-primary)]">
        <input
          type="checkbox"
          checked={config.autoSave}
          onChange={(e) => void updateConfig({ autoSave: e.target.checked })}
        />
        <span>Auto-save scratchpad notes</span>
      </label>

      <label className="block">
        <span className="font-semibold text-[var(--text-primary)] block mb-1">
          Editor Font Size ({config.fontSizePx}px)
        </span>
        <input
          type="range"
          min={10}
          max={20}
          value={config.fontSizePx}
          onChange={(e) => void updateConfig({ fontSizePx: Number(e.target.value) })}
          className="w-full accent-[var(--accent)]"
        />
      </label>

      <button
        type="button"
        onClick={() => void resetConfig()}
        className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1"
      >
        <RotateCcw className="w-3 h-3" />
        Reset Defaults
      </button>
    </div>
  );
};

export const quickNotesPlugin = definePlugin({
  id: 'acme.quick-notes',
  name: 'Quick Notes',
  version: '1.0.0',
  description: 'Bottom scratchpad panel for terminal session notes',
  icon: StickyNote,
  author: 'Acme',
  inject: ['core:layout'],
  defaultEnabled: true,

  activate(ctx) {
    const layout = ctx.inject('core:layout');

    ctx.registerViewport({
      typeId: NOTES_VIEWPORT_TYPE,
      title: 'Quick Notes',
      icon: StickyNote,
      defaultPosition: 'bottom',
      defaultDockRatio: 0.7,
      defaultFloatSize: { width: 560, height: 280 },
      singleton: true,
      openOnStartup: false,
      order: 60,
      component: QuickNotesViewport,
    });

    ctx.registerSettingsPage({
      id: 'quick-notes',
      title: 'Quick Notes',
      description: 'Configure scratchpad persistence and editor typography.',
      icon: StickyNote,
      order: 60,
      component: QuickNotesSettingsPage,
    });

    ctx.registerCommand({
      id: 'quick-notes:toggle',
      group: 'Action',
      label: 'Toggle Quick Notes',
      run: () => {
        layout.toggleSingletonViewport({ typeId: NOTES_VIEWPORT_TYPE });
      },
    });
  },
});
```

### 8.2 合入前自检清单（Checklist）
- [ ] `plugin.id` 符合 `<namespace>.<name>` 小写规范，且前后端一致。
- [ ] 使用 `definePlugin` 定义，不向 Core 或 Layout 引擎添加任何插件专属硬编码判断。
- [ ] 未注册 `'core:*'` 保留命名空间服务，且 `viewport.typeId` 全局唯一。
- [ ] 所有 GUI 视口均显式声明了 `defaultPosition`（及合理的 `defaultDockRatio` / `defaultFloatSize` / `openOnStartup`）。
- [ ] 插件配置项通过 `ctx.registerSettingsPage` 接入 Settings（默认独立配置页归入 `Plugins`/`General`，或通过 `mountTo` 作为可折叠 Panel 挂载到指定配置页），并使用 `usePluginConfig` / `ctx.getConfig` / `ctx.updateConfig` 持久化。
- [ ] 所有事件监听、定时器、动态命令与订阅均已通过 `ctx.onCleanup` 或返回值释放；关闭/禁用插件后可干净重新启用。
- [ ] 通过全部验证：`pnpm exec tsc --noEmit`、`pnpm test --run`、`pnpm run build`、`cargo test --workspace`。
