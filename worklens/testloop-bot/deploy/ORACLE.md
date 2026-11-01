# Deploy the TestLoop bot on Oracle Cloud Always Free

Free forever, always on, with a real disk. About 30–45 minutes the first time.

## 1. Account

1. Sign up at https://signup.cloud.oracle.com. A card is needed for identity verification;
   Always Free resources are not charged.
2. **Home region**: pick one close to you that you're happy to keep. It can't be changed later,
   and free VMs only run in the home region. For Nigeria, **UK South (London)** or
   **South Africa Central (Johannesburg)** work well.

## 2. Create the VM

Menu → **Compute → Instances → Create instance**

- Name: `testloop`
- **Image**: click *Change image* → **Canonical Ubuntu 24.04**
- **Shape**: click *Change shape*
  - Try **Ampere → VM.Standard.A1.Flex**, 1 OCPU, 6 GB RAM (Always Free)
  - If it says *out of capacity*, use **Specialty and previous generation → VM.Standard.E2.1.Micro** (also Always Free, plenty for this bot)
- **Networking**: keep the defaults (new VCN, public subnet). Make sure **Assign a public IPv4 address** is on.
- **SSH keys**: choose *Generate a key pair for me* → **Save private key**. Put it at
  `C:\Users\User\.ssh\testloop.key`.
- Create, wait until it's **Running**, and copy the **Public IP address**.

## 3. Open ports 80 and 443

Instance page → **Subnet** link → **Security Lists** → *Default Security List* → **Add Ingress Rules**:

| Source CIDR | IP Protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

## 4. Deploy (from your PC)

In PowerShell, with `<IP>` being the VM's public IP:

```powershell
icacls C:\Users\User\.ssh\testloop.key /inheritance:r /grant:r "$($env:USERNAME):R"
cd C:\Users\User\Documents\ChatGPT\Research\worklens
scp -i C:\Users\User\.ssh\testloop.key -r testloop-bot ubuntu@<IP>:~/
ssh -i C:\Users\User\.ssh\testloop.key ubuntu@<IP> "bash ~/testloop-bot/deploy/oracle-setup.sh"
```

The `scp` copies your `.env` too (it's not in git). The last lines print the bot URL, like
`https://141-147-1-2.sslip.io`.

## 5. Connect WorkLens

WorkLens → TestLoop → **Connect bot** → that URL + the `SYNC_TOKEN` from `.env`.

## Updating later

Change the code or `.env` on your PC, then run the same `scp` and `ssh` lines again. Testers and
feedback live in `/var/lib/testloop` and are kept.

## Useful commands (on the VM)

```bash
sudo journalctl -u testloop -f       # live logs
sudo systemctl restart testloop      # restart
sudo systemctl status caddy          # HTTPS proxy
```
