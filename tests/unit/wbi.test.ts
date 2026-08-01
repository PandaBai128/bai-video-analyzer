import { describe, expect, it } from 'vitest';
import { md5 } from 'js-md5';
import { buildMixKey, signWbi, WbiSigner } from '@core/bilibili';

/**
 * 测试向量由 tools/gen-wbi-fixture.py 生成，MD5 部分用 Python 标准 hashlib
 * 校验过 RFS 1321 标准向量；WBI 部分用 Python 复现原始算法生成。
 */
const MD5_FIXTURES: ReadonlyArray<{ readonly input: string; readonly expected: string }> = [
  { input: '', expected: 'd41d8cd98f00b204e9800998ecf8427e' },
  { input: 'a', expected: '0cc175b9c0f1b6a831c399e269772661' },
  { input: 'abc', expected: '900150983cd24fb0d6963f7d28e17f72' },
  {
    input: 'The quick brown fox jumps over the lazy dog',
    expected: '9e107d9d372bb6826bd81d3542a419d6',
  },
  { input: '你好世界', expected: '65396ee4aad0b4f17aacd1c6112ee364' },
];

const MIX_KEY_FIXTURES: ReadonlyArray<{
  readonly imgKey: string;
  readonly subKey: string;
  readonly expected: string;
}> = [
  {
    imgKey: '7cd084941338484a6881eb0f8c0c624d',
    subKey: '4932caffdff14a82a82f8b6c0c0c0c0c',
    expected: '828db1f4a23d00a2c14893f1264f4ff8',
  },
  { imgKey: 'abc', subKey: 'def', expected: 'cdfabe' },
  {
    imgKey: 'a1b2c3d4e5',
    subKey: 'f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1',
    expected: 'jbe2q8f628437505oh0gt1794imun9a1',
  },
];

const SIGN_FIXTURES: ReadonlyArray<{
  readonly mix: string;
  readonly params: Readonly<Record<string, string | number>>;
  readonly wts: number;
  readonly expected: Record<string, string | number>;
}> = [
  {
    mix: 'ea1db124af3c7062474693fa704f4ff8',
    params: { bvid: 'BV1xx411c7mD', cid: 12345 },
    wts: 1700000000,
    expected: {
      bvid: 'BV1xx411c7mD',
      cid: 12345,
      wts: 1700000000,
      w_rid: '2287c5697788a0f4dd4927baf674b081',
    },
  },
  {
    mix: 'ea1db124af3c7062474693fa704f4ff8',
    params: { bvid: 'BV1xx', cid: 1, title: "test!'()*value" },
    wts: 1700000000,
    expected: {
      bvid: 'BV1xx',
      cid: 1,
      title: "test!'()*value",
      wts: 1700000000,
      w_rid: '98196de8b910c045c3c166ae66debe16',
    },
  },
  {
    mix: 'abcd1234abcd1234abcd1234abcd1234',
    params: { z: 1, a: 2, m: 3 },
    wts: 1700000001,
    expected: {
      z: 1,
      a: 2,
      m: 3,
      wts: 1700000001,
      w_rid: 'c884bcf6785452af73612dacbd9b3285',
    },
  },
];

describe('WBI / MD5', () => {
  describe('md5 via js-md5 library (sanity)', () => {
    it.each(MD5_FIXTURES)('md5(%j) === %j', ({ input, expected }) => {
      expect(md5(input)).toBe(expected);
    });
  });

  describe('buildMixKey', () => {
    it.each(MIX_KEY_FIXTURES)(
      'mix_key($imgKey, $subKey) === $expected',
      ({ imgKey, subKey, expected }) => {
        expect(buildMixKey(imgKey, subKey)).toBe(expected);
      },
    );
  });

  describe('signWbi', () => {
    it.each(SIGN_FIXTURES)(
      'signs w_rid correctly (wts=$wts)',
      ({ mix, params, wts, expected }) => {
        expect(signWbi({ mixKey: mix, params, wts })).toEqual(expected);
      },
    );
  });
});

