import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';

/**
 * Mobile Native Lifecycle Hook.
 * Connects native hardware events (Back Button, App Backgrounding, Status Bar)
 * to the React application on Android & iOS devices.
 */
export function useMobileLifecycle(options?: {
  onHardwareBack?: () => boolean; // Return true if back was handled (e.g. closed modal)
}) {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    // 1. Configure Native Status Bar
    try {
      const isDark = document.documentElement.classList.contains('dark');
      StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
      if (Capacitor.getPlatform() === 'android') {
        StatusBar.setBackgroundColor({ color: isDark ? '#0f172a' : '#ffffff' });
      }
    } catch (err) {
      console.warn('Status bar initialization failed:', err);
    }

    // 2. Listen to Android Hardware Back Button
    const backSub = App.addListener('backButton', ({ canGoBack }) => {
      // Check if custom handler handled it (e.g. closed an open modal)
      if (options?.onHardwareBack && options.onHardwareBack()) {
        return;
      }

      // Check if standard browser history can go back
      if (canGoBack) {
        window.history.back();
      } else {
        // At root page — minimize app rather than force kill
        App.minimizeApp();
      }
    });

    // 3. Listen to App Lifecycle (Background / Foreground for Proctoring Strikes)
    const appStateSub = App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        // App was backgrounded, switched away from, or notification shade pulled down
        window.dispatchEvent(
          new CustomEvent('mobile-proctor-violation', {
            detail: { reason: 'Application minimized or switched to background' },
          })
        );
      }
    });

    return () => {
      backSub.then((sub) => sub.remove());
      appStateSub.then((sub) => sub.remove());
    };
  }, [options]);
}
