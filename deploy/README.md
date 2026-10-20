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
# docker create picks the container name, so a retry cannot collide with a leftover container.
bash <<'EOF'
set -euo pipefail
image=ghcr.io/adi-il/hq-jr:latest
dest=/opt/hq-jr/deploy
docker pull "$image"
container=""
staging=""
cleanup() {
  if [ -n "$container" ]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  if [ -n "$staging" ]; then
    rm -rf "$staging"
  fi
}
trap cleanup EXIT
container="$(docker create "$image")"
staging="$(mktemp -d)"
mkdir -p "$dest"
docker cp "$container:/app/deploy/." "$staging/"
shopt -s dotglob nullglob
for file in "$staging"/*; do
  [ -f "$file" ] || continue
  name="$(basename "$file")"
  if [ "$name" = compose.yaml ]; then
    cp -f "$file" "$dest/compose.yaml.release"
  else
    cp -f "$file" "$dest/$name"
  fi
done
if [ ! -f "$dest/compose.yaml.release" ]; then
  echo "the image has no /app/deploy/compose.yaml" >&2
  exit 1
fi
if [ ! -f "$dest/compose.yaml" ]; then
  cp "$dest/compose.yaml.release" "$dest/compose.yaml"
  echo "host had no compose.yaml; copied compose.yaml.release to compose.yaml"
elif ! cmp -s "$dest/compose.yaml" "$dest/compose.yaml.release"; then
  echo "left host compose.yaml in place; it differs from compose.yaml.release"
else
  echo "host compose.yaml matches compose.yaml.release"
fi
EOF
```

`docker create` assigns the container id. The block removes that container when it finishes or stops on an error. Run the block again after an interruption. It does not use a fixed name.

The image `compose.yaml` is written as `compose.yaml.release`. An existing host `compose.yaml` is left in place. Compose reads `compose.yaml`, so when that file is absent the block copies `compose.yaml.release` to `compose.yaml`. Edit `compose.yaml` before the first start if you need to pin an image digest. A later run of this block, and `refresh-deploy-files.sh`, does not replace it.

Then follow [Credentials, start, and the update timer](#credentials-start-and-the-update-timer).

When a new release ships, refresh the deploy files from it:

```bash
/opt/hq-jr/deploy/refresh-deploy-files.sh
```

Without an argument the script pulls the image that `compose.yaml` runs, so a pinned version stays pinned. Pass an image reference such as `ghcr.io/adi-il/hq-jr:0.1.9` to take the files from a specific release. The host `compose.yaml` is never overwritten. The copy from the image is written next to it as `compose.yaml.release` so you can compare the two.

The refresh does not touch `/etc/systemd/system`. When a release changes `hq-jr-update.service` or `hq-jr-update.timer`, repeat step 3 of [Credentials, start, and the update timer](#credentials-start-and-the-update-timer) to install the new units.

To make that refresh automatic, uncomment the `ExecStartPre` line in `/etc/systemd/system/hq-jr-update.service` and run `sudo systemctl daemon-reload`. The refresh is non-fatal: when it fails, the unit still runs the updater already on disk.

Automatic refresh runs scripts from the pulled image on the host as the deploy account, which has Docker access. That makes the image registry part of the host trust boundary. Enable it only if you trust the registry as much as the host, and pin `compose.yaml` to an image digest if you want to approve each change. Leave it off, or use mode 2, to keep the host updater independent of the image.

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

The container does not start until `/opt/hq-jr/.env` holds the GitHub App values and the Vertex AI project. The image does not include a `docs/` directory. Set the values in this section.

`APP_ID`, `PRIVATE_KEY`, and `WEBHOOK_SECRET` come from the GitHub App. Keep `PRIVATE_KEY` on one line and write its newlines as `\n`. Do not put spaces around `=`. `GOOGLE_CLOUD_PROJECT` is the Vertex AI project. `GOOGLE_CLOUD_LOCATION` is `global` unless the project uses another region. `HQ_JR_DB_PATH` must be `/app/data/hq-jr.db` so the database stays on the data volume. The image sets that path. This line keeps a copied example from pointing the database somewhere else. Set `WEBHOOK_PROXY_URL` only when GitHub delivers webhooks through a Smee channel.

```bash
# 1. Create /opt/hq-jr/.env when it is missing or empty, then install the ADC file.
# Fill the empty values before starting Compose. A second run leaves a filled file alone.
if [ ! -s /opt/hq-jr/.env ]; then
  cat > /opt/hq-jr/.env <<'ENV'
APP_ID=
PRIVATE_KEY=
WEBHOOK_SECRET=
GOOGLE_CLOUD_PROJECT=
GOOGLE_CLOUD_LOCATION=global
HQ_JR_DB_PATH=/app/data/hq-jr.db
ENV
fi
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
