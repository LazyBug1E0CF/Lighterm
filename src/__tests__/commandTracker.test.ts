import { describe, expect, it } from 'vitest';
import { CommandTracker } from '../utils/commandTracker';

const enc = new TextEncoder();

describe('CommandTracker', () => {
  it('captures normal commands and handles backspace and Ctrl+C', () => {
    const tracker = new CommandTracker();
    tracker.feedOutput(enc.encode('user@host:~$ '));

    expect(tracker.feedInput('ls -l')).toEqual([]);
    expect(tracker.feedInput('\x7fa\r')).toEqual(['ls -a']);

    expect(tracker.feedInput('rm -rf /tmp/test')).toEqual([]);
    // Ctrl+C cancels line
    expect(tracker.feedInput('\x03echo ok\n')).toEqual(['echo ok']);
  });

  it('suppresses recording when prompt asks for a password', () => {
    const tracker = new CommandTracker();
    tracker.feedOutput(enc.encode('[sudo] password for lmmmd: '));
    expect(tracker.feedInput('my-secret-pass\r')).toEqual([]);

    tracker.feedOutput(enc.encode('\r\nuser@host:~$ '));
    expect(tracker.feedInput('uname -a\r')).toEqual(['uname -a']);
  });
});
