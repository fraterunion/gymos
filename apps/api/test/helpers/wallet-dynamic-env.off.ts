import { applyWalletDynamicEnv } from './wallet-dynamic-env';

// Side-effect module: import it FIRST (before anything that imports AppModule).
applyWalletDynamicEnv({ dynamic: false, routes: false, apns: false });
