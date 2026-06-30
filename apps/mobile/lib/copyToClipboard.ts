import { Platform, Share } from 'react-native';

/**
 * Best-effort clipboard copy. Web uses the Clipboard API; native opens the share
 * sheet with the text (no extra dependency). Callers should show their own feedback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;

  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(trimmed);
      return true;
    } catch {
      return false;
    }
  }

  try {
    await Share.share({ message: trimmed });
    return true;
  } catch {
    return false;
  }
}
