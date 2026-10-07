# Deploying to a private Ubuntu server

This guide puts the app on one Ubuntu server that you reach at your own HTTPS address. It runs
in paper mode: **LIVE trading stays off** (`GMGN_LIVE=0`, `GMGN_SOL_BROADCAST=0`).

How the pieces fit:

```
your browser ──HTTPS──▶ Caddy (ports 80/443) ──▶ app on 127.0.0.1:8787 ──▶ /var/lib/gmgn-trader (databases)
```

- **Caddy** gets the HTTPS certificate on its own and forwards visitors to the app.
- **The app** only listens inside the server. Its sign-in protects every page, and trading
  data also needs the app token.
- **systemd** (Ubuntu's service manager) keeps the app running and restarts it if it crashes.
- **A nightly backup** copies the databases to `/var/backups/gmgn-trader` and keeps 14 days.

Commands below are typed on the server, in its terminal, unless a step says "on your computer".
Lines starting with `#` are notes, not commands. Replace `trader.example.com` with your domain
and `you@example.com` with your email everywhere.

## 0. What you need

- A server running **Ubuntu 24.04** with at least 1 GB of memory, and a login you can SSH into
  that can use `sudo`.
- A **domain name** you control (for example `trader.example.com`).
- Never paste passwords, tokens or keys into chats, issues or this repository.

## 1. Point your domain at the server

In your domain provider's DNS settings, add an **A record**: name `trader` (or `@` for the bare
domain), value = your server's public IPv4 address. Check it from your computer:

```bash
# On your computer. It should print your server's IP address.
dig +short trader.example.com
```

DNS changes can take a while to show up. Caddy can only get a certificate once this works.

## 2. Update the server and turn on the firewall

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl ufw unattended-upgrades

# Allow only SSH, HTTP and HTTPS in. Allow SSH first so you don't lock yourself out.
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

`unattended-upgrades` installs Ubuntu security updates automatically.

## 3. Install Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh
sudo bash nodesource_setup.sh
sudo apt install -y nodejs
node -v        # must be v22.13.0 or newer
which node     # must print /usr/bin/node (the service files use this path)
```

## 4. Install Caddy

These are Caddy's official install commands for Ubuntu:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
caddy version
```

## 5. Create the app's own user

The app runs as a user called `gmgn` that cannot log in and owns nothing but its data folder.

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin gmgn
```

## 6. Download and build the app

The code lives in `/opt/gmgn-trader`, owned by **your** login, so the app itself can read it but
never change it.

```bash
sudo mkdir -p /opt/gmgn-trader
sudo chown "$USER": /opt/gmgn-trader
git clone https://github.com/xAc30x/GMGN-AI-Trading-Replica.git /opt/gmgn-trader
cd /opt/gmgn-trader
npm ci --ignore-scripts
npm run build
```

`npm run build` ends with a warning about a large file. That is expected.

## 7. Write the server settings file

Settings and secrets go in `/etc/gmgn-trader/gmgn.env`, outside the code folder. Only `root` can
change it and only the app can read it.

```bash
sudo mkdir -p /etc/gmgn-trader
sudo cp /opt/gmgn-trader/deploy/gmgn.env.example /etc/gmgn-trader/gmgn.env
sudo chown root:gmgn /etc/gmgn-trader/gmgn.env
sudo chmod 640 /etc/gmgn-trader/gmgn.env

# Make a new app token. Copy what it prints; you will paste it in the next command and in step 11.
openssl rand -base64 36

sudo nano /etc/gmgn-trader/gmgn.env
```

In the editor, fill in:

- `GMGN_LOCAL_TOKEN=` the token you just made (at least 32 characters; the app won't start without it)
- `GMGN_ALLOWED_EMAILS=you@example.com` (only these emails can sign up or sign in)
- `GMGN_PUBLIC_URL=https://trader.example.com`
- Leave `GMGN_LIVE=0` and `GMGN_SOL_BROADCAST=0` as they are.
- Optional: `SOLANA_RPC_URL=` your own Helius/QuickNode address. Its key stays on the server.

Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`.

Leave `GMGN_SIGNUP_OPEN=0` for now. While it is `0`, nobody can sign up with an email and
password, not even with an allowed email. You open it briefly in step 10 to create your account.

Optional Google sign-in: add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` the same way, and use
`https://trader.example.com/api/auth/google/callback` as the redirect address in Google's console.
Optional Apple sign-in: copy your `.p8` key to `/etc/gmgn-trader/AuthKey.p8`, then run
`sudo chown root:gmgn /etc/gmgn-trader/AuthKey.p8 && sudo chmod 640 /etc/gmgn-trader/AuthKey.p8`,
and fill in the four `APPLE_` lines. The app can't read anything in `/home`.

## 8. Start the app

```bash
sudo cp /opt/gmgn-trader/deploy/gmgn-trader.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gmgn-trader
sudo systemctl status gmgn-trader --no-pager     # look for "active (running)"

# The page should answer 200 inside the server:
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/
```

If it isn't running, read the last log lines: `sudo journalctl -u gmgn-trader -n 50 --no-pager`.

## 9. Turn on HTTPS with Caddy

```bash
sudo cp /opt/gmgn-trader/deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/trader.example.com/YOUR-DOMAIN-HERE/' /etc/caddy/Caddyfile
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
sudo caddy validate --config /etc/caddy/Caddyfile     # must end with "Valid configuration"
sudo systemctl reload caddy
```

