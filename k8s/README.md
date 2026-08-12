# Kubernetes manifests

Deployment, Service, ConfigMap, Secret template, and a
HorizontalPodAutoscaler.

## Usage

```
cp k8s/secret.yaml.example k8s/secret.yaml
# fill in real values
kubectl apply -f k8s/secret.yaml
kubectl apply -k k8s/
```

Or from the repo root: `make k8s-deploy`. Validate without a cluster with
`make k8s-validate`.

`deployment.yaml` points at `jiffy-messaging:latest` — change it to your
registry path, or to the published image at
`ghcr.io/zeeshanadilbutt/jiffy-messaging:<version>`.

## Notes

**Probes.** Liveness hits `/health`, which checks nothing but the process
itself, so a slow database does not trigger restarts. Readiness hits
`/ready`, which does check the database, so a pod that cannot serve stops
receiving traffic without being restarted.

**Scaling.** The HPA scales on CPU between 2 and 10 replicas. Set
`REDIS_URL` in the Secret before running more than one replica — without
it, a message sent through one pod never reaches a WebSocket client
connected to another.

**Service.** A plain ClusterIP is enough. A WebSocket connection stays on
whichever pod it lands on for its lifetime, and nothing here needs session
affinity to make cross-pod delivery work — Redis handles that.
