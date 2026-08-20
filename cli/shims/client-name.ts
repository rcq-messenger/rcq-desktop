// The web derives this label from the user agent; a CLI has none. Same export
// surface as src/lib/client-name.ts (build.mjs redirects the import). The
// phones truncate the linked-devices label at 24 characters — 'Console ·
// darwin' and friends all fit.

import os from 'node:os'

export async function clientLabel(): Promise<string> {
  return `Console · ${os.platform()}`
}
