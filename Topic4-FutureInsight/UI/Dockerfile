# The UI is a static, no-build-step app (plain HTML/CSS/ES modules) — it just
# needs to be served over http:// (not file://) so fetch() and ES module
# imports work, and so browser CORS treats it as a real origin when calling
# the backend services. nginx serves it as-is; there's nothing to compile.
FROM nginx:alpine
COPY . /usr/share/nginx/html
# Without any caching headers, browsers heuristically reuse their cached
# copies of the ES modules for a while, so after a rebuild a reload can keep
# running the old JS. The files have no content hashes in their names (no
# build step), so every response gets `no-cache`: the browser still caches,
# but revalidates first (a cheap 304 via ETag when nothing changed).
RUN sed -i 's|^\(\s*\)location / {|\1add_header Cache-Control "no-cache" always;\n\1location / {|' /etc/nginx/conf.d/default.conf \
 && grep -q 'Cache-Control "no-cache"' /etc/nginx/conf.d/default.conf
EXPOSE 80
