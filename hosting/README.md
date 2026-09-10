# Windows hosting

Build with Node 24 and npm from a clean checkout on Windows or macOS:

```sh
node hosting/build.cjs PUBLIC_BUILD_SETTINGS_JSON OUTPUT_DIRECTORY
```

The output directory must not exist and must be outside the checkout. The build settings must be a JSON object containing only `NEXT_PUBLIC_` keys and string, finite number, or boolean values. Use `{}` if none are required. These values are public and can be embedded in browser assets; never supply production secrets.

The helper rejects `.env` and `.env.*` files in the checkout root and `web` before running commands. Only `.env.example`, `.env.sample`, and `.env.template` are permitted. It passes a small operating-system environment allowlist plus dummy database/auth settings to every install and build subprocess, and ignores user/global npm configuration. Do not put credentials in project `.npmrc` files or build scripts. Database migrations are never part of this build.

Start a packaged release with `SONGDEE_CONFIG` pointing to its protected runtime JSON, then run `node hosting/launch.cjs`. Runtime configuration remains outside Git and the release. The launcher opts into `SONGDEE_WINDOWS_HOSTING=1` and binds to `127.0.0.1`. Existing cloud deployments leave that flag unset. A controller-supplied `SONGDEE_CANDIDATE_PORT` (1024–65535) overrides the configured port for validation.

For SVIS, `hosting/launch.cjs` with `SONGDEE_CONFIG` is the authoritative entrypoint for new packaged releases. `host/launch.cjs` with `SVIS_CONFIG` remains a legacy compatibility entrypoint and is not copied into release packages.

SVIS packaging runs its host, proxy-header and PostgreSQL-adapter tests. OPS packaging runs the Windows-hosting, admin-auth, database-schema and production-API-boundary checks before the application build. A failed check stops packaging.

Run the isolated helper checks with `node --test hosting/helpers.node-test.cjs`. These validate the settings guard, subprocess environments, package layout, npm discovery and launcher without installing dependencies or starting applications.

Deployment is not enabled by adding these files. The Windows controller, service configuration, initial baseline revision, and rollback checks must be installed and validated separately.
