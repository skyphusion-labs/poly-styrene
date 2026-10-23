# The /lab sandbox image.
#
# Pinned by DIGEST, not by tag. A tag is mutable in a registry we do not
# control, so a tag pin means what executes in the sandbox can change with no
# commit here. That is the same defect as poly-styrene#4 on the Ollama image,
# and it is not worth filing against someone else and then repeating.
#
# alpine:3.21, resolved 2026-10-23 from registry-1.docker.io. This is the
# multi-platform index digest, so it holds for whatever architecture the
# container runs on.
FROM alpine@sha256:ee16d92f96db08d9d2d07da48555a27f3a69d8f0759021dbc601195ed0d2b5bd

# Everything the sandbox will ever have must be baked in HERE. The container
# runs with enableInternet false, so there is no network at runtime: no pip,
# no npm, no apk, no curl to anywhere. A missing tool is a rebuild, not a
# runtime fetch, and that is the point rather than an inconvenience.
RUN apk add --no-cache \
      python3 \
      nodejs \
      file \
      binutils \
      jq \
 && adduser -D -h /home/lab -s /bin/sh lab

# Hygiene, NOT a boundary. Cloudflare documents that file permissions do not
# restrict code inside a container and that a process can return to root, so
# the isolation here is the microVM and nothing in this file. Running as a
# normal user just keeps an accident from being messier than it needs to be.
USER lab
WORKDIR /home/lab

# PID 1 has to stay alive so the instance is there for exec() to attach to.
# busybox sleep does not take "infinity", so this is the portable form.
ENTRYPOINT ["tail", "-f", "/dev/null"]
