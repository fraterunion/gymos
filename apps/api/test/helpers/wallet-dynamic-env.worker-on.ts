import { applyWalletDynamicEnv } from './wallet-dynamic-env';

// Side-effect module: import it FIRST (before anything that imports AppModule). The worker flag
// is on so health evaluates worker liveness; the background timer is still never started — tests
// call worker.tick() with an explicit clock.
applyWalletDynamicEnv({ dynamic: true, routes: true, apns: true, worker: true });