describe('WbiSigner', () => {
  function createMemoryStore() {
    let store: { mixKey: string; expiresAt: number } | null = null;
    return {
      read: async () => store,
      write: async (value: { mixKey: string; expiresAt: number }) => {
        store = value;
      },
      peek: () => store,
    };
  }

  it('refreshes mix_key from nav response and caches in memory', async () => {
    let fetchCount = 0;
    const signer = new WbiSigner({
      now: () => 1_700_000_000,
      fetchNav: async () => {
        fetchCount += 1;
        return {
          code: 0,
          message: '0',
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484a6881eb0f8c0c624d.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caffdff14a82a82f8b6c0c0c0c0c.png',
            },
          },
        };
      },
    });

    const first = await signer.getMixKey();
    const second = await signer.getMixKey();

    expect(first).toBe('828db1f4a23d00a2c14893f1264f4ff8');
    expect(second).toBe(first);
    expect(fetchCount).toBe(1);
  });

  it('persists mix_key through cacheStore across instances', async () => {
    const store = createMemoryStore();

    const first = new WbiSigner({
      now: () => 1_700_000_000,
      ttlMs: 60_000,
      cacheStore: store,
      fetchNav: async () => ({
        code: 0,
        message: '0',
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484a6881eb0f8c0c624d.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caffdff14a82a82f8b6c0c0c0c0c.png',
          },
        },
      }),
    });
    await first.getMixKey();

    // 第二个实例：不带 fetchNav，期望从缓存读出
    const second = new WbiSigner({
      now: () => 1_700_000_030,
      ttlMs: 60_000,
      cacheStore: store,
    });
    await expect(second.getMixKey()).resolves.toBe('828db1f4a23d00a2c14893f1264f4ff8');
  });

  it('refetches when cache expired', async () => {
    const store = createMemoryStore();
    let fetchCount = 0;

    const signer = new WbiSigner({
      now: () => 1_700_000_000,
      ttlMs: 60,
      cacheStore: store,
      fetchNav: async () => {
        fetchCount += 1;
        return {
          code: 0,
          message: '0',
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484a6881eb0f8c0c624d.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caffdff14a82a82f8b6c0c0c0c0c.png',
            },
          },
        };
      },
    });

    await signer.getMixKey();
    expect(fetchCount).toBe(1);

    // 模拟时间推进超过 TTL
    (signer as unknown as { options: { now: () => number } }).options = {
      ...(signer as unknown as { options: object }).options,
      now: () => 1_700_000_100,
    } as { now: () => number };

    await signer.getMixKey();
    expect(fetchCount).toBe(2);
  });

  it('accepts nav response with code=-101 (unauthenticated) as long as wbi_img is present', async () => {
    const signer = new WbiSigner({
      now: () => 1_700_000_000,
      fetchNav: async () => ({
        code: -101,
        message: '未登录',
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484a6881eb0f8c0c624d.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caffdff14a82a82f8b6c0c0c0c0c.png',
          },
        },
      }),
    });

    await expect(signer.getMixKey()).resolves.toBe('828db1f4a23d00a2c14893f1264f4ff8');
  });

  it('throws when wbi_img is missing in nav response', async () => {
    const signer = new WbiSigner({
      now: () => 1_700_000_000,
      fetchNav: async () => ({ code: -101, message: '未登录', data: {} }),
    });

    await expect(signer.getMixKey()).rejects.toThrow(/wbi_img/);
  });

  it('sign() injects wts and w_rid', async () => {
    const signer = new WbiSigner({
      now: () => 1_700_000_000,
      fetchNav: async () => ({
        code: 0,
        message: '0',
        data: {
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484a6881eb0f8c0c624d.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caffdff14a82a82f8b6c0c0c0c0c.png',
          },
        },
      }),
    });

    const signed = await signer.sign({ bvid: 'BV1xx', cid: 999 });

    expect(signed.wts).toBe(1_700_000_000);
    expect(typeof signed.w_rid).toBe('string');
    expect((signed.w_rid as string)).toMatch(/^[0-9a-f]{32}$/);
  });
});
