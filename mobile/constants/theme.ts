/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import { Platform } from 'react-native';

const tintColorLight = '#18181b'; // zinc-900
const tintColorDark = '#fafafa'; // zinc-50

export const Colors = {
  light: {
    text: '#09090b', // zinc-950
    background: '#ffffff', // white
    tint: tintColorLight,
    icon: '#71717a', // zinc-500
    tabIconDefault: '#a1a1aa', // zinc-400
    tabIconSelected: tintColorLight,
    border: '#e4e4e7', // zinc-200
  },
  dark: {
    text: '#fafafa', // zinc-50
    background: '#09090b', // zinc-950
    tint: tintColorDark,
    icon: '#a1a1aa', // zinc-400
    tabIconDefault: '#71717a', // zinc-500
    tabIconSelected: tintColorDark,
    border: '#27272a', // zinc-800
  },
};

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
