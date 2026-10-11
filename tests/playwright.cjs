/* Resolve Playwright without a developer's absolute path in the repository.

   Precedence:
     RELAY_PLAYWRIGHT   an existing playwright package directory (or its entry
                        file). This is how a machine with Playwright installed
                        somewhere unusual keeps working.
     playwright         resolvable from node_modules anywhere up the tree.

   Failure is loud on purpose. The previous code hardcoded one machine's path, so
   every suite here died with a module-not-found error on anyone else's box; a
   silent fallback would let them "pass" by never launching a browser at all,
   which is worse than an error.
*/
const fs = require('node:fs');
const path = require('node:path');

function fromEnv() {
  const raw = process.env.RELAY_PLAYWRIGHT;
  if (!raw) return null;
  const target = path.resolve(raw);
  if (!fs.existsSync(target)) {
    throw new Error(`RELAY_PLAYWRIGHT points at a path that does not exist: ${target}`);
  }
  return fs.statSync(target).isDirectory() ? path.join(target, 'index.js') : target;
}

function resolve() {
  const explicit = fromEnv();
  if (explicit) return explicit;
  try {
    return require.resolve('playwright');
  } catch (_) {
    /* try the sibling install below */
  }
  // Runtimes that ship Node often install Playwright next to the binary rather
  // than in a node_modules the script can see. Deriving it from process.execPath
  // finds that install on any machine, which is what the old absolute path did for
  // exactly one.
  const sibling = path.join(path.dirname(process.execPath), 'node_modules', 'playwright');
  if (fs.existsSync(sibling)) return sibling;
  throw new Error(
    'Playwright is not installed and RELAY_PLAYWRIGHT is not set.\n' +
    '  install:  npm install --no-save playwright\n' +
    '  or point at an existing package:\n' +
    '    $env:RELAY_PLAYWRIGHT = "C:/path/to/node_modules/playwright"'
  );
}

module.exports = require(resolve());
