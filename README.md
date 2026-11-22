# warelay

AI assistants (ChatGPT, Claude, Gemini) through WhatsApp. A self-hosted relay that forwards selected contacts' messages to the assistant's web app through BrowserOS Neo and sends the replies back.

Built for one owner, with a terminal dashboard and an optional owner-only web dashboard. It uses the unofficial Baileys WhatsApp library, not the WhatsApp Business API or OpenAI API.

![Terminal dashboard with contact details and private identifiers redacted](docs/assets/dashboard-redacted.png)

## Motivation

I built warelay for my wife. Her workplace's website allowlist blocks ChatGPT while WhatsApp remains available. I wanted her to ask questions through WhatsApp without another app, my password or API-key setup. Reusing my existing ChatGPT subscription was part of the goal.

**Browser automation is not a policy exception.** OpenAI's [terms](https://openai.com/policies/terms-of-use/) restrict making an account available to others and automatically extracting output. warelay does not claim approved subscription sharing, policy compliance, or free or unlimited ChatGPT. Read [Motivation and approach](docs/concepts/motivation.md) before using it.

## Quick start

Requires **Node.js 24+** and either BrowserOS Neo or an installed, running Docker engine. Repository access is required while this repo is private.

```sh
git clone https://github.com/71zone/warelay.git
cd warelay
npm install
npm link
warelay
```

![Real install and first-launch walkthrough on Ubuntu: npm install, npm link, then warelay asks which browser to use. WhatsApp pairing is omitted.](docs/assets/wabgpt-quick-start.gif)

The first run guides you through choosing native or managed Docker BrowserOS, signing into ChatGPT yourself, linking WhatsApp by QR, and optionally configuring a contact's project and chat lifetime. Automatic replies require an explicit opt-in. No environment variables or Compose commands are needed for this path.

Setup resumes after interruption. Existing configured installations open the terminal dashboard directly. To run setup again:

```sh
warelay setup
```

Rerunning setup pauses forwarding. Recipients use WhatsApp; the owner handles installation, browser login and configuration.

If ChatGPT's usage limit is a problem, press O in the dashboard to add Claude (claude.ai, signed in inside the same BrowserOS) as a fallback: the next assistant takes over until the first one's limit resets, then the primary is used again. See [fallback assistants](docs/concepts/delivery.md#fallback-assistants).

## Documentation

The detailed docs form an [Open Knowledge Format v0.2 bundle](docs/index.md).

- [Getting started](docs/guides/getting-started.md) and [managed Docker browser](docs/guides/managed-browser.md)
- [Projects, memory and conversation lifetimes](docs/concepts/conversations.md)
- [Terminal controls](docs/reference/terminal.md) and [configuration](docs/reference/configuration.md)
- [Headless server](docs/guides/server.md), [Docker Compose](docs/guides/docker-compose.md) and [native browser override](docs/guides/host-browser.md)
- [HTTP interface](docs/reference/http-api.md), [maintenance](docs/runbooks/maintenance.md) and [troubleshooting](docs/runbooks/troubleshooting.md)
- [Architecture and extension contracts](docs/guides/extending.md) and [contributing](CONTRIBUTING.md)

## Before enabling replies

Only enable contacts whose messages you are authorized to share. Browser UI changes, expired logins, account restrictions and verification challenges can interrupt delivery. WhatsApp may restrict accounts using unofficial clients. See [delivery behavior](docs/concepts/delivery.md), [saved data](docs/reference/local-data.md) and [security](SECURITY.md).

A dedicated project per contact is recommended. Set project-only memory in ChatGPT yourself; warelay cannot verify that setting. Chat lifetimes do not promise token, latency or cost savings.

## License

Original code is [MIT-licensed](LICENSE). Dependencies keep their own licenses, including GPL/AGPL components. Redistribution of combined builds has not been legally reviewed; see [third-party notices](THIRD_PARTY_NOTICES.md). Nothing is published to npm or a container registry.

## Renamed from wabgpt

warelay was called wabgpt (repository `71zone/wabgpt`) while it only supported ChatGPT. The command is now `warelay` (no `wabgpt` alias), and the environment variables were renamed without fallback: `WABGPT_SUPERVISED` → `WARELAY_SUPERVISED`, `WABGPT_SESSION_START` → `WARELAY_SESSION_START`, `WABGPT_RESTARTED` → `WARELAY_RESTARTED`. The default data directory is `~/.warelay`; an existing `~/.wa-chatgpt` is still used when `~/.warelay` does not exist (see [Local data](docs/reference/local-data.md)). The Docker image, container, volume and session cookie names changed too. The quick-start GIF may still show the old name.
