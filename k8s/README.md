# Kubernetes manifests

Deployment, Service, ConfigMap, a Secret template, and a
HorizontalPodAutoscaler for running jiffy-messaging in a cluster.

No health or readiness probes yet - those come with the endpoints they
check against, added in a later phase alongside these manifests.

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
