import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { SLOW_RENAME_MIN_DELAY_MS } from '../components/shell/ShellTopBar';
import { shellService, useShellStore } from '../core/shellService';
import { windowControls } from '../core/windowControls';
import { workspaceManager } from '../core/workspaceManager';
import { collectGroups } from '../layout/dockTree';
import { layoutService, useLayoutStore } from '../layout/layoutStore';
import { resetLightermHarnessForTesting } from '../plugins';

describe('Workspace Rename, Save, Hosts Discovery & Layout Restoration', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetLightermHarnessForTesting();
  });

  it('renames, saves, captures closing layout changes, and re-opens terminals with exact layout from Hosts plugin', async () => {
    await shellService.saveHost({
      id: 'host-prod-1',
      name: 'prod-api',
      group: 'Production',
      host: '10.0.1.10',
      port: 22,
      username: 'deploy',
      auth: { type: 'password', password: 'secret' },
      updatedAt: Date.now(),
    });

    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(1);
    });

    // Rename live Workspace 1 via inline Rename button in ShellTopBar
    const workspacesTablist = screen.getByRole('tablist', { name: 'Workspaces' });
    fireEvent.click(within(workspacesTablist).getByLabelText('Rename Workspace 1'));
    const renameInput = within(workspacesTablist).getByLabelText('Rename Workspace');
    fireEvent.change(renameInput, { target: { value: 'Backend Ops' } });
    fireEvent.keyDown(renameInput, { key: 'Enter' });

    await waitFor(() => {
      expect(useLayoutStore.getState().workspaces[0]?.name).toBe('Backend Ops');
    });

    // Open an SSH host terminal in Backend Ops and arrange side-by-side split
    await act(async () => {
      await shellService.createSshSession({ hostId: 'host-prod-1' });
    });

    await waitFor(() => {
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(2);
    });

    act(() => {
      layoutService.arrangeWorkspaceShells('hsp');
    });

    // Save Backend Ops via ShellTopBar Save button
    fireEvent.click(within(workspacesTablist).getByLabelText('Save Backend Ops'));

    // Hosts viewport (active in Left Side Drawer) displays Saved Workspaces section
    const leftDrawer = screen.getByLabelText('Left Side Drawer');
    await waitFor(() => {
      expect(within(leftDrawer).getByText('Saved Workspaces (1)')).toBeTruthy();
      expect(within(leftDrawer).getByText('Backend Ops')).toBeTruthy();
      expect(within(leftDrawer).getByText(/2 terminals · HSP/i)).toBeTruthy();
      expect(within(leftDrawer).getByText('Open')).toBeTruthy();
    });

    // Modify Backend Ops AFTER saving: add a 3rd terminal, switch to VSP, adjust split ratio
    await act(async () => {
      await shellService.createLocalSession({ title: 'Logs Tail' });
    });

    await waitFor(() => {
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(3);
    });

    act(() => {
      layoutService.arrangeWorkspaceShells('vsp');
      const root = useLayoutStore.getState().dockRoot;
      if (root?.type === 'split') {
        layoutService.setSplitRatio(root.id, 0.36);
      }
    });

    // Open a second workspace so Backend Ops tab has a Close button, then close Backend Ops
    act(() => {
      layoutService.createWorkspace('Scratch');
    });

    const backendWs = useLayoutStore
      .getState()
      .workspaces.find((w) => w.name === 'Backend Ops');
    expect(backendWs).toBeTruthy();
    const expectedSavedId = backendWs!.savedWorkspaceId!;

    fireEvent.click(within(workspacesTablist).getByLabelText('Close Backend Ops'));

    // Closing must capture the updated VSP + 3 terminals + 0.36 ratio automatically
    await waitFor(() => {
      expect(
        useLayoutStore.getState().workspaces.some((w) => w.name === 'Backend Ops'),
      ).toBe(false);
      const persisted = useShellStore
        .getState()
        .savedWorkspaces.find((w) => w.id === expectedSavedId);
      expect(persisted).toBeTruthy();
      expect(persisted?.slots).toHaveLength(3);
      expect(persisted?.layoutPreset).toBe('vsp');
      expect(persisted?.dockRoot?.type).toBe('split');
      if (persisted?.dockRoot?.type === 'split') {
        expect(persisted.dockRoot.direction).toBe('horizontal');
        expect(persisted.dockRoot.ratio).toBeCloseTo(0.36, 2);
      }
      expect(within(leftDrawer).getByText(/3 terminals · VSP/i)).toBeTruthy();
    });

    const sessionsBeforeReopen = Object.keys(useShellStore.getState().sessions).length;

    // Click Open Workspace inside Hosts plugin
    fireEvent.click(within(leftDrawer).getByLabelText('Open Workspace Backend Ops'));

    await waitFor(() => {
      const state = useLayoutStore.getState();
      const reopened = state.workspaces.find((w) => w.savedWorkspaceId === expectedSavedId);
      expect(reopened).toBeTruthy();
      expect(state.activeWorkspaceId).toBe(reopened!.id);
      expect(state.activeLayoutPreset).toBe('vsp');

      // Exact terminal count restored with no duplicate auto-opened tabs
      const reopenedViewports = layoutService.findWorkspaceViewportsByType('terminal.viewport');
      expect(reopenedViewports).toHaveLength(3);
      expect(Object.keys(useShellStore.getState().sessions).length).toBe(
        sessionsBeforeReopen + 3,
      );

      // Exact split tree structure, direction, ratio, and group layout restored
      expect(state.dockRoot?.type).toBe('split');
      if (state.dockRoot?.type === 'split') {
        expect(state.dockRoot.direction).toBe('horizontal');
        expect(state.dockRoot.ratio).toBeCloseTo(0.36, 2);
      }
      const groups = collectGroups(state.dockRoot);
      expect(groups).toHaveLength(3);

      // Verify SSH session slot re-bound to host-prod-1
      const sessions = useShellStore.getState().sessions;
      const reopenedSsh = reopenedViewports.some((vp) => {
        const sid = String(vp.params?.sessionId ?? '');
        return sessions[sid]?.info.kind === 'ssh' && sessions[sid]?.hostId === 'host-prod-1';
      });
      expect(reopenedSsh).toBe(true);
    });

    // Rename saved workspace from Hosts plugin and confirm live workspace tab syncs
    fireEvent.click(within(leftDrawer).getByLabelText('Rename Saved Workspace Backend Ops'));
    const savedRenameInput = within(leftDrawer).getByLabelText('Rename Saved Workspace');
    fireEvent.change(savedRenameInput, { target: { value: 'Core Prod' } });
    fireEvent.keyDown(savedRenameInput, { key: 'Enter' });

    await waitFor(() => {
      expect(
        useLayoutStore.getState().workspaces.some((w) => w.name === 'Core Prod'),
      ).toBe(true);
      expect(within(workspacesTablist).getByRole('tab', { name: /Core Prod/i })).toBeTruthy();
    });

    // Modify layout again and flush on window close
    act(() => {
      layoutService.arrangeWorkspaceShells('grid');
      windowControls.close();
    });

    await waitFor(() => {
      const flushed = useShellStore
        .getState()
        .savedWorkspaces.find((w) => w.id === expectedSavedId);
      expect(flushed?.layoutPreset).toBe('grid');
      expect(flushed?.name).toBe('Core Prod');
    });

    // Delete saved workspace from Hosts plugin and confirm live workspace is unlinked
    fireEvent.click(within(leftDrawer).getByLabelText('Delete Workspace Core Prod'));

    await waitFor(() => {
      expect(useShellStore.getState().savedWorkspaces).toHaveLength(0);
      const unlinked = useLayoutStore
        .getState()
        .workspaces.find((w) => w.name === 'Core Prod');
      expect(unlinked?.savedWorkspaceId).toBeNull();
    });
  });

  it('persists across workspaceManager re-initialization via localStorage and focuses already-open workspace without duplicating tabs', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
    });

    await act(async () => {
      await shellService.createLocalSession({ title: 'API Watch' });
    });

    let savedId = '';
    await act(async () => {
      const saved = await workspaceManager.saveWorkspace(undefined, 'API Cluster');
      savedId = saved.id;
    });

    // Clicking Open when already open selects the workspace instead of duplicating it
    const wsCountBefore = useLayoutStore.getState().workspaces.length;
    await act(async () => {
      await workspaceManager.openSavedWorkspace(savedId);
    });
    expect(useLayoutStore.getState().workspaces).toHaveLength(wsCountBefore);
    expect(useShellStore.getState().savedWorkspaces.some((w) => w.id === savedId)).toBe(true);

    // Closing a sole saved workspace resets the empty placeholder tab to Workspace 1
    const workspacesTablist = screen.getByRole('tablist', { name: 'Workspaces' });
    fireEvent.click(within(workspacesTablist).getByLabelText('Close API Cluster'));

    await waitFor(() => {
      const list = useLayoutStore.getState().workspaces;
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('Workspace 1');
      expect(list[0].savedWorkspaceId).toBeNull();
    });

    // Re-opening from Hosts viewport reuses the empty Workspace 1 slot cleanly
    const leftDrawer = screen.getByLabelText('Left Side Drawer');
    fireEvent.click(within(leftDrawer).getByLabelText('Open Workspace API Cluster'));

    await waitFor(() => {
      const list = useLayoutStore.getState().workspaces;
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('API Cluster');
      expect(list[0].savedWorkspaceId).toBe(savedId);
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(2);
    });
  });

  it('supports hover-only rename/save tab buttons, right-click context menu rename, and slow consecutive two-click rename without double-click trigger', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
    });

    const workspacesTablist = screen.getByRole('tablist', { name: 'Workspaces' });

    // 1. Rename & Save buttons are hidden by default and only revealed on group hover
    const renameBtn = within(workspacesTablist).getByLabelText('Rename Workspace 1');
    const saveBtn = within(workspacesTablist).getByLabelText('Save Workspace 1');
    expect(renameBtn.className).toContain('hidden');
    expect(renameBtn.className).toContain('group-hover:inline-flex');
    expect(saveBtn.className).toContain('hidden');
    expect(saveBtn.className).toContain('group-hover:inline-flex');

    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(useShellStore.getState().savedWorkspaces).toHaveLength(1);
    });
    const savedBtnAfter = within(workspacesTablist).getByLabelText('Save Workspace 1');
    expect(savedBtnAfter.className).toContain('hidden');
    expect(savedBtnAfter.className).toContain('group-hover:inline-flex');

    // 2. Right-click context menu Rename & Escape dismissal
    const wsTab = within(workspacesTablist).getByRole('tab', { name: /Workspace 1/i });
    fireEvent.contextMenu(wsTab, { clientX: 120, clientY: 28 });

    const menu = screen.getByRole('menu', { name: 'Workspace Tab Context Menu' });
    expect(menu).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Workspace Tab Context Menu' })).toBeNull();

    fireEvent.contextMenu(wsTab, { clientX: 120, clientY: 28 });
    const reopenedMenu = screen.getByRole('menu', { name: 'Workspace Tab Context Menu' });
    fireEvent.click(within(reopenedMenu).getByRole('menuitem', { name: /Rename/i }));

    const ctxRenameInput = within(workspacesTablist).getByLabelText('Rename Workspace');
    fireEvent.change(ctxRenameInput, { target: { value: 'Staging Env' } });
    fireEvent.keyDown(ctxRenameInput, { key: 'Enter' });

    await waitFor(() => {
      expect(useLayoutStore.getState().workspaces[0]?.name).toBe('Staging Env');
    });

    // 3. Fast double-click must NOT trigger rename; slow consecutive two clicks must trigger rename
    const stagingTab = within(workspacesTablist).getByRole('tab', { name: /Staging Env/i });
    fireEvent.click(stagingTab, { detail: 1 });
    fireEvent.click(stagingTab, { detail: 2 });
    fireEvent.doubleClick(stagingTab);
    expect(within(workspacesTablist).queryByLabelText('Rename Workspace')).toBeNull();

    let nowMs = 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      fireEvent.click(stagingTab, { detail: 1 });
      expect(within(workspacesTablist).queryByLabelText('Rename Workspace')).toBeNull();

      nowMs += SLOW_RENAME_MIN_DELAY_MS + 150;
      fireEvent.click(stagingTab, { detail: 1 });

      const slowInput = within(workspacesTablist).getByLabelText('Rename Workspace');
      fireEvent.change(slowInput, { target: { value: 'Prod Cluster' } });
      fireEvent.keyDown(slowInput, { key: 'Enter' });
    } finally {
      nowSpy.mockRestore();
    }

    await waitFor(() => {
      expect(useLayoutStore.getState().workspaces[0]?.name).toBe('Prod Cluster');
    });
  });
});
