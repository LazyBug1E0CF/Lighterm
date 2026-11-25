import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HostFormModal } from '../components/hosts/HostFormModal';
import { shellService, useShellStore } from '../core/shellService';
import { resetLightermKernelForTesting } from '../plugins';
import type { HostConfig } from '../types';

function makeHost(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    id: overrides.id ?? 'host-1',
    name: overrides.name ?? 'Prod API',
    group: overrides.group ?? 'Production',
    host: overrides.host ?? '10.0.0.10',
    port: overrides.port ?? 22,
    username: overrides.username ?? 'deploy',
    auth: overrides.auth ?? { type: 'password', password: 'secret' },
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

describe('HostFormModal existing group dropdown combobox', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetLightermKernelForTesting();
  });

  it('hides the dropdown toggle when no hosts exist and allows custom free-text group input', async () => {
    render(<HostFormModal />);
    act(() => {
      shellService.openHostModal(null);
    });

    const dialog = await screen.findByRole('dialog', { name: 'New SSH Host' });
    expect(within(dialog).queryByLabelText('Toggle Existing Groups')).toBeNull();

    const groupInput = within(dialog).getByLabelText('Group');
    fireEvent.focus(groupInput);
    expect(within(dialog).queryByRole('listbox', { name: 'Existing Groups' })).toBeNull();

    fireEvent.change(groupInput, { target: { value: 'Sandbox' } });
    fireEvent.change(within(dialog).getByPlaceholderText('192.168.1.50'), {
      target: { value: '10.1.2.3' },
    });
    fireEvent.click(within(dialog).getByText('Save'));

    await waitFor(() => {
      expect(useShellStore.getState().hosts).toHaveLength(1);
      expect(useShellStore.getState().hosts[0]?.group).toBe('Sandbox');
    });
  });

  it('lists all existing groups in dropdown on new host, supports selection, filtering, keyboard nav, and custom input', async () => {
    await shellService.saveHost(makeHost({ id: 'h-prod', name: 'API', group: 'Production' }));
    await shellService.saveHost(makeHost({ id: 'h-stage', name: 'Web', group: 'Staging' }));
    await shellService.saveHost(makeHost({ id: 'h-def', name: 'Jump', group: 'Default' }));

    render(<HostFormModal />);
    act(() => {
      shellService.openHostModal(null);
    });

    const dialog = await screen.findByRole('dialog', { name: 'New SSH Host' });
    const toggleBtn = within(dialog).getByLabelText('Toggle Existing Groups');
    expect(toggleBtn).toBeTruthy();

    // Clicking toggle shows all sorted existing groups even though input starts as 'Default'
    fireEvent.click(toggleBtn);
    const listbox = within(dialog).getByRole('listbox', { name: 'Existing Groups' });
    const options = within(listbox).getAllByRole('option');
    expect(options.map((el) => el.textContent)).toEqual(['Default', 'Production', 'Staging']);

    // Selecting an option updates the input and closes the dropdown
    fireEvent.click(within(listbox).getByRole('option', { name: 'Production' }));
    expect(within(dialog).queryByRole('listbox', { name: 'Existing Groups' })).toBeNull();
    expect((within(dialog).getByLabelText('Group') as HTMLInputElement).value).toBe('Production');

    // Outside mousedown closes open dropdown
    fireEvent.click(toggleBtn);
    expect(within(dialog).getByRole('listbox', { name: 'Existing Groups' })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(within(dialog).queryByRole('listbox', { name: 'Existing Groups' })).toBeNull();

    // Typing filters matching existing groups
    const groupInput = within(dialog).getByLabelText('Group');
    fireEvent.change(groupInput, { target: { value: 'stag' } });
    const filteredList = within(dialog).getByRole('listbox', { name: 'Existing Groups' });
    expect(
      within(filteredList)
        .getAllByRole('option')
        .map((el) => el.textContent),
    ).toEqual(['Staging']);

    // Keyboard Escape closes dropdown cleanly
    fireEvent.keyDown(groupInput, { key: 'Escape' });
    expect(within(dialog).queryByRole('listbox', { name: 'Existing Groups' })).toBeNull();

    // Keyboard ArrowDown + Enter picks highlighted existing group
    fireEvent.change(groupInput, { target: { value: '' } });
    fireEvent.keyDown(groupInput, { key: 'ArrowDown' });
    fireEvent.keyDown(groupInput, { key: 'ArrowDown' });
    fireEvent.keyDown(groupInput, { key: 'Enter' });
    expect((groupInput as HTMLInputElement).value).toBe('Production');

    // Typing a brand-new group hides dropdown and saves the custom group name
    fireEvent.change(groupInput, { target: { value: 'Analytics' } });
    expect(within(dialog).queryByRole('listbox', { name: 'Existing Groups' })).toBeNull();

    fireEvent.change(within(dialog).getByPlaceholderText('192.168.1.50'), {
      target: { value: '10.2.3.4' },
    });
    fireEvent.click(within(dialog).getByText('Save'));

    await waitFor(() => {
      const created = useShellStore.getState().hosts.find((h) => h.host === '10.2.3.4');
      expect(created?.group).toBe('Analytics');
    });
  });

  it('allows changing an edited host group via the existing groups dropdown', async () => {
    const hProd = await shellService.saveHost(
      makeHost({ id: 'h-1', name: 'Worker 1', group: 'Production', host: '10.0.0.21' }),
    );
    await shellService.saveHost(
      makeHost({ id: 'h-2', name: 'DB 1', group: 'Databases', host: '10.0.0.22' }),
    );

    render(<HostFormModal />);
    act(() => {
      shellService.openHostModal(hProd);
    });

    const dialog = await screen.findByRole('dialog', { name: 'Edit SSH Host' });
    const groupInput = within(dialog).getByLabelText('Group') as HTMLInputElement;
    expect(groupInput.value).toBe('Production');

    fireEvent.focus(groupInput);
    const listbox = within(dialog).getByRole('listbox', { name: 'Existing Groups' });
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((el) => el.textContent),
    ).toEqual(['Databases', 'Production']);

    fireEvent.click(within(listbox).getByRole('option', { name: 'Databases' }));
    expect(groupInput.value).toBe('Databases');

    fireEvent.click(within(dialog).getByText('Save'));

    await waitFor(() => {
      const updated = useShellStore.getState().hosts.find((h) => h.id === 'h-1');
      expect(updated?.group).toBe('Databases');
    });
  });
});
