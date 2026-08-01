import { md5 } from 'js-md5';

/**
 * B 站 WBI 签名（2023 年后所有 wbi 接口都要求）。
 *
 * 算法跟服务端对齐：
 *  1. nav 接口返回 `wbi_img.img_url` / `wbi_img.sub_url`，取文件名作为 `img_key` / `sub_key`
 *  2. 把两个 key 拼起来，按固定的 64 项索引表重排，取前 32 字符作为 `mix_key`
 *  3. 签参数：加 `wts`，按 key 字母序排序，value 过滤掉 `!'()*`，
 *     拼成 `k=v&k=v...` 后接 `mix_key`，MD5 → `w_rid`
 *
 * 这一层不直接 fetch 网络，只负责纯计算。`fetchMixKey` / `sign` 是无副作用的，
 * `WbiSigner` 负责把 nav 接口的结果缓存下来。
 *
 * 参考：
 *   - 社区实现：https://socialsisteryi.github.io/bilibili-API-collect/docs/misc/sign/wbi.html
 *   - 服务端校验：/x/player/wbi/v2 走风控，没签名会直接返回空 subtitle_url
 */

const WBI_MIXIN_KEY_TABLE: readonly number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const WBI_FILTER_PATTERN = /[!'()*]/g;

const MIX_KEY_LENGTH = 32;

export interface MixKeyCache {
  readonly mixKey: string;
  /** epoch ms，过期时间。 */
  readonly expiresAt: number;
}

export function buildMixKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  let result = '';

  for (const index of WBI_MIXIN_KEY_TABLE) {
    if (index < raw.length) {
      result += raw[index];
    }
    if (result.length >= MIX_KEY_LENGTH) {
      break;
    }
  }

  return result.slice(0, MIX_KEY_LENGTH);
}

export interface SignInput {
  readonly mixKey: string;
  readonly params: Readonly<Record<string, string | number>>;
  /** epoch seconds，调用方决定传啥时戳，便于测试。 */
  readonly wts: number;
}

export function signWbi(input: SignInput): Record<string, string | number> {
  const merged: Record<string, string | number> = { ...input.params, wts: input.wts };
  const keys = Object.keys(merged).sort();

  // 注意：只对拼查询字符串时做过滤，输出参数保留原始值。
  // 服务端也是这样算 w_rid 的，但接口返回的参数不过滤。
  const query = keys
    .map((key) => {
      const raw = merged[key] as string | number;
      const value = typeof raw === 'number' ? String(raw) : raw;
      return `${key}=${value.replace(WBI_FILTER_PATTERN, '')}`;
    })
    .join('&');

  const wRid = md5(query + input.mixKey);

  return { ...merged, w_rid: wRid };
}

export function extractWbiKeyFromUrl(url: string): string {
  const lastSlash = url.lastIndexOf('/');
  const tail = lastSlash >= 0 ? url.slice(lastSlash + 1) : url;
  const dot = tail.indexOf('.');
  return dot >= 0 ? tail.slice(0, dot) : tail;
}

export interface WbiNavResponse {
  readonly code: number;
  readonly message: string;
  readonly data?: {
    readonly wbi_img?: {
      readonly img_url?: string;
      readonly sub_url?: string;
    };
  };
}

export interface WbiSignerOptions {
  /** 缓存读取：跨 service-worker 重启复用 mix_key。 */
  readonly cacheStore?: WbiCacheStore;
  /** 缓存 TTL，默认 24h。 */
  readonly ttlMs?: number;
  /** 拉 nav 接口的实现，测试时注入。 */
  readonly fetchNav?: () => Promise<WbiNavResponse>;
  /** 当前 epoch seconds，测试时注入。 */
  readonly now?: () => number;
}

export interface WbiCacheStore {
  read(): Promise<MixKeyCache | null>;
  write(cache: MixKeyCache): Promise<void>;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface ResolvedWbiSignerOptions {
  ttlMs: number;
  cacheStore?: WbiCacheStore;
  fetchNav?: () => Promise<WbiNavResponse>;
  now?: () => number;
}

export class WbiSigner {
  private readonly options: ResolvedWbiSignerOptions;

  private cachedMixKey: string | null = null;
  private cachedExpiresAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(options: WbiSignerOptions = {}) {
    const resolved: ResolvedWbiSignerOptions = {
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    };
    if (options.cacheStore) resolved.cacheStore = options.cacheStore;
    if (options.fetchNav) resolved.fetchNav = options.fetchNav;
    if (options.now) resolved.now = options.now;
    this.options = resolved;
  }

  async getMixKey(): Promise<string> {
    const now = this.currentTimeMs();

    if (this.cachedMixKey && this.cachedExpiresAt > now) {
      return this.cachedMixKey;
    }

    if (this.options.cacheStore) {
      const cached = await this.options.cacheStore.read();
      if (cached && cached.expiresAt > now) {
        this.cachedMixKey = cached.mixKey;
        this.cachedExpiresAt = cached.expiresAt;
        return cached.mixKey;
      }
    }

    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.refreshMixKey(now).finally(() => {
      this.inflight = null;
    });

    return this.inflight;
  }

  async sign(params: Readonly<Record<string, string | number>>): Promise<Record<string, string | number>> {
    const mixKey = await this.getMixKey();
    const wts = Math.floor((this.options.now?.() ?? Date.now() / 1000));

    return signWbi({ mixKey, params, wts });
  }

  invalidate(): void {
    this.cachedMixKey = null;
    this.cachedExpiresAt = 0;
  }

  private async refreshMixKey(now: number): Promise<string> {
    const fetcher = this.options.fetchNav;

    if (!fetcher) {
      throw new Error('WbiSigner: 没有可用的 nav 接口实现，无法刷新 mix_key');
    }

    const response = await fetcher();

    if (response.code !== 0 && response.code !== -101) {
      throw new Error(`WbiSigner: nav 接口异常 code=${response.code} message=${response.message}`);
    }

    const wbiImg = response.data?.wbi_img;
    const imgUrl = wbiImg?.img_url;
    const subUrl = wbiImg?.sub_url;

    if (!imgUrl || !subUrl) {
      throw new Error(
        `WbiSigner: nav 接口未返回 wbi_img（code=${response.code}），无法签名；可能未登录`,
      );
    }

    const mixKey = buildMixKey(extractWbiKeyFromUrl(imgUrl), extractWbiKeyFromUrl(subUrl));
    const expiresAt = now + this.options.ttlMs;

    this.cachedMixKey = mixKey;
    this.cachedExpiresAt = expiresAt;

    if (this.options.cacheStore) {
      await this.options.cacheStore.write({ mixKey, expiresAt });
    }

    return mixKey;
  }

  private currentTimeMs(): number {
    if (this.options.now) {
      // 传进来的 now() 是 epoch seconds，统一转成 ms
      return this.options.now() * 1000;
    }

    return Date.now();
  }
}
