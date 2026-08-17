import type { Config } from 'jest';

/**
 * Minimal jest config for pure TypeScript logic tests only.
 * Tests in __tests__/ that import React Native components will fail here —
 * component-level tests require jest-expo + @testing-library/react-native.
 * These tests cover extracted pure functions with no RN dependencies.
 */
const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          module: 'CommonJS',
          moduleResolution: 'node',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    // Map @/ alias to the mobile app root
    '^@/(.*)$': '<rootDir>/$1',
    // Stub out any React Native / Expo modules that pure logic files don't need
    'expo-secure-store': '<rootDir>/__mocks__/expo-secure-store.ts',
    'react-native': '<rootDir>/__mocks__/react-native.ts',
  },
};

export default config;
