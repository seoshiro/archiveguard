import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATUS_LABEL } from '../src/engine';
import { catalog, catalogKeys, count, instant, LOCALE_STORAGE_KEY, locales, message, number, readLocale, saveLocale, t, translations } from '../src/i18n';

const placeholders = (text: string) => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map(match => match[1]).sort();
const safeError = 'This file could not be read safely. Check the format and try a smaller sample.';

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
function canonicalMessages(source: ts.SourceFile): string[] {
  const found = new Set<string>();
  function values(node: ts.Node | undefined): string[] {
    if (!node) return [];
    if (ts.isStringLiteralLike(node)) return [node.text.trim()];
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const expression = span.expression.getText(source);
        const name = expression === 'policy.offsetMinutes' ? 'minutes' : expression === 'entry.path' ? 'path' : expression;
        if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) return [];
        text += '{' + name + '}' + span.literal.text;
      }
      return [text.trim()];
    }
    if (ts.isConditionalExpression(node)) return [...values(node.whenTrue), ...values(node.whenFalse)];
    if (ts.isBinaryExpression(node)) return [...values(node.left), ...values(node.right)];
    if (ts.isParenthesizedExpression(node)) return values(node.expression);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(values);
    return [];
  }
  function add(node: ts.Node | undefined) { values(node).filter(value => /^[A-Z]/.test(value)).forEach(value => found.add(value)); }
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'Error') add(node.arguments?.[0]);
    if (ts.isPropertyAssignment(node) && ['note', 'reason', 'warning', 'message', 'limitations', 'gps', 'writeScope'].includes(node.name.getText(source))) add(node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && ['note', 'reason', 'warning'].includes(node.left.name.text)) add(node.right);
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'progress') add(node.arguments.at(-1));
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...found];
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('complete canonical translation catalogs', () => {
  it('has identical locale key sets, unique English keys and matching placeholders', () => {
    expect(locales).toEqual(['en', 'ru', 'kk']);
    expect(new Set(catalogKeys).size).toBe(catalogKeys.length);
    expect(Object.keys(catalog).sort()).toEqual([...catalogKeys].sort());
    for (const locale of locales) {
      expect(Object.keys(translations[locale]).sort()).toEqual([...catalogKeys].sort());
      for (const key of catalogKeys) {
        expect(translations[locale][key], `${locale}: ${key}`).toBeTruthy();
        expect(placeholders(translations[locale][key]), `${locale}: ${key}`).toEqual(placeholders(key));
      }
    }
  });

  it('covers every canonical engine, JPEG, worker and status message', () => {
    const keys = [...Object.values(STATUS_LABEL), ...['../src/engine.ts', '../src/jpeg.ts', '../src/worker.ts'].flatMap(path => canonicalMessages(sourceFile(path)))];
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      expect(Object.hasOwn(catalog, key), `Missing canonical message: ${key}`).toBe(true);
      expect(t('ru', key), key).not.toBe(key);
      expect(t('kk', key), key).not.toBe(key);
    }
  });

  it('covers UI labels in calls, conditionals, dictionaries and arrays, plus report labels', () => {
    const internal = new Set(['Escape', 'Demo unavailable', 'Demo list invalid', 'Demo asset unavailable']);
    const stable = new Set(['ArchiveGuard', 'UTC', 'MiB', 'KiB']);
    for (const path of ['../src/App.tsx', '../src/reports.ts', '../src/Privacy.tsx', '../src/Language.tsx']) {
      let source: ts.SourceFile;
      try { source = sourceFile(path); }
      catch (error) { if ((path.endsWith('/Privacy.tsx') || path.endsWith('/Language.tsx')) && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const keys = new Set<string>();
      function visit(node: ts.Node): void {
        // A download attribute names the saved file. The same text in a label,
        // JSX body or translation call must still be covered by the catalog.
        const downloadFilename = ts.isStringLiteralLike(node) && ts.isJsxAttribute(node.parent) && node.parent.name.getText(source) === 'download';
        if (ts.isStringLiteralLike(node) && /^[A-Z]/.test(node.text) && !internal.has(node.text) && !stable.has(node.text) && !downloadFilename) keys.add(node.text);
        if (ts.isCallExpression(node)) {
          const name = node.expression.getText(source);
          const arg = name === 'tr' ? node.arguments[0] : name === 't' || name === 'message' ? node.arguments[1] : undefined;
          if (arg && ts.isStringLiteralLike(arg)) keys.add(arg.text);
          if (name === 'count') for (const form of node.arguments.slice(2, 5)) if (ts.isStringLiteralLike(form)) keys.add(form.text);
        }
        if (ts.isJsxText(node) && /[A-Za-z]/.test(node.text.trim()) && !stable.has(node.text.trim())) expect(node.text.trim(), `${path}: untranslated JSX text`).toBe('');
        ts.forEachChild(node, visit);
      }
      visit(source);
      for (const key of keys) expect(Object.hasOwn(catalog, key), `${path}: ${key}`).toBe(true);
    }
  });

  it('keeps English canonical and safely substitutes user data without modifying it', () => {
    for (const key of catalogKeys) expect(t('en', key)).toBe(key);
    const path = 'отпуск/Сурет {count} $&.jpg';
    expect(t('en', 'Review {path}', { path })).toBe('Review ' + path);
    expect(t('ru', 'Review {path}', { path })).toBe('Проверка ' + path);
    expect(t('kk', 'Review {path}', { path })).toBe(path + ' файлын тексеру');
    expect(t('ru', 'Write {date} UTC{offset} using the export policy.', { date: '2023:11:15 03:58:20', offset: '+05:45' })).toContain('2023:11:15 03:58:20 UTC+05:45');
    expect(t('kk', 'An unknown UI key')).toBe('An unknown UI key');
  });
});

describe('safe canonical findings and errors', () => {
  it('localizes specific engine findings and errors without raw parser details', () => {
    for (const locale of locales) {
      expect(message(locale, 'Malformed JSON or invalid UTF-8 sidecar.')).toBe(t(locale, 'Malformed JSON or invalid UTF-8 sidecar.'));
      for (const raw of ['Unexpected token p in JSON at position 12', 'Unable to read filename private-photo.jpg', '<script>private sidecar content</script>', 'RangeError: offset out of bounds', 'EXIF tag private JSON content is outside the supported lossless rewrite scope.', 'EXIF tag 99999 is outside the supported lossless rewrite scope.']) {
        expect(message(locale, raw)).toBe(t(locale, safeError));
        expect(message(locale, raw)).not.toContain(raw);
      }
    }
  });

  it('preserves filenames, EXIF tag IDs and UTC minute values in known dynamic errors', () => {
    const path = 'альбом/Фото $& (1).jpg';
    for (const locale of locales) {
      expect(message(locale, `Selected input changed: ${path}. Import it again.`)).toBe(t(locale, 'Selected input changed: {path}. Import it again.', { path }));
      expect(message(locale, `Choose a valid capture sidecar for ${path}.`)).toBe(t(locale, 'Choose a valid capture sidecar for {path}.', { path }));
      expect(message(locale, 'EXIF tag 65500 is outside the supported lossless rewrite scope.')).toBe(t(locale, 'EXIF tag {tag} is outside the supported lossless rewrite scope.', { tag: 65500 }));
      expect(message(locale, 'Reviewed sidecar capture instant; UTC offset -345 minutes. Only DateTimeOriginal and OffsetTimeOriginal written; SubSecTimeOriginal removed.')).toBe(t(locale, 'Reviewed sidecar capture instant; UTC offset {minutes} minutes. Only DateTimeOriginal and OffsetTimeOriginal written; SubSecTimeOriginal removed.', { minutes: -345 }));
    }
  });

  it('localizes an exclusion and its nested finding while safely replacing an unknown tail', () => {
    const finding = 'No matching valid sidecar. Keep an unchanged copy or exclude this file.';
    expect(message('kk', 'Explicitly excluded in review. ' + finding)).toBe(t('kk', 'Explicitly excluded in review.') + ' ' + t('kk', finding));
    expect(message('ru', 'Explicitly excluded in review. Private parser content')).toBe(t('ru', 'Explicitly excluded in review.') + ' ' + t('ru', safeError));
  });
});

describe('language preference without archive persistence', () => {
  it('defaults to English and accepts only saved supported locale codes', () => {
    const getItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem });
    for (const stored of [null, '', 'RU', 'fr', '{"path":"photo.jpg"}']) { getItem.mockReturnValue(stored); expect(readLocale()).toBe('en'); }
    for (const locale of locales) { getItem.mockReturnValue(locale); expect(readLocale()).toBe(locale); }
    expect(getItem.mock.calls.every(args => args.length === 1 && args[0] === LOCALE_STORAGE_KEY)).toBe(true);
  });

  it('writes only the namespaced preference and leaves other stored data untouched', () => {
    const store = new Map([['unrelated.preference', 'keep']]);
    const setItem = vi.fn((key: string, value: string) => { store.set(key, value); });
    vi.stubGlobal('localStorage', { setItem });
    expect(saveLocale('kk')).toBe(true);
    expect(setItem).toHaveBeenCalledExactlyOnceWith('archiveguard.locale', 'kk');
    expect([...store.entries()]).toEqual([['unrelated.preference', 'keep'], ['archiveguard.locale', 'kk']]);
    expect(saveLocale('fr' as never)).toBe(false);
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it('works when storage is absent, blocked at access, or throws on read/write', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readLocale()).toBe('en'); expect(saveLocale('ru')).toBe(false);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } });
    expect(readLocale()).toBe('en'); expect(saveLocale('kk')).toBe(false);
    vi.unstubAllGlobals();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('SecurityError'); } });
    try { expect(readLocale()).toBe('en'); expect(saveLocale('ru')).toBe(false); }
    finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); }
  });
});

