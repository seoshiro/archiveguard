import js from '@eslint/js';
import ts from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
export default ts.config(
  { ignores: ['dist/**', 'node_modules/**', 'package/**', 'test-results/**', 'playwright-report/**', 'verification/**', '.npm-cache/**', 'evidence/**'] },
  js.configs.recommended, ...ts.configs.recommended,
  { files: ['**/*.{ts,tsx}'], plugins: { 'react-hooks': hooks }, rules: { ...hooks.configs.recommended.rules, 'react-hooks/set-state-in-effect': 'off' } },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: { console: 'readonly', Buffer: 'readonly', URL: 'readonly', process: 'readonly', fetch: 'readonly', AbortSignal: 'readonly' } } },
);
