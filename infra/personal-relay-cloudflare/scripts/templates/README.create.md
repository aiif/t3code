# create-t3cf

Scaffold and deploy the [T3 Code](https://github.com/pingdotgg/t3code) personal
network relay on your own Cloudflare account.

```sh
npm create t3cf@latest
```

This package is a thin wrapper around `t3cf`. It runs the same deploy CLI, writes
the same secrets file at `~/.t3/personal-relay/<worker-name>.json`, and prints the
relay URL, admin console URL, admin key and enrollment key.

Use `npx t3cf@latest init` directly for every flag, including `--upgrade`,
`--destroy` and `--doctor`.

## License

MIT.
