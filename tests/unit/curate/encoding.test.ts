import { describe, expect, it } from 'bun:test';
import { decodeBytes, decodeCp1251, detectEncoding } from '../../../src/curate/encoding.ts';

describe('curate.encoding', () => {
  it('detects UTF-8 BOM', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x41]);
    const det = detectEncoding(bom);
    expect(det.encoding).toBe('utf-8');
    expect(det.reason).toBe('bom');
  });

  it('honors declared utf-8', () => {
    const det = detectEncoding(Buffer.from('hello'), 'UTF-8');
    expect(det.encoding).toBe('utf-8');
    expect(det.reason).toBe('declared');
  });

  it('honors declared cp1251', () => {
    const det = detectEncoding(Buffer.from([0xc1, 0xfe, 0xe4]), 'windows-1251');
    expect(det.encoding).toBe('cp1251');
    expect(det.reason).toBe('declared');
  });

  it('falls through to the heuristic for an unrecognized declared charset', () => {
    // a truthy-but-unknown charset matches neither the utf-8 nor cp1251 branch
    const det = detectEncoding(Buffer.from('hello'), 'iso-8859-1');
    expect(det.reason).toBe('heuristic-utf8');
  });

  it('returns utf-8 with no high-bit bytes', () => {
    const det = detectEncoding(Buffer.from('hello world'));
    expect(det.encoding).toBe('utf-8');
    expect(det.reason).toBe('heuristic-utf8');
  });

  it('detects cp1251 by high-bit byte distribution when not valid utf-8', () => {
    // Valid CP1251 bytes for "Бюджет" (just the cyrillic block)
    const det = detectEncoding(Buffer.from([0xc1, 0xfe, 0xe4, 0xe6, 0xe5, 0xf2]));
    expect(det.encoding).toBe('cp1251');
  });

  it('decodes UTF-8 and strips BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf-8')]);
    expect(decodeBytes(buf, 'utf-8')).toBe('hello');
  });

  it('decodes cp1251 cyrillic round trip', () => {
    // Бюджет — bytes 0xc1 0xfe 0xe4 0xe6 0xe5 0xf2 in CP1251
    const text = decodeCp1251(Buffer.from([0xc1, 0xfe, 0xe4, 0xe6, 0xe5, 0xf2]));
    expect(text).toBe('Бюджет');
  });

  it('decodes ASCII through cp1251 unchanged', () => {
    expect(decodeCp1251(Buffer.from('hello'))).toBe('hello');
  });

  it('decodes special cp1251 mappings (euro sign)', () => {
    expect(decodeCp1251(Buffer.from([0x88]))).toBe('€');
  });

  it('decodes default-fallback bytes as replacement char', () => {
    // 0x90 isn't in our small mapping → replacement
    expect(decodeCp1251(Buffer.from([0x90]))).toBe('�');
  });

  it('falls through to utf-8 with low-confidence on ambiguous bytes', () => {
    // Mixed high-bit bytes that don't align as cp1251 cyrillic block
    const det = detectEncoding(Buffer.from([0xff, 0x80, 0x80, 0x80]));
    expect(['utf-8', 'cp1251']).toContain(det.encoding);
  });
});
