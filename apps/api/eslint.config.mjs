import base from '@gymos/config/eslint';
import globals from 'globals';

export default [
  ...base,
  {
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },
];
