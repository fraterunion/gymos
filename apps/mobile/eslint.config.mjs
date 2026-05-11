import base from '@gymos/config/eslint';

export default [
  {
    ignores: ['metro.config.js', 'tailwind.config.js', 'babel.config.js'],
  },
  ...base,
];
