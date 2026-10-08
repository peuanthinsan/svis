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

Dependency installs continue to use `npm ci` and the lockfiles, with `--prefer-offline` to reuse npm's local download cache. The helper logs command durations so repeated builds can be compared without skipping any install, regression check, build, or packaging step.

OPS and Dashboard can reuse only Next's compiler data from `.next/cache/turbopack` (`web/.next/cache/turbopack` in OPS). Snapshots live outside disposable checkouts in the current user's temporary directory under `songdee-compiler-cache-v1-<user hash>`. Keys include the app, platform, architecture, full Node version, root/web package manifests and lockfiles, Next/TypeScript configuration, and explicit public build settings. No runtime fetch cache, complete `.next` output, environment file, secret, or packaged release is persisted. Existing Next flags are unchanged: if the installed framework does not produce compiler cache data, the helper simply has nothing to save.

Restoration happens after regression checks pass. Cache read/write failures log a skip and leave the build usable without persistent caching. If a Next command fails after a cache hit, the helper removes only the checkout's compiler cache and retries that same command once cold. A failed final build or packaging step never publishes a snapshot; a successful cold recovery can publish fresh compiler data. Cache snapshots are atomic, limited to 256 MiB each and two per app; abandoned publication folders older than one day are cleaned on successful publication. Links and paths overlapping the source/release are rejected. Unix caches also require ownership by the current user and no group/world write access. Set `SONGDEE_BUILD_CACHE=0` in the parent process for a run with persistent compiler-cache restore/save disabled. This switch is not passed into build subprocesses. The programmatic `cacheDirectory` option exists for isolated tests; it is not a CLI or deployment-setting override.

Run the isolated helper checks with `node --test hosting/helpers.node-test.cjs hosting/cache.node-test.cjs`. These validate the settings guard, subprocess environments, package layout, npm discovery, launcher, cold/warm caches, invalidation, I/O failures, bounded concurrent publication, path isolation, and failed-build behavior without installing dependencies or starting applications.

Deployment is not enabled by adding these files. The Windows controller, service configuration, initial baseline revision, and rollback checks must be installed and validated separately.
