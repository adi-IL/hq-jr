# Deploy files and update modes

The released container ships the deploy files inside the image at `/app/deploy`:

| File in the image | Purpose |
| :--- | :--- |
| `/app/deploy/compose.yaml` | Container definition: image, env file, data volume, ADC mount, port, healthcheck, log rotation. |
| `/app/deploy/update.sh` | Pulls the image, compares image IDs, recreates only on change, health-checks, and rolls back if the new image fails. |
| `/app/deploy/refresh-deploy-files.sh` | Copies the deploy files from a released image into `/opt/hq-jr/deploy`. It keeps the host `compose.yaml`. |
| `/app/deploy/hq-jr-update.service` | Oneshot systemd unit that runs `update.sh`. |
| `/app/deploy/hq-jr-update.timer` | Runs the update unit every 15 minutes. |

Two update modes put those files on the host. Pick one.

Run the host commands below on the deploy host as the deploy account. That is the account that runs Docker (a member of the `docker` group) and that the update unit runs as. `sudo` is used only for the steps that need root.

## Host layout

| Path | Owner | Holds |
| :--- | :--- | :--- |
| `/opt/hq-jr` | deploy account | `.env` (mode `600`) |
| `/opt/hq-jr/deploy` | deploy account | The deploy files and `update.sh` state such as `.last-failed-image`. |
| `/opt/hq-jr/data` | uid `1001` | The SQLite database. |
| `/opt/hq-jr/gcloud` | uid `1001`, mode `700` | Only `application_default_credentials.json`. |

```bash
sudo install -d -o "$(id -un)" -g "$(id -gn)" /opt/hq-jr /opt/hq-jr/deploy
sudo install -d -o 1001 -g 1001 /opt/hq-jr/data
sudo install -d -m 700 -o 1001 -g 1001 /opt/hq-jr/gcloud
```

## Mode 1: image-baked (recommended)

The host keeps no git checkout. The deploy directory is materialized from the released image, so the updater that runs on the host is the updater that shipped with the release.

```bash
# 1. Materialize the deploy files from the released image.
docker pull ghcr.io/adi-il/hq-jr:latest
docker create --name hqjr-deploy-extract ghcr.io/adi-il/hq-jr:latest
docker cp hqjr-deploy-extract:/app/deploy/. /opt/hq-jr/deploy/
docker rm hqjr-deploy-extract
```

Then follow [Credentials, start, and the update timer](#credentials-start-and-the-update-timer).

When a new release ships, refresh the deploy files from it:

```bash
/opt/hq-jr/deploy/refresh-deploy-files.sh
```

Without an argument the script pulls the image that `compose.yaml` runs, so a pinned version stays pinned. Pass an image reference such as `ghcr.io/adi-il/hq-jr:0.1.9` to take the files from a specific release. The host `compose.yaml` is never overwritten. The copy from the image is written next to it as `compose.yaml.release` so you can compare the two.

To make that refresh automatic, uncomment the `ExecStartPre` line in `/etc/systemd/system/hq-jr-update.service` and run `sudo systemctl daemon-reload`. The refresh is non-fatal: when it fails, the unit still runs the updater already on disk.

## Mode 2: host-copy

The deploy files are copied to the host by hand from a local clone. The host still runs the container from the GHCR image, so the copy is only a copy.

```bash
# 1. From a clone of this repository on your machine, copy the deploy files to the host.
scp deploy/compose.yaml deploy/update.sh deploy/hq-jr-update.service deploy/hq-jr-update.timer \
  <deploy-user>@<host>:/opt/hq-jr/deploy/
```

Then follow [Credentials, start, and the update timer](#credentials-start-and-the-update-timer).

Every release that changes a deploy file has to be copied over by hand in this mode. That is the reason mode 1 is recommended.

## Credentials, start, and the update timer

```bash
# 1. Create /opt/hq-jr/.env (see docs/05 for the values) and the ADC file.
touch /opt/hq-jr/.env
chmod 600 /opt/hq-jr/.env
sudo install -m 400 -o 1001 -g 1001 \
  ~/.config/gcloud/application_default_credentials.json /opt/hq-jr/gcloud/

# 2. Start the stack.
cd /opt/hq-jr/deploy
docker compose up -d
docker compose ps

# 3. Install the update timer. Set User and Group in the unit to this account before enabling it.
sudo cp /opt/hq-jr/deploy/hq-jr-update.service /opt/hq-jr/deploy/hq-jr-update.timer /etc/systemd/system/
sudo sed -i "s/^User=.*/User=$(id -un)/; s/^Group=.*/Group=$(id -gn)/" /etc/systemd/system/hq-jr-update.service
sudo systemctl daemon-reload
sudo systemctl enable --now hq-jr-update.timer
sudo systemctl status hq-jr-update.timer
```

## The systemd unit needs no git checkout

`hq-jr-update.service` runs `/opt/hq-jr/deploy/update.sh`, plus `refresh-deploy-files.sh` first when its `ExecStartPre` line is enabled. It does not require `/opt/hq-jr` to be a clone, it does not run git, and it does not pull from GitHub. The deploy directory on the host is whatever mode 1 or mode 2 put there.

The unit runs as the account in its `User` and `Group` lines. That account has to own `/opt/hq-jr/deploy` and be a member of the `docker` group.

The timer runs `update.sh` every 15 minutes. `update.sh` reads the image reference from `compose.yaml`, pulls it, recreates the container only when the image changed, and polls `/livez` until the 60-second deadline. A failed health check restores the previous image and exits non-zero.

```bash
sudo journalctl -u hq-jr-update.service -n 50 --no-pager
```

## Credentials on the host

- `/opt/hq-jr/.env` holds the App ID, private key, and webhook secret. Keep it at mode `600`, owned by the deploy account.
- `/opt/hq-jr/gcloud/` holds the Application Default Credentials file. The directory must contain only `application_default_credentials.json`, is owned by uid `1001`, and is mounted read-only at `/gcloud`.
- A `gcloud/` directory in a checkout of this repository is gitignored and excluded from the Docker build context. Never commit an ADC file.
