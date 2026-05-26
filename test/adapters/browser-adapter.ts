/**
 * Browser Test Adapter
 *
 * Uses Playwright to run tests in browsers (Chromium, Firefox, WebKit).
 * This adapter tests the Web bundle (dist/zstd-wasm-decoder.js + zstd.wasm)
 * loaded via test-harness.html
 */

import { type Browser, chromium, firefox, type Page, webkit } from 'playwright';
import type { StreamResult, ZstdOptions } from '../../src/types.js';

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

    // Load the test harness HTML which loads the bundle
    await this.page.goto(`http://localhost:42069/bundles/test-harness.html`);

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
    if (opts.dictionary) {
      serializedOpts.dictionaryBase64 = Buffer.from(opts.dictionary as Uint8Array).toString(
        'base64',
      );
      delete serializedOpts.dictionary;
    }

    const resultBase64 = (await this.page.evaluate(
      async ([dataBase64, options]) => {
        // @ts-ignore
        const bytes = window.base64ToUint8Array(dataBase64 as string);

        // Deserialize dictionary if present
        const decompressOpts: any = { ...options };
        if ((options as any).dictionaryBase64) {
          // @ts-ignore
          decompressOpts.dictionary = window.base64ToUint8Array((options as any).dictionaryBase64);
          delete decompressOpts.dictionaryBase64;
        }

        // @ts-ignore
        const decompressed = await window.ZstdWasm.decompress(bytes, decompressOpts);
        // @ts-ignore
        return window.uint8ArrayToBase64(decompressed);
      },
      [base64, serializedOpts],
    )) as string;

    return Buffer.from(resultBase64, 'base64');
  }

  async decompressStream(
    data: Buffer | Uint8Array,
    isFirst = false,
    opts: ZstdOptions = {},
  ): Promise<StreamResult & { buf: Buffer }> {
    if (!this.page) throw new Error('Browser not initialized');
    const base64 = Buffer.from(data).toString('base64');
    const serializedOpts: any = { ...opts };
    if (opts.dictionary) {
      serializedOpts.dictionaryBase64 = Buffer.from(opts.dictionary as Uint8Array).toString(
        'base64',
      );
      delete serializedOpts.dictionary;
    }

    const result = (await this.page.evaluate(
      async ([dataBase64, isFirstChunk, options]) => {
        // @ts-ignore
        const bytes = window.base64ToUint8Array(dataBase64 as string);

        // Deserialize dictionary if present
        const decompressOpts: any = { ...options };
        if ((options as any).dictionaryBase64) {
          // @ts-ignore
          decompressOpts.dictionary = window.base64ToUint8Array((options as any).dictionaryBase64);
          delete decompressOpts.dictionaryBase64;
        }

        // @ts-ignore
        const result = await window.ZstdWasm.decompressStream(bytes, isFirstChunk, decompressOpts);

        return {
          // @ts-ignore
          buf: window.uint8ArrayToBase64(result.buf),
          in_offset: result.in_offset,
        };
      },
      [base64, isFirst, serializedOpts],
    )) as { buf: string; in_offset: number };

    return {
      buf: Buffer.from(result.buf, 'base64'),
      in_offset: result.in_offset,
    };
  }

  createDecompressionStream(opts: ZstdOptions = {}): any {
    if (!this.page) throw new Error('Browser not initialized');
    const serializedOpts: any = { ...opts };
    if (opts.dictionary) {
      serializedOpts.dictionaryBase64 = Buffer.from(opts.dictionary as Uint8Array).toString(
        'base64',
      );
      delete serializedOpts.dictionary;
    }

    return {
      readable: {
        getReader: () => ({
          read: async () => {
            const result = await this.page!.evaluate(() => {
              // @ts-ignore
              return window._streamReader.read().then((r) => ({
                done: r.done,
                // @ts-ignore
                value: r.value ? window.uint8ArrayToBase64(r.value) : null,
              }));
            });
            return {
              done: result.done,
              value: result.value ? Buffer.from(result.value, 'base64') : undefined,
            };
          },
        }),
      },
      writable: {
        getWriter: () => ({
          write: async (data: Buffer | Uint8Array) => {
            const base64 = Buffer.from(data).toString('base64');
            await this.page!.evaluate(
              async ([dataBase64]) => {
                // @ts-ignore
                const bytes = window.base64ToUint8Array(dataBase64);
                // @ts-ignore
                await window._streamWriter.write(bytes);
              },
              [base64],
            );
          },
          close: async () => {
            await this.page!.evaluate(() => {
              // @ts-ignore
              return window._streamWriter.close();
            });
          },
        }),
      },
      _initInBrowser: async () => {
        await this.page!.evaluate(
          ([options]) => {
            const decompressOpts: any = { ...options };
            if ((options as any).dictionaryBase64) {
              // @ts-ignore
              decompressOpts.dictionary = window.base64ToUint8Array(
                (options as any).dictionaryBase64,
              );
              delete decompressOpts.dictionaryBase64;
            }
            // @ts-ignore
            const stream = new window.ZstdWasm.ZstdDecompressionStream(decompressOpts);
            // @ts-ignore
            window._streamWriter = stream.writable.getWriter();
            // @ts-ignore
            window._streamReader = stream.readable.getReader();
          },
          [serializedOpts],
        );
      },
    };
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
