# Kubernetes manifests

Deployment, Service, ConfigMap, a Secret template, and a
HorizontalPodAutoscaler for running jiffy-messaging in a cluster.

The Deployment's liveness and readiness probes hit /health and /ready.
/health never checks a dependency, so a slow database doesn't get a pod
killed and restarted for no reason; /ready does check the database, so a
pod in that state stops receiving traffic without being restarted.

## Usage

```
cp k8s/secret.yaml.example k8s/secret.yaml
# edit k8s/secret.yaml with real values
kubectl apply -f k8s/secret.yaml
kubectl apply -k k8s/
```

`image: jiffy-messaging:latest` in deployment.yaml assumes an image
already pushed somewhere the cluster can pull it - build and push it with
the Dockerfile at the repo root first, and update the image reference to
match.
