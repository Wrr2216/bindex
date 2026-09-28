# Operational alerts

Alerts go independently to Pushover and to a Wazuh manager over syslog. Both
are off until configured. One destination being absent or unavailable does not
disable the other. The examples below use `51.81.233.158:514 TCP`; substitute
your own manager's address.

## Deployment settings

| Variable | Value / purpose |
| --- | --- |
| `PUSHOVER_TOKEN` | Application API token; store as a secret |
| `PUSHOVER_USER` | User/group key; store as a secret |
| `PUSHOVER_DEVICE` | Optional device name |
| `PUSHOVER_ENABLED` | Set `false` to disable Pushover |
| `WAZUH_HOST` | Your Wazuh manager, e.g. `51.81.233.158`; empty (the default) disables Wazuh |
| `WAZUH_PORT` | `514` |
| `WAZUH_PROTOCOL` | `tcp`; `udp` is also supported when the receiver is configured for it |
| `WAZUH_ENABLED` | Set `false` to disable Wazuh |

Set these in the application's Coolify/runtime environment, then redeploy.
No credentials belong in Git.

Delivery is in `server/src/lib/notify.ts` (Pushover) and
`server/src/lib/wazuh.ts` (Wazuh), with no third-party packages. Every alert
goes to Wazuh even when Pushover has no credentials. The logger also forwards
warning and error event names to Wazuh, without their metadata. Pushover times
out after 5 seconds and Wazuh after 3. Pushover titles and messages are cut to
250 and 1,024 characters. Priority `max` maps to Pushover's emergency priority 2
(repeat every 60 seconds, expire after an hour).

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

The manager needs the shared `mct-alert` decoder in `/var/ossec/etc/decoders/`
and the 100300-series rules in `/var/ossec/etc/rules/`. They are shared by all
projects, so install one copy. Bindex keeps a copy of each in
[`wazuh/decoders/mct-alert.xml`](../wazuh/decoders/mct-alert.xml) and
[`wazuh/rules/100300-mct-alerts.xml`](../wazuh/rules/100300-mct-alerts.xml), and
sends lines in the format that decoder expects (see the sample below). The 100300-100399
block follows the local registry (100100 Datum; 100200 The Foundry); verify
there are no additional manager-side rules using those IDs before installing.
Validate configuration with `/var/ossec/bin/wazuh-analysisd -t` and restart
`wazuh-manager`. Existing Foundry rules and its agent pipeline remain intact.

## Verify

From an allowlisted sender, trigger a controlled application alert. A successful socket write proves transport
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
