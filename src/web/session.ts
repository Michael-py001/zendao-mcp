/**
 * 禅道 **Web 会话**（index.php 前台）—— 用于 REST 覆盖不到的能力
 *
 * ## 为什么需要这一层
 *
 * REST（`api.php/v2`）覆盖不到日志的「自定义类型写入 / 编辑 / 删除」：
 * 实测 DELETE 被 HTTP 层掐断（`ECONNRESET`），`/efforts` 系列全 404。
 * 但网页端能正常增删改，所以这里复刻浏览器的登录与表单提交。
 *
 * ## 登录契约（2026-11-20 从 `window.safeSubmit` 源码逆向 + 真机验证）
 *
 * 网页登录**不是**「算个 md5 直接 POST」那么简单，页面源码里是三步：
 *
 * ```js
 * $.get($.createLink('user','refreshRandom'), function(rand) {
 *     password = md5(md5(password) + rand);        // 双层 md5 + 一次性盐
 *     $.post(link, { account, password, passwordStrength,
 *                    referer, verifyRand: rand, keepLogin, captcha });
 * });
 * ```
 *
 * 三个必须踩准的点：
 *
 * 1. **`rand` 的唯一正确来源是 `m=user&f=refreshRandom`**（返回纯文本，如 `561603447`）。
 *    从 `m=user&f=login&t=json` 的 config 里取 `rand` 看着像、**实际无效** ——
 *    那个是页面渲染上下文里的另一个随机数，服务端不认。
 * 2. **必须把 `verifyRand` 一起回传**。服务端拿它反算密码；不带或对不上，一律登录失败
 *    （失败时不会报"密码错误"，而是把登录页 HTML 又吐回来，非常容易误判成"通了吗"）。
 * 3. **必须带 `X-Requested-With: XMLHttpRequest`**，否则服务端认为不是 ajax，
 *    返回 HTML 而不是 `{result:'success', locate:'...'}`。
 *
 * ## 重定向与 Cookie
 *
 * 登录成功后禅道会**重签 `zentaosid`**，而这个新 cookie 藏在 302 那一跳的响应头里。
 * axios 默认 `maxRedirects>0` 会自动跟随并**吞掉中间跳的 set-cookie** ——
 * 这正是本项目早期「登录明明 302 了、业务页却还是登录页」的根因。
 * 所以这里统一 `maxRedirects: 0` + 手动逐跳跟随，每一跳都收 cookie。
 */

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as crypto from 'crypto';
import { Logger, LogLevel } from '../utils/logger';

const md5 = (s: string): string => crypto.createHash('md5').update(s, 'utf8').digest('hex');

/** 与页面 `computePasswordStrength()` 同算法（只影响服务端强弱提示，不影响校验） */
function passwordStrength(password: string): number {
  if (!password.length) return 0;
  const complexity = [0, 0, 0, 0];
  for (const ch of password) {
    const a = ch.charCodeAt(0);
    if (a >= 48 && a <= 57) complexity[0] = 1;
    else if (a >= 65 && a <= 90) complexity[1] = 2;
    else if (a >= 97 && a <= 122) complexity[2] = 4;
    else complexity[3] = 8;
  }
  const sum = complexity.reduce((acc, v) => acc + v, 0);
  let strength = 0;
  if ((sum === 7 || sum === 15) && password.length >= 6) strength = 1;
  if (sum === 15 && password.length >= 10) strength = 2;
  return strength;
}

/** 网页登录失败时抛这个，便于上层区分「凭证问题」与「网络问题」 */
export class WebLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebLoginError';
  }
}

export interface WebRequestOptions {
  headers?: Record<string, string>;
  /** 表单体（`application/x-www-form-urlencoded`），仅 POST 用 */
  form?: Record<string, string | number | undefined> | URLSearchParams;
  /** 手动跟随重定向的最大跳数，默认 6 */
  maxHops?: number;
}

