/* oxlint-disable t3code/no-global-process-runtime -- The standalone deploy CLI needs the host platform. */
export const hostPlatform = process.platform;
export const isWindows = hostPlatform === "win32";
