# Deploying behind TLS / Cloudflare

The default `docker compose up` publishes one port per service and the browser
calls each directly. That is fine locally and breaks behind TLS. Two reasons,
and the second is the hard one:

1. Every published port would need its own valid certificate, and a plain-http
   call from an https page is blocked by the browser as mixed content.
2. **Cloudflare's proxy only forwards a fixed set of ports.** For HTTPS that is
   443, 2053, 2083, 2087, 2096 and 8443 — nothing else. Ports 8001–8014 and
   8020 never reach the origin at all, whatever the origin listens on.

So a proxied deployment has to serve everything from one origin, routed by
path prefix. The UI supports this natively: see the header of
[`UI/js/sandboxApi.js`](../UI/js/sandboxApi.js).

## The path contract

These prefixes are repeated in several places. Change one, change them all.

| Path prefix         | Service             | Port (direct mode) |
| ------------------- | ------------------- | ------------------ |
| `/api/records`      | records-wrapper     | 8001               |
| `/api/cookbook`     | cookbook-registry   | 8002               |
| `/api/orchestrator` | cook-orchestrator   | 8003               |
| `/api/hub`          | hub-datasets        | 8014               |
| `/api/tools/add`    | tool-add            | 8010               |
| `/api/tools/multiply`   | tool-multiply   | 8011               |
| `/api/tools/multiply3`  | tool-multiply3  | 8012               |
| `/api/tools/geo-buffer` | tool-geo-buffer | 8013               |
| `/`                 | ui                  | 8000               |

Defined in `sandboxApi.js` (`API_ROUTES`, `TOOL_SERVICES`), in
`cookbook-registry`'s `PUBLIC_TOOL_BASE`, and in `gateway.conf`; repeated in
`docker-compose.gateway.yml` as each service's `--root-path` and in the
`/api/hub` entries of `LOCATION_REWRITES`.

## Recommended: the gateway overlay

Adds an nginx container that does the path routing on the compose network, so
the whole stack is reachable on **one** port and Cloudflare needs to know
about nothing else.

```sh
docker compose -f docker-compose.yml -f docker-compose.gateway.yml up -d --build
```

The overlay also rebinds the per-service ports to `127.0.0.1` (reachable for
debugging from a shell on the server, not from the internet) and stops
publishing the UI's own port.

Requires Docker Compose **v2.24+** for the `!override` tag used to replace
the per-service ports (`docker compose version` to check). On older versions,
list merging would leave both the old and new port bindings in place and the
stack would fail to start with a port conflict — in that case delete the
`ports:` overrides from the overlay and close the ports at the firewall
instead.

Then in `.env`:

```sh
COMPOSE_FILE=docker-compose.yml:docker-compose.gateway.yml
GATEWAY_PORT=80
PUBLIC_HOST=nldt-tb2.clearly.app
PUBLIC_TOOL_BASE=https://nldt-tb2.clearly.app/api/tools
#CKAN_SITE_URL_OVERRIDE=https://nldt-tb2.clearly.app/ckan   # only if you proxy CKAN
```

`PUBLIC_HOST` also drives the Cook Orchestrator's `LOCATION_REWRITES`. A
recipe's data input reaches the Cook as a CWL File whose `location` is the
URL the browser used — behind the gateway, `https://<PUBLIC_HOST>/api/hub/...`.
For this stack's own tools the Cook rewrites that prefix to
`http://hub-datasets:8000` before passing the URL on by reference (the
overlay sets the mapping); external processes get the public URL unchanged,
so the origin must also be reachable from the internet for them.

`GATEWAY_PORT` is the **host** side of the port mapping only. nginx inside
the container always listens on 80 — see `listen 80` in `gateway.conf` and
`"${GATEWAY_PORT:-8080}:80"` in the overlay. Point it at whatever port
Cloudflare actually dials on this machine; the next section covers that.

## Connecting Cloudflare

Note the distinction that governs everything here: Cloudflare's fixed port
list constrains what the **browser** may connect to. The port Cloudflare uses
to reach **your origin** is unconstrained. That is why the browser-facing side
must collapse onto one origin, while the origin-facing port is free.

### How the Geonovum testbed deployment is set up

A proxied ("orange cloud") **A record** to the origin IP, with SSL/TLS mode
**Flexible**. Cloudflare terminates TLS and connects inbound to the origin
over plain http on **port 80** — so that is where the gateway must listen:

