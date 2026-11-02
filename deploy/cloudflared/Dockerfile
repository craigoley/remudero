# The console tunnel's pinned cloudflared image (W1-T10844). NEVER BUILT: deploy/edge-heal.sh reads
# the one FROM line below as its TUNNEL_IMAGE, and the Dockerfile shape exists only so Dependabot's
# docker ecosystem can bump it (W1-T10845). acr-build.yml watches deploy/Dockerfile exactly, so this
# file triggers no image build.
#
# Floor: 2026.10.2 or later (Cloudflare's eMudhra notice, 2026-10-26). edge-heal refuses a missing,
# malformed or below-floor pin and creates or replaces nothing. Keep exactly one FROM line, shaped
# `FROM cloudflare/cloudflared:<YYYY.M.P>@sha256:<64 hex>`.
FROM cloudflare/cloudflared:2026.10.4@sha256:c6c7ae1d5dfdcb094ad344ed68ccffc26635c9c6be80965664c33baf064b0515
