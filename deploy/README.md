# Deploy files and update modes

The released container ships the deploy files inside the image at `/app/deploy`:

| File in the image | Purpose |
| :--- | :--- |
| `/app/deploy/compose.yaml` | Container definition: image, env file, data volume, ADC mount, port, healthcheck, log rotation. |
| `/app/deploy/update.sh` | Pulls the image, compares image IDs, recreates only on change, health-checks, and rolls back if the new image fails. |
| `/app/deploy/hq-jr-update.service` | Oneshot systemd unit that runs `update.sh`. |
| `/app/deploy/hq-jr-update.timer` | Runs the update unit every 15 minutes. |

Two update modes put those files on the host. Pick one.

## Mode 1: image-baked (recommended)

The host keeps no git checkout. The deploy directory is materialized from the released image, so the updater that runs on the host is the updater that shipped with the release.

```bash
# 1. Prepare the host directories.
sudo mkdir -p /opt/hq-jr/deploy /opt/hq-jr/data /opt/hq-jr/gcloud
sudo chown -R 1001:1001 /opt/hq-jr/data

# 2. Materialize the deploy files from the released image.
docker pull ghcr.io/adi-il/hq-jr:latest
docker create --name hqjr-deploy-extract ghcr.io/adi-il/hq-jr:latest
docker cp hqjr-deploy-extract:/app/deploy/. /opt/hq-jr/deploy/
docker rm hqjr-deploy-extract

# 3. Create /opt/hq-jr/.env and the ADC file (see docs/05 for the values).
chmod 600 /opt/hq-jr/.env
sudo install -m 400 -o 1001 -g 1001 \
  ~/.config/gcloud/application_default_credentials.json /opt/hq-jr/gcloud/

# 4. Start the stack.
cd /opt/hq-jr/deploy
docker compose up -d
docker compose ps

# 5. Install the update timer.
sudo cp /opt/hq-jr/deploy/hq-jr-update.service /opt/hq-jr/deploy/hq-jr-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hq-jr-update.timer
```

When a new release ships, refresh the deploy files from it:

```bash
VERSION=0.1.9
docker pull ghcr.io/adi-il/hq-jr:$VERSION
docker create --name hqjr-deploy-extract ghcr.io/adi-il/hq-jr:$VERSION
docker cp hqjr-deploy-extract:/app/deploy/. /opt/hq-jr/deploy/
docker rm hqjr-deploy-extract
sudo systemctl restart hq-jr-update.timer
```

To make that refresh automatic, uncomment the `ExecStartPre` line in `/etc/systemd/system/hq-jr-update.service` and reload systemd. The refresh is non-fatal: when the image is not available, the unit still runs the updater already on disk.

## Mode 2: host-copy

The deploy files are copied to the host by hand, or taken from a local clone. The host still runs the container from the GHCR image, so the copy is only a copy.

```bash
# 1. Copy the deploy files to the host.
sudo mkdir -p /opt/hq-jr/deploy /opt/hq-jr/data /opt/hq-jr/gcloud
sudo chown -R 1001:1001 /opt/hq-jr/data
scp deploy/compose.yaml deploy/update.sh deploy/hq-jr-update.service deploy/hq-jr-update.timer \
  <deploy-user>@<host>:/opt/hq-jr/deploy/

# 2. Create /opt/hq-jr/.env and the ADC file (see docs/05 for the values).
chmod 600 /opt/hq-jr/.env
sudo install -m 400 -o 1001 -g 1001 \
  ~/.config/gcloud/application_default_credentials.json /opt/hq-jr/gcloud/

# 3. Start the stack.
cd /opt/hq-jr/deploy
docker compose up -d
docker compose ps

# 4. Install the update timer.
sudo cp /opt/hq-jr/deploy/hq-jr-update.service /opt/hq-jr/deploy/hq-jr-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hq-jr-update.timer
```

Every release that changes a deploy file has to be copied over by hand in this mode. That is the reason mode 1 is recommended.

## The systemd unit needs no git checkout

`hq-jr-update.service` runs `/opt/hq-jr/deploy/update.sh` and nothing else. It does not require `/opt/hq-jr` to be a clone, it does not run git, and it does not pull from GitHub. The deploy directory on the host is whatever mode 1 or mode 2 put there.

Install it by copying it into `/etc/systemd/system`:

```bash
sudo cp /opt/hq-jr/deploy/hq-jr-update.service /opt/hq-jr/deploy/hq-jr-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hq-jr-update.timer
sudo systemctl status hq-jr-update.timer
```

Change `User` and `Group` in the unit to the deploy account on your host. It has to be a member of the `docker` group.

The timer runs `update.sh` every 15 minutes. `update.sh` reads the image reference from `compose.yaml`, pulls it, recreates the container only when the image changed, and polls `/livez` until the 60-second deadline. A failed health check restores the previous image and exits non-zero.

```bash
sudo journalctl -u hq-jr-update.service -n 50 --no-pager
```

## Credentials on the host

- `/opt/hq-jr/.env` holds the App ID, private key, and webhook secret. Keep it at mode `600`.
- `/opt/hq-jr/gcloud/` holds the Application Default Credentials file. The directory must contain only `application_default_credentials.json`, must be owned by uid `1001`, and is mounted read-only at `/gcloud`.
- A local `gcloud/` directory is gitignored in this repository and excluded from the Docker build context. Never commit an ADC file.
