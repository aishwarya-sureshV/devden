# Run DevDen on your own cloud VM

This is a single-user setup: DevDen and its agents run under your own Linux
account on a VM you control. The browser is the client; your laptop can sleep
while the VM keeps working. VM and agent costs belong to you.

The first setup uses DevDen's existing `/remote` HTTPS tunnel. No domain or
central DevDen service is required. Cloudflare Quick Tunnels are intended for
development and testing, have no uptime guarantee, and use a temporary URL.
This is a starting point for personal use, not a production hosting guarantee.
See [Cloudflare's limitations](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## 1. Prepare the VM

Create an Ubuntu 24.04 VM with a persistent disk and SSH-key access. A starting
budget is 2 vCPUs, 4 GB RAM, and 25 GB disk; project builds may need more. Keep
inbound port 4319 closed. Allow SSH from your IP, outbound HTTPS, and outbound
TCP/UDP port 7844 for the tunnel. See [Cloudflare's network requirements](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/).

SSH in as the VM's administrator. Install build tools and system-wide Node.js 24
using the [NodeSource distribution](https://github.com/nodesource/distributions):

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates python3 build-essential openssl
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/devden-nodesource.sh
sudo bash /tmp/devden-nodesource.sh
sudo apt-get install -y nodejs
/usr/bin/node --version
sudo adduser --disabled-password --gecos '' devden
sudo -iu devden
```

The remaining installation and agent login run as `devden`, not root.

## 2. Install DevDen

```bash
git clone https://github.com/aishwarya-sureshV/devden.git ~/devden
cd ~/devden
npm ci
npm run build
mkdir -p ~/projects
```

After opening DevDen in step 5, choose **Install & connect** in setup. DevDen
installs the chosen agent into `~/.local` and starts subscription sign-in.
Open the sign-in link on your laptop or phone and approve access. Any code the
provider asks you to paste back can be entered in DevDen's connection panel.
You can connect more agents later in **Settings → Agents**.

Codex device login may need enabling in ChatGPT security settings or workspace permissions; see the
[official headless login instructions](https://learn.chatgpt.com/docs/auth#login-on-headless-devices)
for the SSH callback fallback.

Logins belong to the Linux account running DevDen. Your laptop's agent logins
and files do not automatically transfer to the VM. DevDen offers subscription
sign-in, without an API-key setup step.

## 3. Add your repositories

Replace `YOUR_REPOSITORY_URL` with your repository URL:

```bash
cd ~/projects
git clone YOUR_REPOSITORY_URL my-project
cd my-project
git config user.name 'Your Name'
git config user.email 'you@example.com'
```

For a private repository, configure Git authentication under `devden` first
(for example, a repository-scoped SSH key). Agent authentication and Git
authentication are separate. Install the project's dependencies and supply its
development configuration here, just as on your laptop.

## 4. Keep DevDen running with systemd

Leave the `devden` shell to return to the administrator account. Generate a
login token in a root-only environment file, then install the included service:

```bash
exit
sudo sh -c 'umask 077; printf "DEVDEN_TOKEN=%s\n" "$(openssl rand -hex 32)" > /etc/devden.env'
sudo install -m 644 /home/devden/devden/packaging/systemd/devden.service /etc/systemd/system/devden.service
sudo systemctl daemon-reload
sudo systemctl enable --now devden
sudo systemctl status devden --no-pager
curl -fsS http://127.0.0.1:4319/api/health
```

The service uses `/usr/bin/node`, includes the user-installed agents on its
`PATH`, and launches from `/home/devden/projects`. It starts on boot and restarts
the server if it exits. It does not use the desktop launcher or open a browser.

To see the login token, run `sudo cat /etc/devden.env` in your private SSH
terminal. Copy only the value after `DEVDEN_TOKEN=` into DevDen's login screen.
Keep it private: access to this workbench grants access to the account's files
and terminal.

## 5. Open it from your laptop, then your phone

On your laptop, open a separate terminal. Replace `ADMIN` and `VM_IP`:

```bash
ssh -N -L 14319:127.0.0.1:4319 ADMIN@VM_IP
```

Open `http://127.0.0.1:14319` in your laptop browser and sign in with the token.
This connection travels inside SSH. Complete onboarding, choose Codex, and
select `/home/devden/projects/my-project` as the workspace.

Type `/remote` in a conversation. DevDen downloads `cloudflared` on first use
and displays an HTTPS connection link and QR code. Open that connection link
on your laptop or scan the QR code on your phone. The connection link contains
a login credential; keep it private.

Once the HTTPS page is connected, you can close the SSH forwarding terminal.
The tunnel and agents run on the VM, independently of that terminal or laptop.
`/remote off` closes the tunnel; SSH access still works.

## 6. Check the behavior

1. Confirm the selected agent is ready and can read your repository.
2. Ask it to run a harmless command such as `sleep 30` in that repository.
3. Close the laptop. Reopen the same session through the HTTPS link on your
   phone and verify the command completes. Approval requests still need you.
4. When no task is running, run `sudo systemctl restart devden` over SSH.
   Confirm the server returns and your saved session history is available.

A server restart or VM reboot interrupts running tasks. Saved history is not
a promise that an interrupted command resumes. The Quick Tunnel also needs
starting again via SSH and `/remote`; it receives a new URL.

## Updates and persistent data

Update when no tasks are running. As `devden`:

```bash
cd ~/devden
git pull --ff-only
npm ci
npm run build
```

Then, as the administrator, run `sudo systemctl restart devden` and reconnect
through SSH to start `/remote` again. For logs, use
`sudo journalctl -u devden -n 100 --no-pager`.

Keep `/home/devden/projects`, `/home/devden/.devden`, and your agents' state
directories (for example, `/home/devden/.codex`) on persistent storage. Back up
the account's home directory and `/etc/devden.env` securely, stopping the service
first for a consistent snapshot. Agent state and the environment file contain
credentials. Browser-local notes and preferences need separate export/backup.

## A permanent domain

For a durable public URL, the next step is a named tunnel or HTTPS reverse
proxy with a domain you own. The current UI defaults to the laptop's localhost
API for arbitrary hostnames, so simply pointing a domain at this service is
not sufficient. Supporting that setup requires same-origin API routing and an
exact `DEVDEN_UI_ORIGIN` for HTTP/WebSocket origin checks. Keep using the supported
Quick Tunnel path until custom-domain support is implemented and verified.
