import * as SplashScreen from 'expo-splash-screen';

let hideRequested = false;

/** Hide the native splash once the RN boot surface matches it (idempotent). */
export function hideNativeSplashWhenReady(): void {
  if (hideRequested) return;
  hideRequested = true;
  void SplashScreen.hideAsync();
}