export class ZenTaoWebSession {
  private readonly siteBaseUrl: string;
  private readonly account?: string;
  private readonly password?: string;
  private readonly logger: Logger;
  private readonly http: AxiosInstance;
  /** cookie jar：name → value */
  private jar: Record<string, string> = {};
  private loggedIn = false;
  /** 正在登录的 Promise，避免并发调用打出多次登录 */
  private loginInFlight: Promise<void> | null = null;

  constructor(siteBaseUrl: string, account?: string, password?: string, logger?: Logger) {
    this.siteBaseUrl = siteBaseUrl.replace(/\/+$/, '');
    this.account = account;
    this.password = password;
    this.logger = logger || new Logger(LogLevel.INFO);

    this.http = axios.create({
      baseURL: this.siteBaseUrl,
      timeout: 30000,
      // 关键：不自动跟随，见文件头「重定向与 Cookie」
      maxRedirects: 0,
      validateStatus: () => true,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
  }

  /** 站点根地址（绝对 URL，如 `http://host/zentaomax`）。拼 Referer 必须用它 —— 相对路径会被服务端无视 */
  get siteUrl(): string {
    return this.siteBaseUrl;
  }

  /** 站点根路径（如 `/zentaomax`），拼 referer 用 */
  get webRoot(): string {
    try {
      const p = new URL(this.siteBaseUrl).pathname;
      return p.endsWith('/') ? p : `${p}/`;
    } catch {
      return '/';
    }
  }

  /** 是否已完成登录（仅在进程内有效） */
  get isLoggedIn(): boolean {
    return this.loggedIn;
  }

  /** 收 set-cookie。同名覆盖；`deleted` 视作失效 */
  private absorbCookie(res: AxiosResponse): void {
    const raw = res.headers?.['set-cookie'];
    for (const line of ([] as string[]).concat(raw || [])) {
      const pair = String(line).split(';')[0];
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!name) continue;
      if (!value || value === 'deleted') delete this.jar[name];
      else this.jar[name] = value;
    }
  }

  private cookieHeader(): string {
    return Object.entries(this.jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /** 单次请求，不跟随重定向 */
  private async once(
    method: 'GET' | 'POST',
    url: string,
    opts: WebRequestOptions = {}
  ): Promise<AxiosResponse> {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;

    let data: string | undefined;
    if (opts.form !== undefined) {
      data =
        opts.form instanceof URLSearchParams
          ? opts.form.toString()
          : new URLSearchParams(
              Object.entries(opts.form)
                .filter(([, v]) => v !== undefined)
                .map(([k, v]) => [k, String(v)] as [string, string])
            ).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const res = await this.http.request({ method, url, headers, data });
    this.absorbCookie(res);
    return res;
  }

  /**
   * 手动逐跳跟随 302。每一跳都会收 cookie（登录重签的 session 就在这里）。
   */
  private async follow(
    method: 'GET' | 'POST',
    url: string,
    opts: WebRequestOptions = {}
  ): Promise<AxiosResponse> {
    const maxHops = opts.maxHops ?? 6;
    let res = await this.once(method, url, opts);
    let hops = 0;
    while ([301, 302, 303, 307, 308].includes(res.status) && hops < maxHops) {
      const location = res.headers?.['location'] as string | undefined;
      if (!location) break;
      hops += 1;
      const next = new URL(location, `${this.siteBaseUrl}/`).pathname +
        (new URL(location, `${this.siteBaseUrl}/`).search || '');
      const nextMethod: 'GET' | 'POST' = res.status === 303 || res.status === 302 ? 'GET' : method;
      res = await this.once(nextMethod, next, {
        headers: opts.headers,
        form: nextMethod === 'GET' ? undefined : opts.form,
      });
    }
    return res;
  }

  /** GET 一个页面并返回 HTML 文本 */
  async getHtml(path: string, opts: WebRequestOptions = {}): Promise<{ status: number; html: string }> {
    const res = await this.follow('GET', path, opts);
    return { status: res.status, html: Buffer.isBuffer(res.data) ? res.data.toString('utf8') : String(res.data ?? '') };
  }

  /** POST 表单并返回原始响应（HTML 或 JSON 文本） */
  async postForm(path: string, form: Record<string, string | number | undefined> | URLSearchParams, opts: WebRequestOptions = {}): Promise<{ status: number; text: string }> {
    const res = await this.follow('POST', path, { ...opts, form });
    const text = Buffer.isBuffer(res.data) ? res.data.toString('utf8') : String(res.data ?? '');
    return { status: res.status, text };
  }

  /**
   * 登录。成功后同一实例可复用 cookie 直接提交表单。
   *
   * @throws {WebLoginError} 缺账号密码、或服务端拒绝（含错误提示原文）
   */
  async login(): Promise<void> {
    if (this.loggedIn) return;
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = this.doLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async doLogin(): Promise<void> {
    if (!this.account || !this.password) {
      throw new WebLoginError(
        '网页登录需要账号密码。当前配置里没有可用的 ZENTAO_ACCOUNT + ZENTAO_PASSWORD ——\n' +
          '⚠️ 注意：`ZENTAO_TOKEN` 与官方 CLI 的 profile（只存 Token、不存密码）**都无法用于网页登录**。\n' +
          '要用自定义日志 / 编辑日志 / 删除日志这类「只有网页才有的能力」，必须在 .env 里配账号密码。'
      );
    }

    const xhr = { 'X-Requested-With': 'XMLHttpRequest' };

    // 1. 建立 session（拿 zentaosid）
    await this.follow('GET', '/index.php?m=user&f=login');

    // 2. 取一次性 rand —— 唯一正确来源
    const randRes = await this.once('GET', '/index.php?m=user&f=refreshRandom', { headers: xhr });
    const randRaw = String(randRes.data ?? '').trim();
    if (!randRaw || randRaw.length > 40) {
      throw new WebLoginError(
        `获取登录盐值失败：\`m=user&f=refreshRandom\` 返回了 ${JSON.stringify(randRaw.slice(0, 80))}。\n` +
          '通常是站点地址不对（应指向禅道根目录，如 http://host/zentaomax），或该实例关闭了网页登录。'
      );
    }
    const rand = randRaw;

    // 3. 双层 md5 + 盐
    const hashed = md5(md5(this.password) + rand);

    // 4. 提交
    const res = await this.once('POST', '/index.php?m=user&f=login', {
      form: {
        account: this.account,
        password: hashed,
        passwordStrength: passwordStrength(this.password),
        referer: this.webRoot,
        verifyRand: rand,
        keepLogin: '0',
        captcha: '',
      },
      headers: {
        ...xhr,
        Referer: `${this.siteBaseUrl}/index.php?m=user&f=login`,
        Origin: this.siteBaseUrl,
      },
    });

    // 5. 判定：服务端返回 JSON（{result, message, locate}）或把登录页吐回来
    const text = String(res.data ?? '');
    let message = '';
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.message === 'string') message = parsed.message;
      if (parsed?.result === 'success') message = '';
    } catch {
      /* 非 JSON：通常是登录页 HTML */
    }

    // 6. 真正可靠的判定是「业务页能不能打开」，而不是看响应体
    const home = await this.follow('GET', '/index.php?m=my&f=index');
    const html = String(home.data ?? '');
    const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || '';
    const stillLoginPage = /用户登录/.test(title) || /id=["']loginForm["']/.test(html);

    if (stillLoginPage || home.status !== 200) {
      throw new WebLoginError(
        '网页登录失败' + (message ? `：${message}` : '（服务端未给出原因）') + '\n' +
          '已尝试：GET 登录页 → GET refreshRandom 取盐 → POST md5(md5(密码)+盐) + verifyRand。\n' +
          '常见原因：账号密码不对 / 该账号被禁用 / 站点开启了验证码或单点登录。'
      );
    }

    this.loggedIn = true;
    this.logger.info('禅道网页会话登录成功', { account: this.account });
  }

  /** 确保已登录（幂等） */
  async ensureLogin(): Promise<void> {
    if (!this.loggedIn) await this.login();
  }

  /** 会话失效时重置，下次调用会重新登录 */
  reset(): void {
    this.loggedIn = false;
    this.jar = {};
  }
}
