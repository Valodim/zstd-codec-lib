#!/usr/bin/env bun

import { execSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { minify } from 'terser';

const PKG_DIR = import.meta.dir;
const SRC_DIR = join(PKG_DIR, 'src');
const ESM_DIR = join(SRC_DIR, '_esm');
const TYPES_DIR = join(SRC_DIR, '_types');
const BUILD_DIR = join(PKG_DIR, 'build');
const WASM_SOURCE_PATH = join(BUILD_DIR, 'zstd.wasm');
const WASM_PERF_PATH = join(BUILD_DIR, 'zstd-perf.wasm');
const WASM_SMALL_PATH = join(BUILD_DIR, 'zstd-small.wasm');
const WASM_SMALL_PERF_PATH = join(BUILD_DIR, 'zstd-small-perf.wasm');
const WASM_CODEC_PATH = join(BUILD_DIR, 'zstd-codec.wasm');
const WASM_CODEC_PERF_PATH = join(BUILD_DIR, 'zstd-codec-perf.wasm');
const WASM_CODEC_LVL1_PATH = join(BUILD_DIR, 'zstd-codec-lvl1.wasm');
const WASM_CODEC_LVL1_PERF_PATH = join(BUILD_DIR, 'zstd-codec-lvl1-perf.wasm');
const ROOT_DIR = join(PKG_DIR, '..', '..');
const LICENSE_PATH = join(ROOT_DIR, 'LICENSE');
const README_PATH = join(ROOT_DIR, 'README.md');

const PREP = process.argv.includes('--prep');

[ESM_DIR, TYPES_DIR].forEach((dir) => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

for (const p of [
  WASM_SOURCE_PATH,
  WASM_PERF_PATH,
  WASM_SMALL_PATH,
  WASM_SMALL_PERF_PATH,
  WASM_CODEC_PATH,
  WASM_CODEC_PERF_PATH,
  WASM_CODEC_LVL1_PATH,
  WASM_CODEC_LVL1_PERF_PATH,
]) {
  if (!existsSync(p)) {
    console.error('WASM file not found at:', p);
    process.exit(1);
  }
}

console.log(`WASM size-optimized: ${(Bun.file(WASM_SOURCE_PATH).size).toLocaleString()} bytes`);
console.log(`WASM perf-optimized: ${(Bun.file(WASM_PERF_PATH).size).toLocaleString()} bytes`);
console.log(`WASM small size-optimized: ${(Bun.file(WASM_SMALL_PATH).size).toLocaleString()} bytes`);
console.log(`WASM small perf-optimized: ${(Bun.file(WASM_SMALL_PERF_PATH).size).toLocaleString()} bytes`);
console.log(`Codec size-optimized: ${(Bun.file(WASM_CODEC_PATH).size).toLocaleString()} bytes`);
console.log(`Codec perf-optimized: ${(Bun.file(WASM_CODEC_PERF_PATH).size).toLocaleString()} bytes`);
console.log(`Codec lvl1 size-optimized: ${(Bun.file(WASM_CODEC_LVL1_PATH).size).toLocaleString()} bytes`);
console.log(`Codec lvl1 perf-optimized: ${(Bun.file(WASM_CODEC_LVL1_PERF_PATH).size).toLocaleString()} bytes\n`);

const terserOptions = {
  ecma: 2020 as const,
  safari10: false,
  ie8: false,
  sourceMap: false,

  // Mb too aggressive
  keep_classnames: false,
  keep_fnames: false,

  parse: {
    html5_comments: false,
  },
  mangle: {
    toplevel: true,
    safari10: false,
    reserved: ['_initialize'],
    properties: {
      regex: /^_(?!initialize)/,
      reserved: ['_initialize'],
    },
  },
  compress: {
    booleans: true,
    drop_console: true,
    drop_debugger: true,
    dead_code: true,
    pure_funcs: ['console.log', 'console.info', 'console.debug'],
    ecma: 2020 as const,
    passes: 2,
    unsafe: true,
    unsafe_arrows: true,
    unsafe_comps: true,
    unsafe_Function: true,
    unsafe_methods: true,
    unsafe_proto: true,
    unsafe_regexp: true,
    unsafe_undefined: true,
    unsafe_math: true,
    pure_getters: true,
    keep_fargs: false,
    keep_infinity: false,
    hoist_funs: true,
    hoist_vars: true,
    toplevel: true,
    module: true,
    global_defs: {
      DEBUG: false,
    },
  },
  format: {
    ascii_only: true,
    comments: (node, comment) => {
      const text = comment.value;
      return /^\s*!?\s*(@__PURE__|@__NO_SIDE_EFFECTS__|#__PURE__|#__NO_SIDE_EFFECTS__)/.test(text);
    },
    preserve_annotations: true,
    shebang: false,
    webkit: true,
    beautify: false,
  },
};

const configs: Array<{
  name: string;
  entry: string;
  outfile: string;
  target: string;
  minify: boolean;
  external?: string[];
}> = [
  {
    name: 'Web ESM',
    entry: join(SRC_DIR, 'index.web.ts'),
    outfile: 'index.web.js',
    target: 'browser',
    minify: true,
  },
  {
    name: 'Web ESM (minified)',
    entry: join(SRC_DIR, 'index.web.ts'),
    outfile: 'index.web.min.js',
    target: 'browser',
    minify: true,
  },
  {
    name: 'Node.js ESM',
    entry: join(SRC_DIR, 'index.node.ts'),
    outfile: 'index.node.js',
    target: 'node',
    minify: true,
  },
  {
    name: 'Web Small ESM',
    entry: join(SRC_DIR, 'index.web.small.ts'),
    outfile: 'index.web.small.js',
    target: 'browser',
    minify: true,
  },
  {
    name: 'Node.js Small ESM',
    entry: join(SRC_DIR, 'index.node.small.ts'),
    outfile: 'index.node.small.js',
    target: 'node',
    minify: true,
  },
  {
    name: 'Codec Web ESM (minified)',
    entry: join(SRC_DIR, 'index.codec.web.ts'),
    outfile: 'index.codec.web.js',
    target: 'browser',
    minify: true,
  },
  {
    name: 'Codec Node.js ESM',
    entry: join(SRC_DIR, 'index.codec.node.ts'),
    outfile: 'index.codec.node.js',
    target: 'node',
    minify: true,
  },
  {
    name: 'Codec lvl1 Web ESM (minified)',
    entry: join(SRC_DIR, 'index.codec.lvl1.web.ts'),
    outfile: 'index.codec.lvl1.web.js',
    target: 'browser',
    minify: true,
  },
  {
    name: 'Codec lvl1 Node.js ESM',
    entry: join(SRC_DIR, 'index.codec.lvl1.node.ts'),
    outfile: 'index.codec.lvl1.node.js',
    target: 'node',
    minify: true,
  },
  {
    name: 'Core Library',
    entry: join(SRC_DIR, 'zstd-wasm.ts'),
    outfile: 'zstd-wasm.js',
    target: 'browser',
    minify: true,
  },
  {
    name: 'Core Library (minified)',
    entry: join(SRC_DIR, 'zstd-wasm.ts'),
    outfile: 'zstd-wasm.min.js',
    target: 'browser',
    minify: true,
  },
];

for (const config of configs) {
  const result = await Bun.build({
    entrypoints: [config.entry],
    outdir: ESM_DIR,
    target: config.target as 'browser' | 'node',
    format: 'esm',
    conditions: config.target === 'browser' ? ['browser', 'import'] : ['node', 'import'],
    naming: config.outfile,
    sourcemap: 'linked',
    packages: 'external',
    external: config.external || [],
    emitDCEAnnotations: true,
    drop: config.minify ? ['console', 'debugger'] : [],
  });

  if (!result.success) {
    console.error(`Failed to build ${config.name}`);
    for (const log of result.logs) console.error(log);
    continue;
  }

  if (config.minify) {
    const filePath = join(ESM_DIR, config.outfile);
    const minified = await minify(readFileSync(filePath, 'utf8'), terserOptions);
    if (minified.code) writeFileSync(filePath, minified.code);
    console.log(`Built (minified): ${config.outfile}`);
  } else {
    console.log(`Built: ${config.outfile}`);
  }
}
/**
 * Pre-compress with deflate-raw using zopfli for maximum compression before encoding to base64.
 * Yields a smaller bundle size when compressed twice
 *
 * Opaque + decomp. via DecompressionStream API
 * .wasm  =>  zopfli deflate  =>  base64  =>  .js  => gzip/brotli/zstd
 *
 * Comparatively the cost of an additional network request
 * to shave off the extra bytes by splitting the .wasm and .js module
 * isn't worth it (for slim modules)
 */

function compressWithZopfli(inputPath: string, iterations: number): Buffer {
  const tmpOutput = `${inputPath}.zopfli.tmp`;
  console.log(`Compressing with zopfli (i=${iterations}, exhaustive): ${inputPath}`);

  try {
    const fd = openSync(tmpOutput, 'w');
    try {
      const result = spawnSync('zopfli', ['--deflate', `--i${iterations}`, inputPath, '-c'], {
        stdio: ['inherit', fd, 'inherit'],
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`zopfli exited with code ${result.status}`);
    } finally {
      closeSync(fd);
    }

    const compressed = readFileSync(tmpOutput);
    try {
      unlinkSync(tmpOutput);
    } catch (e) {}

    console.log(`  Original: ${readFileSync(inputPath).length.toLocaleString()} bytes`);
    console.log(`  Compressed: ${compressed.length.toLocaleString()} bytes`);
    console.log(
      `  Ratio: ${((compressed.length / readFileSync(inputPath).length) * 100).toFixed(2)}%\n`,
    );

    return compressed;
  } catch (error) {
    console.warn('Zopfli compression failed, falling back to standard deflate');
    console.error(error);
    return deflateRawSync(readFileSync(inputPath), { level: 9 });
  }
}

const wasmBase64 = compressWithZopfli(WASM_SOURCE_PATH, 2000).toString('base64');
const wasmPerfBase64 = compressWithZopfli(WASM_PERF_PATH, 200).toString('base64');
const wasmSmallBase64 = compressWithZopfli(WASM_SMALL_PATH, 2000).toString('base64');
const wasmSmallPerfBase64 = compressWithZopfli(WASM_SMALL_PERF_PATH, 200).toString('base64');
const wasmCodecBase64 = compressWithZopfli(WASM_CODEC_PATH, 200).toString('base64');
const wasmCodecPerfBase64 = compressWithZopfli(WASM_CODEC_PERF_PATH, 100).toString('base64');
const wasmCodecLvl1Base64 = compressWithZopfli(WASM_CODEC_LVL1_PATH, 200).toString('base64');
const wasmCodecLvl1PerfBase64 = compressWithZopfli(WASM_CODEC_LVL1_PERF_PATH, 100).toString('base64');

async function buildInlined(
  flavor: 'decoder' | 'decoder-small' | 'codec' | 'codec-lvl1',
  variant: 'size' | 'perf',
) {
  let base64: string;
  let entry: string;
  let stem: string;
  if (flavor === 'codec-lvl1') {
    base64 = variant === 'perf' ? wasmCodecLvl1PerfBase64 : wasmCodecLvl1Base64;
    entry = 'index.codec.lvl1.web.inlined.ts';
    stem = 'index.codec.lvl1.inlined';
  } else if (flavor === 'codec') {
    base64 = variant === 'perf' ? wasmCodecPerfBase64 : wasmCodecBase64;
    entry = 'index.codec.web.inlined.ts';
    stem = 'index.codec.inlined';
  } else if (flavor === 'decoder-small') {
    base64 = variant === 'perf' ? wasmSmallPerfBase64 : wasmSmallBase64;
    entry = 'index.web.inlined.ts';
    stem = 'index.small.inlined';
  } else {
    base64 = variant === 'perf' ? wasmPerfBase64 : wasmBase64;
    entry = 'index.web.inlined.ts';
    stem = 'index.inlined';
  }
  const suffix = variant === 'perf' ? '.perf' : '';

  const result = await Bun.build({
    entrypoints: [join(SRC_DIR, entry)],
    outdir: ESM_DIR,
    target: 'browser',
    format: 'esm',
    minify: true,
    naming: `${stem}${suffix}.js`,
    sourcemap: 'linked',
    external: [],
    emitDCEAnnotations: true,
    drop: ['console', 'debugger'],
  });

  if (result.success) {
    const filePath = join(ESM_DIR, `${stem}${suffix}.js`);
    let code = readFileSync(filePath, 'utf8');
    code = code.replace('__WASM_BASE64_PLACEHOLDER__', base64);
    writeFileSync(filePath, code);

    const minified = await minify(code, terserOptions);
    if (minified.code) {
      writeFileSync(join(ESM_DIR, `${stem}${suffix}.min.js`), minified.code);
      const gzipBytes = gzipSync(minified.code, { level: 6 }).length;
      console.log(
        `Built (minified): ${stem}${suffix}.min.js - ${gzipBytes.toLocaleString()} bytes (${(gzipBytes / 1024).toFixed(2)} KB) gzipped`,
      );
    }
  }
}

await buildInlined('decoder', 'size');
await buildInlined('decoder', 'perf');
await buildInlined('decoder-small', 'size');
await buildInlined('decoder-small', 'perf');
await buildInlined('codec', 'size');
await buildInlined('codec', 'perf');
await buildInlined('codec-lvl1', 'size');
await buildInlined('codec-lvl1', 'perf');

const webJs = readFileSync(join(ESM_DIR, 'index.web.js'), 'utf8');
const webPerfJs = webJs.replace(/zstd-decoder\.wasm/g, 'zstd-decoder-perf.wasm');
writeFileSync(join(ESM_DIR, 'index.web.perf.js'), webPerfJs);
console.log('Built: index.web.perf.js (via string replacement)');

const webSmallJs = readFileSync(join(ESM_DIR, 'index.web.small.js'), 'utf8');
const webSmallPerfJs = webSmallJs.replace(/zstd-decoder-small\.wasm/g, 'zstd-decoder-small-perf.wasm');
writeFileSync(join(ESM_DIR, 'index.web.small.perf.js'), webSmallPerfJs);
console.log('Built: index.web.small.perf.js (via string replacement)');

const codecWebJs = readFileSync(join(ESM_DIR, 'index.codec.web.js'), 'utf8');
const codecWebPerfJs = codecWebJs.replace(/zstd-codec\.wasm/g, 'zstd-codec-perf.wasm');
writeFileSync(join(ESM_DIR, 'index.codec.web.perf.js'), codecWebPerfJs);
console.log('Built: index.codec.web.perf.js (via string replacement)');

const codecLvl1WebJs = readFileSync(join(ESM_DIR, 'index.codec.lvl1.web.js'), 'utf8');
const codecLvl1WebPerfJs = codecLvl1WebJs.replace(/zstd-codec-lvl1\.wasm/g, 'zstd-codec-lvl1-perf.wasm');
writeFileSync(join(ESM_DIR, 'index.codec.lvl1.web.perf.js'), codecLvl1WebPerfJs);
console.log('Built: index.codec.lvl1.web.perf.js (via string replacement)');

copyFileSync(WASM_SOURCE_PATH, join(ESM_DIR, 'zstd-decoder.wasm'));
copyFileSync(WASM_PERF_PATH, join(ESM_DIR, 'zstd-decoder-perf.wasm'));
copyFileSync(WASM_SMALL_PATH, join(ESM_DIR, 'zstd-decoder-small.wasm'));
copyFileSync(WASM_SMALL_PERF_PATH, join(ESM_DIR, 'zstd-decoder-small-perf.wasm'));
copyFileSync(WASM_CODEC_PATH, join(ESM_DIR, 'zstd-codec.wasm'));
copyFileSync(WASM_CODEC_PERF_PATH, join(ESM_DIR, 'zstd-codec-perf.wasm'));
copyFileSync(WASM_CODEC_LVL1_PATH, join(ESM_DIR, 'zstd-codec-lvl1.wasm'));
copyFileSync(WASM_CODEC_LVL1_PERF_PATH, join(ESM_DIR, 'zstd-codec-lvl1-perf.wasm'));
try {
  execSync('tsc --project tsconfig.json', {
    cwd: PKG_DIR,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  const standaloneDtsFiles = ['types.d.ts', 'index.d.ts'];

  for (const file of standaloneDtsFiles) {
    const srcPath = join(SRC_DIR, file);

    if (existsSync(srcPath)) {
      copyFileSync(srcPath, join(TYPES_DIR, file));
      console.log(`Copied: ${file}`);
    }
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}

if (PREP) {
  console.log('\nCopying root files to src folder...');

  if (existsSync(LICENSE_PATH)) {
    copyFileSync(LICENSE_PATH, join(SRC_DIR, 'LICENSE'));
    console.log('Copied: LICENSE');
  } else {
    console.warn('LICENSE file not found at root directory');
  }

  if (existsSync(README_PATH)) {
    copyFileSync(README_PATH, join(SRC_DIR, 'README.md'));
    console.log('Copied: README.md');
  } else {
    console.warn('README.md file not found at root directory');
  }
}
