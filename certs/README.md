# Your own certificates (optional)

Autoheal needs none of this. The control plane makes its own certificate on its first start, and each runner trusts it by the public key in its join code. Make your own CA only if you want:

- the dashboard without a browser warning, on devices that trust your CA;
- Ollama and Home Assistant behind TLS, so the logs Autoheal sends Ollama and its Home Assistant token never cross the network in the clear.

Run these on your own machine, not on a server, and keep `homelab-ca-key.pem` offline (in your password manager). Anyone holding it can mint certificates every device that trusts the CA will accept.

```bash
mkdir -p ~/autoheal-ca && cd ~/autoheal-ca

# 1. The CA (10 years).
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
  -subj "/CN=Homelab CA" -keyout homelab-ca-key.pem -out homelab-ca.pem \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"

# 2. A server certificate. List every address clients use: LAN IP and/or name.
issue() { # issue <name> <subjectAltName>
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$1" \
    -keyout "$1-key.pem" -out "$1.csr"
  openssl x509 -req -in "$1.csr" -CA homelab-ca.pem -CAkey homelab-ca-key.pem -CAcreateserial \
    -days 825 -out "$1.pem" -extfile <(printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$2")
  rm "$1.csr"
}

# The control plane (example: the main host at 192.168.10.10, also called autoheal.lan).
issue control-plane "IP:192.168.10.10,DNS:autoheal.lan"
```

For an IPv6 server, use an unbracketed IP in the SAN list, for example `issue control-plane "IP:fd00::5,DNS:autoheal.lan"`. The dashboard URL uses brackets instead: `PUBLIC_BASE_URL=https://[fd00::5]:8443`. Choose the SAN list for the addresses your clients use.

Import `homelab-ca.pem` into your devices' trust stores, and the dashboard stops warning.

## The control plane

Put `control-plane.pem` and `control-plane-key.pem` in a `certs` folder next to `docker-compose.yml`, the key readable by the container's user, mount it, and name the files in `.env`:

```bash
sudo chown 65532:65532 certs/control-plane-key.pem && sudo chmod 600 certs/control-plane-key.pem
```

```yaml
# docker-compose.yml, under control-plane:
volumes:
  - data:/data
  - join:/join
  - ./certs:/certs:ro
```

```bash
# .env
TLS_CERTIFICATE_FILE=/certs/control-plane.pem
TLS_KEY_FILE=/certs/control-plane-key.pem
```

Runners need nothing new. A runner trusts the control plane when the key matches its join code, or when its host already trusts the certificate: give a runner `homelab-ca.pem` (mounted, with `NODE_EXTRA_CA_CERTS` pointing at it) and it keeps trusting the control plane even after you issue a certificate with a new key.

## Ollama behind TLS

Ollama itself speaks plain http. Bind it to localhost (`OLLAMA_HOST=127.0.0.1:11434`) and put a small TLS proxy in front of it, for example Caddy:

```caddyfile
https://192.168.10.20:11443 {
	tls /certs/ollama.pem /certs/ollama-key.pem
	reverse_proxy 127.0.0.1:11434
}
```

with `issue ollama "IP:192.168.10.20"`. Then `OLLAMA_URL=https://192.168.10.20:11443`, and the control plane must trust the CA: mount `homelab-ca.pem` into it (with the certificates above) and add `NODE_EXTRA_CA_CERTS=/certs/homelab-ca.pem` to `.env`. A certificate from any other CA is then refused, so nobody on the network can stand in for the model.

## Home Assistant over HTTPS

Put the official **NGINX Home Assistant SSL proxy** app in front of Home Assistant, with a certificate from this CA:

```bash
issue homeassistant "IP:192.168.10.30,DNS:homeassistant.local"
```

1. Copy `homeassistant.pem` and `homeassistant-key.pem` to Home Assistant's `ssl` folder (the Samba share or the File editor app).
2. Install **NGINX Home Assistant SSL proxy** (Settings → Apps → App store). In its configuration set `domain: homeassistant.local`, `certfile: homeassistant.pem`, `keyfile: homeassistant-key.pem`, then start it.
3. The `http` integration is configured only in `configuration.yaml`. Keep a copy of the file, add the lines below, check the configuration (Tools → YAML → Check configuration; "Developer tools" before 2026.8) and restart:

   ```yaml
   http:
     use_x_forwarded_for: true
     trusted_proxies:
       - 172.30.33.0/24
   ```

Then use `https://192.168.10.30` as Home Assistant's address in Settings, with the control plane trusting the CA as for Ollama. Phones, voice satellites and everything else can keep using `http://…:8123`.

## Renewing

Server certificates last 825 days. Run `issue` again, copy the new files, and restart the container. Runners that trust the CA need nothing; others need a new join code once the key changes.
