// SDK identity constants, stamped on `session-config`. Lives outside wire/
// because hey-api's `clean: true` wipes that directory on every regen.

import packageJson from '../package.json';

/** The npm package name, sent as the SDK identity on `session-config` and
 *  the `X-Cosmo-SDK` request header. */
export const SDK_NAME: string = packageJson.name;

/** The package version, read from package.json at build time. */
export const SDK_VERSION: string = packageJson.version;
