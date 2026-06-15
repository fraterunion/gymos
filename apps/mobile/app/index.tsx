import { useEffect } from 'react';
import { useRouter } from 'expo-router';

import { PremiumBootScreen } from '@/components/PremiumBootScreen';
import { useAuth } from '@/contexts/AuthContext';
import { useBranding } from '@/contexts/BrandingContext';

export default function BootScreen() {
  const router = useRouter();
  const { status, logoUrl } = useBranding();
  const { hydrated } = useAuth();

  useEffect(() => {
    if (status !== 'ready' || !hydrated) return;
    router.replace('/(app)/(tabs)');
  }, [status, hydrated, router]);

  return <PremiumBootScreen logoUrl={logoUrl} />;
}
