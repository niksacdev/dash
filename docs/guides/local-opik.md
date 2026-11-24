# Run Opik on this computer

DASH can show a Financial Services or Manufacturing evaluation in a local Opik dashboard. You can inspect the dataset version, the approved prompt version when present, the candidate experiments, and their trace scores. Setup starts the service. You choose which finished runs to sync from **Run history**.

## First start

Install Node.js 22.13 or later, Git, and Docker with the Compose plugin (2.24.4 or later). On macOS or Windows, start Docker Desktop once and complete its onboarding. Choose a local Docker socket or named pipe. Docker Desktop licensing depends on your organization. Opik’s self-hosted service requires no Opik account, subscription, or API key.

```sh
git clone https://github.com/niksacdev/dash.git
cd dash/dash-desktop
npm ci
npm run setup:local
npm start
```

Wait for **Local dashboard and API ready**. On subsequent launches, DASH reads the local connection saved by setup. If DASH was open during first setup, reopen it. An explicitly configured `DASH_OPIK_API_URL` takes precedence. For a separate Opik service, use HTTPS for both the API and dashboard URLs. Configure the final API URL exposed by your reverse proxy. A redirect interrupts synchronization and leaves the saved run available for retry. HTTP is supported on `localhost`, `127.0.0.1` and `[::1]`. Keep credentials in `OPIK_API_KEY`. The SDK masks the configured key in its initialization logs even when debug logging is enabled.

Open **Run history**, choose a completed run, and review the destination and data scope in **Opik experiments**. Select **Sync saved run to Opik**, then **Open Opik dashboard**. The local dashboard is at [127.0.0.1:51734](http://127.0.0.1:51734). The workspace is `default` and project is `DASH`.

## Start, inspect, and stop

Run these commands from `dash-desktop/`.

| Command | Effect |
| --- | --- |
| `npm run opik:start` | Starts or resumes the same local stack. Cached configuration and images can be reused offline. |
| `npm run opik:status` | Shows container state and checks both dashboard and API readiness. |
| `npm run opik:stop` | Stops the DASH-managed services. Docker keeps the named volumes for the next start. |

The first setup downloads public images plus five checksummed upstream configuration files. It runs the Opik web application and API, MySQL, Redis, ClickHouse, ZooKeeper and MinIO. Initialization jobs finish after preparing local storage. On one Apple Silicon Mac, the eight ARM64 images reported 3.79 GiB of unpacked image sizes, including shared layers counted per image. After initialization, Docker reported 2.67 GiB of memory across seven running services. Experiment volumes grow with the data you sync. Allow time and disk space for the first download and database migrations. Containers share Docker's memory allocation with other projects. Stop the stack to release running container memory when you only need offline DASH.

The deployment uses its own Compose project, `dash-opik-local`. Seven named volumes hold databases, logs and storage. Configuration and the small local connection marker live under `~/.dash/opik-local/`. The only host port published by the deployment is IPv4 loopback port 51734. The Opik service has no user authentication on that interface. Setup disables backend usage reporting. DASH runs G-Eval locally with its selected judge. This setup omits Opik’s separate Python execution service for server-side evaluation and optimization jobs.

## If setup or sync stops midway

- **Docker offline.** Start Docker and rerun `npm run opik:start`. The start command also attempts to start an installed Docker Desktop on a supported local context. A remote Docker context cannot provide the app’s local destination.
- **Port 51734 in use.** Identify its listener and decide whether to stop it. DASH leaves the existing listener running. The same rule protects pre-existing Docker resources that use a DASH-reserved name.
- **Service unavailable.** Run `npm run opik:status`. For database startup or migration errors, run `docker logs --tail 80 dash-opik-local-backend-1`. Retry `npm run opik:start` after resolving the issue. A failed first setup enables the local destination only after a successful retry.
- **Interrupted sync.** Saved DASH runs remain in local SQLite. Restore the service, choose the same run in Run history, and select **Resume saved run sync**. Removing Docker volumes erases the service’s experiment data.

The launcher uses Opik release 2.2.144. It verifies downloaded files and pins the container images by digest. [Official Compose deployment at the pinned revision](https://github.com/comet-ml/opik/tree/cbc0c11195a51951ad472dde4bb82cab47b21ab6/deployment/docker-compose) · [Upstream local deployment guide](https://www.comet.com/docs/opik/self-host/local_deployment) · [DASH offline and sync design](../adr/0002-opik-and-offline-runs.md) · [Local service decision](../adr/0004-local-opik-service.md)
