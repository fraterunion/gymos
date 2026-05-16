const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// @expo/metro (54.x) internally uses metro-config 0.83.3 whose defaults inject
// watcher.unstable_workerThreads = false. EAS build servers run a newer Metro that
// has removed this key from the accepted watcher schema and rejects it with:
//   "Unknown option 'watcher.unstable_workerThreads' with value false was found."
// Delete it explicitly so the config is valid on both old and new Metro versions.
if (config.watcher) {
  delete config.watcher.unstable_workerThreads;
}

module.exports = withNativeWind(config, { input: './global.css' });
