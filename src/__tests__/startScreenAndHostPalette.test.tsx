import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { shellService, useShellStore } from '../core/shellService';
import { layoutService, useLayoutStore } from '../layout/layoutStore';
import { resetLightermKernelForTesting } from '../plugins';

describe('No-Default-Shell Startup, Two-Column Start Screen & Host Palette', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetLightermKernelForTesting();
  });

  it('does not open a local shell on startup or when creating a new workspace', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
    });

    expect(useShellStore.getState().sessionOrder).toHaveLength(0);
    expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(0);
    expect(screen.getByLabelText('Workspace Start Actions')).toBeTruthy();
    expect(screen.getByLabelText('Recent Hosts')).toBeTruthy();

    // Creating a new workspace via the upper "+" button also stays empty without opening a shell
    fireEvent.click(screen.getByLabelText('New Workspace'));
    const workspacesTablist = screen.getByRole('tablist', { name: 'Workspaces' });
    const ws2Tab = await within(workspacesTablist).findByRole('tab', { name: /Workspace 2/i });
    expect(ws2Tab.getAttribute('aria-selected')).toBe('true');
    expect(useShellStore.getState().sessionOrder).toHaveLength(0);
    expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(0);
    expect(screen.getByLabelText('Workspace Start Actions')).toBeTruthy();
  });

  it('displays New Local Shell, Saved Workspaces, and Saved Hosts on the left, and Recent Hosts on the right with persistence', async () => {
    await shellService.saveHost({
      id: 'host-prod-1',
      name: 'Prod API',
      group: 'Production',
      host: '10.0.1.10',
      port: 22,
      username: 'deploy',
      auth: { type: 'password', password: 'secret' },
      updatedAt: Date.now(),
    });
    await shellService.saveHost({
      id: 'host-stage-1',
      name: 'Staging DB',
      group: 'Staging',
      host: '10.0.2.20',
      port: 2222,
      username: 'postgres',
      auth: { type: 'privateKey' },
      updatedAt: Date.now(),
    });
    await shellService.saveWorkspaceRecord({
      id: 'saved-ws-1',
      name: 'Ops Cluster',
      slots: [
        { slotId: 'slot-1', title: 'Prod API', kind: 'ssh', hostId: 'host-prod-1' },
      ],
      dockRoot: { type: 'group', slotIds: ['slot-1'], activeSlotId: 'slot-1' },
      floating: [],
      activeSlotId: 'slot-1',
      layoutPreset: 'tab',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
    });

    const leftCol = screen.getByLabelText('Workspace Start Actions');
    const rightCol = screen.getByLabelText('Recent Hosts');

    expect(within(leftCol).getByLabelText('Create First Local Shell')).toBeTruthy();
    expect(within(leftCol).getByText('Saved Workspaces (1)')).toBeTruthy();
    expect(within(leftCol).getByText('Ops Cluster')).toBeTruthy();
    expect(within(leftCol).getByText('Saved Hosts (2)')).toBeTruthy();
    expect(within(leftCol).getByText('Prod API')).toBeTruthy();
    expect(within(leftCol).getByText('Staging DB')).toBeTruthy();
    expect(within(rightCol).getByText('Recent Hosts (0)')).toBeTruthy();
    expect(within(rightCol).getByText('No recently opened hosts yet.')).toBeTruthy();

    // Connect to Prod API from left column -> records into Recent Hosts and opens terminal
    fireEvent.click(within(leftCol).getByText('Prod API'));
    await waitFor(() => {
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(1);
      expect(useShellStore.getState().recentHosts).toHaveLength(1);
    });

    // Close terminal to return to empty view -> right column now displays Prod API as recent
    fireEvent.click(screen.getByLabelText('Close Prod API'));
    const rightColAfter = await screen.findByLabelText('Recent Hosts');
    expect(within(rightColAfter).getByText('Recent Hosts (1)')).toBeTruthy();
    expect(within(rightColAfter).getByText('Prod API')).toBeTruthy();
    expect(within(rightColAfter).getByText('deploy@10.0.1.10:22')).toBeTruthy();

    // Clicking recent host reconnects
    fireEvent.click(within(rightColAfter).getByText('Prod API'));
    await waitFor(() => {
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(1);
    });
    expect(useShellStore.getState().recentHosts[0]?.connectCount).toBe(2);

    // Close terminal, test opening Saved Workspace from left column
    fireEvent.click(screen.getByLabelText('Close Prod API'));
    const leftColAfter = await screen.findByLabelText('Workspace Start Actions');
    fireEvent.click(within(leftColAfter).getByText('Ops Cluster'));
    await waitFor(() => {
      expect(
        useLayoutStore.getState().workspaces.some((w) => w.savedWorkspaceId === 'saved-ws-1'),
      ).toBe(true);
    });

    // Close workspace to verify Recent Hosts removal and Clear actions
    const workspacesTablist = screen.getByRole('tablist', { name: 'Workspaces' });
    fireEvent.click(within(workspacesTablist).getByLabelText('Close Ops Cluster'));
    await screen.findByLabelText('Recent Hosts');

    // Also add Staging DB via quick/saved connect so we have 2 recent entries
    await act(async () => {
      await shellService.createSshSession({ hostId: 'host-stage-1' });
    });
    fireEvent.click(screen.getByLabelText('Close Staging DB'));
    const rightColTwo = await screen.findByLabelText('Recent Hosts');
    expect(within(rightColTwo).getByText('Recent Hosts (2)')).toBeTruthy();

    // Remove individual recent host entry
    fireEvent.click(within(rightColTwo).getByLabelText('Remove recent host Prod API'));
    await waitFor(() => {
      expect(within(rightColTwo).getByText('Recent Hosts (1)')).toBeTruthy();
      expect(within(rightColTwo).queryByText('Prod API')).toBeNull();
    });

    // Deleting a saved host also prunes its entry from Recent Hosts
    await act(async () => {
      await shellService.deleteHost('host-stage-1');
    });
    await waitFor(() => {
      expect(within(rightColTwo).getByText('Recent Hosts (0)')).toBeTruthy();
    });

    // Quick SSH connect records a recent host, then Clear empties it
    await act(async () => {
      await shellService.quickConnectSsh('alice@bastion.internal:2222');
    });
    fireEvent.click(screen.getByLabelText('Close alice@bastion.internal'));
    const rightColQuick = await screen.findByLabelText('Recent Hosts');
    expect(within(rightColQuick).getByText('alice@bastion.internal')).toBeTruthy();

    fireEvent.click(within(rightColQuick).getByLabelText('Clear Recent Hosts'));
    await waitFor(() => {
      expect(within(rightColQuick).getByText('Recent Hosts (0)')).toBeTruthy();
    });
  });

  it('opens Host Palette from + Shell with recent hosts, saved hosts, local terminals, search, and keyboard nav', async () => {
    await shellService.saveHost({
      id: 'host-edge-1',
      name: 'Edge Gateway',
      group: 'Infra',
      host: '192.168.10.5',
      port: 22,
      username: 'ops',
      auth: { type: 'privateKey' },
      updatedAt: Date.now(),
    });
    await shellService.recordRecentHost(
      {
        id: 'host-edge-1',
        name: 'Edge Gateway',
        group: 'Infra',
        host: '192.168.10.5',
        port: 22,
        username: 'ops',
        auth: { type: 'privateKey' },
        updatedAt: Date.now(),
      },
      true,
    );

    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
    });

    // Click "+ Shell" on the workspace toolbar -> opens Host Palette (not directly creating a shell)
    fireEvent.click(screen.getByLabelText('Open Host Palette'));
    expect(useShellStore.getState().sessionOrder).toHaveLength(0);

    const dialog = await screen.findByRole('dialog', { name: 'Host Palette' });
    expect(within(dialog).getByText('Recent Hosts')).toBeTruthy();
    expect(within(dialog).getByText('Saved Hosts')).toBeTruthy();
    expect(within(dialog).getByText('Local Terminals')).toBeTruthy();

    // Multiple local terminal profiles are listed
    expect(within(dialog).getByText('Windows PowerShell')).toBeTruthy();
    expect(within(dialog).getByText('Command Prompt')).toBeTruthy();

    // Filter to Command Prompt and confirm via Enter
    const searchInput = within(dialog).getByPlaceholderText(
      /Search recent hosts, saved hosts, local terminals/i,
    );
    fireEvent.change(searchInput, { target: { value: 'Command Prompt' } });
    expect(within(dialog).queryByText('Edge Gateway')).toBeNull();
    expect(within(dialog).getByText('Command Prompt')).toBeTruthy();

    fireEvent.keyDown(searchInput, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Host Palette' })).toBeNull();
      expect(useShellStore.getState().sessionOrder).toHaveLength(1);
    });

    const createdId = useShellStore.getState().sessionOrder[0];
    const createdSession = useShellStore.getState().sessions[createdId];
    expect(createdSession?.info.title).toBe('Command Prompt');
    expect(createdSession?.shell).toBe('cmd.exe');

    // Open Host Palette again via the single-group tab bar "+ Shell", test Quick Connect & Escape
    fireEvent.click(screen.getByLabelText('Open Host Palette'));
    const dialog2 = await screen.findByRole('dialog', { name: 'Host Palette' });
    const searchInput2 = within(dialog2).getByPlaceholderText(
      /Search recent hosts, saved hosts, local terminals/i,
    );

    fireEvent.change(searchInput2, { target: { value: 'root@10.9.9.9:2202' } });
    expect(within(dialog2).getByText('Quick Connect')).toBeTruthy();
    expect(within(dialog2).getByText('Connect: root@10.9.9.9:2202')).toBeTruthy();

    fireEvent.keyDown(searchInput2, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Host Palette' })).toBeNull();
  });

  it('defaults + Local Shell to PowerShell 7 when unconfigured and lets user configure Default Local Shell in Settings', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
    });

    // 1. Unconfigured defaultLocalShell -> + Local Shell opens PowerShell 7 (pwsh.exe)
    expect(useShellStore.getState().settings.defaultLocalShell ?? null).toBeNull();
    const firstBtn = screen.getByLabelText('Create First Local Shell');
    expect(firstBtn.getAttribute('title')).toContain('PowerShell 7');
    fireEvent.click(firstBtn);

    await waitFor(() => {
      expect(useShellStore.getState().sessionOrder).toHaveLength(1);
    });
    const autoSessionId = useShellStore.getState().sessionOrder[0];
    expect(useShellStore.getState().sessions[autoSessionId]?.shell).toBe('pwsh.exe');

    // Close terminal to return to empty view
    fireEvent.click(screen.getByLabelText('Close Terminal 1'));
    await screen.findByLabelText('Workspace Start Actions');

    // 2. Open Settings -> Terminal and verify custom Default Local Shell combobox lists Auto (PowerShell 7) & shells
    fireEvent.click(screen.getByLabelText('Settings'));
    const settingsDialog = await screen.findByRole('dialog', { name: 'Settings' });
    const nav = within(settingsDialog).getByRole('navigation', { name: 'Settings Navigation' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Terminal' }));

    const selectTrigger = await within(settingsDialog).findByRole('combobox', {
      name: 'Default Local Shell',
    });
    expect(selectTrigger.textContent).toContain('Auto (PowerShell 7)');

    fireEvent.click(selectTrigger);
    const listbox = await within(settingsDialog).findByRole('listbox', {
      name: 'Default Local Shell options',
    });
    expect(within(listbox).getByRole('option', { name: /Auto \(PowerShell 7\)/i })).toBeTruthy();
    expect(within(listbox).getByRole('option', { name: /^PowerShell 7/i })).toBeTruthy();
    expect(within(listbox).getByRole('option', { name: /^Windows PowerShell/i })).toBeTruthy();
    expect(within(listbox).getByRole('option', { name: /^Command Prompt/i })).toBeTruthy();

    // 3. Switch Default Local Shell to Command Prompt (cmd.exe)
    fireEvent.click(within(listbox).getByRole('option', { name: /Command Prompt/i }));
    await waitFor(() => {
      expect(useShellStore.getState().settings.defaultLocalShell).toBe('cmd.exe');
      expect(selectTrigger.textContent).toContain('Command Prompt');
    });
    fireEvent.click(within(settingsDialog).getByLabelText('Close Settings'));

    // Host Palette reflects Command Prompt as Default and puts it first in Local Terminals
    fireEvent.click(screen.getByLabelText('Open Host Palette'));
    const palette = await screen.findByRole('dialog', { name: 'Host Palette' });
    const cmdRow = within(palette).getByText('Command Prompt').closest('button')!;
    expect(within(cmdRow).getByText('Default')).toBeTruthy();
    fireEvent.keyDown(within(palette).getByRole('textbox'), { key: 'Escape' });

    // Clicking + Local Shell now launches cmd.exe
    const updatedBtn = screen.getByLabelText('Create First Local Shell');
    expect(updatedBtn.getAttribute('title')).toContain('Command Prompt');
    fireEvent.click(updatedBtn);

    await waitFor(() => {
      expect(useShellStore.getState().sessionOrder).toHaveLength(1);
    });
    const cmdSessionId = useShellStore.getState().sessionOrder[0];
    expect(useShellStore.getState().sessions[cmdSessionId]?.shell).toBe('cmd.exe');

    // 4. Reset back to Auto -> reverts to PowerShell 7 (pwsh.exe)
    fireEvent.click(screen.getByLabelText('Close Terminal 1'));
    await screen.findByLabelText('Workspace Start Actions');
    fireEvent.click(screen.getByLabelText('Settings'));
    const settingsDialog2 = await screen.findByRole('dialog', { name: 'Settings' });
    const selectTrigger2 = await within(settingsDialog2).findByRole('combobox', {
      name: 'Default Local Shell',
    });
    fireEvent.click(selectTrigger2);
    const listbox2 = await within(settingsDialog2).findByRole('listbox', {
      name: 'Default Local Shell options',
    });
    fireEvent.click(within(listbox2).getByRole('option', { name: /Auto \(PowerShell 7\)/i }));
    await waitFor(() => {
      expect(useShellStore.getState().settings.defaultLocalShell).toBeNull();
    });
    fireEvent.click(within(settingsDialog2).getByLabelText('Close Settings'));

    fireEvent.click(screen.getByLabelText('Create First Local Shell'));
    await waitFor(() => {
      expect(useShellStore.getState().sessionOrder).toHaveLength(1);
    });
    const revertedId = useShellStore.getState().sessionOrder[0];
    expect(useShellStore.getState().sessions[revertedId]?.shell).toBe('pwsh.exe');
  });

  it('adapts Default Local Shell visibility and options to detected system shells and handles unavailable synced shell', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
    });

    // 1. Single-shell system -> Default Local Shell setting itself is hidden
    act(() => {
      useShellStore.setState({
        localShells: [
          {
            id: 'sh',
            name: 'POSIX Shell',
            shell: '/bin/sh',
            description: 'Standard system shell',
            isDefault: true,
          },
        ],
        localShellsLoaded: true,
      });
    });

    fireEvent.click(screen.getByLabelText('Settings'));
    const settingsDialog = await screen.findByRole('dialog', { name: 'Settings' });
    const nav = within(settingsDialog).getByRole('navigation', { name: 'Settings Navigation' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Terminal' }));

    expect(within(settingsDialog).queryByRole('combobox', { name: 'Default Local Shell' })).toBeNull();
    expect(within(settingsDialog).getByRole('combobox', { name: 'Cursor Style' })).toBeTruthy();

    // 2. Multi-shell Unix system + cross-OS synced unavailable Windows shell -> shows only Unix shells + Unavailable fallback
    await act(async () => {
      await shellService.updateSettings({
        defaultLocalShell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      });
      useShellStore.setState({
        localShells: [
          {
            id: 'bash',
            name: 'Bash',
            shell: '/bin/bash',
            description: 'Bourne Again Shell',
            isDefault: true,
          },
          {
            id: 'zsh',
            name: 'Zsh',
            shell: '/bin/zsh',
            description: 'Z Shell',
            isDefault: false,
          },
        ],
        localShellsLoaded: true,
      });
    });

    const selectTrigger = await within(settingsDialog).findByRole('combobox', {
      name: 'Default Local Shell',
    });
    expect(within(settingsDialog).getByText(/not available on this system/i)).toBeTruthy();

    fireEvent.click(selectTrigger);
    const listbox = await within(settingsDialog).findByRole('listbox', {
      name: 'Default Local Shell options',
    });
    expect(within(listbox).getByRole('option', { name: /Auto \(Bash\)/i })).toBeTruthy();
    expect(within(listbox).getByRole('option', { name: /^Bash/i })).toBeTruthy();
    expect(within(listbox).getByRole('option', { name: /^Zsh/i })).toBeTruthy();
    expect(within(listbox).getByRole('option', { name: /^Unavailable/i })).toBeTruthy();
    expect(within(listbox).queryByRole('option', { name: /Command Prompt/i })).toBeNull();

    // Close Settings and click + Local Shell -> gracefully falls back to /bin/bash instead of nonexistent Windows path
    fireEvent.click(within(settingsDialog).getByLabelText('Close Settings'));
    fireEvent.click(screen.getByLabelText('Create First Local Shell'));

    await waitFor(() => {
      expect(useShellStore.getState().sessionOrder).toHaveLength(1);
    });
    const sid = useShellStore.getState().sessionOrder[0];
    expect(useShellStore.getState().sessions[sid]?.shell).toBe('/bin/bash');
  });

  it('renders + Local Shell as a platform-adaptive split button with a dropmenu on multi-shell systems', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
    });

    // Multi-shell system -> tail chevron button is visible and opens Local Shell Menu
    const splitToggle = screen.getByLabelText('Select Local Shell');
    expect(splitToggle).toBeTruthy();

    fireEvent.click(splitToggle);
    const menu = await screen.findByRole('menu', { name: 'Local Shell Menu' });
    const pwshItem = within(menu).getByRole('menuitem', { name: /PowerShell 7/i });
    expect(within(pwshItem).getByText('Default')).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Command Prompt/i })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Git Bash/i })).toBeTruthy();

    // Selecting Git Bash from the dropmenu opens a Git Bash local session
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Git Bash/i }));
    await waitFor(() => {
      expect(useShellStore.getState().sessionOrder).toHaveLength(1);
      expect(screen.queryByRole('menu', { name: 'Local Shell Menu' })).toBeNull();
    });
    const gitBashId = useShellStore.getState().sessionOrder[0];
    expect(useShellStore.getState().sessions[gitBashId]?.info.title).toBe('Git Bash');
    expect(useShellStore.getState().sessions[gitBashId]?.shell).toBe('bash.exe');

    // Close terminal, switch to single-shell system -> tail chevron button is hidden
    fireEvent.click(screen.getByLabelText('Close Git Bash'));
    await screen.findByLabelText('Workspace Start Actions');

    act(() => {
      useShellStore.setState({
        localShells: [
          {
            id: 'sh',
            name: 'POSIX Shell',
            shell: '/bin/sh',
            description: 'Standard system shell',
            isDefault: true,
          },
        ],
        localShellsLoaded: true,
      });
    });
    expect(screen.queryByLabelText('Select Local Shell')).toBeNull();

    // Multi-shell Unix system -> dropmenu lists only Unix shells and links to Configure Default Shell
    act(() => {
      useShellStore.setState({
        localShells: [
          { id: 'zsh', name: 'Zsh', shell: '/bin/zsh', isDefault: true },
          { id: 'bash', name: 'Bash', shell: '/bin/bash', isDefault: false },
        ],
        localShellsLoaded: true,
      });
    });

    fireEvent.click(screen.getByLabelText('Select Local Shell'));
    const unixMenu = await screen.findByRole('menu', { name: 'Local Shell Menu' });
    expect(within(unixMenu).getByRole('menuitem', { name: /Zsh/i })).toBeTruthy();
    expect(within(unixMenu).getByRole('menuitem', { name: /Bash/i })).toBeTruthy();
    expect(within(unixMenu).queryByRole('menuitem', { name: /PowerShell/i })).toBeNull();

    fireEvent.click(within(unixMenu).getByRole('menuitem', { name: /Configure Default Shell/i }));
    const settingsDialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(await within(settingsDialog).findByRole('combobox', { name: 'Default Local Shell' })).toBeTruthy();
  });
});
