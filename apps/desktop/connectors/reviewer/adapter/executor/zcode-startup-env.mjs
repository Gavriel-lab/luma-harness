import {existsSync} from 'node:fs';
import {dirname,join} from 'node:path';

/** Calling the desktop's CJS directly bypasses its desktop runtime bootstrap.
 * Recent CLI builds search source-tree paths that do not match the packaged
 * resources/glm + resources/config layout. Point only this child at the
 * installed built-in provider file via ZCode's supported runtime setting.
 * The CLI still owns account auth, personal providers and selected model. */
export function resolveZcodeStartupEnv(entrypoint,env=process.env,exists=existsSync){
  const result={...env};
  if(typeof env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE==='string'&&env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE.trim())return result;
  const folder=dirname(entrypoint);
  // Preserve the CLI's ordinary provider directory if it already works.
  if(exists(join(folder,'provider','zcode-builtin.json')))return result;
  const installed=join(folder,'..','config','provider','zcode-builtin.json');
  if(exists(installed))result.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=installed;
  return result;
}
