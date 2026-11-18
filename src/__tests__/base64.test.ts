import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, utf8ToBase64 } from '../utils/base64';

describe('base64 binary UTF-8 utilities', () => {
  it('round-trips ASCII and multi-byte Chinese/Emoji UTF-8 text', () => {
    const sample = '你好 Lighterm 终端 🚀 — SSH/SFTP Ready';
    const b64 = utf8ToBase64(sample);
    const bytes = base64ToBytes(b64);
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toBe(sample);
  });

  it('decodes cleanly when multi-byte UTF-8 chunks are split mid-character', () => {
    const sample = '中文测试🚀';
    const fullBytes = base64ToBytes(utf8ToBase64(sample));

    // Re-encode 1-byte and 2-byte arbitrary slices and stream-decode like xterm.js
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let result = '';
    for (let i = 0; i < fullBytes.length; i += 2) {
      const sliceB64 = bytesToBase64(fullBytes.subarray(i, i + 2));
      const chunk = base64ToBytes(sliceB64);
      result += decoder.decode(chunk, { stream: true });
    }
    result += decoder.decode();
    expect(result).toBe(sample);
    expect(result).not.toContain('\uFFFD');
  });
});
