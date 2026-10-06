# Security

DevDen runs coding agents and a terminal on your machine, so a bug in its
access checks can mean code execution. Please report vulnerabilities
privately through GitHub's **Report a vulnerability** button on the
Security tab of this repository, not in a public issue.

Include the version or commit, how DevDen was started (`devden`, `npm run dev`,
systemd, `/remote` tunnel), and steps to reproduce.

## Deployment model

- The server binds to `127.0.0.1` by default. Without `DEVDEN_TOKEN`, only
  requests from this machine addressed to `localhost`, `127.0.0.1`, or `[::1]`
  are accepted.
- Binding to another address (`DEVDEN_HOST`) requires `DEVDEN_TOKEN` for any
  access from other machines. Put it behind HTTPS (an SSH tunnel, Cloudflare
  Tunnel, or the built-in `/remote` tunnel). Never expose port 4319 over plain
  HTTP.
- See the Security section of [README.md](README.md) for how the token,
  tunnel tickets, and origin checks work.