describe('localized numbers, UTC dates and plurals', () => {
  it('uses the chosen locale for numbers and honors display precision', () => {
    expect(number('en', 1234.5)).toBe('1,234.5');
    expect(number('ru', 1234.5)).toBe(new Intl.NumberFormat('ru-RU').format(1234.5));
    expect(number('kk', 12.5, { minimumFractionDigits: 2 })).toBe(new Intl.NumberFormat('kk-KZ', { minimumFractionDigits: 2 }).format(12.5));
  });

  it('renders every date in UTC regardless of device timezone and handles missing timestamps', () => {
    const epoch = Date.UTC(2023, 10, 14, 22, 13, 20) / 1000;
    for (const [locale, intl] of [['en', 'en-US'], ['ru', 'ru-RU'], ['kk', 'kk-KZ']] as const) {
      const expected = new Intl.DateTimeFormat(intl, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC', hour12: false }).format(new Date(epoch * 1000)) + ' UTC';
      expect(instant(locale, epoch)).toBe(expected);
      expect(instant(locale, null)).toBe(t(locale, 'Not supplied'));
      expect(instant(locale, undefined)).toBe(t(locale, 'Not supplied'));
      expect(instant(locale, Number.NaN)).toBe(t(locale, 'Not supplied'));
      expect(instant(locale, Number.MAX_VALUE)).toBe(t(locale, 'Not supplied'));
    }
  });

  it('selects English and Kazakh one/other and Russian one/few/many forms', () => {
    const inputCount = (locale: 'en' | 'ru' | 'kk', n: number) => count(locale, n, '{count} input', '{count} inputs (few)', '{count} inputs');
    expect(inputCount('en', 1)).toBe('1 input'); expect(inputCount('en', 2)).toBe('2 inputs');
    expect(inputCount('ru', 1)).toBe('1 файл'); expect(inputCount('ru', 2)).toBe('2 файла');
    expect(inputCount('ru', 5)).toBe('5 файлов'); expect(inputCount('ru', 11)).toBe('11 файлов');
    expect(inputCount('ru', 21)).toBe('21 файл'); expect(inputCount('ru', 22)).toBe('22 файла');
    expect(inputCount('ru', 1.5)).toBe('1,5 файлов');
    expect(inputCount('kk', 1)).toBe('1 файл'); expect(inputCount('kk', 22)).toBe('22 файл');
    expect(inputCount('kk', 0)).toBe('0 файл');
  });
});
