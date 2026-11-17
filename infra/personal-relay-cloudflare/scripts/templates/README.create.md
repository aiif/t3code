# {{CREATE_PACKAGE_NAME}}

Scaffold and deploy the [T3 Code](https://github.com/pingdotgg/t3code) personal
network relay on your own Cloudflare account.

```sh
npm create {{CREATE_ALIAS}}@latest
```

This package is a thin wrapper around `{{MAIN_PACKAGE_NAME}}`. It runs the same
deploy CLI, writes the same secrets file at `~/.t3/personal-relay/<worker-name>.json`,
and prints the relay URL, admin console URL, admin key and enrollment key.

Use `npx {{MAIN_PACKAGE_NAME}}@latest init` directly for every flag, including
`--upgrade`, `--destroy` and `--doctor`.

## License

MIT.