(Type your real domain in place of `YOUR-DOMAIN-HERE`.) Now open `https://trader.example.com` in
your browser. The first visit can take a few seconds while Caddy gets the certificate. If it fails,
check `sudo journalctl -u caddy -n 50 --no-pager`. The usual cause is DNS from step 1 not pointing
at this server yet, or ports 80/443 being closed.

## 10. Create your account

Sign-up is closed (step 7), so open it just long enough to create your account:

1. Run `sudo nano /etc/gmgn-trader/gmgn.env`, change `GMGN_SIGNUP_OPEN=0` to `GMGN_SIGNUP_OPEN=1`,
   save and exit, then run `sudo systemctl restart gmgn-trader`.
2. Open `https://trader.example.com` and choose **Sign up**.
3. Use the email from `GMGN_ALLOWED_EMAILS` and a long password (at least 12 characters).
4. Close sign-up again: run `sudo nano /etc/gmgn-trader/gmgn.env`, change it back to
   `GMGN_SIGNUP_OPEN=0`, save and exit, then run `sudo systemctl restart gmgn-trader`.
5. Check it worked: sign out, then try **Sign up** again. You should see "Sign-up is closed".
   Signing in with your account still works.

Always use the `https://` address. The sign-in cookie only works over HTTPS. If you only use
Google or Apple sign-in, you can skip steps 1, 4 and 5: those don't need sign-up to be open.

## 11. Enter the app token

In the app, open **Credentials** and paste the token from step 7. The browser keeps it only
until you close the tab. "Save credentials" is turned off on the server on purpose: API keys go in
`/etc/gmgn-trader/gmgn.env` instead.

## 12. Turn on nightly backups

```bash
sudo mkdir -p /var/backups/gmgn-trader
sudo chown gmgn:gmgn /var/backups/gmgn-trader
sudo chmod 700 /var/backups/gmgn-trader
sudo cp /opt/gmgn-trader/deploy/gmgn-backup.service /opt/gmgn-trader/deploy/gmgn-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gmgn-backup.timer

# Run one backup now to check it works (needs your account from step 10 to exist):
sudo systemctl start gmgn-backup.service
sudo journalctl -u gmgn-backup -n 5 --no-pager     # look for "Backed up ..."
sudo ls /var/backups/gmgn-trader
```

Backups on the same server don't help if the server is lost. Now and then, copy them to your own
computer. The archive holds password hashes, so keep it private.

```bash
# On the server: pack the backups into one file in your home folder.
sudo tar czf ~/gmgn-backups.tar.gz -C /var/backups gmgn-trader
sudo chown "$USER": ~/gmgn-backups.tar.gz

# On your computer: download it (use your server login and domain).
scp you@trader.example.com:gmgn-backups.tar.gz .

# On the server again: remove the copy from your home folder.
rm ~/gmgn-backups.tar.gz
```

### Restoring a backup

```bash
sudo systemctl stop gmgn-trader
sudo ls /var/backups/gmgn-trader                    # pick a folder, e.g. 2026-10-07T03-30-00Z
sudo cp /var/backups/gmgn-trader/FOLDER/* /var/lib/gmgn-trader/
sudo rm -f /var/lib/gmgn-trader/*.sqlite-wal /var/lib/gmgn-trader/*.sqlite-shm
sudo chown gmgn:gmgn /var/lib/gmgn-trader/*
sudo systemctl start gmgn-trader
```

## Updating to a newer version

```bash
cd /opt/gmgn-trader
git pull
npm ci --ignore-scripts
npm run build
sudo systemctl restart gmgn-trader
sudo systemctl status gmgn-trader --no-pager
```

If a new version changes a file in `deploy/`, copy it again as in the steps above, then run
`sudo systemctl daemon-reload` (for service files) or `sudo systemctl reload caddy` (for the Caddyfile).

## Built-in protections

- **Request limits:** each visitor gets up to 300 requests a minute (`GMGN_API_REQUESTS_PER_MIN`).
- **Token lockout:** after 10 wrong app tokens, that address is blocked for 15 minutes
  (`GMGN_AUTH_FAILURES_PER_15_MIN`). Sign-in has its own lockout for wrong passwords. If you lock
  yourself out, wait 15 minutes or run `sudo systemctl restart gmgn-trader`.
- **Hidden errors:** error messages never include your RPC address, API key, app token or Google
  secret, and unexpected errors show only "Internal server error". Details go to
  `sudo journalctl -u gmgn-trader`.
- **Security headers:** only the app's own scripts run, and other sites can't show the app inside
  theirs.

## Troubleshooting

| What you see | What to check |
|---|---|
| Service won't start, log says `GMGN_LOCAL_TOKEN must be set` | Step 7: the token line is empty or shorter than 32 characters. |
| Signed in, but sent straight back to sign-in | You opened `http://` or the server's IP address. Use `https://trader.example.com`. |
| "Too many wrong token attempts" | Wait 15 minutes or restart the app, then paste the token carefully. |
| Browser says the site can't be reached | `sudo ufw status` shows 80 and 443 allowed; `dig +short` shows the server IP; `sudo systemctl status caddy`. |
| Google sign-in fails | `GMGN_PUBLIC_URL` matches your address exactly, and the redirect address in Google's console ends in `/api/auth/google/callback`. |
