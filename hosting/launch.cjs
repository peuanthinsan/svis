'use strict';
const fs = require('node:fs');
const path = require('node:path');

function launch(options = {}) {
  const environment = options.environment || process.env;
  const root = options.root || path.resolve(__dirname, '..');
  const load = options.load || require;
  if (!environment.SONGDEE_CONFIG) throw new Error('SONGDEE_CONFIG must identify the protected runtime JSON');
  // The controller's candidate port must take precedence over the runtime configuration.
  const candidatePort = environment.SONGDEE_CANDIDATE_PORT;
  if (candidatePort !== undefined && (!/^[1-9]\d{3,4}$/.test(candidatePort) ||
      Number(candidatePort) < 1024 || Number(candidatePort) > 65535)) {
    throw new Error('Invalid candidate port; use 1024 through 65535');
  }
  const settings = JSON.parse(fs.readFileSync(environment.SONGDEE_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Runtime settings must be a JSON object');
  for (const [key, value] of Object.entries(settings)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || ['NODE_OPTIONS', 'PATH', 'NODE_PATH'].includes(key)) throw new Error('Invalid runtime setting name');
    if (!['string', 'number', 'boolean'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value)) || String(value).includes('\0')) throw new Error('Invalid runtime setting value');
  }
  const { app } = JSON.parse(fs.readFileSync(path.join(root, 'hosting/app.json'), 'utf8'));
  const servers = { dashboard: 'server.js', ops: 'web/server.js', svis: 'dist/server.cjs' };
  if (!Object.hasOwn(servers, app)) throw new Error('Unknown application');
  for (const [key, value] of Object.entries(settings)) environment[key] = String(value);
  environment.SONGDEE_WINDOWS_HOSTING = '1';
  environment.NODE_ENV = 'production';
  environment.HOST = environment.HOSTNAME = '127.0.0.1';
  if (candidatePort !== undefined) environment.PORT = candidatePort;
  if (app === 'dashboard') {
    delete environment.AUTH_URL;
    delete environment.NEXTAUTH_URL;
    environment.AUTH_TRUST_HOST = 'true';
  }
  load(path.join(root, servers[app]));
}

module.exports = { launch };
if (require.main === module) launch();
