# Deploying to the VPS

Pushing to `main` deploys. [.github/workflows/deploy.yml](../.github/workflows/deploy.yml)
opens an SSH session to the Windows host, hands the checkout there to
[scripts/deploy.ps1](../scripts/deploy.ps1), and that script installs,
applies the schema, builds, restarts the service, and refuses to call the
deploy successful until `/ready` answers 200.

This is the same shape the platform API already uses to reach the same
host, deliberately: one SSH action, one PowerShell script in the repo, one
Windows service per app.

The links below to `deployment.md` and `preflight-checklist.md` resolve
once #1 is merged. This page assumes those two exist and does not repeat
what is in them.

## Contents

- [Why a Windows service and not a container](#why-a-windows-service-and-not-a-container)
- [What a deploy does](#what-a-deploy-does)
- [When a deploy fails](#when-a-deploy-fails)
- [Repository secrets](#repository-secrets)
- [Repository variables](#repository-variables)
- [First run on the host](#first-run-on-the-host)
- [Redeploying and rolling back](#redeploying-and-rolling-back)
- [What this replaces](#what-this-replaces)

## Why a Windows service and not a container

The service runs as a plain node process, supervised by nssm, started from
`dist/main.js` built on the host. There is no Docker in this path and
`docker-compose.prod.yml` is not used here.

The reason is that the platform API on this host already runs exactly that
way, and it is known to work there. Docker on that box is not something
this repo can verify from outside it, and a deploy that assumes it either
works or leaves a failed pull and a stopped service behind. More to the
point, running one app in a container and another as a service on the same
machine means two ways to start something, two places to look when it is
down, and two restart policies to keep straight. There is no benefit here
that pays for that.

`docker-compose.prod.yml`, the image, and [k8s/](../k8s/README.md) are all
still the right answer somewhere else. They are for hosts that run
containers. This host does not.

Practical consequences of the choice, all handled by the script:

- **The host builds from source.** `pnpm install --frozen-lockfile` there
  is the full dependency set, not a production only install, because tsup
  and typescript are devDependencies and the build happens on the host.
  Nothing extra is loaded at runtime: the service runs `dist/main.js`.
- **The service reads `.env` through node, not through the image.**
  `src/main.ts` reads `process.env` and loads no dotenv file of its own, so
  the service is registered with `node --env-file=...`, which needs node
  20.6 or later.
- **Ports.** This service listens on 8080. The platform API on the same
  host is on 4000. Neither is published directly; the reverse proxy in
  front is still set up by hand, and
  [deployment.md](./deployment.md#reverse-proxy-and-tls) is the reference
  for it. Read that section before writing one, because a proxy that does
  not forward the WebSocket upgrade breaks live delivery while leaving
  every other check green.

## What a deploy does

The workflow, on GitHub's runner:

1. Assembles the environment file from the repository secrets and
   variables below, and fails the run before touching the host if a
   required one is missing or holds a value the file format cannot carry.
2. Opens the SSH session, writes that file to `.env.incoming` on the host,
   records the commit the host is currently serving, fast forwards the
   checkout to `origin/main`, and runs `scripts/deploy.ps1`.

The script, on the host, in `C:\app\jiffy-messaging`:

1. Checks that git, node, pnpm and nssm are on PATH and that the
   `jiffy-messaging` service is registered, and stops if any of that is
   missing rather than discovering it halfway.
2. Keeps the current `.env` as `.env.previous` and promotes
   `.env.incoming` to `.env`.
3. `pnpm install --frozen-lockfile`.
4. Applies [src/adapters/postgres/schema.sql](../src/adapters/postgres/schema.sql)
   through [scripts/apply-schema.mjs](../scripts/apply-schema.mjs). Every
   statement in it is `CREATE ... IF NOT EXISTS`, so this creates the three
   tables on the first deploy and does nothing on every one after. It runs
   before the build so an unreachable database fails the deploy without the
   running service having been touched.
5. `pnpm build`, then confirms `dist/main.js` exists.
6. Stops the service, waits for the port to go quiet, and starts it. The
   wait matters: without it a readiness probe can pass against the old
   process and report a deploy that never happened.
7. Probes `http://127.0.0.1:8080/ready` for up to 36 seconds. 200 means the
   process is up and its database connection works, which is the whole
   definition of a successful deploy here. `DEPLOY_OK` in the log means
   that probe passed.

## When a deploy fails

Any failure, including the probe never passing, rolls the host back inside
the same run:

- `.env.previous` goes back to `.env`, if the configuration had already
  been replaced.
- The checkout is reset to the commit recorded before the deploy started,
  reinstalled and rebuilt.
- The service is restarted and probed again.

`ROLLBACK_OK` means the previous version is serving. `ROLLBACK_FAILED`
means nothing is answering `/ready` and the host needs a look; the last 30
lines of `logs\stderr.log` are printed above it. Either way the workflow
run is red.

The schema is not rolled back. It is additive and every statement is
conditional, so an older build runs against it unchanged.

## Repository secrets

Settings, Secrets and variables, Actions, Secrets tab. All of these are on
this repository, not the platform API's.

| Secret         | Required | Where it comes from                                                                                                                                                                                                       |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SSH_HOST`     | yes      | The VPS address. The same value as the secret of that name on the platform API repository, which already deploys to this host                                                                                             |
| `SSH_USER`     | yes      | The Windows account the deploy runs as. Same value as the platform API repository's                                                                                                                                       |
| `SSH_PASSWORD` | yes      | That account's password. Same value as the platform API repository's                                                                                                                                                      |
| `DATABASE_URL` | yes      | The connection string for this service's own database, created in step 1 of [preflight-checklist.md](./preflight-checklist.md). Ends in `?sslmode=verify-full` for a managed provider                                     |
| `JWT_SECRET`   | yes      | The shared HMAC secret from step 2 of [preflight-checklist.md](./preflight-checklist.md). Byte identical to the value the platform API holds, where it is read as `JIFFY_MESSAGING_JWT_SECRET`. Copy it, do not retype it |
| `REDIS_URL`    | no       | Only once there is a second instance. A single instance does not need it and does not benefit from it. See [deployment.md](./deployment.md#more-than-one-instance)                                                        |
| `CONVERSATION_GATE_URL` | no | The platform API's internal authorization callback (e.g. `https://api.goalslot.io/internal/messaging/can-create-conversation`). Unset means every authenticated user may open a conversation with anyone, which is the correct default for an integrator with no relationship model of its own, but not for the platform API |
| `CONVERSATION_GATE_SECRET` | no, but required alongside `CONVERSATION_GATE_URL` | A separate shared secret from `JWT_SECRET`, used only to authenticate this service's server-to-server callback to the gate URL. Never issued to end users |
| `MESSAGE_NOTIFY_URL` | no | The platform API's internal notification callback (e.g. `https://api.goalslot.io/internal/messaging/on-message-sent`), called after every message send so the platform can push its own notification to the recipients. Unset means no notification fires - the message still sends, delivery is just silent beyond the WebSocket |
| `MESSAGE_NOTIFY_SECRET` | no, but required alongside `MESSAGE_NOTIFY_URL` | A separate shared secret from both `JWT_SECRET` and `CONVERSATION_GATE_SECRET` - this callback and the conversation gate are different capabilities, and a caller with one should not automatically have the other |

`JWT_SECRET` is the one worth being careful with. A trailing newline or
space picked up while pasting is enough to make every authenticated
request 401 with nothing in the log beyond a signature failure, and the
workflow rejects a value containing a newline for exactly that reason. To
confirm the two sides match without moving the secret around, compare a
hash of each:

```
printf %s "$JWT_SECRET" | sha256sum
```

## Repository variables

Same settings page, Variables tab. These are not secrets and reading them
in a log tells nobody anything. An unset variable is left out of the
environment file entirely, which is what makes the service fall back to
its documented default.

| Variable            | Default when unset             | Purpose                                                                             |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `CORS_ORIGIN`       | required, service refuses to start | Comma-separated list of browser origins allowed to call the REST API (e.g. `https://www.goalslot.io`). Not a secret - the value is just as visible in any browser's network tab. Every real caller of `/conversations` and friends is a browser making a cross-origin request, and a preflight request carries no bearer token, so with this unset the auth middleware 401s every preflight and the browser blocks the real request before it is ever sent - the REST API is then unreachable from any browser, and it looks like a dead connection, not a 401 |
| `JWT_ISSUER`        | not checked        | The `iss` claim the platform API signs. Set it, and set it to exactly what it signs |
| `JWT_AUDIENCE`      | not checked        | The `aud` claim the platform API signs. Same                                        |
| `JWT_USER_ID_CLAIM` | `sub`              | Only if the platform API puts its user id somewhere other than `sub`                |
| `LOG_LEVEL`         | `info`             | A pino level                                                                        |

`PORT` is not configurable through the workflow. It is written as 8080,
which is what the deploy script probes and what everything else in this
repo assumes.

[deployment.md](./deployment.md#configuration) explains what each of these
does and how strictly it is checked. Anything not in either table above is
ignored by the process.

**GitHub is the source of truth for configuration.** The workflow rewrites
`.env` on the host on every deploy, so editing that file over RDP works
until the next push and then silently goes away. Change the secret or the
variable and redeploy instead.

## First run on the host

None of this is done by the workflow, and the first deploy fails with a
named error if any of it is missing.

**1. Tooling.** git, node 20.6 or later (22 is what CI builds against),
pnpm 10.24.0, and nssm, all on the machine PATH rather than a single
user's:

```
npm install -g pnpm@10.24.0
```

**2. The checkout.** The path is not configurable; the workflow and the
script both hardcode it:

```
git clone https://github.com/ZeeshanAdilButt/jiffy-messaging.git C:\app\jiffy-messaging
mkdir C:\app\jiffy-messaging\logs
```

**3. The database.** Steps 1 and 2 of
[preflight-checklist.md](./preflight-checklist.md): a database this service
owns, and the shared secret. Do not point it at the platform's own
database. The tables themselves are created by the first deploy, so step 3
of that checklist is already done for you.

**4. The service.** Registered once, pointing at the built entry point and
the environment file the deploy maintains:

```
nssm install jiffy-messaging "C:\Program Files\nodejs\node.exe"
nssm set jiffy-messaging AppParameters "--env-file=C:\app\jiffy-messaging\.env C:\app\jiffy-messaging\dist\main.js"
nssm set jiffy-messaging AppDirectory C:\app\jiffy-messaging
nssm set jiffy-messaging AppEnvironmentExtra NODE_ENV=production
nssm set jiffy-messaging AppStdout C:\app\jiffy-messaging\logs\stdout.log
nssm set jiffy-messaging AppStderr C:\app\jiffy-messaging\logs\stderr.log
nssm set jiffy-messaging AppRotateFiles 1
nssm set jiffy-messaging Start SERVICE_AUTO_START
```

`NODE_ENV` is set on the service rather than in `.env` on purpose. The
deploy script loads `.env` into its own process to reach the database, and
a `NODE_ENV=production` in there would make `pnpm install` skip the
devDependencies the build needs.

The service will not start yet, because `dist` does not exist until the
first deploy builds it. That is expected. Leave it stopped.

**5. The secrets and variables** from the two tables above.

**6. Push to `main`**, or run the workflow by hand from the Actions tab.

After it goes green, the rest of
[preflight-checklist.md](./preflight-checklist.md) still applies: step 7
proves a real token verifies end to end, step 8 puts the proxy in front,
and step 9 points the platform API at this service.

## Redeploying and rolling back

Actions, Deploy to VPS, Run workflow. It always deploys `origin/main`,
whatever branch the run is started from, because that is what the host is
reset to.

To roll a release back after it has been deployed and passed its probe,
revert the commit on `main` and push. The automatic rollback only covers a
deploy that failed during the run.

## What this replaces

[deployment.md](./deployment.md) and
[preflight-checklist.md](./preflight-checklist.md) describe running the
published image on a host with Docker, which is still the general answer
and still the one to follow for any other host. On this VPS specifically,
the workflow takes over four of the checklist's steps:

| Checklist step       | Now                                                 |
| -------------------- | --------------------------------------------------- |
| 3, apply the schema  | Applied on every deploy, before the build           |
| 4, write the `.env`  | Written on every deploy from the repository secrets |
| 5, pull the image    | Not used. The host builds from the checkout         |
| 6, start the service | nssm, restarted and probed on every deploy          |

Steps 1, 2, 7, 8 and 9 are unchanged and still done by hand.
