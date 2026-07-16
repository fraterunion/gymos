const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const projectRoot = __dirname;
const WORKSPACE_ROOT = path.resolve(projectRoot, '../..');
const config = getDefaultConfig(projectRoot);

// Workspace packages (e.g. @gymos/utils) live outside the app root.
config.watchFolders = [WORKSPACE_ROOT];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(WORKSPACE_ROOT, 'node_modules'),
];

// ─── React deduplication ───────────────────────────────────────────────────
// The pnpm monorepo has two peer-resolved instances of use-sync-external-store@1.6.0:
//   • (react@19.1.0) — for apps/mobile
//   • (react@19.2.4) — for apps/admin (Next.js)
//
// pnpm hoists the 19.2.4 instance to root node_modules. That package ships a
// physical node_modules/react@19.2.4 inside it. Metro's filesystem walk finds
// this local copy first, so any package that does require('react') from within
// use-sync-external-store gets React 19.2.4, which has no render dispatcher →
// "Cannot read property 'useRef' of null" at useFrameSize / SceneView.
//
// extraNodeModules is checked AFTER local node_modules and does not override them.
// resolveRequest fires BEFORE Metro's filesystem walk and always wins.
//
// This resolver MUST be set before withNativeWind — NativeWind/css-interop installs
// its own resolveRequest and chains whatever is in config.resolver.resolveRequest at
// that moment. Setting ours first means NativeWind chains ours correctly.

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === 'react' ||
    moduleName.startsWith('react/') ||
    moduleName === 'react-dom' ||
    moduleName.startsWith('react-dom/')
  ) {
    // Pretend the require originates from the workspace root so Metro's
    // node_modules walk starts at root/node_modules — where react@19.1.0 lives —
    // instead of resolving upward from the requiring package's location (which
    // might find a nested react@19.2.4 first).
    return context.resolveRequest(
      { ...context, originModulePath: path.join(WORKSPACE_ROOT, '__react_shim__.js') },
      moduleName,
      platform
    );
  }
  return context.resolveRequest(context, moduleName, platform);
};

// ─── Metro watcher fix ────────────────────────────────────────────────────
// @expo/metro 54.x defaults inject watcher.unstable_workerThreads = false.
// Newer EAS Metro removes that key and rejects it with an unknown-option error.
if (config.watcher) {
  delete config.watcher.unstable_workerThreads;
}

module.exports = withNativeWind(config, { input: './global.css' });
