/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './contexts/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset'), require('@gymos/config/tailwind-preset')],
  theme: {
    extend: {},
  },
  plugins: [],
};
