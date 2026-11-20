import { create } from 'zustand';
import type { ShellService } from '../../core/shellService';
import type { LayoutService } from '../../layout/layoutStore';
import { useLayoutStore } from '../../layout/layoutStore';
import type { HostConfig, SplitDirection } from '../../types';

export const TERMINAL_VIEWPORT_TYPE = 'terminal.viewport';

export const useTerminalPluginStore = create<{ searchSignal: number }>(() => ({
  searchSignal: 0,
}));

export class TerminalPluginService {
  constructor(
    private shell: ShellService,
    private layout: LayoutService,
  ) {}

  async splitActive(direction: SplitDirection, explicitHost?: HostConfig): Promise<void> {
    const layoutState = useLayoutStore.getState();
    const activeVp = layoutState.activeViewportId
      ? layoutState.viewports[layoutState.activeViewportId]
      : undefined;

    const terminalVps = this.layout.findViewportsByType(TERMINAL_VIEWPORT_TYPE);
    const targetVp =
      activeVp?.typeId === TERMINAL_VIEWPORT_TYPE ? activeVp : terminalVps[terminalVps.length - 1];

    if (!targetVp) {
      if (explicitHost) {
        await this.shell.createSshSession({ hostId: explicitHost.id, hostConfig: explicitHost });
      } else {
        await this.shell.createLocalSession();
      }
      return;
    }

    const sessionId = String(targetVp.params?.sessionId ?? '');
    const existingSession = this.shell.getSession(sessionId);
    const targetHost =
      explicitHost ??
      (existingSession?.info.kind === 'ssh'
        ? existingSession.hostConfig ??
          (existingSession.hostId
            ? this.shell
                .listSessions()
                .find((s) => s.hostId === existingSession.hostId)?.hostConfig
            : undefined)
        : undefined);

    const meta = {
      splitFromViewportId: targetVp.id,
      splitDirection: direction,
    };

    if (targetHost) {
      await this.shell.createSshSession({
        hostId: targetHost.id || undefined,
        hostConfig: targetHost,
        cols: 80,
        rows: 24,
        meta,
      });
    } else {
      await this.shell.createLocalSession({
        cols: 80,
        rows: 24,
        title: 'Local Shell',
        meta,
      });
    }
  }

  triggerSearch(): void {
    useTerminalPluginStore.setState((s) => ({ searchSignal: s.searchSignal + 1 }));
  }

  cycleTerminalViewport(delta: 1 | -1): void {
    const terminalVps = this.layout.findViewportsByType(TERMINAL_VIEWPORT_TYPE);
    if (terminalVps.length <= 1) return;
    const activeId = useLayoutStore.getState().activeViewportId;
    const idx = terminalVps.findIndex((v) => v.id === activeId);
    const base = idx < 0 ? 0 : idx;
    const next = terminalVps[(base + delta + terminalVps.length) % terminalVps.length];
    this.layout.setActiveViewport(next.id);
    const sid = String(next.params?.sessionId ?? '');
    if (sid) this.shell.setActiveSession(sid);
  }

  closeActiveTerminal(): void {
    const activeId = useLayoutStore.getState().activeViewportId;
    if (!activeId) return;
    const vp = this.layout.getViewport(activeId);
    if (vp?.typeId === TERMINAL_VIEWPORT_TYPE) {
      this.layout.closeViewport(vp.id);
    }
  }
}
