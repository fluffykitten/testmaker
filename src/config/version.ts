/**
 * Application Version & Developer Metadata
 * Synced automatically from package.json via Vite `define.__APP_VERSION__`.
 */
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION_NUMBER =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '2.5.1';
export const APP_VERSION = `v.${APP_VERSION_NUMBER}`;
export const APP_NAME = 'ICM Exam Platform';
export const DEVELOPER_NAME = 'fluffykitten';
export const DEVELOPER_EMAIL = 'salman.madani@icm.sch.id';
