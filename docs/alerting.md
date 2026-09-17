# Operational alerts

Alerts go independently to Pushover and Wazuh at **51.81.233.158:514 TCP**.
One destination being absent or unavailable does not disable the other.
Existing `SYSLOG_*` settings remain a separate log destination.

## Deployment settings

| Variable | Value / purpose |
| --- | --- |
| `PUSHOVER_TOKEN` | Application API token; store as a secret |
| `PUSHOVER_USER` | User/group key; store as a secret |
| `PUSHOVER_DEVICE` | Optional device name |
| `PUSHOVER_ENABLED` | Set `false` to disable Pushover |
| `WAZUH_HOST` | `51.81.233.158`; unset disables Wazuh |
| `WAZUH_PORT` | `514` |
| `WAZUH_PROTOCOL` | `tcp`; `udp` is also supported when the receiver is configured for it |
| `WAZUH_ENABLED` | Set `false` to disable Wazuh |

Set these in the application's Coolify/runtime environment, then redeploy.
GitHub Actions secrets are separate: set `PUSHOVER_TOKEN` and `PUSHOVER_USER`
under Settings > Secrets and variables > Actions. The local notification action
uses repository variables `WAZUH_HOST`, `WAZUH_PORT`, `WAZUH_PROTOCOL`, and
`WAZUH_ENABLED`, defaulting to the target above. No credentials belong in Git.

Node consumers vendor `lm-observability` 0.2.1 because the npm registry's 0.1.5
release still uses the previous provider. Keep the tarball, package manifest,
lockfile, and Docker COPY steps together when updating it. `pushover.send()`
mirrors the notification to Wazuh even when Pushover credentials are absent.
The shared logger also mirrors warning/error event messages, without metadata.
Delivery attempts have a 5-second Pushover timeout and 3-second Wazuh timeout.
Pushover titles/messages are limited to 250/1024 characters. Priority `max`
maps to emergency priority 2 (retry every 60 seconds, expire after one hour).

## Wazuh manager setup (once)

The existing `<connection>secure</connection>` receiver on TCP 1514 serves
Wazuh agents. Keep it. Add this second block inside `<ossec_config>` in
`/var/ossec/etc/ossec.conf` (web UI: Server management > Settings > Edit configuration):

```xml
<remote>
  <connection>syslog</connection>
  <port>514</port>
  <protocol>tcp</protocol>
  <allowed-ips>51.81.233.156</allowed-ips>
  <allowed-ips>51.81.233.157</allowed-ips>
  <allowed-ips>51.81.233.158</allowed-ips>
</remote>
```

The user-approved sender allowlist is 51.81.233.156 through 51.81.233.158. Apply the same
source allowlist to the firewall. Docker deployments must publish manager port
`514:514/tcp`. For GitHub-hosted runners, the source IP changes between runs:
use a runner or relay with a known egress IP, or manage the actual runner ranges
in your network configuration. An application-host allowlist alone does not
allow GitHub-hosted CI, Home Assistant, or Windmill workers.

Install `wazuh/decoders/mct-alert.xml` into `/var/ossec/etc/decoders/` and
`wazuh/rules/100300-mct-alerts.xml` into `/var/ossec/etc/rules/` on the manager.
These are shared files: install one copy for all projects. The 100300-100399
block follows the local registry (100100 Datum; 100200 The Foundry); verify
there are no additional manager-side rules using those IDs before installing.
Validate configuration with `/var/ossec/bin/wazuh-analysisd -t` and restart
`wazuh-manager`. Existing Foundry rules and its agent pipeline remain intact.

## Verify

From an allowlisted sender, run the repository's notification helper or trigger
a controlled application alert. A successful socket write proves transport
acceptance only. Confirm ingestion and rule matching on the manager:

```bash
sudo /var/ossec/bin/wazuh-logtest
```

Paste this sample line into logtest (rule 100301 should match):

```text
<131>Sep  8 12:00:00 test-host mct-alert: {"app":"alert-test","event":"notification","title":"Integration test","message":"Controlled test","priority":1}
```

In Wazuh Threat Hunting, filter for `rule.groups: mct_app_alerts`, or inspect
`/var/ossec/logs/alerts/alerts.json`. A missing receiver, firewall allowlist,
decoder or rule prevents end-to-end verification. Local transport tests do not
prove manager ingestion.

Sources: [Pushover API](https://pushover.net/api),
[Wazuh syslog receiver](https://documentation.wazuh.com/current/user-manual/capabilities/log-data-collection/syslog.html),
[Wazuh JSON decoding](https://documentation.wazuh.com/current/user-manual/ruleset/decoders/json-decoder.html).
