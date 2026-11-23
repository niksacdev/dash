# 0004. Start a local Opik service from DASH setup

**Status** Accepted

## Decision

DASH setup starts the upstream Opik Compose deployment on the operator's local Docker engine. Pin upstream configuration by commit and checksum and container images by digest. Publish only the frontend on loopback. Its reverse proxy serves the dashboard and API from the same address. The runtime needs no Opik subscription or credentials for this deployment.

The launcher manages a labeled Compose project and its named volumes. It refuses conflicting resources. A private marker records the expected loopback port after both the frontend and API respond. A configured external Opik deployment takes precedence. The SQLite workspace remains the source of the original measured run. The operator chooses which saved evidence to send from Run history.

## Why a separate service process

Using the published Opik server gives DASH upstream experiments, datasets, prompts and feedback without maintaining a fork. The containers can stop while Electron continues offline. Running the services inside Electron would couple database startup, memory use and upgrades to every desktop launch. An account-based default would require network access and move case data off the workstation.

## Operating cost and verification

Docker with Compose is required and the initial download needs several gigabytes. Stop the services to release their running memory. The deployment supports SDK-based grading in DASH. Opik's optional server-side Python execution service is outside this installation.

On Apple Silicon, setup, stop and restart retained the seven named volumes and restored the API at the same address. A completed synthetic Manufacturing run sent from DASH produced two native experiments with case-level feedback on the same dataset and approved prompt versions. The dashboard is reachable on the computer running Docker. [Setup guide](../guides/local-opik.md) · [Upstream deployment](https://github.com/comet-ml/opik/tree/cbc0c11195a51951ad472dde4bb82cab47b21ab6/deployment/docker-compose)
