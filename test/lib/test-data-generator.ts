import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = join(__dirname, '../data');
const ZSTD_DIR = join(__dirname, '../../vendor/zstd');

const TEST_FILES: Array<[string, string]> = [
  ['tiny-256b.bin', '-g256 -P80 -s8'],
  ['small-highly-compressible.bin', '-g1024 -P90 -s1'],
  ['medium-10k.bin', '-g10240 -P50 -s2'],
  ['random-10k.bin', '-g10240 -P0 -s6'],
  ['repetitive-50k.bin', '-g51200 -P95 -s7'],
  ['medium-100k.bin', '-g102400 -P70 -s3'],
  ['large-512k.bin', '-g524288 -P65 -s4'],
  ['large-1m.bin', '-g1048576 -P60 -s5'],
];

export function ensureTestData(): void {
  if (existsSync(join(DATA_DIR, 'large-1m.bin'))) return;
  mkdirSync(DATA_DIR, { recursive: true });

  const datagen = `${ZSTD_DIR}/tests/datagen`;

  if (!existsSync(datagen)) {
    execFileSync('make', ['datagen'], { cwd: `${ZSTD_DIR}/tests`, stdio: 'pipe' });
  }

  TEST_FILES.forEach(([name, args]) => {
    const filePath = join(DATA_DIR, name);
    const fd = openSync(filePath, 'w');
    try {
      spawnSync(datagen, args.split(' '), {
        stdio: ['ignore', fd, 'inherit'],
      });
    } finally {
      closeSync(fd);
    }
  });

  const testJsonPath = join(DATA_DIR, 'test.json');
  if (!existsSync(testJsonPath)) {
    const testData = {
      name: 'test',
      data: Array(100)
        .fill(0)
        .map((_, i) => ({
          id: i,
          value: `value_${i}`,
          nested: { field: `field_${i}` },
        })),
    };
    writeFileSync(testJsonPath, JSON.stringify(testData, null, 2));
  }
}
