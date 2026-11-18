# {{CREATE_PACKAGE_NAME}}

Create a T3 Code personal network relay on your own VPS.

```sh
npm create {{CREATE_ALIAS}}@latest
```

This runs the same CLI as `npx {{MAIN_PACKAGE_NAME}}@latest init`.

The relay deploys a Caddy + frps + registry stack with Docker Compose under
`/opt/t3-relay`, prints the admin key once, and gives you the host URL rule.
See `{{MAIN_PACKAGE_NAME}}` for prerequisites, DNS records, upgrades and the
AI-native no-Docker path.

## License

MIT.
