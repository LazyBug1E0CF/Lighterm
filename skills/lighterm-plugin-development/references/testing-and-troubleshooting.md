# Testing & Troubleshooting Guide

Standard Vitest + Rust test templates and fixes for the most common Lighterm plugin bugs.

---

## 1. Frontend Testing Recipe (Vitest + React Testing Library)

Lighterm uses **Vitest** with `jsdom` (`src/__tests__/setup.ts` already sets up mocks/canvas stubs). Place plugin tests in `src/__tests__/<pluginName>.test.tsx`.

### Standard Harness Unit / Layout Integration Test
```tsx
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import { harnessKernel } from '../harness';
import { layoutService, useLayoutStore } from '../layout/layoutStore';
import { bootstrapLightermHarness, resetLightermHarnessForTesting } from '../plugins';
import { MY_VIEWPORT_TYPE } from '../plugins/my-plugin';

describe('acme.my-plugin', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetLightermHarnessForTesting();
  });

  it('opens at registered defaultPosition and returns on Reset Layout', async () => {
    await bootstrapLightermHarness();

    let vpId = '';
    act(() => {
      const vp = layoutService.toggleSingletonViewport({ typeId: MY_VIEWPORT_TYPE });
      vpId = vp!.id;
    });

    expect(layoutService.getViewportLocation(vpId)).toBe('docked'); // e.g. for 'bottom'

    act(() => {
      layoutService.floatViewport(vpId);
      layoutService.resetLayoutPreservingViewports();
    });

    expect(layoutService.getViewportLocation(vpId)).toBe('docked');
  });
});
```

### Standard Settings UI & Disable/Re-enable Test (`render(<App />)`)
```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { useShellStore } from '../core/shellService';

it('renders Settings page in expected section, persists config, and disables cleanly', async () => {
  render(<App />);

  await waitFor(() => {
    expect(useShellStore.getState().initialized).toBe(true);
    expect(harnessKernel.isPluginActive('acme.my-plugin')).toBe(true);
  });

  fireEvent.click(screen.getByLabelText('Settings'));
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  const nav = within(dialog).getByRole('navigation', { name: 'Settings Navigation' });
  const section = within(nav).getByRole('group', {
    name: 'Plugin Settings', // Use 'General Settings' for alwaysOn: true plugins
  });

  fireEvent.click(within(section).getByRole('button', { name: 'My Plugin' }));
  expect(dialog.querySelector('[data-plugin-settings-header="acme.my-plugin"]')).toBeTruthy();

  // Exercise disable -> tab disappears and UI falls back cleanly to Appearance
  await act(async () => {
    await harnessKernel.disablePlugin('acme.my-plugin');
  });
  await waitFor(() => {
    expect(within(section).queryByRole('button', { name: 'My Plugin' })).toBeNull();
  });

  // Re-enable -> everything comes back without errors or duplicate registrations
  await act(async () => {
    await harnessKernel.enablePlugin('acme.my-plugin');
  });
  expect(await within(section).findByRole('button', { name: 'My Plugin' })).toBeTruthy();
});
```

---

## 2. Rust Backend Testing Recipe (`crates/plugins/<name>/src/lib.rs`)

Add `tempfile = "3"` under `[dev-dependencies]` in `crates/plugins/<name>/Cargo.toml`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use lighterm_core::error::CoreError;
    use lighterm_core::LightermCore;
    use tempfile::tempdir;

    #[test]
    fn plugin_lifecycle_storage_and_disable_guard() {
        let dir = tempdir().unwrap();
        let core = LightermCore::with_data_dir(dir.path().to_path_buf()).unwrap();
        let plugin = Arc::new(MyPlugin::new());

        core.register_plugin(plugin.clone()).unwrap();
        assert!(core.plugins.is_active("acme.my-plugin"));

        let active = core.plugins.get_active::<MyPlugin>("acme.my-plugin");
        assert!(active.is_ok());

        // Disabling invokes on_deactivate and blocks get_active
        core.plugins
            .set_enabled("acme.my-plugin", false, &core.context())
            .unwrap();
        assert!(!core.plugins.is_active("acme.my-plugin"));
        assert!(matches!(
            core.plugins.get_active::<MyPlugin>("acme.my-plugin"),
            Err(CoreError::PluginDisabled(_))
        ));
    }
}
```

---

## 3. Verification Commands

Run these from the repository root after edits:

```bash
# 1. TypeScript strict check
pnpm exec tsc --noEmit

# 2. Frontend unit & integration tests
pnpm test --run

# 3. Production frontend bundle check
pnpm run build

# 4. Rust workspace unit & integration tests (whenever Cargo.toml, crates/, or src-tauri/ changed)
cargo test --workspace
```

### Windows PowerShell Environment Notes
- If PowerShell `ExecutionPolicy` blocks `pnpm.ps1`, invoke **`pnpm.cmd`** (`pnpm.cmd exec tsc --noEmit`, `pnpm.cmd test --run`, `pnpm.cmd run build`).
- Windows PowerShell 5.1 does not support `&&`. Run commands sequentially or chain with `; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE };`.

---

## 4. Common Pitfalls & Fixes

| Symptom | Cause | Fix |
| --- | --- | --- |
| React error `#185` (`Maximum update depth exceeded`) or constant re-renders with `usePluginConfig` | Passed inline object literal `{ foo: 1 }` as `defaults` argument | Hoist `DEFAULT_<NAME>_CONFIG` to a module-level `const` outside components |
| Startup drawer plugin missing until after async load / wrong drawer order | `ctx.registerViewport(...)` was placed after an `await` inside `activate` | Keep all `registerViewport`, `registerSettingsPage`, `registerSlot`, and `registerCommand` calls synchronous at the top of `activate(ctx)` |
| Clicking button/input inside a viewport tab/card accidentally starts dragging the panel | Outer viewport header listens to `onPointerDown` for floating/dock dragging | Add `onPointerDown={(e) => e.stopPropagation()}` or `data-no-drag="true"` on interactive controls |
| Plugin works on Tauri desktop, throws or stalls in Vitest / browser preview | Code called `invokeTauri(...)` directly without checking `isTauriRuntime()` | Guard every Tauri call with `if (isTauriRuntime()) { ... } else { /* mock/localStorage */ }` |
| Second Vitest test fails with stale plugin data or duplicated commands | Plugin store/client module state was not cleared between tests | Export a `resetForTesting()` helper on your client store and call it inside `resetLightermHarnessForTesting()` in `src/plugins/index.ts` |
| Plugin toggle state snaps back or backend errors with `PluginDisabled` on Tauri | `PluginDefinition.id` != `CorePlugin::id()`, or `alwaysOn` differs between TS and Rust | Keep `id` and `alwaysOn` identical in both `definePlugin(...)` and `impl CorePlugin` |
| `Tauri command` returns invalid args or `missing required key hostId` | Rust used `snake_case` param `host_id` and JS passed `{ host_id }` instead of `{ hostId }` | Tauri v2 converts Rust `snake_case` argument names to JS `camelCase` automatically |