```sh
GATEWAY_PORT=80
```

```sh
docker compose up -d      # recreates the gateway on the new host port
```

Then set SSL/TLS → Overview → **Flexible** in the dashboard.

Be aware of what Flexible means: the Cloudflare-to-origin hop crosses the
public internet unencrypted, and because port 80 is open to everyone, the
origin IP can be reached directly, bypassing Cloudflare entirely. Acceptable
for a public demo with no auth and no private data — which is this stack —
but not a posture to carry into anything real. See "Restricting the origin"
below.

### Alternatives

**Full (strict)** — the gateway terminates TLS itself with a Cloudflare
Origin Certificate (free, 15 years, generated in the dashboard). Encrypted
end to end. Mount the cert, add `listen 443 ssl` with `ssl_certificate` /
`ssl_certificate_key` to `gateway.conf`, and publish host port 443 to the
container's port 443 in the overlay. `GATEWAY_PORT=443` alone is not enough:
it only changes the host side of the mapping to nginx's plain-http port 80.

**Cloudflare Tunnel** — a `cloudflared` daemon dials out, so the origin needs
no open inbound ports at all and the direct-access problem disappears:

```yaml
# ~/.cloudflared/config.yml
ingress:
  - hostname: nldt-tb2.clearly.app
    service: http://localhost:8080   # GATEWAY_PORT
  - service: http_status:404
```

The gateway already routes by path, so the tunnel takes a single catch-all
rule. Resist splitting the `/api/*` prefixes across tunnel ingress rules too —
one place owning the routing is enough, and two places can disagree.

### Restricting the origin

**`ufw` does not work for this.** Docker inserts its own iptables rules ahead
of ufw's, so `ufw deny 80` has no effect on a Docker-published port — it looks
closed while remaining wide open. Use the `DOCKER-USER` chain:

```sh
sudo iptables -I DOCKER-USER -p tcp --dport 80 -j DROP
for ip in $(curl -s https://www.cloudflare.com/ips-v4); do
  sudo iptables -I DOCKER-USER -s "$ip" -p tcp --dport 80 -j ACCEPT
done
sudo apt install iptables-persistent    # survive reboot
```

`-I` inserts at the top, so running the DROP first and the ACCEPTs after
leaves the ACCEPTs above it. Only port 80 is affected — SSH is untouched.
Verify from off-network: `curl -sI http://<origin-ip>/` should hang or refuse
while the domain keeps working.

### Cloudflare settings worth checking

- **Timeout.** The UI runs recipes asynchronously (`Prefer: respond-async`)
  and polls the job, so no single request stays open long. A client that
  calls `/api/orchestrator/processes/cook/execution` synchronously, however,
  holds one request open for the whole run. Cloudflare's free plan cuts
  requests off at ~100s with a 524; the gateway's own 180s timeout cannot
  override that. Use async execution for anything but short recipes.
- **Caching.** Cloudflare may cache `/js/*.js` and serve a stale UI after a
  redeploy. If a change doesn't appear, purge the cache — or add a cache rule
  bypassing `/api/*` and the JS assets.
- **Rocket Loader / auto-minify**, if enabled, rewrite scripts and can break
  ES modules. The UI is plain ES modules with no build step, so leave these
  off for this hostname.

## CKAN's own UI

The app never calls CKAN from the browser — only `records-wrapper` talks to it,
over the compose network — so CKAN does **not** need to be proxied for the app
to work. Proxy it only if you want to browse the raw catalog. If you do, it
needs its own path prefix (a `location` block in `gateway.conf`, which has
none for CKAN) and `CKAN_SITE_URL_OVERRIDE` in `.env` set to match, or its
links and redirects will point at the unproxied address.

## Links behind a path prefix

The gateway strips each service's `/api/<service>` prefix and reaches the
service over plain http. So that the links a service writes into its answers
(`self`, `collection`, execute and monitor links, a job's `Location` header,
`service-desc` / `service-doc`) still carry the public prefix and `https`, the
overlay starts every Python service with `--root-path <its prefix>` and
`--forwarded-allow-ips *` (trusting the gateway's `X-Forwarded-Proto`). These
`command:` lines repeat each service's Dockerfile `CMD`; if a Dockerfile's
`CMD` changes, change the overlay too.
