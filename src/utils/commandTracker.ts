const PASSWORD_PROMPT_RE = /(?:password|passphrase|pin|passcode|verification code)[^\r\n:]*:\s*$/i;
const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

export class CommandTracker {
  private buffer = '';
  private recentOutputTail = '';

  feedOutput(chunk: Uint8Array): void {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(chunk);
    const cleaned = text.replace(ANSI_ESCAPE_RE, '');
    const combined = this.recentOutputTail + cleaned;
    this.recentOutputTail = combined.slice(-160);
  }

  feedInput(data: string): string[] {
    const submitted: string[] = [];

    for (let i = 0; i < data.length; i++) {
      const ch = data[i];

      // Ignore CSI/escape sequences (arrow keys, etc.)
      if (ch === '\x1b') {
        if (data[i + 1] === '[' || data[i + 1] === 'O') {
          i += 2;
          while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) <= 0x3f) {
            i++;
          }
        }
        continue;
      }

      if (ch === '\r' || ch === '\n') {
        const line = this.buffer.trim();
        this.buffer = '';
        if (line.length > 0 && !this.isSensitivePrompt()) {
          submitted.push(line);
        }
        continue;
      }

      // Backspace / DEL
      if (ch === '\x7f' || ch === '\b') {
        this.buffer = this.buffer.slice(0, -1);
        continue;
      }

      // Ctrl+C (\x03) or Ctrl+U (\x15) clears current line
      if (ch === '\x03' || ch === '\x15') {
        this.buffer = '';
        continue;
      }

      // Ignore other ASCII control chars except tab
      const code = ch.charCodeAt(0);
      if (code < 0x20 && ch !== '\t') {
        continue;
      }

      this.buffer += ch;
    }

    return submitted;
  }

  private isSensitivePrompt(): boolean {
    const trimmedTail = this.recentOutputTail.trimEnd();
    return PASSWORD_PROMPT_RE.test(trimmedTail);
  }
}
