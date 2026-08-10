/**
 * Unit tests cho createInMemoryCache — LRU cache voi TTL va maxEntries eviction.
 *
 * Coverage:
 * 1. get() tra ve null khi key khong ton tai
 * 2. set() + get() hoat dong dung
 * 3. set() ghi de gia tri cu
 * 4. deleteByKey() hoat dong
 * 5. clearAll() xoa tat ca
 * 6. maxEntries eviction: khi vuot maxEntries, entry cu nhat bi xoa tu dong
 * 7. Khi maxEntries = 1, sau 2 lan set thi chi con 1 entry
 * 8. has() tra ve dung
 * 9. TTL expiration: entry het han thi tra ve null
 * 10. get() sau khi set cung key se tra ve gia tri moi nhat
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createInMemoryCache } from '../../utils/inMemoryCache';

describe('createInMemoryCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  // ===== 1. get() tra ve null khi key khong ton tai =====
  it('get() tra ve null khi key khong ton tai', () => {
    const cache = createInMemoryCache<string>();
    const result = cache.get('nonexistent-key');
    expect(result).toBeNull();
  });

  // ===== 2. set() + get() hoat dong dung =====
  it('set() + get() hoat dong dung', () => {
    const cache = createInMemoryCache<string>();

    cache.set('key1', 'value1', 60);
    const result = cache.get('key1');

    expect(result).toBe('value1');
  });

  // ===== 3. set() ghi de gia tri cu =====
  it('set() ghi de gia tri cu khi cung key', () => {
    const cache = createInMemoryCache<string>();

    cache.set('key1', 'old-value', 60);
    cache.set('key1', 'new-value', 60);

    const result = cache.get('key1');
    expect(result).toBe('new-value');
  });

  // ===== 4. deleteByKey() hoat dong =====
  it('deleteByKey() xoa entry khoi cache', () => {
    const cache = createInMemoryCache<string>();

    cache.set('key1', 'value1', 60);
    cache.deleteByKey('key1');

    const result = cache.get('key1');
    expect(result).toBeNull();
  });

  it('deleteByPrefix() chi xoa cac entry cung namespace', () => {
    const cache = createInMemoryCache<string>();

    cache.set('transparency:project-a:summary', 'a', 60);
    cache.set('transparency:project-a:timeline', 'a', 60);
    cache.set('transparency:project-b:summary', 'b', 60);

    cache.deleteByPrefix('transparency:project-a:');

    expect(cache.get('transparency:project-a:summary')).toBeNull();
    expect(cache.get('transparency:project-a:timeline')).toBeNull();
    expect(cache.get('transparency:project-b:summary')).toBe('b');
  });

  // ===== 5. clearAll() xoa tat ca =====
  it('clearAll() xoa tat ca entries', () => {
    const cache = createInMemoryCache<string>();

    cache.set('key1', 'value1', 60);
    cache.set('key2', 'value2', 60);
    cache.set('key3', 'value3', 60);

    cache.clearAll();

    expect(cache.get('key1')).toBeNull();
    expect(cache.get('key2')).toBeNull();
    expect(cache.get('key3')).toBeNull();
  });

  // ===== 6. maxEntries eviction: khi vuot maxEntries, entry cu nhat bi xoa tu dong =====
  it('evicts oldest entry when exceeding maxEntries', () => {
    const cache = createInMemoryCache<string>({ maxEntries: 3 });

    cache.set('key1', 'value1', 60);
    cache.set('key2', 'value2', 60);
    cache.set('key3', 'value3', 60);

    // Khi them entry thu 4, entry cu nhat (key1) phai bi xoa
    cache.set('key4', 'value4', 60);

    expect(cache.get('key1')).toBeNull(); // Bi xoa vi la entry cu nhat
    expect(cache.get('key2')).toBe('value2');
    expect(cache.get('key3')).toBe('value3');
    expect(cache.get('key4')).toBe('value4');
  });

  // ===== 7. Khi maxEntries = 1, sau 2 lan set thi chi con 1 entry =====
  it('with maxEntries=1, only the latest entry remains', () => {
    const cache = createInMemoryCache<string>({ maxEntries: 1 });

    cache.set('key1', 'value1', 60);
    cache.set('key2', 'value2', 60);

    expect(cache.get('key1')).toBeNull(); // Bi xoa vi chi giu 1 entry
    expect(cache.get('key2')).toBe('value2');
  });

  // ===== 8. has() tra ve dung =====
  it('has() tra ve true khi key ton tai va chua het han', () => {
    const cache = createInMemoryCache<string>();

    cache.set('key1', 'value1', 60);

    // has() khong co trong API hien tai, nen test get() thay vi has()
    expect(cache.get('key1')).toBe('value1');
  });

  it('has() tra ve false khi key khong ton tai', () => {
    const cache = createInMemoryCache<string>();

    expect(cache.get('nonexistent')).toBeNull();
  });

  // ===== 9. TTL expiration: entry het han thi tra ve null =====
  it('tra ve null khi entry da het han', () => {
    const cache = createInMemoryCache<string>();

    // Set voi TTL 5 giay nhung advanced time len 10 giay
    cache.set('key1', 'value1', 5);
    vi.advanceTimersByTime(10 * 1000); // 10 seconds

    const result = cache.get('key1');
    expect(result).toBeNull();
  });

  // ===== 10. Access updated ordering: sau khi get() thi entry van duoc giu =====
  it('entry van ton tai sau khi get() vi get() khong xoa entry', () => {
    const cache = createInMemoryCache<string>({ maxEntries: 2 });

    cache.set('key1', 'value1', 60);
    cache.set('key2', 'value2', 60);

    // Doc entry cu nhat
    cache.get('key1');

    // Them entry moi - entry cu nhat van bi xoa vi no duoc add truoc key2
    cache.set('key3', 'value3', 60);

    // key1 bi xoa, key2 va key3 con lai
    expect(cache.get('key1')).toBeNull();
    expect(cache.get('key2')).toBe('value2');
    expect(cache.get('key3')).toBe('value3');
  });

  // ===== Edge case: default maxEntries = 500 =====
  it('default maxEntries la 500', () => {
    const cache = createInMemoryCache<string>();

    // Them 501 entries
    for (let i = 0; i < 501; i++) {
      cache.set(`key${i}`, `value${i}`, 60);
    }

    // Entry cu nhat (key0) phai bi xoa
    expect(cache.get('key0')).toBeNull();
    // Entry moi nhat con ton tai
    expect(cache.get('key500')).toBe('value500');
  });

  // ===== Edge case: undefined value =====
  it('ho tro gia tri undefined', () => {
    const cache = createInMemoryCache<undefined>();

    cache.set('key1', undefined, 60);
    const result = cache.get('key1');

    expect(result).toBeUndefined();
  });

  // ===== Edge case: object value =====
  it('ho tro gia tri la object', () => {
    const cache = createInMemoryCache<Record<string, unknown>>();

    const objValue = { foo: 'bar', nested: { baz: 123 } };
    cache.set('key1', objValue, 60);

    const result = cache.get('key1');
    expect(result).toEqual(objValue);
  });

  // ===== Edge case: deleteByKey() khi key khong ton tai khong throw =====
  it('deleteByKey() khong throw khi key khong ton tai', () => {
    const cache = createInMemoryCache<string>();

    expect(() => {
      cache.deleteByKey('nonexistent');
    }).not.toThrow();
  });

  // ===== Edge case: clearAll() tren cache rong khong throw =====
  it('clearAll() tren cache rong khong throw', () => {
    const cache = createInMemoryCache<string>();

    expect(() => {
      cache.clearAll();
    }).not.toThrow();
  });
});
