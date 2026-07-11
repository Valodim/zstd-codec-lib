/**
 * Browser Test Adapter
 *
 * Uses Playwright to run tests in browsers (Chromium, Firefox, WebKit).
 * Loads test-harness.html, which imports the built entrypoint selected by
 * TEST_VARIANT (web, web-perf, web-inlined, web-inlined-perf).
 */

import { type Browser, chromium, firefox, type Page, webkit } from 'playwright';
import type { ZstdOptions } from '../../src/types.js';

interface BrowserAdapterOptions {
  browser: 'chromium' | 'firefox' | 'webkit';
}

export class BrowserAdapter {
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(private options: BrowserAdapterOptions) {}

  async init() {
    const browserType = {
      chromium,
      firefox,
      webkit,
    }[this.options.browser];

    this.browser = await browserType.launch({ headless: true });
    this.page = await this.browser.newPage();

    // Load the test harness HTML, which dynamically imports the built
    // entrypoint selected by TEST_VARIANT. Non-web variants (e.g. the default
    // 'node') fall back to the external web bundle.
    const requested = process.env.TEST_VARIANT;
    const variant = requested?.startsWith('web') ? requested : 'web';
    await this.page.goto(`http://localhost:42069/bundles/test-harness.html?variant=${variant}`);

    // Wait for WASM to initialize
    await this.page.waitForFunction(
      () => {
        // @ts-ignore
        return window.ZstdWasm?.ready === true;
      },
      { timeout: 120000 },
    );

    // Inject utility functions into the browser context
    await this.page.evaluate(() => {
      // @ts-ignore
      window.base64ToUint8Array = (base64: string): Uint8Array => {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
        return bytes;
      };

      // @ts-ignore
      window.uint8ArrayToBase64 = (bytes: Uint8Array): string => {
        let binaryStr = '';
        for (let i = 0; i < bytes.length; i += 32768) {
          const end = Math.min(i + 32768, bytes.length);
          for (let j = i; j < end; j++) binaryStr += String.fromCharCode(bytes[j]);
        }
        return btoa(binaryStr);
      };
    });

    console.log(`${this.options.browser} initialized`);
  }

  async decompress(data: Buffer | Uint8Array, opts: ZstdOptions = {}): Promise<Buffer> {
    if (!this.page) throw new Error('Browser not initialized');
    const base64 = Buffer.from(data).toString('base64');
    const serializedOpts: any = { ...opts };

    const resultBase64 = (await this.page.evaluate(
      async ([dataBase64, options]) => {
        // @ts-ignore
        const bytes = window.base64ToUint8Array(dataBase64 as string);

        const decompressOpts: any = { ...options };

        // @ts-ignore
        const decompressed = await window.ZstdWasm.decompress(bytes, decompressOpts);
        // @ts-ignore
        return window.uint8ArrayToBase64(decompressed);
      },
      [base64, serializedOpts],
    )) as string;

    return Buffer.from(resultBase64, 'base64');
  }

  async close() {
    await this.page?.close();
    await this.browser?.close();
  }
}

export async function createBrowserAdapter(
  browser: 'chromium' | 'firefox' | 'webkit',
): Promise<BrowserAdapter> {
  const adapter = new BrowserAdapter({ browser });
  await adapter.init();
  return adapter;
}
