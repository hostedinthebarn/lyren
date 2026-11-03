# Pull deploy

Every merge to `main` deploys to a server installed as in [docs/ubuntu-server.md](../../docs/ubuntu-server.md), with nothing able to reach into the server:

1. **CI** ([`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml)) typechecks, tests and builds; packages the Node.js archive; smoke-tests it with [`scripts/ci/smoke-node.sh`](../../scripts/ci/smoke-node.sh); and publishes it as the release `build-<run number>`.
2. **The server** runs [`lyren-pull-deploy.sh`](lyren-pull-deploy.sh) every 5 minutes (`lyren-pull-deploy.timer`). When the latest release is a new `build-<n>` published by `github-actions[bot]`, it checks the archive against its `.sha256` file and upgrades as §12 does by hand: back up with the running version, stop, switch `current`, start. If `/api/health` doesn't answer within 60 seconds, it switches back and remembers the build as failed.
3. **CI checks from outside** (when the repository variable `LIVE_URL` is set): it waits until the live site serves this build's web app, then checks that a made-up path and the server's own files aren't served.

The server needs outbound HTTPS to GitHub only. GitHub holds no key or address for it.

## Install on the server

```sh
sudo install -m 755 lyren-pull-deploy.sh /usr/local/sbin/lyren-pull-deploy
sudo install -m 644 lyren-pull-deploy.service lyren-pull-deploy.timer /etc/systemd/system/
echo 'REPO=<owner>/<repo>' | sudo tee /etc/lyren-deploy.env
sudo systemctl daemon-reload
sudo systemctl enable --now lyren-pull-deploy.timer
```

It needs `curl`, `jq` and `sha256sum`. Watch it with `journalctl -u lyren-pull-deploy -f`. The installed build and the previous one are in `/var/lib/lyren-pull-deploy/` (`deployed-tag`, `previous`, `failed-tag`).

## Roll back by hand

```sh
sudo systemctl stop lyren-plan
sudo ln -sfn "$(cat /var/lib/lyren-pull-deploy/previous)" /opt/lyren-plan/current
sudo systemctl start lyren-plan
```

A build whose migration the previous version can't open needs §12's restore steps as well. Stop the timer first (`sudo systemctl stop lyren-pull-deploy.timer`), or it reinstalls the latest build on its next run.

## Trust

The server installs whatever the deploy workflow publishes, so the guard is who can merge to `main` and who can change the workflow: protect `main` (pull requests and the CI check required). A release made by hand, or tagged anything other than `build-<n>`, is ignored.
